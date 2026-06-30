/**
 * YouTube BGM 서버 — 포트 18791 의 작은 HTTP 서버.
 * InnerTube 기반 검색 + 스트림 URL 엔드포인트를 셸 BGM 플레이어(`components/BgmPlayer.tsx`)에 제공.
 * 레이어 = 환경 사이드카(SoT: docs/brain-body-environment.md). agent 독립.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { Innertube } from "youtubei.js";

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

const ALLOWED_ORIGINS = new Set([
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
	"http://localhost:1420",
]);

function cors(req: IncomingMessage, res: ServerResponse) {
	const origin = String(req.headers.origin ?? "");
	res.setHeader(
		"Access-Control-Allow-Origin",
		ALLOWED_ORIGINS.has(origin) ? origin : "tauri://localhost",
	);
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

// YouTube video ID: 11 chars, base64url charset (1-20 for safety)
const YT_ID_RE = /^[A-Za-z0-9_-]{1,20}$/;

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleSearch(req: IncomingMessage, res: ServerResponse, params: URLSearchParams) {
	const q = params.get("q")?.trim() ?? "";
	if (!q) { json(req, res, 400, { error: "q required" }); return; }
	const max = Math.min(Number(params.get("max") ?? "12"), 20);

	// BGM 음악 검색은 playlist/믹스 결과를 선호(요즘 음악이 플레이리스트로 많이 올라옴)
	// → 쿼리에 "playlist" 태그 부가. 이미 들어있으면 중복 안 함.
	const searchQuery = /\bplaylist\b/i.test(q) ? q : `${q} playlist`;

	const yt = await getInnertube();
	const search = await yt.search(searchQuery, { type: "video" });

	// biome-ignore lint/suspicious/noExplicitAny: youtubei.js types vary by version
	const results = (search.videos ?? []).slice(0, max).map((v: any) => ({
		id: v.id ?? v.video_id ?? "",
		title: typeof v.title === "string" ? v.title : (v.title?.text ?? ""),
		thumbnail: v.thumbnails?.[0]?.url ?? v.thumbnail?.[0]?.url ?? "",
		duration: typeof v.duration === "string" ? v.duration : (v.duration?.text ?? ""),
		channel: v.author?.name ?? v.channel?.name ?? "",
	}));

	json(req, res, 200, { results });
}

async function handleStream(req: IncomingMessage, res: ServerResponse, params: URLSearchParams) {
	const id = params.get("id")?.trim() ?? "";
	if (!id || !YT_ID_RE.test(id)) { json(req, res, 400, { error: "invalid video id" }); return; }

	const yt = await getInnertube();

	// TV_EMBEDDED client ("TVHTML5_SIMPLY_EMBEDDED_PLAYER") bypasses PoToken requirement
	// and returns direct stream URLs for most public videos.
	// Falls back to WEB if TV_EMBEDDED has no audio formats.
	// biome-ignore lint/suspicious/noExplicitAny: youtubei.js types vary by version
	let info: any;
	// biome-ignore lint/suspicious/noExplicitAny: youtubei.js types vary by version
	let format: any;
	let url: string | undefined;

	for (const client of ["TV_EMBEDDED", "WEB"] as const) {
		try {
			info = await (yt as any).getBasicInfo(id, client);
		} catch (e) {
			process.stderr.write(`[youtube-server] getBasicInfo(${client}) error: ${e}\n`);
			continue;
		}
		try {
			// format:'any' avoids the default mp4-only filter (audio/webm would be excluded otherwise)
			format = info.chooseFormat({ type: "audio", quality: "best", format: "any" });
		} catch (e) {
			process.stderr.write(`[youtube-server] chooseFormat(${client}) error: ${e}\n`);
			format = undefined;
		}
		if (!format) continue;

		url = format.url;
		if (!url && typeof format.decipher === "function") {
			try { url = await format.decipher(yt.session?.player); } catch (e) {
				process.stderr.write(`[youtube-server] decipher(${client}) error: ${e}\n`);
			}
		}
		if (url) break;
		process.stderr.write(`[youtube-server] no URL for client=${client}, trying next\n`);
		format = undefined;
	}

	if (!format) { json(req, res, 404, { error: "no audio format found" }); return; }
	if (!url) { json(req, res, 404, { error: "could not resolve stream URL" }); return; }

	// Try to get a video-only stream URL for background display (low quality, optional)
	let videoUrl: string | undefined;
	try {
		// biome-ignore lint/suspicious/noExplicitAny: youtubei.js types vary by version
		const videoFormat: any = info.chooseFormat({ type: "video", quality: "360p" });
		if (videoFormat?.url) videoUrl = videoFormat.url;
	} catch {
		// video format is optional — audio-only is sufficient
	}

	json(req, res, 200, {
		url,
		mime: format.mime_type ?? "audio/webm",
		title: typeof info.basic_info?.title === "string" ? info.basic_info.title : "",
		duration: info.basic_info?.duration ?? 0,
		...(videoUrl ? { videoUrl } : {}),
	});
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
	res.setHeader(
		"Access-Control-Allow-Origin",
		ALLOWED_ORIGINS.has(origin) ? origin : "tauri://localhost",
	);
	res.setHeader("Vary", "Origin");
	res.setHeader("Content-Type", "audio/mpeg");
	res.writeHead(200);
	res.end(Buffer.concat(chunks));
}

export function startYoutubeServer(): void {
	// Pre-warm Innertube in the background
	getInnertube().catch(() => {});

	const server = createServer(async (req, res) => {
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
			} else if (url.pathname === "/yt/stream") {
				await handleStream(req, res, url.searchParams);
			} else if (url.pathname === "/edge-tts") {
				await handleEdgeTts(req, res, url.searchParams);
			} else if (url.pathname === "/health") {
				// Readiness probe — used by Rust spawn_youtube_bgm_server (#335)
				// to confirm the server is actually listening (catches EADDRINUSE
				// or other startup failures that the spawn handle can't see).
				json(req, res, 200, { ok: true });
			} else {
				json(req, res, 404, { error: "not found" });
			}
		} catch (err) {
			// Only reset singleton if Innertube itself failed (not downstream API errors).
			// getInnertube() already clears _ytInit on init failure via its .catch handler.
			process.stderr.write(`[youtube-server] request error: ${err}\n`);
			json(req, res, 500, { error: "internal server error" });
		}
	});

	// Listen on all interfaces (no host arg) so both 127.0.0.1 and ::1 are covered.
	// On macOS, `localhost` resolves to ::1 (IPv6) by default; binding only to
	// 127.0.0.1 would make the server unreachable from the Tauri webview.
	server.listen(YT_SERVER_PORT, () => {
		process.stderr.write(`[youtube-server] listening on port ${YT_SERVER_PORT}\n`);
	});

	server.on("error", (err: NodeJS.ErrnoException) => {
		process.stderr.write(`[youtube-server] error: ${err}\n`);
		if (err.code === "EADDRINUSE") {
			// Port already in use (stale agent from previous session).
			// The shell kills the old agent on startup; retry after a short delay.
			setTimeout(() => {
				server.close();
				server.listen(YT_SERVER_PORT, () => {
					process.stderr.write(`[youtube-server] retry OK on port ${YT_SERVER_PORT}\n`);
				});
			}, 1000);
		}
	});
}
