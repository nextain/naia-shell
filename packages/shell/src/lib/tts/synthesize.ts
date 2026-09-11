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

import { BGM_SIDECAR_BASE_URL } from "../bgm-sidecar-url";
import { DEFAULT_LOCAL_VOICE_HOST, type TtsProviderId } from "../config";
import { Logger } from "../logger";
import {
	isOwnLocalVoiceUrl,
	localVoiceAuthHeaders,
	recoverLocalVoiceToken,
} from "../voice/local-runtime";
import { applyLocalRefAudio } from "../voice/ref-audio-api";
import { resolveEdgeVoice } from "./edge-tts";

// Edge neural TTS runs in the bgm/media sidecar (node msedge-tts) — the in-app
// webview can't do the MS WebSocket handshake (it can't set the required
// headers/Origin → 400). The shell fetches the sidecar's /edge-tts (#363).
const EDGE_TTS_SIDECAR_URL = `${BGM_SIDECAR_BASE_URL}/edge-tts`;
// A sentence must be able to wait out the PREVIOUS sentence's synthesis on the
// single GPU slot — measured up to ~60s per sentence on the 4060 — so the busy
// budget must exceed that, or every follow-up sentence dies with 429 and the
// reply goes silent after the first utterance (2026-08-18 실측).
const LOCAL_VOICE_BUSY_RETRY_DELAYS_MS = [
	250, 500, 750, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 3_500, 3_500, 3_500,
	3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500,
	3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500, 3_500,
	3_500, 3_500,
];
// The TensorRT VoxCPM2 worker can need roughly a minute for its first model
// load. The facade starts earlier, so requests made during that narrow window
// are rejected before the upstream POST is admitted (WinError 10061). Retrying
// that exact failure is safe and keeps the user's first reply queued until the
// local GPU is genuinely ready.
// Budget must exceed a COLD engine start: measured ~80-90s on the RTX 4060
// (model load + W8A16 + TRT engine + warm-up) — the old ~37s budget gave up
// ~25s before READY, so the turn's sentences all failed. ~120s total.
const LOCAL_VOICE_STARTUP_RETRY_DELAYS_MS = [
	1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 5_000, 5_000,
	5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
	5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
];
const LOCAL_VOICE_BUSY_MAX_RETRY_DELAY_MS = 3_500;

function retryAfterMs(response: Response, fallbackMs: number): number {
	const raw = response.headers?.get?.("Retry-After")?.trim();
	if (!raw) return fallbackMs;
	const seconds = Number(raw);
	if (Number.isFinite(seconds)) {
		return Math.min(
			LOCAL_VOICE_BUSY_MAX_RETRY_DELAY_MS,
			Math.max(100, Math.round(seconds * 1_000)),
		);
	}
	const dateMs = Date.parse(raw);
	if (!Number.isFinite(dateMs)) return fallbackMs;
	return Math.min(
		LOCAL_VOICE_BUSY_MAX_RETRY_DELAY_MS,
		Math.max(100, dateMs - Date.now()),
	);
}

