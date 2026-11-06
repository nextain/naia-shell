import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getAdkPath } from "./adk-store";
import {
	type BroadcastUiState,
	getBroadcastBridgeSnapshot,
	getSharedAudioContext,
	isBroadcastActive,
	setBroadcastAudioTapNode,
	setBroadcastBridgeSnapshot,
} from "./broadcast-audio-bridge";
import { loadConfig, loadConfigWithSecrets, saveConfig } from "./config";
import { usdToCredits } from "./credits";
import { t } from "./i18n";
import { Logger } from "./logger";
import { useChatStore } from "../stores/chat";

export type BroadcastPlatformId = "youtube" | "twitch" | "chzzk" | "soop";
export type BroadcastResolutionId = "1080p30" | "720p30";
export type BroadcastBrainKind = "local" | "gateway" | "both";

export interface BroadcastPlatformPreset {
	id: BroadcastPlatformId;
	label: string;
	defaultServerUrl: string;
	keyframeSeconds: 1 | 2;
	gopAt30Fps: 30 | 60;
	defaultVideoBitrate: "6M" | "8M";
	audioBitrate: "160k";
	sampleRate: 48000;
}

export const BROADCAST_PLATFORM_PRESETS: Record<
	BroadcastPlatformId,
	BroadcastPlatformPreset
> = {
	youtube: {
		id: "youtube",
		label: "YouTube",
		defaultServerUrl: "rtmps://a.rtmp.youtube.com/live2",
		keyframeSeconds: 2,
		gopAt30Fps: 60,
		defaultVideoBitrate: "6M",
		audioBitrate: "160k",
		sampleRate: 48000,
	},
	twitch: {
		id: "twitch",
		label: "Twitch",
		defaultServerUrl: "rtmp://live.twitch.tv/app",
		keyframeSeconds: 2,
		gopAt30Fps: 60,
		defaultVideoBitrate: "6M",
		audioBitrate: "160k",
		sampleRate: 48000,
	},
	chzzk: {
		id: "chzzk",
		label: "Chzzk",
		defaultServerUrl: "rtmp://global-rtmp.lip2.navercorp.com:8080/relay",
		keyframeSeconds: 1,
		gopAt30Fps: 30,
		defaultVideoBitrate: "8M",
		audioBitrate: "160k",
		sampleRate: 48000,
	},
	soop: {
		id: "soop",
		label: "SOOP",
		defaultServerUrl: "rtmp://stream.sooplive.co.kr/app",
		keyframeSeconds: 2,
		gopAt30Fps: 60,
		defaultVideoBitrate: "6M",
		audioBitrate: "160k",
		sampleRate: 48000,
	},
};

export interface BroadcastStatusPayload {
	state: BroadcastUiState;
	platform: BroadcastPlatformId | null;
	resolution?: BroadcastResolutionId | null;
	encoder: "h264_nvenc" | "libx264" | "nvh264enc" | "x264enc" | null;
	startedAt: string | null;
	elapsedSeconds: number;
	retryCount?: number;
	restartCount?: number;
	drops: number;
	lastError: string | null;
	restoreToken?: string | null;
}

/**
 * Replace any occurrence of a stream key with `***` so it is never logged or displayed.
 */
export function redactStreamKey(text: string, streamKey: string): string {
	const trimmed = streamKey.trim();
	if (!trimmed) return text;
	return text.split(trimmed).join("***");
}

/**
 * Redact the stream key across an array of ffmpeg CLI arguments.
 */
export function redactFfmpegArgs(
	args: readonly string[],
	streamKey: string,
): string[] {
	return args.map((arg) => redactStreamKey(arg, streamKey));
}

/**
 * Return a masked placeholder for UI display; never returns the raw stream key.
 */
export function maskStreamKeyForDisplay(
	streamKey: string | null | undefined,
): string {
	return streamKey && streamKey.trim().length > 0 ? "••••••••" : "";
}

/**
 * Broadcast start button is enabled only when a non-empty stream key is configured.
 */
export function canStartBroadcastWithConfig(
	config: { broadcastStreamKey?: string | null } | null | undefined,
): boolean {
	return Boolean(config?.broadcastStreamKey?.trim());
}

