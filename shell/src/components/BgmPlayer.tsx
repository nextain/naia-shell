import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listNaiaAssets, toLocalBlobUrl } from "../lib/adk-store";
import { t } from "../lib/i18n";
import { emitAiInterferenceEvent } from "../lib/ai-interference";
import { loadConfig, saveConfig } from "../lib/config";
import { Logger } from "../lib/logger";
import type { NaiaContextBridge } from "../lib/panel-registry";
import { type BackgroundMediaType, useAvatarStore } from "../stores/avatar";

// ── YouTube server ────────────────────────────────────────────────────────────

const YT_BASE = "http://localhost:18791";

interface YtVideo {
	id: string;
	title: string;
	thumbnail: string;
	duration: string;
	channel: string;
}

async function ytSearch(query: string): Promise<YtVideo[]> {
	const res = await fetch(
		`${YT_BASE}/yt/search?q=${encodeURIComponent(query)}&max=12`,
	);
	if (!res.ok) {
		const body = await res.json().catch(() => ({})) as { error?: string };
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}
	const data = (await res.json()) as { results?: YtVideo[] };
	return data.results ?? [];
}

// ── Curated categories ────────────────────────────────────────────────────────

const CATEGORIES = [
	{ id: "lofi", labelKey: "bgm.cat.lofi", query: "lofi hip hop beats to study relax" },
	{ id: "rain", labelKey: "bgm.cat.rain", query: "rain sounds sleep study white noise 1 hour" },
	{ id: "ghibli", labelKey: "bgm.cat.ghibli", query: "studio ghibli piano collection bgm" },
	{ id: "jazz", labelKey: "bgm.cat.jazz", query: "jazz cafe background music lounge" },
	{ id: "classical", labelKey: "bgm.cat.classical", query: "classical music background study concentration" },
	{ id: "nature", labelKey: "bgm.cat.nature", query: "nature sounds forest birds water relaxing" },
	{ id: "ambient", labelKey: "bgm.cat.ambient", query: "ambient atmospheric background music drone" },
	{ id: "synthwave", labelKey: "bgm.cat.synthwave", query: "synthwave retrowave 80s neon background" },
	{ id: "bossa", labelKey: "bgm.cat.bossa", query: "bossa nova jazz cafe morning music" },
	{ id: "piano", labelKey: "bgm.cat.piano", query: "solo piano relaxing music sleep background" },
	{ id: "meditation", labelKey: "bgm.cat.meditation", query: "meditation healing music binaural beats deep" },
	{ id: "celtic", labelKey: "bgm.cat.celtic", query: "celtic fantasy ambient rpg isekai music" },
	{ id: "darkacademia", labelKey: "bgm.cat.darkacademia", query: "dark academia background music study aesthetic" },
	{ id: "kdrama", labelKey: "bgm.cat.kdrama", query: "korean drama ost background music piano" },
	{ id: "new-age", labelKey: "bgm.cat.newage", query: "new age relaxing music 1 hour" },
	{ id: "jpop", labelKey: "bgm.cat.jpop", query: "japanese city pop bgm 1 hour aesthetic" },
] as const;

// ── Favorites ─────────────────────────────────────────────────────────────────

const FAV_KEY = "yt-bgm-favorites";

function loadFavs(): YtVideo[] {
	try {
		return JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]") as YtVideo[];
	} catch {
		return [];
	}
}

function saveFavs(favs: YtVideo[]) {
	try {
		localStorage.setItem(FAV_KEY, JSON.stringify(favs));
	} catch {}
}

// ── Panel height ──────────────────────────────────────────────────────────────

interface Props {
	naia?: NaiaContextBridge;
}

type Source = "local" | "youtube";
type PanelTab = "youtube" | "local";
type YtView = "categories" | "search" | "favorites";

const YT_PANEL_H_KEY = "yt-panel-height";
const YT_PANEL_H_DEFAULT = 360;
const YT_PANEL_H_MIN = 200;
const YT_PANEL_H_MAX = 700;
// Marquee kicks in when track label exceeds this character count
const MARQUEE_THRESHOLD = 22;

function loadPanelHeight(): number {
	const v = parseInt(localStorage.getItem(YT_PANEL_H_KEY) ?? "", 10);
	return Number.isFinite(v) ? Math.max(YT_PANEL_H_MIN, Math.min(YT_PANEL_H_MAX, v)) : YT_PANEL_H_DEFAULT;
}

