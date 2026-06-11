/**
 * YouTube BGM server — tiny HTTP server on port 18791.
 * Exposes InnerTube-based search and stream URL endpoints for the shell BGM player.
 * The Innertube client is a lazy singleton shared with the youtube-bgm skill.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Innertube } from "youtubei.js";

export const YT_SERVER_PORT = 18791;

// ── yt-dlp stream extraction ──────────────────────────────────────────────────
// YouTube gates InnerTube stream URLs behind a po_token (bot detection) — its
// formats come back with no playable URL. yt-dlp extracts a direct URL reliably
// (ANDROID_VR etc. clients) and is actively maintained against YouTube changes.
// We prefer Opus/webm audio, which Flatpak WebKitGTK decodes natively (no
// proprietary AAC/H.264 codecs). Bundled at /app/bin/yt-dlp in the Flatpak. (#262)

function ytDlpPath(): string {
	if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
	for (const p of ["/app/bin/yt-dlp", "/app/bin/yt-dlp_linux"]) {
		if (existsSync(p)) return p;
	}
	return "yt-dlp";
}

interface YtAudioMeta {
	url: string;
	ext?: string;
	title?: string;
	duration?: number;
}

function ytDlpAudio(id: string): Promise<YtAudioMeta> {
	return new Promise((resolve, reject) => {
		const args = [
			"-f",
			"bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio",
			"-j",
			"--no-warnings",
			"--no-playlist",
			`https://www.youtube.com/watch?v=${id}`,
		];
		const child = spawn(ytDlpPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("yt-dlp timeout"));
		}, 25000);
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`yt-dlp exit ${code}: ${err.slice(0, 200)}`));
				return;
			}
			try {
				const j = JSON.parse(out) as { url?: string; ext?: string; title?: string; duration?: number };
				if (!j.url) {
					reject(new Error("yt-dlp: no url in output"));
					return;
				}
				resolve({ url: j.url, ext: j.ext, title: j.title, duration: j.duration });
			} catch (e) {
				reject(new Error(`yt-dlp parse error: ${e}`));
			}
		});
	});
}

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

	const yt = await getInnertube();
	const search = await yt.search(q, { type: "video" });

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

	// Resolve a direct Opus/webm audio URL via yt-dlp (see ytDlpAudio above) —
	// InnerTube can no longer return playable stream URLs (po_token wall).
	try {
		const meta = await ytDlpAudio(id);
		json(req, res, 200, {
			url: meta.url,
			mime: meta.ext === "m4a" || meta.ext === "mp4" ? "audio/mp4" : "audio/webm",
			title: meta.title ?? "",
			duration: meta.duration ?? 0,
		});
	} catch (e) {
		process.stderr.write(`[youtube-server] yt-dlp(${id}) error: ${e}\n`);
		json(req, res, 502, { error: "could not resolve stream URL" });
	}
}

// ── Server bootstrap ──────────────────────────────────────────────────────────

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