/**
 * Format a `broadcast_start` failure into a user-friendly localized message while
 * always redacting the stream key (Item 2).
 */
export function formatBroadcastStartError(
	rawError: unknown,
	streamKey = "",
): string {
	const rawText =
		rawError instanceof Error
			? rawError.message
			: typeof rawError === "string"
				? rawError
				: String(rawError ?? "");
	const stripped = rawText.replace(/^Error:\s*/i, "").trim();
	const safeReason = redactStreamKey(stripped, streamKey);
	if (
		/#!naia-ffmpeg-dev-placeholder|os error 216|PE\(MZ\)|ffmpeg 실행 파일을 찾을 수 없습니다/i.test(
			safeReason,
		)
	) {
		return `${t("broadcast.errorFfmpegInvalid")} (${safeReason})`;
	}
	return t("broadcast.startFailed", {
		reason: safeReason || "Unknown error",
	});
}

export function clearBroadcastError(): void {
	setBroadcastBridgeSnapshot({ lastError: null });
}

/**
 * Determine whether starting a broadcast requires an in-app confirmation step (Item 4).
 * - On Linux, XDG Desktop Portal ScreenCast already prompts the user to select/confirm the window.
 * - On Windows (where `gdigrab` grabs the `Naia` window directly) and other non-Linux OSes,
 *   we show an in-app confirmation step before connecting to the external RTMP server.
 */
export function requiresBroadcastConfirmation(
	platformOverride?: string,
): boolean {
	const raw =
		platformOverride ??
		(typeof navigator !== "undefined"
			? `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`
			: "");
	const normalized = raw.trim().toLowerCase();
	if (normalized.includes("win")) {
		return true;
	}
	if (normalized.includes("linux") && !normalized.includes("android")) {
		return false;
	}
	return true;
}

export interface BroadcastConfirmationPreview {
	platform: BroadcastPlatformId;
	serverUrl: string;
	maskedStreamKey: string;
	destinationDisplay: string;
	captureTarget: string;
}

export function getBroadcastConfirmationPreview(
	config?: {
		broadcastPlatform?: BroadcastPlatformId | null;
		broadcastServerUrl?: string | null;
		broadcastStreamKey?: string | null;
	} | null,
): BroadcastConfirmationPreview {
	const platform: BroadcastPlatformId =
		config?.broadcastPlatform ?? "youtube";
	const preset =
		BROADCAST_PLATFORM_PRESETS[platform] ??
		BROADCAST_PLATFORM_PRESETS.youtube;
	const rawServerUrl =
		config?.broadcastServerUrl?.trim() || preset.defaultServerUrl;
	const streamKey = config?.broadcastStreamKey?.trim() ?? "";
	const safeServerUrl = redactStreamKey(rawServerUrl, streamKey).replace(
		/\/+$/,
		"",
	);
	const maskedStreamKey = maskStreamKeyForDisplay(streamKey) || "••••••••";
	return {
		platform,
		serverUrl: safeServerUrl,
		maskedStreamKey,
		destinationDisplay: `${safeServerUrl}/${maskedStreamKey}`,
		captureTarget: t("broadcast.confirmTargetNaiaWindow"),
	};
}

/**
 * Evaluate YouTube BGM selection during active broadcast:
 * YouTube BGM is not blocked, and when broadcasting is active a single-line copyright notice is shown.
 */
export function checkYoutubeBgmAllowedDuringBroadcast(
	broadcastActive: boolean,
): {
	allowed: boolean;
	forcedMode: "local" | "youtube";
	noticeKey: "broadcast.bgmYoutubeCopyrightNotice" | null;
} {
	if (broadcastActive) {
		return {
			allowed: true,
			forcedMode: "youtube",
			noticeKey: "broadcast.bgmYoutubeCopyrightNotice",
		};
	}
	return {
		allowed: true,
		forcedMode: "youtube",
		noticeKey: null,
	};
}

/**
 * Convert stereo Float32 [-1, 1] planar channels into interleaved Int16 (s16le).
 */
