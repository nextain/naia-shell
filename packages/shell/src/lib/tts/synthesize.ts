/**
 * Shell-direct TTS synthesis (A안 — #363).
 *
 * Pipeline / preview TTS previously routed through the agent via a
 * `tts_request` IPC message. new-core's agent has **no TTS synthesis** — the
 * message fell through `agent_dispatcher`'s `_ => {}` arm and was dropped, so
 * every cloud provider (edge/google/nextain/openai/elevenlabs) went silent
 * (30s timeout → no audio). The only real cloud TTS backend in the ecosystem is
 * the gateway's `/v1/audio/speech` (Google Cloud TTS proxied via Nextain
 * credits); the agent's `skill_tts` was only ever an advertised tool, never a
 * synthesizer.
 *
 * This module synthesizes **directly from the shell webview** — the same
 * pattern the realtime voice paths (gemini-live / naia-omni WebSocket) and the
 * SettingsTab voice preview already use — bypassing the agent entirely. Per the
 * brain/body/environment layering, the agent (brain) does not own audio output;
 * the shell (body) does.
 *
 * Browser TTS (`isClientSide`) is handled by the caller via `speechSynthesis`
 * and never reaches here.
 */

import { DEFAULT_LOCAL_VOICE_HOST, type TtsProviderId } from "../config";
import { resolveEdgeVoice } from "./edge-tts";

// Edge neural TTS runs in the bgm/media sidecar (node msedge-tts) — the in-app
// webview can't do the MS WebSocket handshake (it can't set the required
// headers/Origin → 400). The shell fetches the sidecar's /edge-tts (#363).
const EDGE_TTS_SIDECAR_URL = "http://localhost:18791/edge-tts";

export interface SynthesizeOpts {
	/** Text to speak (emotion tags / emoji already stripped by caller). */
	text: string;
	/** Provider-specific voice id. May be undefined → provider default. */
	voice?: string;
	provider: TtsProviderId;
	/** Direct-provider API key (google / openai / elevenlabs). */
	apiKey?: string;
	/** Naia gateway key (nextain provider). */
	naiaKey?: string;
	/** Gateway base URL, no trailing slash (nextain provider). */
	gatewayUrl?: string;
	/** Local vLLM base URL (vllm provider — LLM-style OpenAI host). */
	vllmHost?: string;
	/**
	 * Local voice engine host (naia-local-voice provider) — distinct from
	 * `vllmHost` (which is the LLM host). When unset for naia-local-voice,
	 * synthesis falls back to `vllmHost` then fails honestly (no silent
	 * free-voice substitution — see ChatPanel catch).
	 */
	vllmTtsHost?: string;
	/** Abort signal for cancellation / interrupt. */
	signal?: AbortSignal;
}

export interface SynthesizeResult {
	/** Base64-encoded audio (MP3, or WAV for some local engines). */
	audioBase64: string;
	/** Server-reported cost in USD (gateway/nextain only; undefined otherwise). */
	costUsd?: number;
}

/**
 * ArrayBuffer → base64 in fixed-size chunks (avoids
 * `Maximum call stack size exceeded` from spreading a large byte array).
 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(
			...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
		);
	}
	return btoa(binary);
}

/** Derive a BCP-47 language code from a voice name (`ko-KR-Neural2-A` → `ko-KR`). */
export function deriveLanguageCode(voice: string | undefined): string {
	if (!voice) return "ko-KR";
	const parts = voice.split("-");
	if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
	return "ko-KR";
}

async function errorDetail(resp: Response): Promise<string> {
	try {
		const body = await resp.text();
		return body.slice(0, 200);
	} catch {
		return "";
	}
}

