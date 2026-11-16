/**
 * Azure AI Speech Streaming TTS + Real-Time Viseme Lip-Sync Provider Adapter.
 *
 * Supports 100% Azure-credit-backed multi-user concurrency without single-GPU
 * VoxCPM2 bottlenecks across three transports:
 *  1. `websocket` — Azure Speech USP WebSocket (`cognitiveservices/websocket/v1`)
 *     streaming real-time `Path:audio.metadata` Viseme ID (`0..21`) + `Path:audio` chunks.
 *  2. `rest` — Azure Speech REST (`/cognitiveservices/v1`) streaming SSML synthesis
 *     with short-lived STS Bearer token exchange/caching + PCM16 amplitude lip-sync.
 *  3. `gateway` — Naia Gateway proxy (`/v1/audio/speech` with `X-AnyLLM-Key`)
 *     supporting streaming PCM16/MP3, NDJSON viseme+audio frames, and Nextain JSON.
 */

import type { SpeechPlan } from "../avatar/nva-speech/vendor/speech-plan.js";
import { Logger } from "../logger";
import type { PcmStreamSource } from "../voice/audio-queue";
import {
	type AmplitudeAnalyzerOptions,
	type AmplitudeLipSyncCue,
	type AzureVisemeCue,
	type AzureVisemeTimelineDriver,
	Pcm16AmplitudeTracker,
	azureTicksToMs,
	normalizeAzureVisemeId,
	visemesToSpeechPlan,
} from "./azure-speech-viseme";
import {
	type AzureVisemeRequestType,
	type ResolvedAzureVoice,
	buildAzureSpeechSsml,
	estimateAzureSpeechCostUsd,
	resolveAzureSpeechVoice,
} from "./azure-speech-voices";

export type AzureSpeechTransport = "websocket" | "rest" | "gateway";
export type AzureSpeechMode = "auto" | AzureSpeechTransport;
export type AzureSpeechAudioFormat = "pcm16-24khz" | "mp3-24khz" | "wav-24khz";

/** Minimal browser/Node compatible WebSocket interface for USP streaming & offline mocks. */
export interface WebSocketLike {
	binaryType?: string;
	readonly readyState: number;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	onclose: ((ev: { code?: number; reason?: string }) => void) | null;
	send(data: string | ArrayBuffer | Uint8Array): void;
	close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
	url: string,
	protocols?: string | string[],
) => WebSocketLike;

export interface AzureSpeechAuthConfig {
	/** Azure region (e.g. `"koreacentral"`, `"eastus"`). */
	region?: string;
	/** Pre-issued short-lived Azure Speech STS Bearer token (~10 min TTL). */
	authToken?: string;
	/** Async provider returning a short-lived Bearer token (e.g. from Naia Gateway STS). */
	getAuthToken?: (signal?: AbortSignal) => Promise<string>;
	/** Optional Azure Speech resource key (used for STS `issueToken` or trusted server calls). */
	subscriptionKey?: string;
	/** Custom STS token endpoint override (`https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`). */
	stsEndpointUrl?: string;
	/** Custom REST synthesis endpoint override (`https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`). */
	restEndpointUrl?: string;
	/** Custom USP WebSocket endpoint override (`wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v1`). */
	wsEndpointUrl?: string;
	/** Naia Gateway base URL (e.g. `"https://gateway.naia.nextain.io"`). */
	gatewayUrl?: string;
	/** Naia Cloud / AnyLLM API key (`X-AnyLLM-Key: Bearer <naiaKey>`). */
	naiaKey?: string;
	/** Gateway TTS model identifier (default `"azure-speech"`). */
	gatewayModel?: string;
}

export interface AzureSpeechAdapterConfig extends AzureSpeechAuthConfig {
	/** Preferred transport mode (`"auto"` tries configured transports in order). */
	mode?: AzureSpeechMode;
	/** Explicit fallback chain when `mode === "auto"`. */
	transportOrder?: readonly AzureSpeechTransport[];
	/** Preferred audio wire format (default `"pcm16-24khz"` for zero-decode Web Audio streaming + amplitude analysis). */
	outputFormat?: AzureSpeechAudioFormat;
	/** Default voice ID or alias (default `"ko-KR-SunHiNeural"`). */
	defaultVoice?: string;
	/** WebSocket connection handshake timeout in ms (default `8000`). */
	wsConnectTimeoutMs?: number;
	/** Request timeout in ms (default `30000`). */
	requestTimeoutMs?: number;
	/** Amplitude fallback analyzer tuning. */
	amplitudeOptions?: AmplitudeAnalyzerOptions;
	/** Custom `fetch` implementation for testing or custom runtimes. */
	fetchImpl?: typeof fetch;
	/** Custom `WebSocket` constructor/factory for deterministic offline tests. */
	createWebSocket?: WebSocketFactory;
}

export interface AzureSpeechSynthesizeRequest {
	text: string;
	voice?: string;
	language?: string;
	/** Speaking speed multiplier (`0.5` .. `2.0`) or SSML rate string (`"+10%"`). */
	rate?: number | string;
	pitch?: string;
	volume?: string;
	style?: string;
	styleDegree?: number;
	visemeType?: AzureVisemeRequestType;
	outputFormat?: AzureSpeechAudioFormat;
	mode?: AzureSpeechMode;
	signal?: AbortSignal;
	/** Live `PcmStreamSource` for immediate `AudioQueue` Web Audio playback as chunks arrive. */
	pcmStream?: PcmStreamSource;
	/** Live `AzureVisemeTimelineDriver` automatically populated with incoming viseme or amplitude cues. */
	visemeDriver?: AzureVisemeTimelineDriver;
	/** Invoked for each decoded PCM16 mono chunk during streaming synthesis. */
	onPcmChunk?: (chunk: Int16Array, sampleRate: number) => void;
	/** Invoked for raw encoded audio chunks (e.g. MP3 frames). */
	onAudioBytes?: (bytes: Uint8Array, mimeType: string) => void;
	/** Invoked immediately as each real-time Viseme cue arrives. */
	onViseme?: (cue: AzureVisemeCue) => void;
}

export interface AzureSpeechSynthesisResult {
	/** Assembled WAV (for PCM16/WAV) or MP3 base64 payload compatible with `AudioQueue`. */
	audioBase64: string;
	audioMimeType: "audio/wav" | "audio/mpeg";
	sampleRate: number;
	durationMs: number;
	costUsd: number;
	transportUsed: AzureSpeechTransport;
	attemptedTransports: AzureSpeechTransport[];
	resolvedVoice: ResolvedAzureVoice;
	/** Sorted real-time Viseme cues (`0..21`), empty if upstream omitted visemes. */
	visemes: AzureVisemeCue[];
	/** Generated fallback amplitude cues (always populated for PCM/WAV when visemes are absent). */
	amplitudeCues: AmplitudeLipSyncCue[];
	/** Canonical NVA `SpeechPlan` (`quality_mode: "aligned"`) when WAV + visemes are available. */
	speechPlan: SpeechPlan | null;
	lipSyncMode: "viseme" | "amplitude";
}