export function packStereoFloat32ToS16le(
	left: Float32Array,
	right?: Float32Array,
): Int16Array {
	const r = right && right.length === left.length ? right : left;
	const out = new Int16Array(left.length * 2);
	for (let i = 0; i < left.length; i++) {
		const cl = Math.max(-1, Math.min(1, left[i]));
		const cr = Math.max(-1, Math.min(1, r[i]));
		out[i * 2] = cl < 0 ? Math.round(cl * 32768) : Math.round(cl * 32767);
		out[i * 2 + 1] = cr < 0 ? Math.round(cr * 32768) : Math.round(cr * 32767);
	}
	return out;
}

/**
 * Encode an interleaved Int16Array (s16le) buffer to base64 for Tauri IPC.
 */
export function int16ToBase64(pcm: Int16Array): string {
	const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let binary = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		const slice = bytes.subarray(i, Math.min(i + step, bytes.length));
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

/**
 * Accumulates 48kHz stereo PCM frames (e.g. 128-frame Web Audio render quanta)
 * into fixed-size interleaved s16le chunks before sending over Tauri IPC.
 */
export class PcmStereoFrameBundler {
	private buffer: Int16Array;
	private writeOffset = 0;
	readonly samplesPerChunk: number;

	constructor(public readonly framesPerChunk = 2048) {
		this.samplesPerChunk = Math.max(128, framesPerChunk) * 2;
		this.buffer = new Int16Array(this.samplesPerChunk);
	}

	push(left: Float32Array, right?: Float32Array): Int16Array[] {
		const packed = packStereoFloat32ToS16le(left, right);
		const chunks: Int16Array[] = [];
		let readOffset = 0;
		while (readOffset < packed.length) {
			const space = this.samplesPerChunk - this.writeOffset;
			const toCopy = Math.min(space, packed.length - readOffset);
			this.buffer.set(
				packed.subarray(readOffset, readOffset + toCopy),
				this.writeOffset,
			);
			this.writeOffset += toCopy;
			readOffset += toCopy;
			if (this.writeOffset === this.samplesPerChunk) {
				chunks.push(this.buffer.slice());
				this.writeOffset = 0;
			}
		}
		return chunks;
	}

	flush(): Int16Array | null {
		if (this.writeOffset === 0) return null;
		const remaining = this.buffer.slice(0, this.writeOffset);
		this.writeOffset = 0;
		return remaining;
	}
}

export function classifyBrainProvider(
	provider: string | null | undefined,
): "local" | "gateway" {
	const normalized = (provider ?? "").trim().toLowerCase();
	if (normalized === "ollama" || normalized === "local") {
		return "local";
	}
	return "gateway";
}

export function resolveBroadcastBrainKind(
	providersUsed: Iterable<string>,
	fallbackProvider?: string | null,
): BroadcastBrainKind {
	let sawLocal = false;
	let sawGateway = false;
	for (const p of providersUsed) {
		if (!p || !p.trim()) continue;
		if (classifyBrainProvider(p) === "local") {
			sawLocal = true;
		} else {
			sawGateway = true;
		}
	}
	if (sawLocal && sawGateway) return "both";
	if (sawLocal) return "local";
	if (sawGateway) return "gateway";
	return classifyBrainProvider(fallbackProvider);
}

export interface BroadcastMetricsInput {
	startAnswerCount: number;
	endAnswerCount: number;
	startCredits?: number | null;
	endCredits?: number | null;
	startCostUsdNaia?: number;
	endCostUsdNaia?: number;
	providersUsed: Iterable<string>;
	fallbackProvider?: string | null;
}

export function computeBroadcastSessionMetrics(input: BroadcastMetricsInput): {
	answers: number;
	creditsUsed: number;
	brain: BroadcastBrainKind;
} {
	const answers = Math.max(
		0,
		Math.trunc(input.endAnswerCount) - Math.trunc(input.startAnswerCount),
	);
	let creditsUsed = 0;
	if (input.startCredits != null && input.endCredits != null) {
		creditsUsed = Math.max(
			0,
			Number((input.startCredits - input.endCredits).toFixed(4)),
		);
	} else if (
		input.startCostUsdNaia !== undefined ||
		input.endCostUsdNaia !== undefined
	) {
		const usdDelta = Math.max(
			0,
			(input.endCostUsdNaia ?? 0) - (input.startCostUsdNaia ?? 0),
		);
		creditsUsed = Math.max(0, Number(usdToCredits(usdDelta).toFixed(4)));
	}
	const brain = resolveBroadcastBrainKind(
		input.providersUsed,
		input.fallbackProvider,
	);
	return { answers, creditsUsed, brain };
}

export function formatBroadcastElapsed(totalSeconds: number): string {
	const safe = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(safe / 3600);
	const mins = Math.floor((safe % 3600) / 60);
	const secs = safe % 60;
	const mm = String(mins).padStart(2, "0");
	const ss = String(secs).padStart(2, "0");
	if (hours > 0) {
		return `${hours}:${mm}:${ss}`;
	}
	return `${mm}:${ss}`;
}

const WORKLET_PROCESSOR_NAME = "naia-broadcast-pcm-tap";
const WORKLET_SOURCE = `
class NaiaBroadcastPcmTapProcessor extends AudioWorkletProcessor {
	process(inputs) {
		const input = inputs[0];
		if (!input || input.length === 0) {
			const silence = new Float32Array(128);
			this.port.postMessage({ left: silence, right: silence });
			return true;
		}
		const left = input[0] ? new Float32Array(input[0]) : new Float32Array(128);
		const right = input[1] ? new Float32Array(input[1]) : new Float32Array(left);
		this.port.postMessage({ left, right });
		return true;
	}
}
registerProcessor("${WORKLET_PROCESSOR_NAME}", NaiaBroadcastPcmTapProcessor);
`;

interface ActiveBroadcastSessionTracker {
	startAnswerCount: number;
	startCostUsdNaia: number;
	providersUsed: Set<string>;
	unsubscribeChat: (() => void) | null;
	workletNode: AudioWorkletNode | null;
	silentSinkGain: GainNode | null;
	bundler: PcmStereoFrameBundler;
	elapsedTimer: ReturnType<typeof setInterval> | null;
	startedAtMs: number;
}

let activeSession: ActiveBroadcastSessionTracker | null = null;
let statusEventUnlisten: UnlistenFn | null = null;
const registeredWorkletContexts = new WeakSet<AudioContext>();

function countAssistantMessages(): number {
	const messages = useChatStore.getState().messages;
	let count = 0;
	for (const msg of messages) {
		if (msg.role === "assistant" && msg.content.trim().length > 0) {
			count++;
		}
	}
	return count;
}

async function setupBroadcastAudioWorklet(): Promise<{
	workletNode: AudioWorkletNode | null;
	silentSinkGain: GainNode | null;
	bundler: PcmStereoFrameBundler;
}> {
	const bundler = new PcmStereoFrameBundler(2048);
	if (typeof AudioContext !== "function") {
		return { workletNode: null, silentSinkGain: null, bundler };
	}
	try {
		const ctx = getSharedAudioContext();
		if (!ctx.audioWorklet || typeof AudioWorkletNode !== "function") {
			return { workletNode: null, silentSinkGain: null, bundler };
		}
		if (!registeredWorkletContexts.has(ctx)) {
			const blob = new Blob([WORKLET_SOURCE], {
				type: "application/javascript",
			});
			const url = URL.createObjectURL(blob);
			try {
				await ctx.audioWorklet.addModule(url);
				registeredWorkletContexts.add(ctx);
			} finally {
				URL.revokeObjectURL(url);
			}
		}
		const workletNode = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
		});
		workletNode.port.onmessage = (
			event: MessageEvent<{ left: Float32Array; right: Float32Array }>,
		) => {
			if (!isBroadcastActive()) return;
			const { left, right } = event.data;
			const chunks = bundler.push(left, right);
			for (const chunk of chunks) {
				const pcmBase64 = int16ToBase64(chunk);
				void invoke("broadcast_push_audio", { pcmBase64 }).catch(() => {});
			}
		};
		const silentSinkGain = ctx.createGain();
		silentSinkGain.gain.value = 0;
		workletNode.connect(silentSinkGain);
		silentSinkGain.connect(ctx.destination);
		setBroadcastAudioTapNode(workletNode);
		return { workletNode, silentSinkGain, bundler };
	} catch (error) {
		Logger.warn("Broadcast", "AudioWorklet tap setup skipped", {
			error: String(error),
		});
		return { workletNode: null, silentSinkGain: null, bundler };
	}
}

