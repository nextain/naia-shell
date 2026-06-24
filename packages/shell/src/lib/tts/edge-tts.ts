/**
 * Microsoft Edge (read-aloud) TTS over WebSocket — free, no API key, neural
 * voices for 14+ languages. This is the `edge` provider's synthesizer.
 *
 * Edge TTS has never had a real synthesizer in this codebase — `edge` was the
 * default provider in metadata but the agent dropped every `tts_request`, so
 * the default voice was silent (#363). This module implements the
 * `speech.platform.bing.com` protocol directly from the shell webview.
 *
 * Verification ceiling: the live WebSocket round-trip to Microsoft cannot be
 * exercised in CI / this dev environment (same ceiling as every other network
 * path in the shell — gateway, googleapis, openai). The deterministic pieces
 * (Sec-MS-GEC token, SSML build, binary frame parse, voice resolution) are unit
 * tested; the orchestration is thin. The caller (ChatPanel) falls back to
 * browser `speechSynthesis` if this rejects, so the default never goes silent.
 *
 * Protocol reference: the public edge-tts spec (rany2/edge-tts, Python).
 */

// Microsoft's fixed trusted client token for the read-aloud endpoint.
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const SEC_MS_GEC_VERSION = "1-130.0.2849.68";
const WS_BASE =
	"wss://speech.platform.bing.com/consumer/speech/synthesize/readwrite/edge/v1";
// 100ns-tick offset between the Unix epoch (1970) and the Windows epoch (1601).
const WIN_EPOCH_OFFSET_SECONDS = 11644473600n;

const EDGE_DEFAULT_VOICES: Record<string, string> = {
	ko: "ko-KR-SunHiNeural",
	en: "en-US-AriaNeural",
	ja: "ja-JP-NanamiNeural",
	zh: "zh-CN-XiaoxiaoNeural",
	fr: "fr-FR-DeniseNeural",
	de: "de-DE-KatjaNeural",
	es: "es-ES-ElviraNeural",
	pt: "pt-BR-FranciscaNeural",
	ru: "ru-RU-SvetlanaNeural",
};

export interface EdgeTtsOpts {
	text: string;
	/** Edge voice name (e.g. `ko-KR-SunHiNeural`). Non-edge names → language default. */
	voice?: string;
	/** BCP-47 language hint for the default voice. Defaults to document/`ko-KR`. */
	lang?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Windows file-time ticks (100ns since 1601), rounded down to the nearest 5
 * minutes — the value Microsoft hashes for the Sec-MS-GEC token. BigInt because
 * the magnitude (~1.3e17) exceeds `Number.MAX_SAFE_INTEGER`.
 */
export function secMsGecTicks(unixMs: number): bigint {
	let seconds = BigInt(Math.floor(unixMs / 1000)) + WIN_EPOCH_OFFSET_SECONDS;
	seconds -= seconds % 300n;
	return seconds * 10_000_000n;
}

/** Sec-MS-GEC token = uppercase hex SHA-256 of `${ticks}${TRUSTED_CLIENT_TOKEN}`. */
export async function computeSecMsGec(unixMs: number): Promise<string> {
	const str = `${secMsGecTicks(unixMs).toString()}${TRUSTED_CLIENT_TOKEN}`;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(str),
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
}

/** Build the authenticated WebSocket URL (includes the time-bound GEC token). */
export async function buildEdgeWsUrl(unixMs: number): Promise<string> {
	const gec = await computeSecMsGec(unixMs);
	const params = new URLSearchParams({
		TrustedClientToken: TRUSTED_CLIENT_TOKEN,
		"Sec-MS-GEC": gec,
		"Sec-MS-GEC-Version": SEC_MS_GEC_VERSION,
	});
	return `${WS_BASE}?${params.toString()}`;
}

/** Pick an edge voice: pass through real edge voices, else language default. */
export function resolveEdgeVoice(
	voice: string | undefined,
	lang: string,
): string {
	// Edge neural voices end with "Neural" (e.g. SunHiNeural, AvaMultilingualNeural).
	// Google voices (ko-KR-Neural2-A) end with "-A" / contain "Neural2" → not edge.
	if (voice && /Neural$/.test(voice)) return voice;
	const short = (lang || "ko").slice(0, 2).toLowerCase();
	return EDGE_DEFAULT_VOICES[short] ?? EDGE_DEFAULT_VOICES.ko;
}

export function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function buildSsml(text: string, voice: string, lang: string): string {
	return (
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' ` +
		`xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='${lang}'>` +
		`<voice name='${voice}'>` +
		`<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody>` +
		`</voice></speak>`
	);
}

/** speech.config preamble — selects the MP3 output format. */
export function buildConfigMessage(timestamp: string): string {
	const cfg = {
		context: {
			synthesis: {
				audio: {
					metadataoptions: {
						sentenceBoundaryEnabled: "false",
						wordBoundaryEnabled: "false",
					},
					outputFormat: "audio-24khz-48kbitrate-mono-mp3",
				},
			},
		},
	};
	return (
		`X-Timestamp:${timestamp}\r\n` +
		`Content-Type:application/json; charset=utf-8\r\n` +
		`Path:speech.config\r\n\r\n${JSON.stringify(cfg)}`
	);
}

export function buildSsmlMessage(
	requestId: string,
	ssml: string,
	timestamp: string,
): string {
	return (
		`X-RequestId:${requestId}\r\n` +
		`Content-Type:application/ssml+xml\r\n` +
		// timestamp is already an ISO string (ends with Z) — no extra Z (review #7).
		`X-Timestamp:${timestamp}\r\n` +
		`Path:ssml\r\n\r\n${ssml}`
	);
}

export interface ParsedFrame {
	path: string;
	payload: Uint8Array;
}

/**
 * Parse a binary audio frame: `[uint16 big-endian header length][header text]
 * [audio bytes]`. Returns the `Path:` value and the trailing audio payload.
 */
export function parseBinaryFrame(buf: ArrayBuffer): ParsedFrame {
	const view = new DataView(buf);
	const headerLen = view.getUint16(0, false);
	const header = new TextDecoder().decode(new Uint8Array(buf, 2, headerLen));
	const path = (header.match(/Path:([^\r\n]+)/)?.[1] ?? "").trim();
	const payload = new Uint8Array(buf, 2 + headerLen);
	return { path, payload };
}

/** 32-hex request id (no dashes), per the edge-tts protocol. */
function randomRequestId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function uint8ToBase64(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(
			...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
		);
	}
	return btoa(binary);
}