// ── Voice warm-up (apply-time cold-cost prepayment) ─────────────────────────
// The FIRST synthesis with a never-used reference voice is dominated by the
// engine's per-voice prompt-cache build and is far more prone to runaway
// generation (2026-08-18 실측: 10-char first sentence → 136 patches / 39.8s;
// the SECOND sentence with the same voice → 6.4s). In live chat that cold cost
// lands on the first reply → the user assumes it broke, sends a new message,
// and new-input priority aborts the almost-finished synthesis — an endless
// "no sound" loop. Pay the cold cost in the background the moment the user
// APPLIES a voice (preset click / upload) instead.
let warmInFlight = false;
export async function warmLocalVoice(opts: {
	/** Facade palette id (preset basename) or "current" after an upload. */
	voice: string;
	/** Uploaded clip to install first (upload warm only). */
	localRefAudioBase64?: string;
}): Promise<void> {
	if (warmInFlight) return;
	warmInFlight = true;
	const base = DEFAULT_LOCAL_VOICE_HOST; // own loopback engine ONLY — never warm a remote host
	try {
		// Never SPAWN the engine for a warm-up — only warm one that is already
		// running (health is unauthenticated by design). A user who applies a
		// voice with the engine off pays the cold cost on first use, as before.
		const healthy = await fetch(`${base}/health`).then(
			(r) => r.ok,
			() => false,
		);
		if (!healthy) {
			Logger.debug("tts-warm", "skip: engine not running");
			return;
		}
		if (!localVoiceAuthHeaders().Authorization) {
			// Engine is up but this webview lost the per-launch bearer (reload) —
			// recover it; with a running engine this is idempotent, no spawn.
			if (!(await recoverLocalVoiceToken())) {
				Logger.debug("tts-warm", "skip: no auth token");
				return;
			}
		}
		if (opts.voice === "current" && opts.localRefAudioBase64) {
			await applyLocalRefAudio(opts.localRefAudioBase64, base);
		}
		const startedAt = Date.now();
		Logger.debug("tts-warm", "warm start", { voice: opts.voice });
		// The single GPU slot is often held right when a warm matters most — the
		// startup prime (~40s) or a running synthesis (which also starves the
		// accept loop → raw fetch TypeError). Wait those out (~100s budget); a
		// one-shot warm silently died on the prime's 429 (e2e-proven).
		let response: Response | null = null;
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				response = await fetch(`${base}/v1/audio/speech`, {
					method: "POST",
					headers: {
						...localVoiceAuthHeaders(),
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: "voxcpm2",
						// Medium-length text: very short inputs are the runaway trigger,
						// and the warm-up should walk the same cache path as a real
						// sentence.
						input: "안녕하세요, 만나서 반가워요.",
						voice: opts.voice,
						response_format: "wav",
					}),
				});
			} catch (err) {
				Logger.debug("tts-warm", "warm retry (unreachable)", {
					attempt,
					error: String(err),
				});
				await new Promise((r) => setTimeout(r, 3_500));
				continue;
			}
			if (response.status !== 429) break;
			Logger.debug("tts-warm", "warm retry (busy)", { attempt });
			await new Promise((r) => setTimeout(r, 3_500));
		}
		if (response?.ok) await response.arrayBuffer(); // drain so the server sees a clean finish
		Logger.debug("tts-warm", "warm done", {
			voice: opts.voice,
			status: response?.status ?? 0,
			secs: Math.round((Date.now() - startedAt) / 100) / 10,
		});
	} catch (err) {
		Logger.debug("tts-warm", "warm failed (non-fatal)", { error: String(err) });
	} finally {
		warmInFlight = false;
	}
}