function teardownActiveSessionAudio(): void {
	setBroadcastAudioTapNode(null);
	if (!activeSession) return;
	if (activeSession.elapsedTimer) {
		clearInterval(activeSession.elapsedTimer);
		activeSession.elapsedTimer = null;
	}
	if (activeSession.unsubscribeChat) {
		activeSession.unsubscribeChat();
		activeSession.unsubscribeChat = null;
	}
	if (activeSession.workletNode) {
		try {
			activeSession.workletNode.port.onmessage = null;
			activeSession.workletNode.disconnect();
		} catch {
			/* ignore */
		}
		activeSession.workletNode = null;
	}
	if (activeSession.silentSinkGain) {
		try {
			activeSession.silentSinkGain.disconnect();
		} catch {
			/* ignore */
		}
		activeSession.silentSinkGain = null;
	}
}

async function ensureStatusListener(): Promise<void> {
	if (statusEventUnlisten) return;
	try {
		statusEventUnlisten = await listen<BroadcastStatusPayload>(
			"broadcast-status-changed",
			(event) => {
				const payload = event.payload;
				if (!payload) return;
				setBroadcastBridgeSnapshot({
					state: payload.state,
					elapsedSeconds: payload.elapsedSeconds ?? 0,
					lastError: payload.lastError ?? null,
				});
				if (payload.state === "idle") {
					teardownActiveSessionAudio();
					activeSession = null;
				}
			},
		);
	} catch {
		/* Tauri event bridge unavailable in unit tests */
	}
}