/** nextain → gateway `/v1/audio/speech` (Google TTS proxied via Nextain credit). */
async function synthNextain(opts: SynthesizeOpts): Promise<SynthesizeResult> {
	if (!opts.naiaKey) {
		throw new Error("Naia 로그인이 필요합니다 (naiaKey 없음).");
	}
	const base = opts.gatewayUrl?.replace(/\/$/, "");
	if (!base) {
		throw new Error("게이트웨이 URL이 설정되지 않았습니다.");
	}
	const resp = await fetch(`${base}/v1/audio/speech`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-AnyLLM-Key": `Bearer ${opts.naiaKey}`,
		},
		body: JSON.stringify({
			input: opts.text,
			// Gateway defaults bare names (no "-") to ko-KR-Neural2-A.
			voice: opts.voice || "ko-KR-Neural2-A",
			audio_encoding: "MP3",
		}),
		signal: opts.signal,
	});
	if (!resp.ok) {
		throw new Error(`Naia TTS 실패 (${resp.status}): ${await errorDetail(resp)}`);
	}
	const data = (await resp.json()) as {
		audio_content?: string;
		cost_usd?: number;
	};
	if (!data.audio_content) {
		throw new Error("Naia TTS 오디오를 수신하지 못했습니다.");
	}
	return { audioBase64: data.audio_content, costUsd: data.cost_usd };
}

/** google → Google Cloud TTS REST (`text:synthesize`) with a user API key. */
async function synthGoogle(opts: SynthesizeOpts): Promise<SynthesizeResult> {
	if (!opts.apiKey) {
		throw new Error("Google API 키가 필요합니다.");
	}
	const voice = opts.voice || "ko-KR-Neural2-A";
	const resp = await fetch(
		`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(opts.apiKey)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: { text: opts.text },
				voice: { languageCode: deriveLanguageCode(voice), name: voice },
				audioConfig: { audioEncoding: "MP3" },
			}),
			signal: opts.signal,
		},
	);
	if (!resp.ok) {
		throw new Error(
			`Google TTS 실패 (${resp.status}): ${await errorDetail(resp)}`,
		);
	}
	const data = (await resp.json()) as { audioContent?: string };
	if (!data.audioContent) {
		throw new Error("Google TTS 오디오를 수신하지 못했습니다.");
	}
	return { audioBase64: data.audioContent };
}

// Voices that are only available on the gpt-4o-mini-tts model.
const OPENAI_4O_VOICES = new Set(["ballad", "verse", "marin", "cedar"]);

/** openai → `/v1/audio/speech` (returns raw audio bytes). */
async function synthOpenai(opts: SynthesizeOpts): Promise<SynthesizeResult> {
	if (!opts.apiKey) {
		throw new Error("OpenAI API 키가 필요합니다.");
	}
	const voice = opts.voice || "alloy";
	const model = OPENAI_4O_VOICES.has(voice) ? "gpt-4o-mini-tts" : "tts-1";
	const resp = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${opts.apiKey}`,
		},
		body: JSON.stringify({
			model,
			input: opts.text,
			voice,
			response_format: "mp3",
		}),
		signal: opts.signal,
	});
	if (!resp.ok) {
		throw new Error(
			`OpenAI TTS 실패 (${resp.status}): ${await errorDetail(resp)}`,
		);
	}
	return { audioBase64: arrayBufferToBase64(await resp.arrayBuffer()) };
}

/** elevenlabs → `/v1/text-to-speech/{voiceId}` (returns raw MP3 bytes). */
async function synthElevenlabs(opts: SynthesizeOpts): Promise<SynthesizeResult> {
	if (!opts.apiKey) {
		throw new Error("ElevenLabs API 키가 필요합니다.");
	}
	// Rachel — ElevenLabs' default multilingual voice.
	const voiceId = opts.voice || "21m00Tcm4TlvDq8ikWAM";
	const resp = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"xi-api-key": opts.apiKey,
				Accept: "audio/mpeg",
			},
			body: JSON.stringify({
				text: opts.text,
				model_id: "eleven_multilingual_v2",
			}),
			signal: opts.signal,
		},
	);
	if (!resp.ok) {
		throw new Error(
			`ElevenLabs TTS 실패 (${resp.status}): ${await errorDetail(resp)}`,
		);
	}
	return { audioBase64: arrayBufferToBase64(await resp.arrayBuffer()) };
}

/** vllm → local OpenAI-compatible `/v1/audio/speech`. (naia-local-voice 는 VoxCPM2
 * 자체 프로토콜 `/tts` 라 synthNaiaLocalVoice 가 따로 처리.) */