export interface SynthesizeOpts {
	/** Text to speak (emotion tags / emoji already stripped by caller). */
	text: string;
	/** Provider-specific voice id. May be undefined → provider default. */
	voice?: string;
	/** 오디오 인코딩(nextain). 기본 MP3(재생용). 아바타 립싱크는 LINEAR16(PCM 24k)로
	 *  받아 cascade /stream 에 그대로 흘림(Ditto 구동). */
	encoding?: "MP3" | "LINEAR16";
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
	 * `vllmHost` (which is the LLM host). When unset, it uses the installed
	 * cascade facade at `http://localhost:8910`; it never falls back to the
	 * LLM host or a cloud voice.
	 */
	vllmTtsHost?: string;
	/** Persisted browser-uploaded WAV for the naia-local-voice Runtime. */
	localRefAudioBase64?: string;
	/** Abort signal for cancellation / interrupt. */
	signal?: AbortSignal;
	/**
	 * naia-local-voice: ask the host for a streamed `audio/pcm` response and
	 * deliver PCM16 chunks as they arrive (the caller plays them immediately).
	 * Hosts that ignore it still return a whole WAV, which is handled as before.
	 */
	streamPcm?: boolean;
	onPcmChunk?: (chunk: Int16Array, sampleRate: number) => void;
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
			audio_encoding: opts.encoding || "MP3",
		}),
		signal: opts.signal,
	});
	if (!resp.ok) {
		throw new Error(
			`Naia TTS 실패 (${resp.status}): ${await errorDetail(resp)}`,
		);
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
async function synthElevenlabs(
	opts: SynthesizeOpts,
): Promise<SynthesizeResult> {
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

/** vllm → local OpenAI-compatible `/v1/audio/speech`. */
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
		throw new Error(
			`vLLM TTS 실패 (${resp.status}): ${await errorDetail(resp)}`,
		);
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

// The private Runtime returns a RIFF WAV directly for voice-only playback.

/**
 * naia-local-voice → the private Runtime's OpenAI-compatible voice-only surface.
 * Raw engine adapters stay hidden behind :8910. The Runtime resolves the
 * selected reference voice and requires the per-launch loopback bearer.
 */
async function synthNaiaLocalVoice(
	opts: SynthesizeOpts,
): Promise<SynthesizeResult> {
	const base = (opts.vllmTtsHost || DEFAULT_LOCAL_VOICE_HOST).replace(
		/\/$/,
		"",
	);
	const defaultVoice = "naia-default";
	const selectedVoice =
		!opts.voice || opts.voice === "default" ? defaultVoice : opts.voice;
	const runtimeVoice = (voice: string) => {
		if (voice === "naia-current") return "current";
		if (voice === "naia-default") return "default";
		return voice;
	};
	// The loopback runtime rejects unauthenticated calls (401). The webview can
	// lose the per-launch bearer while the engine keeps running (auto-start
	// without the Settings flow, webview reload) — recover it from the app's own
	// engine BEFORE the first authenticated call, otherwise every sentence 401s
	// into silence. Only for the app's OWN loopback engine: a custom host (e.g.
	// a remote cascade URL) must not trigger a local TRT spawn.
	const isOwnLoopbackEngine = isOwnLocalVoiceUrl(base);
	if (isOwnLoopbackEngine && !localVoiceAuthHeaders().Authorization) {
		await recoverLocalVoiceToken();
	}
	// "내 음색"(uploaded clip) travels as a RAW wav install (PUT /voice) — a
	// LOCAL-only contract. Remote hosts (e.g. cascade) reject raw injection
	// (400; the outbound design is a voice FINGERPRINT API, 미구현) — so on a
	// custom host fall back to that server's default voice instead of failing
	// every sentence. Presets still travel fine (palette id in `voice`).
	let effectiveVoice = selectedVoice;
	if (selectedVoice === "naia-current" && opts.localRefAudioBase64) {
		if (isOwnLoopbackEngine) {
			// Reinstall on every sentence so a Runtime restart or another voice
			// change cannot silently select the wrong clone. The Runtime keys the
			// temp WAV by content hash, making repeated installs idempotent.
			await applyLocalRefAudio(opts.localRefAudioBase64, base);
		} else {
			Logger.info(
				"tts-synthesize",
				"Custom voice host — uploaded clip cannot travel; using server default",
				{ base },
			);
			effectiveVoice = defaultVoice;
		}
	}
	const request = (voice: string) =>
		fetch(`${base}/v1/audio/speech`, {
			method: "POST",
			headers: {
				// The per-launch bearer authenticates the app's OWN loopback engine
				// ONLY — sending it to a user-configured remote host would exfiltrate
				// the local credential to that server (adversarial review finding).
				...(isOwnLoopbackEngine ? localVoiceAuthHeaders() : {}),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "voxcpm2",
				input: opts.text,
				// RefAudioSection stores a preset URL in voiceRefUrl. ChatArea resolves
				// it to this facade palette id; keep it intact all the way to :8910.
				voice: runtimeVoice(voice),
				// 2026-09-11: streaming contract — a host that supports it answers
				// `audio/pcm;rate=24000` in chunks; older hosts answer a whole WAV.
				response_format: opts.streamPcm ? "pcm16" : "wav",
				stream: !!opts.streamPcm,
			}),
			signal: opts.signal,
		});
	const waitForRetry = (delayMs: number) =>
		new Promise<void>((resolve, reject) => {
			if (opts.signal?.aborted) {
				reject(opts.signal.reason ?? new DOMException("Aborted", "AbortError"));
				return;
			}
			const onAbort = () => {
				clearTimeout(timer);
				reject(
					opts.signal?.reason ?? new DOMException("Aborted", "AbortError"),
				);
			};
			const timer = setTimeout(() => {
				opts.signal?.removeEventListener("abort", onAbort);
				resolve();
			}, delayMs);
			opts.signal?.addEventListener("abort", onAbort, { once: true });
		});
	const requestAfterBusy = async (voice: string) => {
		let recoveredAuth = false;
		for (let retry = 0; ; retry++) {
			let response: Response;
			try {
				response = await request(voice);
			} catch (err) {
				// Direct connection refused (fetch TypeError): the engine is still
				// starting — the DIRECT runtime has no facade to return the 502/10061
				// shape the legacy retry keyed on, so without this branch the FIRST
				// utterance during the ~80s engine boot fails instantly with
				// "로컬 음성 엔진에 연결할 수 없습니다". Wait it out like gpu-starting.
				// A REMOTE host has no "engine boot" — an unreachable custom host must
				// fail fast (3 tries), not hang the turn for two minutes.
				if (opts.signal?.aborted) throw err;
				const budget = isOwnLoopbackEngine
					? LOCAL_VOICE_STARTUP_RETRY_DELAYS_MS.length
					: 3;
				if (retry >= budget) throw err;
				const delayMs = LOCAL_VOICE_STARTUP_RETRY_DELAYS_MS[retry];
				// Tell the chat surface the wait is the VOICE MODEL booting, not the
				// LLM thinking — the output-stage chip switches its label on this.
				if (isOwnLoopbackEngine && typeof window !== "undefined")
					window.dispatchEvent(
						new CustomEvent("naia:voice-model-preparing", { detail: true }),
					);
				Logger.info("tts-synthesize", "Local voice unreachable; retrying", {
					retry: retry + 1,
					delayMs,
					reason: "engine-starting",
					error: String(err),
				});
				await waitForRetry(delayMs);
				continue;
			}
			if (response.ok) {
				if (typeof window !== "undefined")
					window.dispatchEvent(
						new CustomEvent("naia:voice-model-preparing", { detail: false }),
					);
				Logger.debug("tts-synthesize", "local synth response ok", {
					voice,
					retry,
				});
				return { response, detail: "" };
			}
			const detail = await errorDetail(response);
			// A stale/absent bearer 401s every sentence into silence even though the
			// engine is healthy. Recover the token from the app's own engine once,
			// then retry this same request with the fresh Authorization header.
			if (response.status === 401 && isOwnLoopbackEngine && !recoveredAuth) {
				recoveredAuth = true;
				// force: the 401 proves the CURRENT token is stale — clear it so
				// recovery fetches a fresh one instead of declaring the dead header
				// "already recovered".
				if (await recoverLocalVoiceToken({ force: true })) {
					Logger.info(
						"tts-synthesize",
						"Recovered local voice token; retrying",
						{
							status: response.status,
						},
					);
					continue;
				}
			}
			// 429 means the POST was not admitted and is therefore safe to retry.
			// Keep one narrowly-scoped compatibility path for older facades that
			// wrapped urllib's exact upstream 429 as synthesis_failed/502.
			const busy =
				response.status === 429 ||
				(response.status === 502 &&
					detail.includes("HTTP Error 429: Too Many Requests"));
			const starting =
				response.status === 502 && detail.includes("WinError 10061");
			const retryDelays = starting
				? LOCAL_VOICE_STARTUP_RETRY_DELAYS_MS
				: LOCAL_VOICE_BUSY_RETRY_DELAYS_MS;
			if ((!busy && !starting) || retry >= retryDelays.length) {
				return { response, detail };
			}
			const delayMs = starting
				? retryDelays[retry]
				: retryAfterMs(response, retryDelays[retry]);
			Logger.info("tts-synthesize", "Local voice unavailable; retrying", {
				retry: retry + 1,
				delayMs,
				status: response.status,
				reason: starting ? "gpu-starting" : "busy",
			});
			await waitForRetry(delayMs);
		}
	};
	let { response: resp, detail } = await requestAfterBusy(effectiveVoice);
	if (!resp.ok) {
		// A profile update can remove a formerly bundled voice while ui-config
		// still points at it. Recover once with the facade's stable default instead
		// of turning an otherwise healthy local engine into silence.
		if (
			resp.status === 400 &&
			effectiveVoice !== defaultVoice &&
			detail.includes("unknown_voice")
		) {
			({ response: resp, detail } = await requestAfterBusy(defaultVoice));
			if (resp.ok) {
				return {
					audioBase64: arrayBufferToBase64(await resp.arrayBuffer()),
				};
			}
			throw new Error(`호스트 음성 합성 실패 (${resp.status}): ${detail}`);
		}
		throw new Error(`호스트 음성 합성 실패 (${resp.status}): ${detail}`);
	}
	// Streaming host: consume `audio/pcm` chunks as they arrive, hand each to
	// the caller for immediate playback, and still assemble the WAV for the
	// existing consumers (duration/RTF/diagnostics).
	// Only a streaming request inspects the headers — a plain WAV caller keeps
	// the previous contract exactly (and keeps working with header-less stubs).
	const ctype = opts.streamPcm ? (resp.headers?.get("content-type") ?? "") : "";
	if (opts.streamPcm && ctype.startsWith("audio/pcm") && resp.body) {
		const rate = Number(/rate=(\d+)/.exec(ctype)?.[1] ?? "24000");
		const reader = resp.body.getReader();
		const parts: Int16Array[] = [];
		let carry: Uint8Array = new Uint8Array(0);
		let total = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value || value.length === 0) continue;
			let bytes = value;
			if (carry.length) {
				const merged = new Uint8Array(carry.length + value.length);
				merged.set(carry);
				merged.set(value, carry.length);
				bytes = merged;
			}
			const even = bytes.length - (bytes.length % 2);
			carry = bytes.slice(even);
			if (even === 0) continue;
			const chunk = new Int16Array(
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even),
			);
			parts.push(chunk);
			total += chunk.length;
			opts.onPcmChunk?.(chunk, rate);
		}
		return { audioBase64: pcm16ToWavBase64(parts, total, rate) };
	}
	// audio/wav(RIFF) bytes — AudioQueue/ttsAudioToWav 가 RIFF 를 네이티브 감지.
	return { audioBase64: arrayBufferToBase64(await resp.arrayBuffer()) };
}

/** Assemble PCM16 mono chunks into a RIFF/WAVE base64 payload. */
function pcm16ToWavBase64(
	parts: Int16Array[],
	total: number,
	rate: number,
): string {
	const buf = new ArrayBuffer(44 + total * 2);
	const v = new DataView(buf);
	const w = (o: number, str: string) => {
		for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i));
	};
	w(0, "RIFF");
	v.setUint32(4, 36 + total * 2, true);
	w(8, "WAVE");
	w(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	w(36, "data");
	v.setUint32(40, total * 2, true);
	let off = 44;
	for (const p of parts) {
		for (let i = 0; i < p.length; i++) {
			v.setInt16(off, p[i], true);
			off += 2;
		}
	}
	return arrayBufferToBase64(buf);
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