export async function syncBroadcastStreamKeyAvailability(): Promise<boolean> {
	const config = await loadConfigWithSecrets();
	const hasStreamKey = canStartBroadcastWithConfig(config);
	setBroadcastBridgeSnapshot({ hasStreamKey });
	return hasStreamKey;
}

export async function refreshBroadcastStatus(): Promise<BroadcastStatusPayload | null> {
	await ensureStatusListener();
	await syncBroadcastStreamKeyAvailability();
	try {
		const status = await invoke<BroadcastStatusPayload>("broadcast_status");
		setBroadcastBridgeSnapshot({
			state: status.state,
			elapsedSeconds: status.elapsedSeconds ?? 0,
			lastError: status.lastError ?? null,
		});
		return status;
	} catch {
		return null;
	}
}

export async function startBroadcast(): Promise<BroadcastStatusPayload> {
	await ensureStatusListener();
	const config = await loadConfigWithSecrets();
	const streamKey = config?.broadcastStreamKey?.trim() ?? "";
	if (!streamKey) {
		const msg = t("broadcast.keyRequiredHint");
		setBroadcastBridgeSnapshot({
			hasStreamKey: false,
			lastError: msg,
		});
		throw new Error(msg);
	}
	const platform: BroadcastPlatformId =
		config?.broadcastPlatform ?? "youtube";
	const preset = BROADCAST_PLATFORM_PRESETS[platform];
	const serverUrl =
		config?.broadcastServerUrl?.trim() || preset.defaultServerUrl;
	const resolution: BroadcastResolutionId =
		config?.broadcastResolution ?? "1080p30";

	setBroadcastBridgeSnapshot({
		state: "starting",
		elapsedSeconds: 0,
		hasStreamKey: true,
		lastError: null,
	});

	Logger.info("Broadcast", "starting broadcast stream", {
		platform,
		resolution,
		serverUrl: redactStreamKey(serverUrl, streamKey),
	});

	const chatState = useChatStore.getState();
	const providersUsed = new Set<string>();
	if (config?.provider) {
		providersUsed.add(config.provider);
	}
	const unsubscribeChat = useChatStore.subscribe((state) => {
		if (state.provider) {
			providersUsed.add(state.provider);
		}
		for (const entry of state.sessionCostEntries) {
			if (entry.provider) {
				providersUsed.add(entry.provider);
			}
		}
	});

	try {
		const adkPath = getAdkPath() ?? "";
		const status = await invoke<BroadcastStatusPayload>("broadcast_start", {
			request: {
				adkPath,
				platform,
				serverUrl,
				streamKey,
				resolution,
				restoreToken: config?.broadcastRestoreToken ?? null,
			},
		});
		if (
			status.restoreToken &&
			status.restoreToken !== config?.broadcastRestoreToken
		) {
			const latest = loadConfig();
			if (latest) {
				saveConfig({
					...latest,
					broadcastRestoreToken: status.restoreToken,
				});
			}
		}

		const { workletNode, silentSinkGain, bundler } =
			await setupBroadcastAudioWorklet();
		const startedAtMs = Date.now();
		const elapsedTimer = setInterval(() => {
			const snap = getBroadcastBridgeSnapshot();
			if (snap.state === "live") {
				setBroadcastBridgeSnapshot({
					elapsedSeconds: Math.max(
						0,
						Math.floor((Date.now() - startedAtMs) / 1000),
					),
				});
			}
		}, 1000);

		activeSession = {
			startAnswerCount: countAssistantMessages(),
			startCostUsdNaia: chatState.totalSessionCostNaia,
			providersUsed,
			unsubscribeChat,
			workletNode,
			silentSinkGain,
			bundler,
			elapsedTimer,
			startedAtMs,
		};

		setBroadcastBridgeSnapshot({
			state: status.state,
			elapsedSeconds: status.elapsedSeconds ?? 0,
			hasStreamKey: true,
			lastError: status.lastError ?? null,
		});
		return status;
	} catch (error) {
		unsubscribeChat();
		const errMsg = formatBroadcastStartError(error, streamKey);
		Logger.error("Broadcast", "broadcast_start failed", { error: errMsg });
		setBroadcastBridgeSnapshot({
			state: "idle",
			elapsedSeconds: 0,
			lastError: errMsg,
		});
		throw new Error(errMsg);
	}
}

