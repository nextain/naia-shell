/**
 * YouTube BGM 서버 — 포트 18791 의 작은 HTTP 서버.
 * InnerTube 기반 검색 메타데이터를 셸 BGM 플레이어(`components/BgmPlayer.tsx`)에 제공.
 * 레이어 = 환경 사이드카(SoT: docs/brain-body-environment.md). agent 독립.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { Innertube } from "youtubei.js";
import { allowOriginFor } from "./cors-origin.js";
import { listenOnLoopback } from "./loopback-listen.js";

// Fixed default 18791 (shell hardcodes it); NAIA_BGM_PORT overrides for tests.
export const YT_SERVER_PORT = Number(process.env.NAIA_BGM_PORT) || 18791;

// ── Innertube singleton ───────────────────────────────────────────────────────

let _yt: Innertube | null = null;
let _ytInit: Promise<Innertube> | null = null;

export async function getInnertube(): Promise<Innertube> {
	if (_yt) return _yt;
	if (_ytInit) return _ytInit;
	_ytInit = Innertube.create()
		.then((yt) => {
			_yt = yt;
			return yt;
		})
		.catch((err: unknown) => {
			// Clear so next call retries instead of re-resolving the rejected promise
			_ytInit = null;
			throw err;
		});
	return _ytInit;
}

// ── CORS headers ──────────────────────────────────────────────────────────────

function cors(req: IncomingMessage, res: ServerResponse) {
	const origin = String(req.headers.origin ?? "");
	res.setHeader("Access-Control-Allow-Origin", allowOriginFor(origin));
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	res.setHeader("Vary", "Origin");
	res.setHeader("Content-Type", "application/json; charset=utf-8");
}

function json(req: IncomingMessage, res: ServerResponse, status: number, data: unknown) {
	cors(req, res);
	res.writeHead(status);
	res.end(JSON.stringify(data));
}

// ── Route handlers ────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: youtubei.js types vary by version
export function mapYoutubeSearchVideo(v: any) {
	return {
		id: v?.id ?? v?.video_id ?? "",
		title: typeof v?.title === "string" ? v.title : (v?.title?.text ?? ""),
		thumbnail: v?.thumbnails?.[0]?.url ?? v?.thumbnail?.[0]?.url ?? "",
		duration:
			typeof v?.duration === "string"
				? v.duration
				: (v?.duration?.text ??
					(typeof v?.duration?.seconds === "number" && v.duration.seconds > 0
						? String(v.duration.seconds)
						: "")),
		channel: v?.author?.name ?? v?.channel?.name ?? "",
	};
}

async function handleSearch(req: IncomingMessage, res: ServerResponse, params: URLSearchParams) {
	const q = params.get("q")?.trim() ?? "";
	if (!q) { json(req, res, 400, { error: "q required" }); return; }
	const max = Math.min(Number(params.get("max") ?? "12"), 20);

	// Do not force "playlist" onto every search query: Radio DJ and default BGM
	// playback prefer individual songs so track-end transitions happen naturally.
	// Explicit playlist/mix queries still keep the user's terms intact.
	const searchQuery = q;

	const yt = await getInnertube();
	const search = await yt.search(searchQuery, { type: "video" });

	const results = (search.videos ?? []).slice(0, max).map(mapYoutubeSearchVideo);

	json(req, res, 200, { results });
}

// ── Server bootstrap ──────────────────────────────────────────────────────────

// ── Edge TTS (#363) ─────────────────────────────────────────────────────────
// Microsoft Edge neural voices, keyless. MUST run here (node), not in the shell
// webview: the browser WebSocket API can't set the headers/Origin MS requires,
// so the in-app webview gets a 400/handshake reject. Node (msedge-tts → `ws`
// with headers) succeeds. Returns raw MP3 bytes to the shell synthesize path.

/** Edge neural voice id (e.g. ko-KR-SunHiNeural); fall back to a Korean voice. */
function edgeVoice(v: string | null): string {
	return v && /Neural$/.test(v) ? v : "ko-KR-SunHiNeural";
}

async function handleEdgeTts(
	req: IncomingMessage,
	res: ServerResponse,
	params: URLSearchParams,
): Promise<void> {
	const text = (params.get("text") ?? "").slice(0, 5000);
	if (!text.trim()) {
		json(req, res, 400, { error: "text required" });
		return;
	}
	const tts = new MsEdgeTTS();
	await tts.setMetadata(
		edgeVoice(params.get("voice")),
		OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
	);
	const { audioStream } = tts.toStream(text);
	const chunks: Buffer[] = [];
	await new Promise<void>((resolve, reject) => {
		audioStream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
		audioStream.on("end", () => resolve());
		audioStream.on("error", reject);
	});
	const origin = String(req.headers.origin ?? "");
	res.setHeader("Access-Control-Allow-Origin", allowOriginFor(origin));
	res.setHeader("Vary", "Origin");
	res.setHeader("Content-Type", "audio/mpeg");
	res.writeHead(200);
	res.end(Buffer.concat(chunks));
}

export function startYoutubeServer(): void {
	// Pre-warm Innertube in the background
	getInnertube().catch(() => {});

	const handler: RequestListener = async (req, res) => {
		if (req.method === "OPTIONS") {
			cors(req, res);
			res.writeHead(204);
			res.end();
			return;
		}

		const url = new URL(req.url ?? "/", `http://localhost:${YT_SERVER_PORT}`);
		try {
			if (url.pathname === "/yt/search") {
				await handleSearch(req, res, url.searchParams);
			} else if (url.pathname === "/edge-tts") {
				await handleEdgeTts(req, res, url.searchParams);
			} else if (url.pathname === "/health") {
				// Readiness probe — used by Rust spawn_youtube_bgm_server (#335)
				// to confirm the server is actually listening (catches EADDRINUSE
				// or other startup failures that the spawn handle can't see).
				json(req, res, 200, {
					ok: true,
					nonce: process.env.NAIA_BGM_HEALTH_NONCE ?? null,
				});
			} else {
				json(req, res, 404, { error: "not found" });
			}
		} catch (err) {
			// Only reset singleton if Innertube itself failed (not downstream API errors).
			// getInnertube() already clears _ytInit on init failure via its .catch handler.
			process.stderr.write(`[youtube-server] request error: ${err}\n`);
			json(req, res, 500, { error: "internal server error" });
		}
	};

	// Loopback only — both 127.0.0.1 and ::1, never every interface (#716).
	listenOnLoopback(handler, YT_SERVER_PORT, (err) => {
		process.stderr.write(`[youtube-server] error: ${err}\n`);
		if (err.code === "EADDRINUSE") {
			// FR-BGM.14 (#517): exit immediately instead of retrying. A retry loop
			// leaves a zombie that inherits the port with a stale health nonce the
			// moment the current holder dies, making the failure self-perpetuating.
			// Port reclaim is the shell's job (FR-BGM.13) before it spawns us.
			process.stderr.write(
				`[youtube-server] port ${YT_SERVER_PORT} is taken — exiting so the shell can reclaim it\n`,
			);
			process.exit(1);
		}
	});
}
