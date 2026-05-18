import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listNaiaAssets, toLocalBlobUrl } from "../lib/adk-store";
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

// Ordered by YouTube BGM popularity
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

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
	naia?: NaiaContextBridge;
}

type Source = "local" | "youtube";
type YtView = "categories" | "search" | "favorites";

export function BgmPlayer({ naia }: Props) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const playerRef = useRef<HTMLDivElement>(null);
	const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(null);

	// ── Local BGM ─────────────────────────────────────────────────────────────
	const bgmTrackUrl = useAvatarStore((s) => s.bgmTrackUrl);
	const setBgmTrackUrl = useAvatarStore((s) => s.setBgmTrackUrl);
	const setBackgroundVideoUrl = useAvatarStore((s) => s.setBackgroundVideoUrl);
	const setBackgroundMediaType = useAvatarStore((s) => s.setBackgroundMediaType);
	// Saved background before YouTube takes over — restored when BGM stops
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
	const [source, setSource] = useState<Source>("local");
	const [playing, setPlaying] = useState(false);
	const [volume, setVolume] = useState(0.3);

	// ── YouTube state ─────────────────────────────────────────────────────────
	const [ytExpanded, setYtExpanded] = useState(false);
	const [ytView, setYtView] = useState<YtView>("categories");
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<YtVideo[]>([]);
	const [searching, setSearching] = useState(false);
	const [favs, setFavs] = useState<YtVideo[]>(loadFavs);
	const [currentYt, setCurrentYt] = useState<YtVideo | null>(null);

	// ── Volume sync ───────────────────────────────────────────────────────────
	useEffect(() => {
		const audio = audioRef.current;
		if (audio) audio.volume = volume;
		// Also propagate volume to YouTube iframe if active
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

	// ── AI command listener (bgm_youtube_play / bgm_youtube_stop) ────────────
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
					// Restore previous background — only if YouTube actually took over
					// (a video was selected → backgroundMediaType became "iframe").
					// Without this guard, opening the YouTube panel and closing it
					// without selecting a video would erase the existing background.
					if (useAvatarStore.getState().backgroundMediaType === "iframe") {
						setBackgroundVideoUrl(prevBgVideoRef.current);
						setBackgroundMediaType(prevBgMediaRef.current);
					}
					prevBgVideoRef.current = "";
					prevBgMediaRef.current = "";
				}
			} catch (err) {
				Logger.error("BgmPlayer", "agent_response parse error", { error: String(err) });
			}
		});
		return () => { unlistenP.then((u) => u()); };
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── Hide quick-toggles when YouTube panel is open ─────────────────────────
	// ── Panel anchor position (portal positioning) ────────────────────────────
	useEffect(() => {
		if (source === "youtube" && ytExpanded && playerRef.current) {
			const rect = playerRef.current.getBoundingClientRect();
			setPanelPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
		} else {
			setPanelPos(null);
		}
	}, [source, ytExpanded]);

	// ── AI context push ───────────────────────────────────────────────────────
	useEffect(() => {
		if (!naia || !currentYt) return;
		naia.pushContext({
			type: "bgm",
			data: {
				source: "youtube",
				videoId: currentYt.id,
				title: currentYt.title,
				channel: currentYt.channel,
				playing,
			},
		});
	}, [naia, currentYt, playing]);

	// ── Playback helpers ──────────────────────────────────────────────────────

	function handleYtSelect(video: YtVideo) {
		// Stop local audio and switch to YouTube iframe playback
		audioRef.current?.pause();
		setCurrentYt(video);
		setSource("youtube");
		setPlaying(true);

		// Save current background — read store directly to avoid stale closure
		if (!prevBgVideoRef.current && prevBgMediaRef.current === "") {
			const { backgroundVideoUrl: curUrl, backgroundMediaType: curType } = useAvatarStore.getState();
			if (curType !== "iframe") {
				prevBgVideoRef.current = curUrl;
				prevBgMediaRef.current = curType;
			}
		}
		const embedUrl =
			`https://www.youtube-nocookie.com/embed/${video.id}` +
			"?autoplay=1&enablejsapi=1&controls=0" +
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
		setCurrentYt(null);
		setBgmTrackUrl(localTracks[idx]);
		setLocalIndex(idx);
		const audio = audioRef.current;
		if (!audio) return;
		audio.src = localTracks[idx];
		if (playing) audio.play().catch(() => {});
	}

	function playNext() {
		if (source === "local") {
			playLocalAt((localIndex + 1) % Math.max(localTracks.length, 1));
		}
		// YouTube: no auto-next for now
	}

	function playPrev() {
		if (source === "local") {
			playLocalAt((localIndex - 1 + Math.max(localTracks.length, 1)) % Math.max(localTracks.length, 1));
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
			? (currentYt?.title ?? "YouTube BGM")
			: (localNames[localIndex] ?? "");


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
				<button type="button" className="bgm-btn" onClick={playPrev} title="이전">‹</button>
				<button
					type="button"
					className="bgm-btn bgm-btn--play"
					onClick={togglePlay}
					title={playing ? "일시정지" : "재생"}
				>
					{playing ? "Ⅱ" : "▶"}
				</button>
				<button type="button" className="bgm-btn" onClick={playNext} title="다음">›</button>

				<div className="bgm-player-sep" />

				{/* Source toggle */}
				<button
					type="button"
					className={`bgm-btn bgm-source-btn${source === "youtube" ? " bgm-source-btn--yt" : ""}`}
					title="로컬 / YouTube 전환"
					onClick={() => {
						if (source === "local") {
							setSource("youtube");
							setYtExpanded(true);
						} else {
							audioRef.current?.pause();
							setPlaying(false);
							setSource("local");
							setYtExpanded(false);
							setCurrentYt(null);
							// Restore previous background only if YouTube actually took over
							if (useAvatarStore.getState().backgroundMediaType === "iframe") {
								setBackgroundVideoUrl(prevBgVideoRef.current);
								setBackgroundMediaType(prevBgMediaRef.current);
							}
							prevBgVideoRef.current = "";
							prevBgMediaRef.current = "";
						}
					}}
				>
					{source === "youtube" ? "▶ YT" : "🎵"}
				</button>

				<span className="bgm-track-name" title={trackLabel}>
					{trackLabel || "BGM"}
				</span>

				{source === "youtube" && (
					<button
						type="button"
						className={`bgm-btn${ytExpanded ? " bgm-btn--active" : ""}`}
						title={ytExpanded ? "접기" : "YouTube 검색"}
						onClick={() => setYtExpanded((v) => !v)}
					>
						{ytExpanded ? "▲" : "▼"}
					</button>
				)}

				<input
					type="range"
					className="bgm-volume"
					min={0}
					max={1}
					step={0.05}
					value={volume}
					onChange={(e) => setVolume(Number(e.target.value))}
					title="볼륨"
				/>
			</div>

			{/* ── YouTube panel (expanded) ── */}
			{source === "youtube" && ytExpanded && panelPos && createPortal(
				<div
					className="bgm-yt-panel"
					style={{ position: "fixed", top: panelPos.top, right: panelPos.right, zIndex: 10001 }}
				>
					{/* Search bar */}
					<form
						className="bgm-yt-search-row"
						onSubmit={(e) => { e.preventDefault(); doSearch(searchQuery); }}
					>
						<input
							type="text"
							className="bgm-yt-search-input"
							placeholder="YouTube 검색…"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
						/>
						<button type="submit" className="bgm-btn" disabled={searching}>
							{searching ? "…" : "🔍"}
						</button>
					</form>

					{/* View tabs */}
					<div className="bgm-yt-tabs">
						<button
							type="button"
							className={`bgm-yt-tab${ytView === "categories" ? " bgm-yt-tab--active" : ""}`}
							onClick={() => setYtView("categories")}
						>
							장르
						</button>
						<button
							type="button"
							className={`bgm-yt-tab${ytView === "search" ? " bgm-yt-tab--active" : ""}`}
							onClick={() => setYtView("search")}
						>
							검색결과
						</button>
						<button
							type="button"
							className={`bgm-yt-tab${ytView === "favorites" ? " bgm-yt-tab--active" : ""}`}
							onClick={() => setYtView("favorites")}
						>
							즐겨찾기 {favs.length > 0 && `(${favs.length})`}
						</button>
					</div>

					{/* Categories */}
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

					{/* Search results */}
					{ytView === "search" && (
						<div className="bgm-yt-list">
							{searching && <div className="bgm-yt-status">검색 중…</div>}
							{!searching && searchResults.length === 0 && (
								<div className="bgm-yt-status">결과 없음</div>
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

					{/* Favorites */}
					{ytView === "favorites" && (
						<div className="bgm-yt-list">
							{favs.length === 0 && (
								<div className="bgm-yt-status">즐겨찾기가 비어 있습니다</div>
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
				</div>,
				document.body,
			)}
		</div>
	);
}

// ── YtTrackRow ────────────────────────────────────────────────────────────────

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
					{loading ? "로딩 중…" : playing ? "▶ " + video.title : video.title}
				</div>
				<div className="bgm-yt-row-meta">
					{video.channel && <span>{video.channel}</span>}
					{video.duration && <span>{video.duration}</span>}
				</div>
			</div>
			<button
				type="button"
				className={`bgm-yt-fav-btn${fav ? " bgm-yt-fav-btn--on" : ""}`}
				title={fav ? "즐겨찾기 제거" : "즐겨찾기 추가"}
				onClick={(e) => { e.stopPropagation(); onFav(); }}
			>
				{fav ? "★" : "☆"}
			</button>
		</div>
	);
}