const WS_OPEN = 1;
const STS_TOKEN_CACHE_TTL_MS = 9 * 60 * 1000; // Refresh 1 min before Azure's 10-min expiry.
const DEFAULT_SAMPLE_RATE = 24000;

/** Create a standard `AbortError` compatible with DOMException and Node/Vitest. */
export function createAbortError(
	message = "The operation was aborted.",
): Error {
	if (typeof DOMException !== "undefined") {
		return new DOMException(message, "AbortError");
	}
	const err = new Error(message);
	err.name = "AbortError";
	return err;
}

export function isAbortError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	return (err as { name?: string }).name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw createAbortError();
	}
}

/** Generate a 32-char lowercase hex request ID required by Azure Speech USP (`X-RequestId`). */
export function generateUspRequestId(): string {
	if (
		typeof globalThis.crypto !== "undefined" &&
		typeof globalThis.crypto.getRandomValues === "function"
	) {
		const bytes = new Uint8Array(16);
		globalThis.crypto.getRandomValues(bytes);
		return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	}
	let out = "";
	for (let i = 0; i < 32; i++) {
		out += Math.floor(Math.random() * 16).toString(16);
	}
	return out;
}

/** Encode a UTF-8 USP text frame (`Path: speech.config` or `Path: ssml`). */
export function encodeUspTextFrame(params: {
	path: string;
	requestId: string;
	contentType: string;
	body: string;
	timestamp?: string;
}): string {
	const ts = params.timestamp ?? new Date().toISOString();
	return `Path: ${params.path}\r\nX-RequestId: ${params.requestId}\r\nX-Timestamp: ${ts}\r\nContent-Type: ${params.contentType}\r\n\r\n${params.body}`;
}

export interface DecodedUspTextFrame {
	headers: Record<string, string>;
	path: string;
	requestId: string;
	body: string;
}

/** Decode an incoming USP text frame (`Path:audio.metadata`, `Path:turn.end`, etc.). */
export function decodeUspTextFrame(raw: string): DecodedUspTextFrame {
	const sepIdx = raw.indexOf("\r\n\r\n");
	const altSepIdx = sepIdx === -1 ? raw.indexOf("\n\n") : -1;
	let headerBlock = raw;
	let body = "";
	if (sepIdx !== -1) {
		headerBlock = raw.slice(0, sepIdx);
		body = raw.slice(sepIdx + 4);
	} else if (altSepIdx !== -1) {
		headerBlock = raw.slice(0, altSepIdx);
		body = raw.slice(altSepIdx + 2);
	}

	const headers: Record<string, string> = {};
	for (const line of headerBlock.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		headers[key] = value;
	}

	return {
		headers,
		path: (headers.path ?? "").toLowerCase(),
		requestId: headers["x-requestid"] ?? "",
		body,
	};
}

export interface DecodedUspBinaryFrame {
	headers: Record<string, string>;
	path: string;
	requestId: string;
	payload: Uint8Array;
}

/** Encode a USP binary frame (2-byte BE header length + ASCII headers + binary payload) — useful for tests/mocks. */
export function encodeUspBinaryFrame(params: {
	path: string;
	requestId: string;
	contentType?: string;
	payload: Uint8Array;
}): ArrayBuffer {
	const headerText = `Path:${params.path}\r\nX-RequestId:${params.requestId}\r\n${params.contentType ? `Content-Type:${params.contentType}\r\n` : ""}`;
	const headerBytes = new TextEncoder().encode(headerText);
	const total = 2 + headerBytes.byteLength + params.payload.byteLength;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint16(0, headerBytes.byteLength, false);
	out.set(headerBytes, 2);
	out.set(params.payload, 2 + headerBytes.byteLength);
	return out.buffer;
}

/** Decode an incoming USP binary frame (`Path:audio`). */
export function decodeUspBinaryFrame(bytes: Uint8Array): DecodedUspBinaryFrame {
	if (bytes.byteLength < 2) {
		return { headers: {}, path: "", requestId: "", payload: new Uint8Array(0) };
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const headerLen = view.getUint16(0, false);
	const clampedHeaderEnd = Math.min(bytes.byteLength, 2 + headerLen);
	const headerText = new TextDecoder("utf-8").decode(
		bytes.subarray(2, clampedHeaderEnd),
	);
	const headers: Record<string, string> = {};
	for (const line of headerText.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		headers[key] = value;
	}
	const payload = bytes.subarray(clampedHeaderEnd);
	return {
		headers,
		path: (headers.path ?? "").toLowerCase(),
		requestId: headers["x-requestid"] ?? "",
		payload,
	};
}

/**
 * Parse Viseme cues from either USP `Path:audio.metadata` JSON or Gateway
 * `visemes` array (`Offset` / `AudioOffset` 100ns ticks or `offsetMs` / `offset_ms`).
 */
export function parseAzureVisemePayload(input: unknown): AzureVisemeCue[] {
	if (!input) return [];
	let parsed: unknown = input;
	if (typeof input === "string") {
		const trimmed = input.trim();
		if (!trimmed) return [];
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return [];
		}
	}

	const rawItems: unknown[] = [];
	if (Array.isArray(parsed)) {
		rawItems.push(...parsed);
	} else if (typeof parsed === "object" && parsed !== null) {
		const obj = parsed as Record<string, unknown>;
		if (Array.isArray(obj.Metadata)) {
			rawItems.push(...obj.Metadata);
		} else if (Array.isArray(obj.visemes)) {
			rawItems.push(...obj.visemes);
		} else {
			rawItems.push(obj);
		}
	}

	const cues: AzureVisemeCue[] = [];
	for (const entry of rawItems) {
		if (!entry || typeof entry !== "object") continue;
		const rec = entry as Record<string, unknown>;
		const entryType =
			typeof rec.Type === "string"
				? rec.Type.toLowerCase()
				: typeof rec.type === "string"
					? rec.type.toLowerCase()
					: "viseme";
		if (entryType !== "viseme") continue;

		const data =
			rec.Data && typeof rec.Data === "object"
				? (rec.Data as Record<string, unknown>)
				: rec;

		const rawVisemeId =
			data.VisemeId ?? data.visemeId ?? data.viseme_id ?? rec.viseme_id;
		if (typeof rawVisemeId !== "number" || !Number.isFinite(rawVisemeId)) {
			continue;
		}

		let offsetMs = 0;
		const explicitMs =
			data.offsetMs ?? data.offset_ms ?? rec.offsetMs ?? rec.offset_ms;
		if (typeof explicitMs === "number" && Number.isFinite(explicitMs)) {
			offsetMs = Math.max(0, explicitMs);
		} else {
			const ticks =
				data.Offset ??
				data.AudioOffset ??
				data.audioOffset ??
				rec.AudioOffset ??
				rec.Offset;
			if (typeof ticks === "number" && Number.isFinite(ticks)) {
				offsetMs = azureTicksToMs(ticks);
			}
		}

		const animation =
			typeof data.Animation === "string"
				? data.Animation
				: typeof data.animation === "string"
					? data.animation
					: undefined;

		cues.push({
			offsetMs,
			visemeId: normalizeAzureVisemeId(rawVisemeId),
			animation,
		});
	}

	return cues;
}