async function synthVllm(opts: SynthesizeOpts): Promise<SynthesizeResult> {
	const base = opts.vllmHost?.replace(/\/$/, "");
	if (!base) {
		throw new Error("vLLM 호스트가 설정되지 않았습니다.");
	}
	const resp = await fetch(`${base}/v1/audio/speech`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "tts",
			input: opts.text,
			voice: opts.voice || "default",
			response_format: "mp3",
		}),
		signal: opts.signal,
	});
	if (!resp.ok) {
		throw new Error(`vLLM TTS 실패 (${resp.status}): ${await errorDetail(resp)}`);
	}
	return { audioBase64: arrayBufferToBase64(await resp.arrayBuffer()) };
}

/** edge → bgm/media sidecar (node msedge-tts → real MS neural voices, keyless). */
async function synthEdge(opts: SynthesizeOpts): Promise<SynthesizeResult> {
	const voice = resolveEdgeVoice(opts.voice, deriveLanguageCode(opts.voice));
	const resp = await fetch(
		`${EDGE_TTS_SIDECAR_URL}?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(opts.text)}`,
		{ signal: opts.signal },
	);
	if (!resp.ok) {
		throw new Error(
			`Edge TTS 사이드카 실패 (${resp.status}): ${await errorDetail(resp)}`,
		);
	}
	return { audioBase64: arrayBufferToBase64(await resp.arrayBuffer()) };
}

/** base64 → bytes (arrayBufferToBase64 의 역). */
function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** f32 PCM 샘플(mono) → 16-bit PCM WAV(ArrayBuffer). AudioQueue 가 base64 의 RIFF
 * 매직을 스니핑해 audio/wav data-URI 로 재생(합성 결과는 playBase64Audio 의 mp3 하드코딩
 * 경로가 아니라 enqueueOrdered→AudioQueue 경로). */
function f32PcmToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
	const n = samples.length;
	const buffer = new ArrayBuffer(44 + n * 2);
	const view = new DataView(buffer);
	const writeStr = (off: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
	};
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + n * 2, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits/sample
	writeStr(36, "data");
	view.setUint32(40, n * 2, true);
	let off = 44;
	for (let i = 0; i < n; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		off += 2;
	}
	return buffer;
}

/**
 * naia-local-voice → 로컬 VoxCPM2 `/tts`. naia-os 의 OpenAI `/v1/audio/speech` 와 다른
 * 계약(POST /tts {text} → {audio_b64: f32 PCM base64, sample_rate})이라 전용 어댑터로
 * 호출하고 f32 PCM → WAV 로 변환해 재생 가능한 audioBase64 반환. host=vllmTtsHost||:22600.
 */
async function synthNaiaLocalVoice(
	opts: SynthesizeOpts,
): Promise<SynthesizeResult> {
	const base = (opts.vllmTtsHost || DEFAULT_LOCAL_VOICE_HOST).replace(/\/$/, "");
	const resp = await fetch(`${base}/tts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: opts.text, normalize: true }),
		signal: opts.signal,
	});
	if (!resp.ok) {
		throw new Error(
			`로컬 음성 합성 실패 (${resp.status}): ${await errorDetail(resp)}`,
		);
	}
	const data = (await resp.json()) as {
		audio_b64?: string;
		sample_rate?: number;
		error?: string;
	};
	if (!data.audio_b64) {
		throw new Error(`로컬 음성 합성 실패: ${data.error ?? "audio_b64 없음"}`);
	}
	const pcm = base64ToBytes(data.audio_b64);
	const f32 = new Float32Array(pcm.buffer, 0, Math.floor(pcm.byteLength / 4));
	const wav = f32PcmToWav(f32, data.sample_rate ?? 48000);
	return { audioBase64: arrayBufferToBase64(wav) };
}

/**
 * Synthesize one utterance shell-side and return its audio as base64.
 * Throws on any failure (network, auth, unsupported provider) — the caller
 * decides whether to surface, drop, or fall back (e.g. edge → browser TTS).
 */
export async function synthesizeTts(
	opts: SynthesizeOpts,
): Promise<SynthesizeResult> {
	switch (opts.provider) {
		case "nextain":
			return synthNextain(opts);
		case "google":
			return synthGoogle(opts);
		case "openai":
			return synthOpenai(opts);
		case "elevenlabs":
			return synthElevenlabs(opts);
		case "vllm":
			return synthVllm(opts);
		case "naia-local-voice":
			return synthNaiaLocalVoice(opts);
		case "edge":
			return synthEdge(opts);
		default:
			throw new Error(`지원하지 않는 TTS provider: ${opts.provider}`);
	}
}