export async function stopBroadcast(): Promise<BroadcastStatusPayload> {
	const session = activeSession;
	if (session) {
		const remaining = session.bundler.flush();
		if (remaining) {
			const pcmBase64 = int16ToBase64(remaining);
			await invoke("broadcast_push_audio", { pcmBase64 }).catch(() => {});
		}
	}
	teardownActiveSessionAudio();

	const cfg = loadConfig();
	const chatState = useChatStore.getState();
	const metrics = computeBroadcastSessionMetrics({
		startAnswerCount: session?.startAnswerCount ?? countAssistantMessages(),
		endAnswerCount: countAssistantMessages(),
		startCostUsdNaia: session?.startCostUsdNaia ?? chatState.totalSessionCostNaia,
		endCostUsdNaia: chatState.totalSessionCostNaia,
		providersUsed: session?.providersUsed ?? [],
		fallbackProvider: cfg?.provider ?? chatState.provider,
	});
	activeSession = null;

	setBroadcastBridgeSnapshot({ state: "stopping" });
	try {
		const adkPath = getAdkPath() ?? undefined;
		const status = await invoke<BroadcastStatusPayload>("broadcast_stop", {
			request: {
				adkPath,
				answers: metrics.answers,
				creditsUsed: metrics.creditsUsed,
				brain: metrics.brain,
			},
		});
		setBroadcastBridgeSnapshot({
			state: "idle",
			elapsedSeconds: 0,
			lastError: null,
		});
		return status;
	} catch (error) {
		const errMsg = String(error);
		Logger.warn("Broadcast", "broadcast_stop error", { error: errMsg });
		setBroadcastBridgeSnapshot({
			state: "idle",
			elapsedSeconds: 0,
			lastError: errMsg,
		});
		throw error;
	}
}

export async function toggleBroadcast(): Promise<BroadcastStatusPayload> {
	const current = getBroadcastBridgeSnapshot();
	if (isBroadcastActive(current.state)) {
		return stopBroadcast();
	}
	return startBroadcast();
}