/**
 * Synthesize one utterance via Edge TTS and return MP3 base64.
 * Rejects on timeout, abort, WS error, or empty audio — the caller should fall
 * back (browser TTS) rather than leave the default voice silent.
 */
export async function synthesizeEdgeTts(opts: EdgeTtsOpts): Promise<string> {
	const lang =
		opts.lang ||
		(typeof document !== "undefined" ? document.documentElement.lang : "") ||
		"ko-KR";
	const voice = resolveEdgeVoice(opts.voice, lang);
	const url = await buildEdgeWsUrl(Date.now());

	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const chunks: Uint8Array[] = [];
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";

		const timeout = setTimeout(
			() => fail(new Error("edge-tts 응답 시간 초과")),
			opts.timeoutMs ?? 20_000,
		);

		const onAbort = () => fail(new Error("edge-tts 취소됨"));

		function cleanup(): void {
			clearTimeout(timeout);
			opts.signal?.removeEventListener("abort", onAbort);
			try {
				ws.close();
			} catch {
				/* already closing */
			}
		}

		function fail(err: Error): void {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		}

		function done(): void {
			if (settled) return;
			const total = chunks.reduce((n, c) => n + c.length, 0);
			if (total === 0) {
				fail(new Error("edge-tts 오디오를 수신하지 못했습니다."));
				return;
			}
			settled = true;
			cleanup();
			const merged = new Uint8Array(total);
			let offset = 0;
			for (const c of chunks) {
				merged.set(c, offset);
				offset += c.length;
			}
			resolve(uint8ToBase64(merged));
		}

		if (opts.signal) {
			if (opts.signal.aborted) {
				fail(new Error("edge-tts 취소됨"));
				return;
			}
			opts.signal.addEventListener("abort", onAbort);
		}

		ws.onopen = () => {
			const ts = new Date().toISOString();
			ws.send(buildConfigMessage(ts));
			ws.send(buildSsmlMessage(randomRequestId(), buildSsml(opts.text, voice, lang), ts));
		};

		ws.onmessage = (ev: MessageEvent) => {
			if (typeof ev.data === "string") {
				if (/Path:turn\.end/.test(ev.data)) done();
				return;
			}
			try {
				const { path, payload } = parseBinaryFrame(ev.data as ArrayBuffer);
				if (path === "audio" && payload.length > 0) chunks.push(payload);
			} catch {
				/* ignore malformed frame */
			}
		};

		ws.onerror = () => fail(new Error("edge-tts WebSocket 오류"));
		ws.onclose = () => {
			// Some servers close right after the last audio frame without a
			// trailing turn.end — accept what we have rather than dropping it.
			if (!settled) {
				if (chunks.length) done();
				else fail(new Error("edge-tts 연결이 조기 종료됨"));
			}
		};
	});
}