/** Chunk-safe Uint8Array -> base64 encoder (avoids call stack overflow on large audio). */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const slice = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

/** Base64 -> Uint8Array decoder. */
export function base64ToBytes(base64: string): Uint8Array {
	const cleaned = base64.replace(/^data:[^;]+;base64,/, "").trim();
	const binary = atob(cleaned);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

/** Assemble PCM16 mono little-endian chunks into a 44-byte header RIFF/WAVE Uint8Array. */
export function pcm16ChunksToWavBytes(
	chunks: readonly Int16Array[],
	totalSamples: number,
	sampleRate: number,
): Uint8Array {
	const buffer = new ArrayBuffer(44 + totalSamples * 2);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, str: string) => {
		for (let i = 0; i < str.length; i++) {
			view.setUint8(offset + i, str.charCodeAt(i));
		}
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + totalSamples * 2, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM = 1
	view.setUint16(22, 1, true); // Mono = 1
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, totalSamples * 2, true);

	let byteOffset = 44;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i++) {
			view.setInt16(byteOffset, chunk[i], true);
			byteOffset += 2;
		}
	}
	return new Uint8Array(buffer);
}

function concatByteArrays(parts: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.byteLength;
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		merged.set(p, offset);
		offset += p.byteLength;
	}
	return merged;
}

function isRiffWaveBytes(bytes: Uint8Array): boolean {
	return (
		bytes.byteLength >= 44 &&
		bytes[0] === 0x52 && // R
		bytes[1] === 0x49 && // I
		bytes[2] === 0x46 && // F
		bytes[3] === 0x46 && // F
		bytes[8] === 0x57 && // W
		bytes[9] === 0x41 && // A
		bytes[10] === 0x56 && // V
		bytes[11] === 0x45 // E
	);
}

/** Extract PCM16 mono samples & sampleRate from a RIFF/WAVE byte buffer for fallback amplitude analysis. */
function extractPcm16FromWav(wavBytes: Uint8Array): {
	samples: Int16Array;
	sampleRate: number;
} | null {
	if (!isRiffWaveBytes(wavBytes)) return null;
	const view = new DataView(
		wavBytes.buffer,
		wavBytes.byteOffset,
		wavBytes.byteLength,
	);
	let sampleRate = DEFAULT_SAMPLE_RATE;
	let channels = 1;
	let bitsPerSample = 16;
	let offset = 12;

	while (offset + 8 <= wavBytes.byteLength) {
		const id = String.fromCharCode(
			wavBytes[offset],
			wavBytes[offset + 1],
			wavBytes[offset + 2],
			wavBytes[offset + 3],
		);
		const size = view.getUint32(offset + 4, true);
		const bodyStart = offset + 8;
		if (id === "fmt " && bodyStart + 16 <= wavBytes.byteLength) {
			const audioFormat = view.getUint16(bodyStart, true);
			if (audioFormat !== 1) return null; // Only uncompressed PCM
			channels = Math.max(1, view.getUint16(bodyStart + 2, true));
			sampleRate = view.getUint32(bodyStart + 4, true) || DEFAULT_SAMPLE_RATE;
			bitsPerSample = view.getUint16(bodyStart + 14, true);
		} else if (id === "data") {
			if (bitsPerSample !== 16) return null;
			const byteLen = Math.min(size, wavBytes.byteLength - bodyStart);
			const frameBytes = channels * 2;
			const frameCount = Math.floor(byteLen / frameBytes);
			const mono = new Int16Array(frameCount);
			for (let i = 0; i < frameCount; i++) {
				mono[i] = view.getInt16(bodyStart + i * frameBytes, true);
			}
			return { samples: mono, sampleRate };
		}
		offset = bodyStart + size + (size % 2);
	}
	return null;
}