export function BgmPlayer({ naia }: Props) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const playerRef = useRef<HTMLDivElement>(null);
	const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);
	const [ytPanelHeight, setYtPanelHeight] = useState(loadPanelHeight);
	const handleDragRef = useRef<{ startY: number; startH: number; moved: boolean } | null>(null);

	// ── Local BGM ─────────────────────────────────────────────────────────────
	const bgmTrackUrl = useAvatarStore((s) => s.bgmTrackUrl);
	const setBgmTrackUrl = useAvatarStore((s) => s.setBgmTrackUrl);
	const setBackgroundVideoUrl = useAvatarStore((s) => s.setBackgroundVideoUrl);
	const setBackgroundMediaType = useAvatarStore((s) => s.setBackgroundMediaType);
	const prevBgVideoRef = useRef<string>("");
	const prevBgMediaRef = useRef<BackgroundMediaType>("");
	const [localTracks, setLocalTracks] = useState<string[]>([]);
	const [localNames, setLocalNames] = useState<string[]>([]);
	const [localIndex, setLocalIndex] = useState(0);

	useEffect(() => {
		listNaiaAssets("bgm-musics").then(async (paths) => {
			const urls = await Promise.all(paths.map(toLocalBlobUrl));
			const names = paths.map(
				(p) => p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? p,
			);
			setLocalTracks(urls);
			setLocalNames(names);
			if (urls.length > 0 && !bgmTrackUrl) setBgmTrackUrl(urls[0]);
		});
	}, [bgmTrackUrl, setBgmTrackUrl]);

	// ── Playback state (restored from persisted config) ───────────────────────
	const [source, setSource] = useState<Source>(() => (loadConfig()?.bgmSource as Source | undefined) ?? "youtube");
	const [playing, setPlaying] = useState(false); // never auto-play on restore
	const [volume, setVolume] = useState(() => loadConfig()?.bgmVolume ?? 0.3);

	// ── Unified panel state ───────────────────────────────────────────────────
	// panelExpanded: the single panel is open or closed
	// panelTab: which tab is currently shown in the panel (independent of what's playing)
	const [panelExpanded, setPanelExpanded] = useState(false);
	const [panelTab, setPanelTab] = useState<PanelTab>("youtube");

	// ── YouTube state ─────────────────────────────────────────────────────────
	const [ytView, setYtView] = useState<YtView>("categories");
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<YtVideo[]>([]);
	const [searching, setSearching] = useState(false);
	const [ytLoading, setYtLoading] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [favs, setFavs] = useState<YtVideo[]>(loadFavs);
	const [currentYt, setCurrentYt] = useState<YtVideo | null>(() => {
		const cfg = loadConfig();
		if (cfg?.bgmYoutubeVideoId) {
			return {
				id: cfg.bgmYoutubeVideoId,
				title: cfg.bgmYoutubeTitle ?? "",
				channel: cfg.bgmYoutubeChannel ?? "",
				thumbnail: cfg.bgmYoutubeThumbnail ?? "",
				duration: "",
			};
		}
		return null;
	});
	// Keep last YT track so returning to YT mode can show it
	const lastYtRef = useRef<YtVideo | null>(currentYt);

	// ── Volume ref (stale-closure-safe for message listener) ─────────────────
	const volumeRef = useRef(volume);
	useEffect(() => { volumeRef.current = volume; }, [volume]);

	// ── YouTube IFrame API bridge ──────────────────────────────────────────────
	// YouTube sends `initialDelivery` when the player finishes loading.
	// We must reply with `{event:"listening"}` to activate the command bridge,
	// then immediately sync the current volume. Without this handshake
	// `setVolume` postMessages are silently ignored by the player.
	useEffect(() => {
		function onYtMessage(e: MessageEvent) {
			if (!e.data || typeof e.data !== "string") return;
			try {
				const msg = JSON.parse(e.data) as Record<string, unknown>;
				if (msg.event === "initialDelivery" || msg.event === "onReady") {
					const iframe = document.querySelector(".app-bg-iframe") as HTMLIFrameElement | null;
					if (!iframe?.contentWindow) return;
					iframe.contentWindow.postMessage(JSON.stringify({ event: "listening" }), "*");
					iframe.contentWindow.postMessage(
						JSON.stringify({ event: "command", func: "setVolume", args: [Math.round(volumeRef.current * 100)] }),
						"*",
					);
				}
			} catch {}
		}
		window.addEventListener("message", onYtMessage);
		return () => window.removeEventListener("message", onYtMessage);
	}, []);

	// ── Volume sync ───────────────────────────────────────────────────────────
	useEffect(() => {
		const audio = audioRef.current;
		if (audio) audio.volume = volume;
		if (source === "youtube") {
			const iframe = document.querySelector(".app-bg-iframe") as HTMLIFrameElement | null;
			if (iframe?.contentWindow) {
				// Re-send listening before each command in case bridge was reset
				iframe.contentWindow.postMessage(JSON.stringify({ event: "listening" }), "*");
				iframe.contentWindow.postMessage(
					JSON.stringify({ event: "command", func: "setVolume", args: [Math.round(volume * 100)] }),
					"*",
				);
			}
		}
	}, [volume, source]);

	// ── Local track sync ──────────────────────────────────────────────────────
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio || source !== "local" || !bgmTrackUrl) return;
		const idx = localTracks.indexOf(bgmTrackUrl);
		if (idx >= 0) setLocalIndex(idx);
		if (audio.src !== bgmTrackUrl) {
			audio.src = bgmTrackUrl;
			if (playing) audio.play().catch(() => {});
		}
	}, [bgmTrackUrl, localTracks, playing, source]);

	// ── AI command listener ───────────────────────────────────────────────────
	// Expose currentYt + favs via ref so the listener (created once) can see latest values
	const currentYtRef = useRef<YtVideo | null>(null);
	const favsRef = useRef<YtVideo[]>([]);
	useEffect(() => { currentYtRef.current = currentYt; }, [currentYt]);
	useEffect(() => { favsRef.current = favs; }, [favs]);

	useEffect(() => {
		const unlistenP = listen<string>("agent_response", (e) => {
			try {
				const msg = JSON.parse(e.payload) as Record<string, unknown>;
				if (msg.type === "bgm_youtube_play") {
					const video: YtVideo = {
						id: String(msg.videoId ?? ""),
						title: String(msg.title ?? ""),
						thumbnail: String(msg.thumbnail ?? ""),
						duration: "",
						channel: "",
					};
					handleYtSelect(video);
				} else if (msg.type === "bgm_youtube_stop") {
					audioRef.current?.pause();
					setPlaying(false);
					if (useAvatarStore.getState().backgroundMediaType === "iframe") {
						setBackgroundVideoUrl(prevBgVideoRef.current);
						setBackgroundMediaType(prevBgMediaRef.current);
					}
					prevBgVideoRef.current = "";
					prevBgMediaRef.current = "";
				} else if (msg.type === "bgm_youtube_fav_add") {
					// Add currently playing YT track to favorites (or explicit videoId)
					const cur = currentYtRef.current;
					if (!cur) return;
					setFavs((prev) => {
						if (prev.some((f) => f.id === cur.id)) return prev; // already added
						const next = [cur, ...prev].slice(0, 50);
						saveFavs(next);
						return next;
					});
				} else if (msg.type === "bgm_youtube_fav_remove") {
					const cur = currentYtRef.current;
					if (!cur) return;
					setFavs((prev) => {
						const next = prev.filter((f) => f.id !== cur.id);
						saveFavs(next);
						return next;
					});
				} else if (msg.type === "bgm_youtube_pause") {
					const iframe = document.querySelector(".app-bg-iframe") as HTMLIFrameElement | null;
					iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "pauseVideo", args: [] }), "*");
					setPlaying(false);
				} else if (msg.type === "bgm_youtube_resume") {
					const iframe = document.querySelector(".app-bg-iframe") as HTMLIFrameElement | null;
					if (!iframe && currentYtRef.current) {
						handleYtSelect(currentYtRef.current);
					} else {
						iframe?.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "playVideo", args: [] }), "*");
						setPlaying(true);
					}
				} else if (msg.type === "bgm_youtube_next") {
					const curFavs = favsRef.current;
					const curYt = currentYtRef.current;
					if (curFavs.length > 0) {
						const curIdx = curYt ? curFavs.findIndex((f) => f.id === curYt.id) : -1;
						handleYtSelect(curFavs[(curIdx + 1) % curFavs.length]);
					}
				} else if (msg.type === "bgm_youtube_prev") {
					const curFavs = favsRef.current;
					const curYt = currentYtRef.current;
					if (curFavs.length > 0) {
						const curIdx = curYt ? curFavs.findIndex((f) => f.id === curYt.id) : 0;
						handleYtSelect(curFavs[(curIdx - 1 + curFavs.length) % curFavs.length]);
					}
				} else if (msg.type === "bgm_youtube_volume") {
					const val = Number(msg.volume ?? 0.5);
					if (val >= 0 && val <= 1) setVolume(val);
				}
			} catch (err) {
				Logger.error("BgmPlayer", "agent_response parse error", { error: String(err) });
			}
		});
		return () => { unlistenP.then((u) => u()); };
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── Panel anchor position ─────────────────────────────────────────────────
	// panelPos is always calculated so the portal stays in DOM for CSS animation.
	useEffect(() => {
		if (!playerRef.current) { setPanelPos(null); return; }
		const rect = playerRef.current.getBoundingClientRect();
		const PANEL_W = Math.min(320, window.innerWidth - 16);
		// Right-align panel to player's right edge, clamp so it doesn't overflow screen
		const safeLeft = Math.max(8, Math.min(rect.right - PANEL_W, window.innerWidth - PANEL_W - 8));
		setPanelPos({ top: rect.bottom + 4, left: safeLeft });
	}, [panelExpanded, ytPanelHeight]);

	// ── BGM state persistence ─────────────────────────────────────────────────
	useEffect(() => {
		const cfg = loadConfig();
		if (!cfg) return;
		saveConfig({ ...cfg, bgmVolume: volume });
	}, [volume]);

	useEffect(() => {
		const cfg = loadConfig();
		if (!cfg) return;
		saveConfig({ ...cfg, bgmPlaying: playing });
	}, [playing]);

	useEffect(() => {
		const cfg = loadConfig();
		if (!cfg) return;
		const ytFields = source === "youtube" && currentYt
			? { bgmYoutubeVideoId: currentYt.id, bgmYoutubeTitle: currentYt.title, bgmYoutubeChannel: currentYt.channel, bgmYoutubeThumbnail: currentYt.thumbnail }
			: {};
		saveConfig({ ...cfg, bgmSource: source, ...ytFields });
	}, [source, currentYt]);

	// ── Auto-restore YouTube playback on mount ────────────────────────────────
	// If the app was closed while YouTube was playing, resume automatically.
	useEffect(() => {
		const cfg = loadConfig();
		if (!cfg?.bgmYoutubeVideoId || !cfg.bgmPlaying || !currentYt) return;
		// Resume via the direct-stream path (not the iframe embed — see handleYtSelect).
		handleYtSelect(currentYt);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── AI context push ───────────────────────────────────────────────────────
	// Provide full BGM state so Naia can control all player features via agent_response events.
	// Supported commands: bgm_youtube_play, bgm_youtube_stop, bgm_youtube_fav_add, bgm_youtube_fav_remove
	useEffect(() => {
		if (!naia) return;
		naia.pushContext({
			type: "bgm",
			data: {
				source,
				playing,
				volume,
				// YouTube info
				currentVideoId: currentYt?.id ?? null,
				currentTitle:
					source === "youtube"
						? (currentYt?.title ?? null)
						: (localNames[localIndex] ?? null),
				currentChannel: currentYt?.channel ?? null,
				isCurrentFavorited: currentYt ? favs.some((f) => f.id === currentYt.id) : false,
				favoritesCount: favs.length,
				favoritesList: favs.slice(0, 10).map((f) => ({ id: f.id, title: f.title })),
				// Local info
				localTrackCount: localTracks.length,
				localTrackIndex: localIndex,
				// Available commands for AI:
				// bgm_youtube_play  { videoId, title } — play a specific video
				// bgm_youtube_stop  — stop playback
				// bgm_youtube_fav_add    — add current track to favorites
				// bgm_youtube_fav_remove — remove current track from favorites
			},
		});
	}, [naia, source, playing, volume, currentYt, favs, localNames, localIndex, localTracks.length]);

	// ── Playback helpers ──────────────────────────────────────────────────────

	// Warm the server-side stream cache on hover so clicking a track starts fast.
	const prefetchedRef = useRef<Set<string>>(new Set());
	function prefetchYt(id: string) {
		if (!id || prefetchedRef.current.has(id)) return;
		prefetchedRef.current.add(id);
		fetch(`${YT_BASE}/yt/stream?id=${encodeURIComponent(id)}`).catch(() => {
			prefetchedRef.current.delete(id);
		});
	}

	async function handleYtSelect(video: YtVideo) {
		audioRef.current?.pause();
		setCurrentYt(video);
		lastYtRef.current = video;
		setSource("youtube");
		emitAiInterferenceEvent({
			source: "bgm",
			action: "music_changed",
			summary: `BGM: YouTube "${video.title}" (${video.channel}) 재생 시작`,
		});

		if (!prevBgVideoRef.current && prevBgMediaRef.current === "") {
			const { backgroundVideoUrl: curUrl, backgroundMediaType: curType } = useAvatarStore.getState();
			if (curType !== "iframe" && curType !== "video") {
				prevBgVideoRef.current = curUrl;
				prevBgMediaRef.current = curType;
			}
		}

		// Play via the local InnerTube server's direct stream URL (audio/webm =
		// Opus/Vorbis), which WebKitGTK decodes natively. The youtube-nocookie
		// iframe embed fails on WebKitGTK with "video player configuration error"
		// (153) — it needs YouTube's full player. Direct stream is the pre-regression
		// path (#262, regressed by the iframe switch in #303 / aa3fe947).
		setYtLoading(true);
		try {
			const res = await fetch(`${YT_BASE}/yt/stream?id=${encodeURIComponent(video.id)}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { url: string; videoUrl?: string };
			const audio = audioRef.current;
			if (audio) {
				audio.src = data.url;
				audio.volume = volumeRef.current;
				audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
			}
			// Restore the YouTube visual: play the VP9/webm video-only stream as the
			// background. WebKitGTK decodes VP9 natively (H.264 would show a broken
			// frame). Capped at 480p server-side to keep bandwidth modest. (#262)
			if (data.videoUrl) {
				setBackgroundVideoUrl(data.videoUrl);
				setBackgroundMediaType("video");
			}
		} catch (err) {
			Logger.warn("BgmPlayer", "yt stream failed", { error: String(err) });
			setPlaying(false);
		} finally {
			setYtLoading(false);
		}
	}

	function togglePlay() {
		if (source === "youtube") {
			const audio = audioRef.current;
			if (playing) {
				audio?.pause();
				setPlaying(false);
			} else if (audio?.src) {
				audio.play().then(() => setPlaying(true)).catch(() => {});
			} else if (currentYt) {
				// No stream loaded yet (e.g. restored from config) — fetch & play
				handleYtSelect(currentYt);
			}
			return;
		}
		const audio = audioRef.current;
		if (!audio) return;
		if (playing) {
			audio.pause();
			setPlaying(false);
		} else {
			if (localTracks.length > 0 && !audio.src) {
				audio.src = localTracks[localIndex];
			}
			audio.play().then(() => setPlaying(true)).catch(() => {});
		}
	}

	function playLocalAt(idx: number) {
		if (localTracks.length === 0) return;
		setSource("local");
		setBgmTrackUrl(localTracks[idx]);
		setLocalIndex(idx);
		// Restore YT background when switching to local
		if (useAvatarStore.getState().backgroundMediaType === "iframe") {
			setBackgroundVideoUrl(prevBgVideoRef.current);
			setBackgroundMediaType(prevBgMediaRef.current);
			prevBgVideoRef.current = "";
			prevBgMediaRef.current = "";
		}
		emitAiInterferenceEvent({
			source: "bgm",
			action: "music_changed",
			summary: `BGM: ${t("bgm.localBgm")} "${localNames[idx]}"`,
		});
		const audio = audioRef.current;
		if (!audio) return;
		audio.src = localTracks[idx];
		audio.play().then(() => setPlaying(true)).catch(() => {});
	}

	function playNext() {
		if (source === "local") {
			playLocalAt((localIndex + 1) % Math.max(localTracks.length, 1));
		} else if (source === "youtube" && favs.length > 0) {
			// YouTube: cycle through favorites
			const curIdx = currentYt ? favs.findIndex((f) => f.id === currentYt.id) : -1;
			const nextIdx = (curIdx + 1) % favs.length;
			handleYtSelect(favs[nextIdx]);
		}
	}

	function playPrev() {
		if (source === "local") {
			playLocalAt((localIndex - 1 + Math.max(localTracks.length, 1)) % Math.max(localTracks.length, 1));
		} else if (source === "youtube" && favs.length > 0) {
			// YouTube: cycle through favorites in reverse
			const curIdx = currentYt ? favs.findIndex((f) => f.id === currentYt.id) : 0;
			const prevIdx = (curIdx - 1 + favs.length) % favs.length;
			handleYtSelect(favs[prevIdx]);
		}
	}

	// ── Search ────────────────────────────────────────────────────────────────

	async function doSearch(q: string) {
		if (!q.trim()) return;
		setSearching(true);
		setSearchError(null);
		setYtView("search");
		try {
			const results = await ytSearch(q);
			setSearchResults(results);
		} catch (err) {
			const msg = String(err);
			const lower = msg.toLowerCase();
			Logger.warn("BgmPlayer", "yt search unavailable", { error: msg });
			// Connection refused / WebKit "Load failed" → local agent helper not reachable
			if (
				lower.includes("failed to fetch") ||
				lower.includes("load failed") ||
				lower.includes("econnrefused") ||
				lower.includes("fetch")
			) {
				setSearchError("에이전트 서버에 연결할 수 없습니다 (127.0.0.1:18791). 앱을 재시작해 보세요.");
			} else {
				setSearchError(`검색 오류: ${msg}`);
			}
		} finally {
			setSearching(false);
		}
	}

	async function loadCategory(query: string) {
		setSearchQuery(query);
		await doSearch(query);
	}

	// ── Favorites ─────────────────────────────────────────────────────────────

	function isFav(id: string) { return favs.some((f) => f.id === id); }

	function toggleFav(video: YtVideo) {
		setFavs((prev) => {
			const next = isFav(video.id)
				? prev.filter((f) => f.id !== video.id)
				: [video, ...prev].slice(0, 50);
			saveFavs(next);
			return next;
		});
	}

	// ── Track name display ────────────────────────────────────────────────────

	const trackLabel = ytLoading
		? `⏳ ${currentYt?.title ?? t("bgm.defaultYouTubeTrack")}`
		: source === "youtube"
			? (currentYt?.title ?? t("bgm.defaultYouTubeTrack"))
			: (localNames[localIndex] ?? t("bgm.localBgm"));

	// Always scroll when playing (so AI-triggered tracks with short titles also marquee)
	const isScrolling = playing || trackLabel.length > MARQUEE_THRESHOLD;

	// ── Render ────────────────────────────────────────────────────────────────

	return (
		<div className="bgm-player" ref={playerRef}>
			<audio
				ref={audioRef}
				loop={source === "local" && localTracks.length <= 1}
				onEnded={playNext}
				onError={() => setPlaying(false)}
			>
				<track kind="captions" />
			</audio>

			{/* ── Compact bar ── */}
			<div className="bgm-player-controls">
				{/* Fixed BGM icon — pulses when playing */}
				<span
					className={`bgm-icon${playing ? " bgm-icon--playing" : ""}`}
					title={t("bgm.panelToggleTitle")}
					onClick={() => setPanelExpanded((v) => !v)}
				>♫</span>

				<div className="bgm-player-sep" />

				<button type="button" className="bgm-btn" onClick={playPrev} title={t("bgm.prev")}>‹</button>
				<button
					type="button"
					className="bgm-btn bgm-btn--play"
					onClick={togglePlay}
					title={playing ? t("bgm.pause") : t("bgm.play")}
				>
					{playing ? "Ⅱ" : "▶"}
				</button>
				<button type="button" className="bgm-btn" onClick={playNext} title={t("bgm.next")}>›</button>

				{/* Track name — fixed width, marquee when long, click to toggle panel */}
				<button
					type="button"
					className={`bgm-track-name bgm-track-toggle${panelExpanded ? " bgm-track-name--open" : ""}`}
					title={panelExpanded ? t("bgm.close") : t("bgm.panelToggleTitle")}
					onClick={() => setPanelExpanded((v) => !v)}
				>
					{isScrolling ? (
						<span className="bgm-track-name__scroll">
							<span>{trackLabel}&nbsp;&nbsp;&nbsp;&nbsp;</span>
							<span>{trackLabel}&nbsp;&nbsp;&nbsp;&nbsp;</span>
						</span>
					) : (
						trackLabel
					)}
				</button>

				<input
					type="range"
					className="bgm-volume"
					min={0}
					max={1}
					step={0.05}
					value={volume}
					onChange={(e) => setVolume(Number(e.target.value))}
					title={t("bgm.volume")}
				/>
			</div>

			{/* ── Unified BGM panel — always in DOM when anchor ready, hidden via CSS ── */}
			{panelPos && createPortal(
				<div
					className={`bgm-yt-panel${panelExpanded ? "" : " bgm-yt-panel--hidden"}`}
					style={{ position: "fixed", top: panelPos.top, left: panelPos.left, zIndex: 10001, height: ytPanelHeight }}
				>
					{/* Mode tab header */}
					<div className="bgm-panel-header">
						<div className="bgm-panel-tabs">
							<button
								type="button"
								className={`bgm-panel-tab${panelTab === "youtube" ? " bgm-panel-tab--active" : ""}`}
								onClick={() => setPanelTab("youtube")}
							>
								▶ YouTube
							</button>
							<button
								type="button"
								className={`bgm-panel-tab${panelTab === "local" ? " bgm-panel-tab--active" : ""}`}
								onClick={() => setPanelTab("local")}
							>
								{t("bgm.tabLocal")}
							</button>
						</div>
						<button
							type="button"
							className="bgm-panel-close"
							onClick={() => setPanelExpanded(false)}
							title={t("bgm.close")}
						>
							✕
						</button>
					</div>

					{/* ── YouTube tab ── */}
					{panelTab === "youtube" && (
						<>
							<form
								className="bgm-yt-search-row"
								onSubmit={(e) => { e.preventDefault(); doSearch(searchQuery); }}
							>
								<input
									type="text"
									className="bgm-yt-search-input"
									placeholder={t("bgm.searchPlaceholder")}
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
								/>
								<button type="submit" className="bgm-btn" disabled={searching}>
									{searching ? "…" : "🔍"}
								</button>
							</form>

							<div className="bgm-yt-tabs">
								<button
									type="button"
									className={`bgm-yt-tab${ytView === "categories" ? " bgm-yt-tab--active" : ""}`}
									onClick={() => setYtView("categories")}
								>{t("bgm.tabGenres")}
								</button>
								<button
									type="button"
									className={`bgm-yt-tab${ytView === "search" ? " bgm-yt-tab--active" : ""}`}
									onClick={() => setYtView("search")}
								>{t("bgm.tabSearch")}
								</button>
								<button
									type="button"
									className={`bgm-yt-tab${ytView === "favorites" ? " bgm-yt-tab--active" : ""}`}
									onClick={() => setYtView("favorites")}
								>
									{t("bgm.tabFavorites")} {favs.length > 0 && `(${favs.length})`}
								</button>
							</div>

							{ytView === "categories" && (
								<div className="bgm-yt-categories">
									{CATEGORIES.map((cat) => (
										<button
											key={cat.id}
											type="button"
											className="bgm-yt-cat-btn"
											onClick={() => loadCategory(cat.query)}
										>
											{t(cat.labelKey)}
										</button>
									))}
								</div>
							)}

							{ytView === "search" && (
								<div className="bgm-yt-list">
									{searching && <div className="bgm-yt-status">{t("bgm.searching")}</div>}
									{!searching && searchError && (
										<div className="bgm-yt-status bgm-yt-status--error">{searchError}</div>
									)}
									{!searching && !searchError && searchResults.length === 0 && (
										<div className="bgm-yt-status">{t("bgm.noResults")}</div>
									)}
									{searchResults.map((v) => (
										<YtTrackRow
											key={v.id}
											video={v}
											loading={false}
											playing={currentYt?.id === v.id && playing}
											fav={isFav(v.id)}
											onPlay={() => handleYtSelect(v)}
											onFav={() => toggleFav(v)}
											onHover={() => prefetchYt(v.id)}
										/>
									))}
								</div>
							)}

							{ytView === "favorites" && (
								<div className="bgm-yt-list">
									{favs.length === 0 && (
										<div className="bgm-yt-status">{t("bgm.favEmpty")}</div>
									)}
									{favs.map((v) => (
										<YtTrackRow
											key={v.id}
											video={v}
											loading={false}
											playing={currentYt?.id === v.id && playing}
											fav={true}
											onPlay={() => handleYtSelect(v)}
											onFav={() => toggleFav(v)}
											onHover={() => prefetchYt(v.id)}
										/>
									))}
								</div>
							)}
						</>
					)}

					{/* ── Local tab ── */}
					{panelTab === "local" && (
						<div className="bgm-yt-list">
							{localTracks.length === 0 && (
								<div className="bgm-yt-status">{t("bgm.noTracks")}</div>
							)}
							{localTracks.map((url, idx) => {
								const isActive = source === "local" && localIndex === idx;
								return (
									<div
										key={url}
										className={`bgm-yt-row bgm-local-row${isActive && playing ? " bgm-yt-row--playing" : ""}`}
										onClick={() => playLocalAt(idx)}
										onKeyDown={(e) => e.key === "Enter" && playLocalAt(idx)}
										role="button"
										tabIndex={0}
										title={localNames[idx]}
									>
										<div className="bgm-local-icon">
											{isActive && playing ? "▶" : "♪"}
										</div>
										<div className="bgm-yt-row-info">
											<div className="bgm-yt-row-title">{localNames[idx]}</div>
										</div>
									</div>
								);
							})}
						</div>
					)}
				{/* ── Drawer handle — inside panel so it moves as one unit, no desync ── */}
				<button
					type="button"
					className="bgm-yt-drawer-handle"
					title={t("bgm.drawerTitle")}
					onPointerDown={(e) => {
						e.currentTarget.setPointerCapture(e.pointerId);
						handleDragRef.current = { startY: e.clientY, startH: ytPanelHeight, moved: false };
					}}
					onPointerMove={(e) => {
						const ref = handleDragRef.current;
						if (!ref) return;
						const delta = e.clientY - ref.startY;
						if (!ref.moved && Math.abs(delta) > 4) ref.moved = true;
						if (ref.moved) {
							const next = Math.max(YT_PANEL_H_MIN, Math.min(YT_PANEL_H_MAX, ref.startH + delta));
							setYtPanelHeight(next);
							localStorage.setItem(YT_PANEL_H_KEY, String(next));
						}
					}}
					onPointerUp={() => {
						const ref = handleDragRef.current;
						handleDragRef.current = null;
						if (!ref?.moved) setPanelExpanded(false);
					}}
					onPointerCancel={() => { handleDragRef.current = null; }}
				>
					<span className="bgm-yt-drawer-handle__bar" />
					<span className="bgm-yt-drawer-handle__arrow">▲</span>
				</button>
				</div>,
				document.body,
			)}
		</div>
	);
}

// ── YtTrackRow ───────────────────────────────────────────────────────────────── ────────────────────────────────────────────────────────────────

interface RowProps {
	video: YtVideo;
	loading: boolean;
	playing: boolean;
	fav: boolean;
	onPlay: () => void;
	onFav: () => void;
	onHover?: () => void;
}

function YtTrackRow({ video, loading, playing, fav, onPlay, onFav, onHover }: RowProps) {
	return (
		<div
			className={`bgm-yt-row${playing ? " bgm-yt-row--playing" : ""}`}
			onClick={onPlay}
			onMouseEnter={onHover}
			onKeyDown={(e) => e.key === "Enter" && onPlay()}
			role="button"
			tabIndex={0}
			title={video.title}
		>
			{video.thumbnail && (
				<img
					className="bgm-yt-thumb"
					src={video.thumbnail}
					alt=""
					loading="lazy"
				/>
			)}
			<div className="bgm-yt-row-info">
				<div className="bgm-yt-row-title">
					{loading ? t("bgm.loading") : playing ? "▶ " + video.title : video.title}
				</div>
				<div className="bgm-yt-row-meta">
					{video.channel && <span>{video.channel}</span>}
					{video.duration && <span>{video.duration}</span>}
				</div>
			</div>
			<button
				type="button"
				className={`bgm-yt-fav-btn${fav ? " bgm-yt-fav-btn--on" : ""}`}
				title={fav ? t("bgm.favRemove") : t("bgm.favAdd")}
				onClick={(e) => { e.stopPropagation(); onFav(); }}
			>
				{fav ? "★" : "☆"}
			</button>
		</div>
	);
}
