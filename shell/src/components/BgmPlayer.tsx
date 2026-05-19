import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listNaiaAssets, toLocalBlobUrl } from "../lib/adk-store";
import { t } from "../lib/i18n";
import { emitAiInterferenceEvent } from "../lib/ai-interference";
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
	const data = (await res.json()) as { results?: YtVideo[] };
	return data.results ?? [];
}

// ── Curated categories ────────────────────────────────────────────────────────

const CATEGORIES = [
	{ id: "lofi", label: "📚 로파이", query: "lofi hip hop beats to study relax" },
	{ id: "rain", label: "🌧 빗소리", query: "rain sounds sleep study white noise 1 hour" },
	{ id: "ghibli", label: "🌿 지브리", query: "studio ghibli piano collection bgm" },
	{ id: "jazz", label: "🎷 재즈 카페", query: "jazz cafe background music lounge" },
	{ id: "classical", label: "🎻 클래식", query: "classical music background study concentration" },
	{ id: "nature", label: "🌲 자연 소리", query: "nature sounds forest birds water relaxing" },
	{ id: "ambient", label: "🌌 앰비언트", query: "ambient atmospheric background music drone" },
	{ id: "synthwave", label: "🌃 신스웨이브", query: "synthwave retrowave 80s neon background" },
	{ id: "bossa", label: "🍵 보사노바", query: "bossa nova jazz cafe morning music" },
	{ id: "piano", label: "🎹 솔로 피아노", query: "solo piano relaxing music sleep background" },
	{ id: "meditation", label: "🧘 명상", query: "meditation healing music binaural beats deep" },
	{ id: "celtic", label: "🧝 판타지/켈트", query: "celtic fantasy ambient rpg isekai music" },
	{ id: "darkacademia", label: "📖 다크 아카데미아", query: "dark academia background music study aesthetic" },
	{ id: "kdrama", label: "🎬 K-드라마 OST", query: "korean drama ost background music piano" },
	{ id: "new-age", label: "✨ 뉴에이지", query: "new age relaxing music 1 hour" },
	{ id: "jpop", label: "🌸 시티팝", query: "japanese city pop bgm 1 hour aesthetic" },
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
	const [handlePos, setHandlePos] = useState<{ top: number; left: number } | null>(null);
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

	// ── Playback state ────────────────────────────────────────────────────────
	const [source, setSource] = useState<Source>("youtube");
	const [playing, setPlaying] = useState(false);
	const [volume, setVolume] = useState(0.3);

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
	const [favs, setFavs] = useState<YtVideo[]>(loadFavs);
	const [currentYt, setCurrentYt] = useState<YtVideo | null>(null);
	// Keep last YT track so returning to YT mode can show it
	const lastYtRef = useRef<YtVideo | null>(null);

	// ── Volume sync ───────────────────────────────────────────────────────────
	useEffect(() => {
		const audio = audioRef.current;
		if (audio) audio.volume = volume;
		if (source === "youtube") {
			const iframe = document.querySelector(".app-bg-iframe") as HTMLIFrameElement | null;
			iframe?.contentWindow?.postMessage(
				JSON.stringify({ event: "command", func: "setVolume", args: [Math.round(volume * 100)] }),
				"*",
			);
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
				}
			} catch (err) {
				Logger.error("BgmPlayer", "agent_response parse error", { error: String(err) });
			}
		});
		return () => { unlistenP.then((u) => u()); };
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── Panel anchor + drawer handle position ────────────────────────────────
	// panelPos is always calculated so the portal stays in DOM for CSS animation.
	useEffect(() => {
		if (!playerRef.current) { setHandlePos(null); setPanelPos(null); return; }
		const rect = playerRef.current.getBoundingClientRect();
		const PANEL_W = Math.min(320, window.innerWidth - 16);
		const safeLeft = Math.min(rect.left, window.innerWidth - PANEL_W - 8);
		const panelTop = rect.bottom + 4;
		// Panel position always set (portal stays mounted; hidden via CSS class)
		setPanelPos({ top: panelTop, left: safeLeft });
		if (panelExpanded) {
			setHandlePos({ top: panelTop + ytPanelHeight, left: rect.left + rect.width / 2 });
		} else {
			setHandlePos({ top: rect.bottom, left: rect.left + rect.width / 2 });
		}
	}, [panelExpanded, ytPanelHeight]);

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

	function handleYtSelect(video: YtVideo) {
		audioRef.current?.pause();
		setCurrentYt(video);
		lastYtRef.current = video;
		setSource("youtube");
		setPlaying(true);
		emitAiInterferenceEvent({
			source: "bgm",
			action: "music_changed",
			summary: `BGM: YouTube "${video.title}" (${video.channel}) 재생 시작`,
		});

		if (!prevBgVideoRef.current && prevBgMediaRef.current === "") {
			const { backgroundVideoUrl: curUrl, backgroundMediaType: curType } = useAvatarStore.getState();
			if (curType !== "iframe") {
				prevBgVideoRef.current = curUrl;
				prevBgMediaRef.current = curType;
			}
		}
		const embedUrl =
			`https://www.youtube-nocookie.com/embed/${video.id}` +
			"?autoplay=1&enablejsapi=1" +
			"&origin=tauri%3A%2F%2Flocalhost";
		setBackgroundVideoUrl(embedUrl);
		setBackgroundMediaType("iframe");
	}

	function sendYtCmd(func: string) {
		const iframe = document.querySelector(".app-bg-iframe") as HTMLIFrameElement | null;
		iframe?.contentWindow?.postMessage(
			JSON.stringify({ event: "command", func, args: [] }),
			"*",
		);
	}

	function togglePlay() {
		if (source === "youtube") {
			if (playing) {
				sendYtCmd("pauseVideo");
				setPlaying(false);
			} else {
				sendYtCmd("playVideo");
				setPlaying(true);
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
			summary: `BGM: 로컬 "${localNames[idx]}" 재생`,
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
		setYtView("search");
		try {
			const results = await ytSearch(q);
			setSearchResults(results);
		} catch (err) {
			Logger.error("BgmPlayer", "yt search failed", { error: String(err) });
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

	const trackLabel =
		source === "youtube"
			? (currentYt?.title ?? t("bgm.defaultYouTubeTrack"))
			: (localNames[localIndex] ?? "로컬 BGM");

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

			{/* ── Drawer handle — drag to resize, click to toggle ── */}
			{handlePos && createPortal(
				<button
					type="button"
					className={`bgm-yt-drawer-handle${panelExpanded ? " bgm-yt-drawer-handle--open" : ""}`}
					style={{ position: "fixed", top: handlePos.top, left: handlePos.left }}
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
							if (!panelExpanded) setPanelExpanded(true);
						}
					}}
					onPointerUp={() => {
						const ref = handleDragRef.current;
						handleDragRef.current = null;
						if (!ref?.moved) setPanelExpanded((v) => !v);
					}}
					onPointerCancel={() => { handleDragRef.current = null; }}
				>
					<span className="bgm-yt-drawer-handle__bar" />
					<span className="bgm-yt-drawer-handle__arrow">
						{panelExpanded ? "▲" : "▼"}
					</span>
				</button>,
				document.body,
			)}

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
								♪ 로컬
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
											{cat.label}
										</button>
									))}
								</div>
							)}

							{ytView === "search" && (
								<div className="bgm-yt-list">
									{searching && <div className="bgm-yt-status">{t("bgm.searching")}</div>}
									{!searching && searchResults.length === 0 && (
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
}

function YtTrackRow({ video, loading, playing, fav, onPlay, onFav }: RowProps) {
	return (
		<div
			className={`bgm-yt-row${playing ? " bgm-yt-row--playing" : ""}`}
			onClick={onPlay}
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