async function computeSha256Hex(
	bytes: Uint8Array,
): Promise<string | undefined> {
	if (
		typeof globalThis.crypto === "undefined" ||
		!globalThis.crypto.subtle ||
		typeof globalThis.crypto.subtle.digest !== "function"
	) {
		return undefined;
	}
	try {
		const digest = await globalThis.crypto.subtle.digest(
			"SHA-256",
			bytes as BufferSource,
		);
		return Array.from(new Uint8Array(digest), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
	} catch {
		return undefined;
	}
}

function azureMicrosoftOutputFormat(format: AzureSpeechAudioFormat): string {
	switch (format) {
		case "mp3-24khz":
			return "audio-24khz-96kbitrate-mono-mp3";
		case "wav-24khz":
			return "riff-24khz-16bit-mono-pcm";
		default:
			return "raw-24khz-16bit-mono-pcm";
	}
}

async function toUint8Array(data: unknown): Promise<Uint8Array | null> {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	if (
		typeof Blob !== "undefined" &&
		data instanceof Blob &&
		typeof data.arrayBuffer === "function"
	) {
		return new Uint8Array(await data.arrayBuffer());
	}
	return null;
}

/** Mutable PCM16 odd-byte carry framer shared by WebSocket, REST, and Gateway streams. */
class Pcm16StreamAssembler {
	readonly chunks: Int16Array[] = [];
	totalSamples = 0;
	emittedAnyAudio = false;
	private carry = new Uint8Array(0);
	private checkedHeader = false;

	constructor(
		readonly sampleRate: number,
		private readonly onChunk?: (chunk: Int16Array, sampleRate: number) => void,
		private readonly pcmStream?: PcmStreamSource,
		private readonly amplitudeTracker?: Pcm16AmplitudeTracker,
		private readonly visemeDriver?: AzureVisemeTimelineDriver,
	) {}

	pushBytes(rawBytes: Uint8Array): void {
		if (rawBytes.byteLength === 0) return;
		let bytes = rawBytes;
		if (this.carry.byteLength > 0) {
			const merged = new Uint8Array(
				this.carry.byteLength + rawBytes.byteLength,
			);
			merged.set(this.carry, 0);
			merged.set(rawBytes, this.carry.byteLength);
			bytes = merged;
			this.carry = new Uint8Array(0);
		}

		// Strip a 44-byte RIFF/WAVE header if an upstream sent RIFF on the first frame.
		if (!this.checkedHeader) {
			if (bytes.byteLength < 12) {
				this.carry = bytes.slice();
				return;
			}
			this.checkedHeader = true;
			if (isRiffWaveBytes(bytes)) {
				if (bytes.byteLength <= 44) return;
				bytes = bytes.subarray(44);
			}
		}

		const evenLen = bytes.byteLength - (bytes.byteLength % 2);
		if (evenLen < bytes.byteLength) {
			this.carry = bytes.slice(evenLen);
		}
		if (evenLen === 0) return;

		const view = new DataView(bytes.buffer, bytes.byteOffset, evenLen);
		const sampleCount = evenLen / 2;
		const pcm = new Int16Array(sampleCount);
		for (let i = 0; i < sampleCount; i++) {
			pcm[i] = view.getInt16(i * 2, true);
		}

		this.chunks.push(pcm);
		this.totalSamples += pcm.length;
		this.emittedAnyAudio = true;

		this.onChunk?.(pcm, this.sampleRate);
		this.pcmStream?.push(pcm);
		if (this.amplitudeTracker) {
			const newCues = this.amplitudeTracker.pushChunk(pcm);
			if (newCues.length > 0 && this.visemeDriver) {
				this.visemeDriver.pushAmplitudeCues(newCues);
			}
		}
	}

	finalize(): Uint8Array {
		this.checkedHeader = true;
		if (this.amplitudeTracker) {
			const tailCues = this.amplitudeTracker.flush();
			if (tailCues.length > 0 && this.visemeDriver) {
				this.visemeDriver.pushAmplitudeCues(tailCues);
			}
		}
		this.pcmStream?.end();
		return pcm16ChunksToWavBytes(
			this.chunks,
			this.totalSamples,
			this.sampleRate,
		);
	}
}

interface CachedToken {
	token: string;
	expiresAtMs: number;
}

/**
 * Production Azure AI Speech + Viseme TTS adapter class.
 */
export class AzureSpeechTtsAdapter {
	private readonly config: AzureSpeechAdapterConfig;
	private readonly fetchImpl: typeof fetch;
	private readonly createWebSocket: WebSocketFactory;
	private cachedStsToken: CachedToken | null = null;

	constructor(config: AzureSpeechAdapterConfig) {
		this.config = { ...config };
		this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.createWebSocket =
			config.createWebSocket ??
			((url, protocols) => {
				if (typeof globalThis.WebSocket !== "function") {
					throw new Error(
						"WebSocket runtime is unavailable in this environment",
					);
				}
				const sock = protocols
					? new globalThis.WebSocket(url, protocols)
					: new globalThis.WebSocket(url);
				return sock as unknown as WebSocketLike;
			});
	}

	/** Clear cached STS Bearer token. */
	clearTokenCache(): void {
		this.cachedStsToken = null;
	}

	/** Obtain a short-lived Azure Speech Bearer token (from direct token, callback, or STS cache). */
	async resolveDirectAuth(
		signal?: AbortSignal,
		forceRefresh = false,
	): Promise<{ bearerToken?: string; subscriptionKey?: string }> {
		throwIfAborted(signal);

		if (this.config.authToken && !forceRefresh) {
			return { bearerToken: this.config.authToken };
		}

		if (this.config.getAuthToken) {
			const token = (await this.config.getAuthToken(signal)).trim();
			if (!token) {
				throw new Error("Azure Speech token provider returned an empty token");
			}
			return { bearerToken: token };
		}

		if (this.config.subscriptionKey) {
			const now = Date.now();
			if (
				!forceRefresh &&
				this.cachedStsToken &&
				this.cachedStsToken.expiresAtMs > now
			) {
				return {
					bearerToken: this.cachedStsToken.token,
					subscriptionKey: this.config.subscriptionKey,
				};
			}

			const stsUrl =
				this.config.stsEndpointUrl?.trim() ||
				(this.config.region
					? `https://${this.config.region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`
					: "");

			if (stsUrl) {
				const resp = await this.fetchImpl(stsUrl, {
					method: "POST",
					headers: {
						"Ocp-Apim-Subscription-Key": this.config.subscriptionKey,
						"Content-Length": "0",
					},
					signal,
				});
				if (!resp.ok) {
					const errText = await resp.text().catch(() => "");
					throw new Error(
						`Azure Speech STS token exchange failed (${resp.status}): ${errText || resp.statusText}`,
					);
				}
				const token = (await resp.text()).trim();
				if (!token) {
					throw new Error("Azure Speech STS returned an empty token");
				}
				this.cachedStsToken = {
					token,
					expiresAtMs: Date.now() + STS_TOKEN_CACHE_TTL_MS,
				};
				return {
					bearerToken: token,
					subscriptionKey: this.config.subscriptionKey,
				};
			}

			return { subscriptionKey: this.config.subscriptionKey };
		}

		if (this.config.authToken) {
			return { bearerToken: this.config.authToken };
		}

		throw new Error(
			"Azure Speech direct credentials missing (provide authToken, getAuthToken, or subscriptionKey)",
		);
	}

	/** Determine ordered transport list for a synthesis call. */
	resolveTransportChain(
		requestedMode?: AzureSpeechMode,
	): AzureSpeechTransport[] {
		const mode = requestedMode ?? this.config.mode ?? "auto";
		if (mode !== "auto") {
			return [mode];
		}
		if (this.config.transportOrder && this.config.transportOrder.length > 0) {
			return [...this.config.transportOrder];
		}

		const hasDirectAuth = Boolean(
			this.config.authToken ||
				this.config.getAuthToken ||
				this.config.subscriptionKey,
		);
		const hasWsTarget = Boolean(
			this.config.wsEndpointUrl || this.config.region,
		);
		const hasRestTarget = Boolean(
			this.config.restEndpointUrl || this.config.region,
		);
		const hasGateway = Boolean(this.config.gatewayUrl && this.config.naiaKey);

		const chain: AzureSpeechTransport[] = [];
		if (hasDirectAuth && hasWsTarget) chain.push("websocket");
		if (hasDirectAuth && hasRestTarget) chain.push("rest");
		if (hasGateway) chain.push("gateway");

		return chain.length > 0 ? chain : ["gateway"];
	}

	/**
	 * Synthesize speech with real-time streaming audio + Viseme `0..21` lip-sync
	 * (and automatic amplitude fallback when visemes are absent).
	 */
	async synthesize(
		request: AzureSpeechSynthesizeRequest,
	): Promise<AzureSpeechSynthesisResult> {
		const text = request.text.trim();
		if (!text) {
			throw new Error("Azure Speech synthesis text must not be empty");
		}
		throwIfAborted(request.signal);

		const transports = this.resolveTransportChain(request.mode);
		const attemptedTransports: AzureSpeechTransport[] = [];
		let lastError: unknown = null;

		for (let i = 0; i < transports.length; i++) {
			const transport = transports[i];
			throwIfAborted(request.signal);
			attemptedTransports.push(transport);

			const tracker = { emittedAudio: false };
			try {
				if (transport === "websocket") {
					return await this.synthesizeViaWebSocket(
						request,
						attemptedTransports,
						tracker,
					);
				}
				if (transport === "rest") {
					return await this.synthesizeViaRest(
						request,
						attemptedTransports,
						tracker,
					);
				}
				return await this.synthesizeViaGateway(
					request,
					attemptedTransports,
					tracker,
				);
			} catch (err) {
				if (isAbortError(err) || request.signal?.aborted) {
					request.pcmStream?.fail();
					request.visemeDriver?.stop();
					throw isAbortError(err) ? err : createAbortError();
				}
				lastError = err;
				const hasNext = i + 1 < transports.length;
				if (!hasNext || tracker.emittedAudio) {
					request.pcmStream?.fail();
					request.visemeDriver?.stop();
					throw err;
				}
				Logger.warn(
					"azure-speech-tts",
					"Primary transport failed before audio emission; falling back",
					{
						failedTransport: transport,
						nextTransport: transports[i + 1],
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}

		request.pcmStream?.fail();
		request.visemeDriver?.stop();
		throw lastError instanceof Error
			? lastError
			: new Error("All Azure Speech TTS transports failed");
	}

	private async synthesizeViaWebSocket(
		request: AzureSpeechSynthesizeRequest,
		attemptedTransports: AzureSpeechTransport[],
		tracker: { emittedAudio: boolean },
	): Promise<AzureSpeechSynthesisResult> {
		const auth = await this.resolveDirectAuth(request.signal);
		throwIfAborted(request.signal);

		const baseWsUrl =
			this.config.wsEndpointUrl?.trim() ||
			(this.config.region
				? `wss://${this.config.region}.tts.speech.microsoft.com/cognitiveservices/websocket/v1`
				: "");
		if (!baseWsUrl) {
			throw new Error(
				"Azure Speech WebSocket requires `region` or `wsEndpointUrl`",
			);
		}

		const requestId = generateUspRequestId();
		const urlObj = new URL(baseWsUrl);
		urlObj.searchParams.set("X-ConnectionId", requestId);
		if (auth.bearerToken) {
			urlObj.searchParams.set("Authorization", `Bearer ${auth.bearerToken}`);
		} else if (auth.subscriptionKey) {
			urlObj.searchParams.set(
				"Ocp-Apim-Subscription-Key",
				auth.subscriptionKey,
			);
		}

		const outputFormat =
			request.outputFormat ?? this.config.outputFormat ?? "pcm16-24khz";
		const isMp3 = outputFormat === "mp3-24khz";
		const sampleRate = DEFAULT_SAMPLE_RATE;

		const { ssml, resolvedVoice, visemeRequested } = buildAzureSpeechSsml({
			text: request.text,
			voice: request.voice ?? this.config.defaultVoice,
			language: request.language,
			rate: request.rate,
			pitch: request.pitch,
			volume: request.volume,
			style: request.style,
			styleDegree: request.styleDegree,
			visemeType: request.visemeType,
		});

		const amplitudeTracker = new Pcm16AmplitudeTracker(
			sampleRate,
			this.config.amplitudeOptions,
		);
		const pcmAssembler = isMp3
			? null
			: new Pcm16StreamAssembler(
					sampleRate,
					request.onPcmChunk,
					request.pcmStream,
					amplitudeTracker,
					request.visemeDriver,
				);
		const mp3Parts: Uint8Array[] = [];
		const visemes: AzureVisemeCue[] = [];

		const connectTimeoutMs = this.config.wsConnectTimeoutMs ?? 8000;
		const requestTimeoutMs = this.config.requestTimeoutMs ?? 30000;

		return await new Promise<AzureSpeechSynthesisResult>((resolve, reject) => {
			let settled = false;
			let opened = false;
			let connectTimer: ReturnType<typeof setTimeout> | null = null;
			let overallTimer: ReturnType<typeof setTimeout> | null = null;
			let pendingBinaryOps: Promise<void> = Promise.resolve();

			let ws: WebSocketLike;
			try {
				ws = this.createWebSocket(urlObj.toString());
				ws.binaryType = "arraybuffer";
			} catch (err) {
				reject(err);
				return;
			}

			const cleanup = () => {
				if (connectTimer) {
					clearTimeout(connectTimer);
					connectTimer = null;
				}
				if (overallTimer) {
					clearTimeout(overallTimer);
					overallTimer = null;
				}
				request.signal?.removeEventListener("abort", onAbort);
			};

			const failWith = (err: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				try {
					ws.close(1000, "closed");
				} catch {
					/* noop */
				}
				reject(err);
			};

			const onAbort = () => {
				failWith(createAbortError());
			};

			if (request.signal) {
				if (request.signal.aborted) {
					failWith(createAbortError());
					return;
				}
				request.signal.addEventListener("abort", onAbort, { once: true });
			}

			connectTimer = setTimeout(() => {
				if (!opened) {
					failWith(
						new Error(
							`Azure Speech WebSocket handshake timed out after ${connectTimeoutMs}ms`,
						),
					);
				}
			}, connectTimeoutMs);

			overallTimer = setTimeout(() => {
				failWith(
					new Error(
						`Azure Speech WebSocket synthesis timed out after ${requestTimeoutMs}ms`,
					),
				);
			}, requestTimeoutMs);

			ws.onopen = () => {
				if (settled) return;
				opened = true;
				if (connectTimer) {
					clearTimeout(connectTimer);
					connectTimer = null;
				}
				try {
					const speechConfigBody = JSON.stringify({
						context: {
							synthesis: {
								audio: {
									metadataoptions: {
										sentenceBoundaryEnabled: false,
										wordBoundaryEnabled: false,
										visemeEnabled: visemeRequested,
									},
									outputFormat: azureMicrosoftOutputFormat(outputFormat),
								},
							},
						},
					});
					ws.send(
						encodeUspTextFrame({
							path: "speech.config",
							requestId,
							contentType: "application/json; charset=utf-8",
							body: speechConfigBody,
						}),
					);
					ws.send(
						encodeUspTextFrame({
							path: "ssml",
							requestId,
							contentType: "application/ssml+xml",
							body: ssml,
						}),
					);
				} catch (sendErr) {
					failWith(sendErr);
				}
			};

			ws.onmessage = (event) => {
				if (settled) return;
				const { data } = event;

				if (typeof data === "string") {
					const frame = decodeUspTextFrame(data);
					if (frame.path === "audio.metadata") {
						const newCues = parseAzureVisemePayload(frame.body);
						for (const cue of newCues) {
							visemes.push(cue);
							request.visemeDriver?.pushViseme(cue);
							request.onViseme?.(cue);
						}
					} else if (frame.path === "turn.end") {
						pendingBinaryOps = pendingBinaryOps
							.then(async () => {
								if (settled) return;
								settled = true;
								cleanup();
								try {
									ws.close(1000, "turn.end");
								} catch {
									/* noop */
								}
								const result = await this.finalizeResult({
									text: request.text,
									resolvedVoice,
									transportUsed: "websocket",
									attemptedTransports,
									isMp3,
									pcmAssembler,
									mp3Parts,
									pcmStream: request.pcmStream,
									amplitudeTracker,
									visemes,
									sampleRate,
								});
								resolve(result);
							})
							.catch(failWith);
					}
					return;
				}

				pendingBinaryOps = pendingBinaryOps
					.then(async () => {
						if (settled) return;
						const bytes = await toUint8Array(data);
						if (!bytes) return;
						const binFrame = decodeUspBinaryFrame(bytes);
						if (
							binFrame.path !== "audio" ||
							binFrame.payload.byteLength === 0
						) {
							return;
						}
						if (pcmAssembler) {
							pcmAssembler.pushBytes(binFrame.payload);
							if (pcmAssembler.emittedAnyAudio) {
								tracker.emittedAudio = true;
							}
						} else {
							const copy = binFrame.payload.slice();
							mp3Parts.push(copy);
							tracker.emittedAudio = true;
							request.onAudioBytes?.(copy, "audio/mpeg");
						}
					})
					.catch(failWith);
			};

			ws.onerror = () => {
				failWith(new Error("Azure Speech WebSocket transport error"));
			};

			ws.onclose = (ev) => {
				if (settled) return;
				if (ws.readyState !== WS_OPEN && !opened) {
					failWith(
						new Error(
							`Azure Speech WebSocket closed before handshake (code=${ev?.code ?? 0})`,
						),
					);
					return;
				}
				failWith(
					new Error(
						`Azure Speech WebSocket closed before turn.end (code=${ev?.code ?? 0}, reason=${ev?.reason ?? ""})`,
					),
				);
			};
		});
	}

	private async synthesizeViaRest(
		request: AzureSpeechSynthesizeRequest,
		attemptedTransports: AzureSpeechTransport[],
		tracker: { emittedAudio: boolean },
	): Promise<AzureSpeechSynthesisResult> {
		const restUrl =
			this.config.restEndpointUrl?.trim() ||
			(this.config.region
				? `https://${this.config.region}.tts.speech.microsoft.com/cognitiveservices/v1`
				: "");
		if (!restUrl) {
			throw new Error(
				"Azure Speech REST requires `region` or `restEndpointUrl`",
			);
		}

		const outputFormat =
			request.outputFormat ?? this.config.outputFormat ?? "pcm16-24khz";
		const isMp3 = outputFormat === "mp3-24khz";
		const sampleRate = DEFAULT_SAMPLE_RATE;

		const { ssml, resolvedVoice } = buildAzureSpeechSsml({
			text: request.text,
			voice: request.voice ?? this.config.defaultVoice,
			language: request.language,
			rate: request.rate,
			pitch: request.pitch,
			volume: request.volume,
			style: request.style,
			styleDegree: request.styleDegree,
			// REST /cognitiveservices/v1 returns raw audio stream only; lip-sync uses PCM16 amplitude.
			visemeType: "none",
		});

		const doFetch = async (forceRefresh: boolean) => {
			const auth = await this.resolveDirectAuth(request.signal, forceRefresh);
			const headers: Record<string, string> = {
				"Content-Type": "application/ssml+xml",
				"X-Microsoft-OutputFormat": azureMicrosoftOutputFormat(outputFormat),
				"User-Agent": "naia-shell-tts/1.0",
			};
			if (auth.bearerToken) {
				headers.Authorization = `Bearer ${auth.bearerToken}`;
			} else if (auth.subscriptionKey) {
				headers["Ocp-Apim-Subscription-Key"] = auth.subscriptionKey;
			}
			return await this.fetchImpl(restUrl, {
				method: "POST",
				headers,
				body: ssml,
				signal: request.signal,
			});
		};

		let response = await doFetch(false);
		if (
			response.status === 401 &&
			(this.config.subscriptionKey || this.config.getAuthToken)
		) {
			response = await doFetch(true);
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(
				`Azure Speech REST synthesis failed (${response.status}): ${detail || response.statusText}`,
			);
		}

		const headerVisemes = parseAzureVisemePayload(
			response.headers?.get("x-azure-visemes"),
		);
		for (const cue of headerVisemes) {
			request.visemeDriver?.pushViseme(cue);
			request.onViseme?.(cue);
		}

		const amplitudeTracker = new Pcm16AmplitudeTracker(
			sampleRate,
			this.config.amplitudeOptions,
		);
		const pcmAssembler = isMp3
			? null
			: new Pcm16StreamAssembler(
					sampleRate,
					request.onPcmChunk,
					request.pcmStream,
					amplitudeTracker,
					request.visemeDriver,
				);
		const mp3Parts: Uint8Array[] = [];

		await this.consumeReadableResponse(response, request.signal, (chunk) => {
			if (pcmAssembler) {
				pcmAssembler.pushBytes(chunk);
				if (pcmAssembler.emittedAnyAudio) tracker.emittedAudio = true;
			} else {
				const copy = chunk.slice();
				mp3Parts.push(copy);
				tracker.emittedAudio = true;
				request.onAudioBytes?.(copy, "audio/mpeg");
			}
		});

		return await this.finalizeResult({
			text: request.text,
			resolvedVoice,
			transportUsed: "rest",
			attemptedTransports,
			isMp3,
			pcmAssembler,
			mp3Parts,
			pcmStream: request.pcmStream,
			amplitudeTracker,
			visemes: headerVisemes,
			sampleRate,
		});
	}

	private async synthesizeViaGateway(
		request: AzureSpeechSynthesizeRequest,
		attemptedTransports: AzureSpeechTransport[],
		tracker: { emittedAudio: boolean },
	): Promise<AzureSpeechSynthesisResult> {
		const gatewayBase = (this.config.gatewayUrl ?? "")
			.trim()
			.replace(/\/+$/, "");
		const naiaKey = (this.config.naiaKey ?? "").trim();
		if (!gatewayBase || !naiaKey) {
			throw new Error(
				"Azure Speech Gateway mode requires `gatewayUrl` and `naiaKey`",
			);
		}

		const resolvedVoice = resolveAzureSpeechVoice(
			request.voice ?? this.config.defaultVoice,
			request.language ?? request.text,
		);
		const outputFormat =
			request.outputFormat ?? this.config.outputFormat ?? "pcm16-24khz";
		const wantMp3 = outputFormat === "mp3-24khz";
		const responseFormat = wantMp3
			? "mp3"
			: outputFormat === "wav-24khz"
				? "wav"
				: "pcm16";

		const numericSpeed =
			typeof request.rate === "number" && Number.isFinite(request.rate)
				? Math.min(3.0, Math.max(0.25, request.rate))
				: 1.0;

		const response = await this.fetchImpl(`${gatewayBase}/v1/audio/speech`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AnyLLM-Key": `Bearer ${naiaKey}`,
				"X-Azure-Viseme": resolvedVoice.supportsViseme ? "true" : "false",
			},
			body: JSON.stringify({
				model: this.config.gatewayModel ?? "azure-speech",
				input: request.text,
				voice: resolvedVoice.voiceId,
				response_format: responseFormat,
				speed: numericSpeed,
				stream: outputFormat === "pcm16-24khz",
				viseme: resolvedVoice.supportsViseme,
			}),
			signal: request.signal,
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(
				`Azure Speech Gateway synthesis failed (${response.status}): ${detail || response.statusText}`,
			);
		}

		const contentType = (
			response.headers?.get("content-type") ?? ""
		).toLowerCase();
		const visemes = parseAzureVisemePayload(
			response.headers?.get("x-azure-visemes"),
		);
		for (const cue of visemes) {
			request.visemeDriver?.pushViseme(cue);
			request.onViseme?.(cue);
		}

		// Case 1: NDJSON streaming response (`application/x-ndjson`) carrying interleaved visemes + audio.
		if (contentType.includes("application/x-ndjson")) {
			return await this.consumeGatewayNdjson(
				response,
				request,
				resolvedVoice,
				attemptedTransports,
				visemes,
				wantMp3,
				tracker,
			);
		}

		// Case 2: Nextain Gateway JSON (`{ audio_content, cost_usd, visemes? }`).
		if (contentType.includes("application/json")) {
			const data = (await response.json()) as {
				audio_content?: string;
				audio_base64?: string;
				cost_usd?: number;
				mime_type?: string;
				visemes?: unknown;
			};
			throwIfAborted(request.signal);

			const bodyVisemes = parseAzureVisemePayload(data.visemes);
			for (const cue of bodyVisemes) {
				visemes.push(cue);
				request.visemeDriver?.pushViseme(cue);
				request.onViseme?.(cue);
			}

			const audioB64 = data.audio_content ?? data.audio_base64 ?? "";
			if (!audioB64) {
				throw new Error("Gateway JSON TTS response missing `audio_content`");
			}
			const rawBytes = base64ToBytes(audioB64);
			const isWav = isRiffWaveBytes(rawBytes);
			const amplitudeTracker = new Pcm16AmplitudeTracker(
				DEFAULT_SAMPLE_RATE,
				this.config.amplitudeOptions,
			);
			let durationMs = 0;
			let sampleRate = DEFAULT_SAMPLE_RATE;

			if (isWav) {
				const extracted = extractPcm16FromWav(rawBytes);
				if (extracted) {
					sampleRate = extracted.sampleRate;
					durationMs = (extracted.samples.length / sampleRate) * 1000;
					const newCues = amplitudeTracker.pushChunk(extracted.samples);
					const tail = amplitudeTracker.flush();
					request.visemeDriver?.pushAmplitudeCues([...newCues, ...tail]);
				}
			}

			tracker.emittedAudio = true;
			request.pcmStream?.endWithAudio(audioB64);

			visemes.sort((a, b) => a.offsetMs - b.offsetMs);
			if (durationMs <= 0 && visemes.length > 0) {
				durationMs = visemes[visemes.length - 1].offsetMs + 80;
			}
			const wavSha = isWav ? await computeSha256Hex(rawBytes) : undefined;
			const speechPlan =
				isWav && visemes.length > 0 && durationMs > 0
					? visemesToSpeechPlan(visemes, {
							text: request.text,
							durationMs,
							audioSha256: wavSha,
						})
					: null;

			return {
				audioBase64: audioB64,
				audioMimeType: isWav ? "audio/wav" : "audio/mpeg",
				sampleRate,
				durationMs,
				costUsd:
					typeof data.cost_usd === "number"
						? data.cost_usd
						: estimateAzureSpeechCostUsd(
								request.text.length,
								resolvedVoice.voiceId,
							),
				transportUsed: "gateway",
				attemptedTransports: [...attemptedTransports],
				resolvedVoice,
				visemes,
				amplitudeCues: [...amplitudeTracker.getCues()],
				speechPlan,
				lipSyncMode: visemes.length > 0 ? "viseme" : "amplitude",
			};
		}

		// Case 3: Streaming `audio/pcm` (`audio/pcm;rate=24000`) or `audio/wav` or `audio/mpeg`.
		const rateMatch = /rate=(\d+)/i.exec(contentType);
		const sampleRate = rateMatch
			? Math.max(8000, Number(rateMatch[1]))
			: DEFAULT_SAMPLE_RATE;
		const isMp3 =
			contentType.includes("audio/mpeg") ||
			contentType.includes("audio/mp3") ||
			(wantMp3 && !contentType.includes("pcm") && !contentType.includes("wav"));

		const amplitudeTracker = new Pcm16AmplitudeTracker(
			sampleRate,
			this.config.amplitudeOptions,
		);
		const pcmAssembler = isMp3
			? null
			: new Pcm16StreamAssembler(
					sampleRate,
					request.onPcmChunk,
					request.pcmStream,
					amplitudeTracker,
					request.visemeDriver,
				);
		const mp3Parts: Uint8Array[] = [];

		await this.consumeReadableResponse(response, request.signal, (chunk) => {
			if (pcmAssembler) {
				pcmAssembler.pushBytes(chunk);
				if (pcmAssembler.emittedAnyAudio) tracker.emittedAudio = true;
			} else {
				const copy = chunk.slice();
				mp3Parts.push(copy);
				tracker.emittedAudio = true;
				request.onAudioBytes?.(copy, "audio/mpeg");
			}
		});

		const headerCost = Number(response.headers?.get("x-cost-usd"));
		return await this.finalizeResult({
			text: request.text,
			resolvedVoice,
			transportUsed: "gateway",
			attemptedTransports,
			isMp3,
			pcmAssembler,
			mp3Parts,
			pcmStream: request.pcmStream,
			amplitudeTracker,
			visemes,
			sampleRate,
			explicitCostUsd:
				Number.isFinite(headerCost) && headerCost >= 0 ? headerCost : undefined,
		});
	}

	private async consumeGatewayNdjson(
		response: Response,
		request: AzureSpeechSynthesizeRequest,
		resolvedVoice: ResolvedAzureVoice,
		attemptedTransports: AzureSpeechTransport[],
		visemes: AzureVisemeCue[],
		isMp3: boolean,
		tracker: { emittedAudio: boolean },
	): Promise<AzureSpeechSynthesisResult> {
		const sampleRate = DEFAULT_SAMPLE_RATE;
		const amplitudeTracker = new Pcm16AmplitudeTracker(
			sampleRate,
			this.config.amplitudeOptions,
		);
		const pcmAssembler = isMp3
			? null
			: new Pcm16StreamAssembler(
					sampleRate,
					request.onPcmChunk,
					request.pcmStream,
					amplitudeTracker,
					request.visemeDriver,
				);
		const mp3Parts: Uint8Array[] = [];
		const decoder = new TextDecoder("utf-8");
		let lineBuffer = "";
		let explicitCostUsd: number | undefined;

		const handleLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			const obj = JSON.parse(trimmed) as Record<string, unknown>;
			const type = String(obj.type ?? "").toLowerCase();
			if (type === "viseme") {
				const parsed = parseAzureVisemePayload(obj);
				for (const cue of parsed) {
					visemes.push(cue);
					request.visemeDriver?.pushViseme(cue);
					request.onViseme?.(cue);
				}
			} else if (type === "audio") {
				const b64 = String(obj.audio_base64 ?? obj.data ?? "");
				if (!b64) return;
				const bytes = base64ToBytes(b64);
				if (pcmAssembler) {
					pcmAssembler.pushBytes(bytes);
					if (pcmAssembler.emittedAnyAudio) tracker.emittedAudio = true;
				} else {
					mp3Parts.push(bytes);
					tracker.emittedAudio = true;
					request.onAudioBytes?.(bytes, "audio/mpeg");
				}
			} else if (type === "done" && typeof obj.cost_usd === "number") {
				explicitCostUsd = obj.cost_usd;
			}
		};

		await this.consumeReadableResponse(response, request.signal, (chunk) => {
			lineBuffer += decoder.decode(chunk, { stream: true });
			let nl = lineBuffer.indexOf("\n");
			while (nl !== -1) {
				const line = lineBuffer.slice(0, nl);
				lineBuffer = lineBuffer.slice(nl + 1);
				handleLine(line);
				nl = lineBuffer.indexOf("\n");
			}
		});
		lineBuffer += decoder.decode();
		if (lineBuffer.trim()) {
			handleLine(lineBuffer);
		}

		return await this.finalizeResult({
			text: request.text,
			resolvedVoice,
			transportUsed: "gateway",
			attemptedTransports,
			isMp3,
			pcmAssembler,
			mp3Parts,
			pcmStream: request.pcmStream,
			amplitudeTracker,
			visemes,
			sampleRate,
			explicitCostUsd,
		});
	}

	private async consumeReadableResponse(
		response: Response,
		signal: AbortSignal | undefined,
		onChunk: (chunk: Uint8Array) => void,
	): Promise<void> {
		throwIfAborted(signal);
		if (!response.body || typeof response.body.getReader !== "function") {
			const buf = new Uint8Array(await response.arrayBuffer());
			throwIfAborted(signal);
			if (buf.byteLength > 0) onChunk(buf);
			return;
		}

		const reader = response.body.getReader();
		const onAbort = () => {
			reader.cancel().catch(() => undefined);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			for (;;) {
				throwIfAborted(signal);
				const { value, done } = await reader.read();
				throwIfAborted(signal);
				if (done) break;
				if (value && value.byteLength > 0) {
					onChunk(value);
				}
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			try {
				reader.releaseLock();
			} catch {
				/* noop */
			}
		}
	}

	private async finalizeResult(params: {
		text: string;
		resolvedVoice: ResolvedAzureVoice;
		transportUsed: AzureSpeechTransport;
		attemptedTransports: AzureSpeechTransport[];
		isMp3: boolean;
		pcmAssembler: Pcm16StreamAssembler | null;
		mp3Parts: Uint8Array[];
		pcmStream?: PcmStreamSource;
		amplitudeTracker: Pcm16AmplitudeTracker;
		visemes: AzureVisemeCue[];
		sampleRate: number;
		explicitCostUsd?: number;
	}): Promise<AzureSpeechSynthesisResult> {
		params.visemes.sort((a, b) => a.offsetMs - b.offsetMs);

		let audioBase64: string;
		let audioMimeType: "audio/wav" | "audio/mpeg";
		let durationMs = 0;
		let speechPlan: SpeechPlan | null = null;

		if (params.pcmAssembler) {
			const wavBytes = params.pcmAssembler.finalize();
			audioBase64 = bytesToBase64(wavBytes);
			audioMimeType = "audio/wav";
			durationMs =
				(params.pcmAssembler.totalSamples / params.sampleRate) * 1000;
			if (params.visemes.length > 0 && durationMs > 0) {
				const wavSha = await computeSha256Hex(wavBytes);
				speechPlan = visemesToSpeechPlan(params.visemes, {
					text: params.text,
					durationMs,
					audioSha256: wavSha,
				});
			}
		} else {
			const mergedMp3 = concatByteArrays(params.mp3Parts);
			audioBase64 = bytesToBase64(mergedMp3);
			audioMimeType = "audio/mpeg";
			params.pcmStream?.endWithAudio(audioBase64);
			if (params.visemes.length > 0) {
				durationMs = params.visemes[params.visemes.length - 1].offsetMs + 80;
			}
		}

		const costUsd =
			params.explicitCostUsd ??
			estimateAzureSpeechCostUsd(
				params.text.length,
				params.resolvedVoice.voiceId,
			);

		return {
			audioBase64,
			audioMimeType,
			sampleRate: params.sampleRate,
			durationMs,
			costUsd,
			transportUsed: params.transportUsed,
			attemptedTransports: [...params.attemptedTransports],
			resolvedVoice: params.resolvedVoice,
			visemes: params.visemes,
			amplitudeCues: [...params.amplitudeTracker.getCues()],
			speechPlan,
			lipSyncMode: params.visemes.length > 0 ? "viseme" : "amplitude",
		};
	}
}

/** Convenience functional wrapper around `AzureSpeechTtsAdapter.synthesize`. */
export async function synthesizeAzureSpeech(
	config: AzureSpeechAdapterConfig,
	request: AzureSpeechSynthesizeRequest,
): Promise<AzureSpeechSynthesisResult> {
	const adapter = new AzureSpeechTtsAdapter(config);
	return await adapter.synthesize(request);
}
