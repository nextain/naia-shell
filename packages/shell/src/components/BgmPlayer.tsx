import { listen } from "@tauri-apps/api/event";
import {
	diagnoseBgmObservationFailure,
	emptyBgmObservationCounters,
} from "../lib/bgm-observation-diagnosis";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listNaiaAssets, toLocalBlobUrl } from "../lib/adk-store";
import { t } from "../lib/i18n";
import { emitAiInterferenceEvent } from "../lib/ai-interference";
import { loadConfig, saveConfig } from "../lib/config";
import {
	addTrackToPlaylist,
	createPlaylist,
	loadBgmLibrary,
	movePlaylistTrack,
	nextPlaylistIndex,
	removeTrackFromPlaylist,
	toggleBgmLike,
	trackIdentity,
	type BgmLibraryState,
	type BgmLibraryTrack,
} from "../lib/bgm-library";
import {
	bgmLibraryCache,
	loadBgmLibraryFromSandbox,
	persistBgmLibrary,
} from "../lib/bgm-library-store";
import {
	bgmPlayback,
	toBgmObservedContext,
	type BgmPlaybackSnapshot,
	type BgmPlaybackStatus,
} from "../lib/bgm-playback";
import {
	cancelRadioDjRecovery,
	continueRadioDjRecoveryAfterQueueAdvance,
	getBgmRecentTracks,
	recordBgmPlayedTrack,
	recoverRadioDjPlayback,
} from "../lib/bgm-skill";
import { Logger } from "../lib/logger";
import type { NaiaContextBridge } from "../lib/app-registry";
import {
	UI_PREFERENCE_KEYS,
	patchUiPreferences,
	useUiPreference,
} from "../lib/ui-preferences";
import { type BackgroundMediaType, useAvatarStore } from "../stores/avatar";

// ── YouTube server ────────────────────────────────────────────────────────────

import { ensureBgmSidecar } from "../lib/bgm-sidecar-url";

const YT_BASE =
	import.meta.env.VITE_NAIA_BGM_BASE?.replace(/\/$/, "") ??
	"http://localhost:18791";

interface YtVideo {
	id: string;
	title: string;
	thumbnail: string;
	duration: string;
	channel: string;
}

async function ytSearch(query: string): Promise<YtVideo[]> {
	await ensureBgmSidecar();
	const res = await fetch(
		`${YT_BASE}/yt/search?q=${encodeURIComponent(query)}&max=12`,
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}
	const data = (await res.json()) as { results?: YtVideo[] };
	return data.results ?? [];
}

// ── Curated categories ────────────────────────────────────────────────────────

const CATEGORIES = [
	{
		id: "lofi",
		labelKey: "bgm.cat.lofi",
		query: "lofi hip hop beats to study relax",
	},
	{
		id: "kpop",
		labelKey: "bgm.cat.kpop",
		query: "kpop hits popular songs playlist",
	},
	{
		id: "jpop",
		labelKey: "bgm.cat.jpop",
		query: "jpop hits popular songs playlist",
	},
	{
		id: "rain",
		labelKey: "bgm.cat.rain",
		query: "rain sounds sleep study white noise 1 hour",
	},
	{
		id: "ghibli",
		labelKey: "bgm.cat.ghibli",
		query: "studio ghibli piano collection bgm",
	},
	{
		id: "jazz",
		labelKey: "bgm.cat.jazz",
		query: "jazz cafe background music lounge",
	},
	{
		id: "classical",
		labelKey: "bgm.cat.classical",
		query: "classical music background study concentration",
	},
	{
		id: "nature",
		labelKey: "bgm.cat.nature",
		query: "nature sounds forest birds water relaxing",
	},
	{
		id: "ambient",
		labelKey: "bgm.cat.ambient",
		query: "ambient atmospheric background music drone",
	},
	{
		id: "synthwave",
		labelKey: "bgm.cat.synthwave",
		query: "synthwave retrowave 80s neon background",
	},
	{
		id: "bossa",
		labelKey: "bgm.cat.bossa",
		query: "bossa nova jazz cafe morning music",
	},
	{
		id: "piano",
		labelKey: "bgm.cat.piano",
		query: "solo piano relaxing music sleep background",
	},
	{
		id: "meditation",
		labelKey: "bgm.cat.meditation",
		query: "meditation healing music binaural beats deep",
	},
	{
		id: "celtic",
		labelKey: "bgm.cat.celtic",
		query: "celtic fantasy ambient rpg isekai music",
	},
	{
		id: "darkacademia",
		labelKey: "bgm.cat.darkacademia",
		query: "dark academia background music study aesthetic",
	},
	{
		id: "kdrama",
		labelKey: "bgm.cat.kdrama",
		query: "korean drama ost background music piano",
	},
	{
		id: "new-age",
		labelKey: "bgm.cat.newage",
		query: "new age relaxing music 1 hour",
	},
	{
		id: "citypop",
		labelKey: "bgm.cat.citypop",
		query: "japanese city pop bgm 1 hour aesthetic",
	},
] as const;

// ── Favorites ─────────────────────────────────────────────────────────────────

// Legacy webview-profile storage. Favorites are USER DATA: the workspace SoT
// (naia-settings config, #476) is authoritative; this key is only read once
// for migration and then cleared.
const FAV_KEY = "yt-bgm-favorites";

function readLegacyLocalFavs(): YtVideo[] {
	try {
		const parsed = JSON.parse(
			localStorage.getItem(FAV_KEY) ?? "[]",
		) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is YtVideo =>
				item !== null &&
				typeof item === "object" &&
				typeof (item as YtVideo).id === "string" &&
				typeof (item as YtVideo).title === "string",
		);
	} catch {
		return [];
	}
}

function loadFavs(): YtVideo[] {
	const stored = loadConfig()?.bgmYoutubeFavorites;
	if (Array.isArray(stored)) {
		return stored.map((f) => ({
			id: f.id,
			title: f.title,
			thumbnail: f.thumbnail ?? "",
			duration: f.duration ?? "",
			channel: f.channel ?? "",
		}));
	}
	// Not yet migrated — fall back to the legacy webview copy.
	return readLegacyLocalFavs();
}

// ── App height ──────────────────────────────────────────────────────────────

interface Props {
	naia?: NaiaContextBridge;
}

type Source = "local" | "youtube";
type AppTab = "youtube" | "local" | "playlists";
type YtView = "categories" | "search" | "likes" | "playlists";

function ytVideoToLibraryTrack(video: YtVideo): BgmLibraryTrack {
	return {
		id: `youtube:${video.id}`,
		source: "youtube",
		youtubeId: video.id,
		title: video.title,
		thumbnail: video.thumbnail,
		channel: video.channel,
	};
}

function libraryTrackToYtVideo(track: BgmLibraryTrack): YtVideo | null {
	if (track.source !== "youtube" || !track.youtubeId) return null;
	return {
		id: track.youtubeId,
		title: track.title,
		thumbnail: track.thumbnail ?? "",
		duration: track.durationSeconds ? String(track.durationSeconds) : "",
		channel: track.channel ?? "",
	};
}

function localLibraryTrack(path: string, title: string): BgmLibraryTrack {
	return {
		id: `local:${path}`,
		source: "local",
		path,
		title,
	};
}

const YT_APP_H_KEY = "yt-app-height";
const YT_APP_H_DEFAULT = 360;
const YT_APP_H_MIN = 200;
const YT_APP_H_MAX = 700;
// Marquee kicks in when track label exceeds this character count
const MARQUEE_THRESHOLD = 22;
const PLAYBACK_TIMEOUT_MS = 12_000;

/** Native E2E uses a same-origin fixture; normal Shell runs always use YouTube. */
function youtubeEmbedUrl(videoId: string, playbackId?: string): string {
	const fixture = import.meta.env.VITE_NAIA_E2E_BGM_IFRAME_URL?.trim();
	if (fixture) {
		const url = new URL(fixture, window.location.origin);
		url.searchParams.set("videoId", videoId);
		if (playbackId) url.searchParams.set("naiaPlayback", playbackId);
		return url.toString();
	}
	return (
		`https://www.youtube-nocookie.com/embed/${videoId}` +
		`?autoplay=1&enablejsapi=1` +
		`&origin=${encodeURIComponent(window.location.origin)}` +
		(playbackId ? `&naiaPlayback=${encodeURIComponent(playbackId)}` : "")
	);
}

function loadAppHeight(): number {
	const v = parseInt(localStorage.getItem(YT_APP_H_KEY) ?? "", 10);
	return Number.isFinite(v)
		? Math.max(YT_APP_H_MIN, Math.min(YT_APP_H_MAX, v))
		: YT_APP_H_DEFAULT;
}

export function BgmPlayer({ naia }: Props) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const playerRef = useRef<HTMLDivElement>(null);
	const [appPos, setAppPos] = useState<{
		top: number;
		left: number;
	} | null>(null);
	const persistedYtAppHeight = useUiPreference<number>(
		UI_PREFERENCE_KEYS.youtubeAppHeight,
		loadAppHeight(),
	);
	const [ytAppHeight, setYtAppHeight] = useState(() =>
		Math.max(YT_APP_H_MIN, Math.min(YT_APP_H_MAX, persistedYtAppHeight)),
	);
	useEffect(() => {
		setYtAppHeight(
			Math.max(YT_APP_H_MIN, Math.min(YT_APP_H_MAX, persistedYtAppHeight)),
		);
	}, [persistedYtAppHeight]);
	const handleDragRef = useRef<{
		startY: number;
		startH: number;
		moved: boolean;
	} | null>(null);
	const dragHeightRef = useRef(ytAppHeight);

	// ── Local BGM ─────────────────────────────────────────────────────────────
	const bgmTrackUrl = useAvatarStore((s) => s.bgmTrackUrl);
	const setBgmTrackUrl = useAvatarStore((s) => s.setBgmTrackUrl);
	const setBackgroundVideoUrl = useAvatarStore((s) => s.setBackgroundVideoUrl);
	const setBackgroundMediaType = useAvatarStore(
		(s) => s.setBackgroundMediaType,
	);
	const prevBgVideoRef = useRef<string>("");
	const prevBgMediaRef = useRef<BackgroundMediaType>("");
	const [localTracks, setLocalTracks] = useState<string[]>([]);
	const [localPaths, setLocalPaths] = useState<string[]>([]);
	const [localNames, setLocalNames] = useState<string[]>([]);
	const localPathsRef = useRef<string[]>([]);
	const [localIndex, setLocalIndex] = useState(0);

	useEffect(() => {
		listNaiaAssets("bgm-musics").then(async (paths) => {
			const urls = await Promise.all(paths.map(toLocalBlobUrl));
			const names = paths.map(
				(p) =>
					p
						.split(/[\\/]/)
						.pop()
						?.replace(/\.[^.]+$/, "") ?? p,
			);
			localPathsRef.current = paths;
			setLocalPaths(paths);
			setLocalTracks(urls);
			setLocalNames(names);
			if (urls.length > 0 && !bgmTrackUrl) setBgmTrackUrl(urls[0]);
		});
	}, [bgmTrackUrl, setBgmTrackUrl]);

	// ── Playback state (restored from persisted config) ───────────────────────
	const [source, setSource] = useState<Source>(
		() => (loadConfig()?.bgmSource as Source | undefined) ?? "youtube",
	);
	const [playing, setPlaying] = useState(false); // never auto-play on restore
	const [volume, setVolume] = useState(() => loadConfig()?.bgmVolume ?? 0.3);
	const [showYoutubeBackground, setShowYoutubeBackground] = useState(
		() => loadConfig()?.bgmYoutubeBackgroundVideo ?? true,
	);
	// FR-BGM-VIDEO.2 (#476 검은 화면): the YouTube iframe may never render a
	// picture in the packaged WebView2 (embed refusal, CSP, load failure) while
	// the user's background has already been swapped out underneath it. The
	// iframe is therefore only allowed to COVER the fallback background after
	// this playback has been genuinely observed playing (onStateChange playing
	// or real infoDelivery progress). Until then — and again on error/timeout/
	// ended — the previous background stays visible through the transparent
	// iframe instead of a black screen.
	const [videoLive, setVideoLive] = useState(false);
	const [playbackSnapshot, setPlaybackSnapshot] =
		useState<BgmPlaybackSnapshot | null>(() => bgmPlayback.current());
	const [queueVersion, setQueueVersion] = useState(0);
	const playbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const manuallyStoppedPlaybackRef = useRef<string | null>(null);
	const lastProgressObservationRef = useRef<{
		playbackId?: string;
		observedAt: number;
	}>({ observedAt: 0 });

	// ── Unified app state ───────────────────────────────────────────────────
	// appExpanded: the single app is open or closed
	// appTab: which tab is currently shown in the app (independent of what's playing)
	const [appExpanded, setAppExpanded] = useState(false);
	const [appTab, setAppTab] = useState<AppTab>("youtube");

	const [library, setLibrary] = useState<BgmLibraryState>(() => {
		// 첫 페인트는 캐시/구 config 로 즉시, 진짜 SoT(샌드박스)는 마운트 효과가 hydrate.
		const cached = bgmLibraryCache();
		if (cached) return cached;
		const cfg = loadConfig();
		return loadBgmLibrary(
			cfg?.bgmLibrary,
			loadFavs().map(ytVideoToLibraryTrack),
		);
	});
	const libraryRef = useRef(library);
	const [newPlaylistName, setNewPlaylistName] = useState("");
	// 플레이리스트 드래그 정렬 — HTML5 DnD, 놓는 순간 한 번만 이동한다.
	const [dragTrackIndex, setDragTrackIndex] = useState<number | null>(null);
	const [dragOverTrackIndex, setDragOverTrackIndex] = useState<number | null>(null);
	const dragOverRef = useRef<number | null>(null);

	// 포인터 기반 정렬 (#543): Tauri 창 drag-drop(파일 열기)이 켜져 있으면
	// WebView2 에서 HTML5 DnD 가 성립하지 않는다 — 손잡이 pointerdown 으로 시작해
	// document 포인터 이동/업으로 목적지를 정한다.
	useEffect(() => {
		if (dragTrackIndex === null) return;
		const onMove = (event: PointerEvent) => {
			const row = (
				document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
			)?.closest?.("[data-track-index]") as HTMLElement | null;
			if (!row) return;
			const over = Number(row.dataset.trackIndex);
			if (Number.isInteger(over)) {
				dragOverRef.current = over;
				setDragOverTrackIndex(over);
			}
		};
		const onUp = () => {
			const from = dragTrackIndex;
			const to = dragOverRef.current;
			const playlistId = libraryRef.current.activePlaylistId;
			if (playlistId && to !== null && to !== from) {
				updateLibrary((state) => movePlaylistTrack(state, playlistId, from, to));
			}
			dragOverRef.current = null;
			setDragTrackIndex(null);
			setDragOverTrackIndex(null);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp, { once: true });
		return () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dragTrackIndex]);
	const activePlaylist =
		library.playlists.find((playlist) => playlist.id === library.activePlaylistId) ??
		library.playlists[0];
	const favs = library.likes.flatMap((track) => {
		const video = libraryTrackToYtVideo(track);
		return video ? [video] : [];
	});

	// ── YouTube state ─────────────────────────────────────────────────────────
	const [ytView, setYtView] = useState<YtView>("categories");
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<YtVideo[]>([]);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
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
	useEffect(() => {
		volumeRef.current = volume;
	}, [volume]);

	function updateLibrary(
		updater: (current: BgmLibraryState) => BgmLibraryState,
	) {
		setLibrary((current) => {
			const updated = updater(current);
			if (updated === current) return current;
			// Stamp a fresh top-level updatedAt on every real change (incl. raw-spread
			// mutations that skip bgm-library.ts) so the store's restart reconciliation can
			// compare recency reliably.
			const next = { ...updated, updatedAt: Date.now() };
			libraryRef.current = next;
			void persistBgmLibrary(next);
			return next;
		});
	}

	useEffect(() => {
		libraryRef.current = library;
	}, [library]);

	function clearPlaybackTimeout() {
		if (playbackTimeoutRef.current) {
			clearTimeout(playbackTimeoutRef.current);
			playbackTimeoutRef.current = null;
		}
	}

	function observePlayback(
		status: Exclude<BgmPlaybackStatus, "requested">,
		options: {
			playbackId?: string;
			reason?: string;
			currentTime?: number;
			duration?: number;
		} = {},
	): BgmPlaybackSnapshot | null {
		const current = bgmPlayback.current();
		if (
			!current ||
			(options.playbackId && current.playbackId !== options.playbackId)
		) {
			return null;
		}
		const next = bgmPlayback.observe({
			playbackId: current.playbackId,
			sequence: current.sequence + 1,
			status,
			...(options.reason ? { reason: options.reason } : {}),
			...(options.currentTime !== undefined
				? { currentTime: options.currentTime }
				: {}),
			...(options.duration !== undefined ? { duration: options.duration } : {}),
		});
		if (!next) return null;
		setPlaybackSnapshot(next);
		if (status === "playing") {
			setVideoLive(true);
		} else if (
			status === "error" ||
			status === "ended"
		) {
			setVideoLive(false);
		}
		if (status === "playing" && current.status !== "playing") {
			emitAiInterferenceEvent({
				source: "bgm",
				action: "music_started",
				summary: `BGM: internal playback of "${next.selected.title}" is now confirmed playing.`,
			});
		}

		if (status === "error" || status === "timeout") {
			emitAiInterferenceEvent({
				source: "bgm",
				action: status === "error" ? "music_error" : "music_timeout",
				summary:
					status === "error"
						? `BGM: "${next.selected.title}" failed (${next.reason ?? "unknown error"}).`
						: `BGM: playback for "${next.selected.title}" was not observed before the diagnostic deadline; keep observing before declaring failure.`,
			});
		} else if (
			status === "playing" &&
			(current.status === "timeout" || current.status === "error")
		) {
			emitAiInterferenceEvent({
				source: "bgm",
				action: "music_recovered",
				summary: `BGM: "${next.selected.title}" is now confirmed playing after ${current.status}.`,
			});
		}
		if (
			status === "playing" ||
			status === "paused" ||
			status === "ended" ||
			status === "error" ||
			status === "timeout"
		) {
			clearPlaybackTimeout();
		}
		return next;
	}

	function startNextQueuedTrack(
		reason: "ended" | "error" | "timeout",
	): boolean {
		const previousPlaybackId = bgmPlayback.current()?.playbackId;
		const next = bgmPlayback.advance();
		if (!next) return false;
		if (previousPlaybackId) {
			continueRadioDjRecoveryAfterQueueAdvance(
				previousPlaybackId,
				next.playbackId,
			);
		}
		Logger.debug("BgmPlayer", "advancing queued playback", {
			reason,
			playbackId: next.playbackId,
			videoId: next.selected.videoId,
		});
		setPlaybackSnapshot(next);
		setQueueVersion((version) => version + 1);
		handleYtSelect(
			{
				id: next.selected.videoId,
				title: next.selected.title,
				thumbnail: "",
				duration: "",
				channel: "",
			},
			next.playbackId,
		);
		return true;
	}

	function recoverAfterQueueExhausted(
		failed: BgmPlaybackSnapshot,
		reason: "error" | "timeout",
	): void {
		if (startNextQueuedTrack(reason)) return;
		void recoverRadioDjPlayback(failed.playbackId)
			.then((result) => {
				if (!result.recovered) return;
				Logger.info("BgmPlayer", "recovered Radio DJ playback by search", {
					reason,
					failedPlaybackId: failed.playbackId,
					playbackId: result.playbackId,
					videoId: result.selected.id,
				});
			})
			.catch((error) => {
				Logger.warn("BgmPlayer", "Radio DJ recovery search failed", {
					reason,
					failedPlaybackId: failed.playbackId,
					error: String(error),
				});
			});
	}

	// 12s watchdog: only a diagnostic mark, never an automatic track skip. The
	// only hard evidence of "this track genuinely failed" is the iframe's own
	// onError event (handled separately below) or the user's own action — a
	// missing "playing" message within an arbitrary window is not evidence of
	// failure, since the message itself (not the playback) can be lost (see
	// the infoDelivery cross-check above). Blindly skipping on this timer alone
	// used to jump to an unrelated track while the current one was still
	// playing fine.
	// #521 — 관측이 실패했을 때 어느 관문에서 끊겼는지를 남긴다. 설치본에서
	// 음악이 실제로 들리는데도 timeout 이 나던 문제를 재현 로그 한 줄로
	// 특정하기 위한 계측이다.
	const observationCountersRef = useRef(emptyBgmObservationCounters());

	function beginPlaybackTimeout(playbackId: string) {
		clearPlaybackTimeout();
		observationCountersRef.current = emptyBgmObservationCounters();
		observationCountersRef.current.expectedPlaybackId = playbackId;
		playbackTimeoutRef.current = setTimeout(() => {
			const current = bgmPlayback.current();
			if (current?.playbackId !== playbackId || current.status === "playing")
				return;
			const counters = observationCountersRef.current;
			counters.activePlaybackId = activeIframePlaybackId();
			const diagnosis = diagnoseBgmObservationFailure(counters);
			Logger.warn(
				"BgmPlayer",
				`재생 관측 실패 (#521): ${diagnosis.summary}`,
				{
					cause: diagnosis.cause,
					received: counters.received,
					filteredOut: counters.filteredOut,
					idMismatched: counters.idMismatched,
					stateChangeSeen: counters.stateChangeSeen,
					infoDeliverySeen: counters.infoDeliverySeen,
					expectedPlaybackId: counters.expectedPlaybackId,
					activePlaybackId: counters.activePlaybackId,
				},
			);
			observePlayback("timeout", {
				playbackId,
				reason: "iframe_playing_not_observed",
			});
		}, PLAYBACK_TIMEOUT_MS);
	}

	/** 지금 화면에 붙어 있는 iframe 이 어느 재생을 담고 있는가. */
	function activeIframePlaybackId(): string | undefined {
		const iframe = document.querySelector(
			".app-bg-iframe",
		) as HTMLIFrameElement | null;
		if (!iframe) return undefined;
		try {
			return (
				new URL(iframe.src, window.location.href).searchParams.get(
					"naiaPlayback",
				) ?? undefined
			);
		} catch {
			return undefined;
		}
	}

	useEffect(() => () => clearPlaybackTimeout(), []);

	// ── YouTube IFrame API bridge ──────────────────────────────────────────────
	// YouTube sends `initialDelivery` when the player finishes loading.
	// We must reply with `{event:"listening"}` to activate the command bridge,
	// then immediately sync the current volume. Without this handshake
	// `setVolume` postMessages are silently ignored by the player.
	useEffect(() => {
		function onYtMessage(e: MessageEvent) {
			if (!e.data) return;
			const activeIframe = document.querySelector(
				".app-bg-iframe",
			) as HTMLIFrameElement | null;
			if (!activeIframe) return;
			// 화면에 붙어 있는 iframe 이 보낸 것만 받는다. 보낸 창을 특정할 수
			// 없으면 그 이벤트를 어느 playbackId 에 결속할지도 알 수 없고
			// (FR-RADIO-DJ.2), 아래에서 eventPlaybackId 를 "지금 붙어 있는"
			// iframe 의 URL 에서 읽으므로 곧 남의 이벤트를 현재 곡에 붙이게 된다.
			//
			// 예전에는 `e.source &&` 로 출처 없는 메시지를 그냥 통과시켰다. 그런데
			// WebKitGTK 는 이미 떨어져 나간 프레임이 보낸 메시지의 `source` 를
			// null 로 준다 — 곡 A 의 늦은 오류가 곡 B 를 `error` 로 덮어쓰는,
			// S-RADIO-DJ-1 이 금지하는 바로 그 경로였다(#557).
			if (
				activeIframe.contentWindow &&
				e.source !== activeIframe.contentWindow
			) {
				observationCountersRef.current.filteredOut++; // #521
				return;
			}
			const allowedOrigin = (() => {
				if (!e.origin) return true;
				// same-origin = E2E 픽스처 iframe 과 자기 브리지 — 항상 신뢰.
				if (e.origin === window.location.origin) return true;
				try {
					const hostname = new URL(e.origin).hostname;
					return (
						hostname === "youtube.com" ||
						hostname.endsWith(".youtube.com") ||
						hostname === "youtube-nocookie.com" ||
						hostname.endsWith(".youtube-nocookie.com")
					);
				} catch {
					return false;
				}
			})();
			if (!allowedOrigin) {
				observationCountersRef.current.filteredOut++; // #521
				Logger.warn("BgmPlayer", "ignored iframe message from unexpected origin", {
					origin: e.origin,
				});
				return;
			}
			try {
				const msg = (typeof e.data === "string"
					? JSON.parse(e.data)
					: e.data) as Record<string, unknown>;
				observationCountersRef.current.received++; // #521
				const eventPlaybackId = activeIframe
					? (new URL(activeIframe.src, window.location.href).searchParams.get(
							"naiaPlayback",
						) ?? undefined)
					: undefined;
				const counters = observationCountersRef.current; // #521
				if (
					counters.expectedPlaybackId &&
					eventPlaybackId &&
					counters.expectedPlaybackId !== eventPlaybackId
				) {
					counters.idMismatched++;
				}
				if (
					["initialDelivery", "onReady", "onStateChange", "onError"].includes(
						String(msg.event),
					)
				) {
					Logger.debug("BgmPlayer", "YouTube iframe event", {
						event: msg.event,
						eventPlaybackId,
					});
				}
				if (msg.event === "onStateChange") {
					counters.stateChangeSeen = true; // #521
					const state = Number(msg.info ?? msg.data);
					if (state === 1) {
						if (
							eventPlaybackId &&
							manuallyStoppedPlaybackRef.current === eventPlaybackId
						) {
							// A stale PLAYING event can arrive after stopVideo in WebView2.
							// Manual stop wins; reaffirm it instead of resurrecting playback.
							activeIframe.contentWindow?.postMessage(
								JSON.stringify({ event: "command", func: "stopVideo", args: [] }),
								"*",
							);
							setPlaying(false);
							return;
						}
						manuallyStoppedPlaybackRef.current = null;
						setPlaying(true);
						const observed = observePlayback("playing", {
							playbackId: eventPlaybackId,
						});
						if (observed) {
							const persist = recordBgmPlayedTrack({
								id: observed.selected.videoId,
								title: observed.selected.title,
							});
							const recorded = bgmLibraryCache();
							if (recorded) {
								libraryRef.current = recorded;
								setLibrary(recorded);
							}
							void persist;
						}
					} else if (state === 2) {
						setPlaying(false);
						observePlayback("paused", { playbackId: eventPlaybackId });
					} else if (state === 0) {
						setPlaying(false);
						if (
							eventPlaybackId &&
							manuallyStoppedPlaybackRef.current === eventPlaybackId
						) {
							manuallyStoppedPlaybackRef.current = null;
							observePlayback("paused", { playbackId: eventPlaybackId });
							return;
						}
						const ended = observePlayback("ended", {
							playbackId: eventPlaybackId,
						});
						if (!ended) return;
						const continued = startNextQueuedTrack("ended") || playNext();
						// Notify the agent the moment a track genuinely ends (not on a
						// timer — this is the real onStateChange ENDED event), the same
						// way a new track start already does via "music_changed". Without
						// this, the agent only learns a track ended by passively noticing
						// stale bgm context on some later, unrelated turn — it never gets
						// an active cue to comment or queue the next song right now.
						emitAiInterferenceEvent({
							source: "bgm",
							action: "music_ended",
							summary: continued
								? `BGM: "${ended.selected.title}" ended; the next queued track is starting now.`
								: `BGM: "${ended.selected.title}" ended; nothing is queued next.`,
						});
					} else if (state === -1 || state === 3) {
						observePlayback("loading", { playbackId: eventPlaybackId });
					}
				} else if (msg.event === "infoDelivery") {
					counters.infoDeliverySeen = true; // #521
					const info = msg.info;
					if (info && typeof info === "object") {
						const currentTime = Number(
							(info as Record<string, unknown>).currentTime,
						);
						const duration = Number((info as Record<string, unknown>).duration);
						const current = bgmPlayback.current();
						const isSamePlayback =
							!!current?.playbackId && current.playbackId === eventPlaybackId;
						if (
							eventPlaybackId &&
							manuallyStoppedPlaybackRef.current === eventPlaybackId
						)
							return;
						// The iframe bridge can lose the onStateChange "playing" (state=1)
						// message after a src swap (WebView2 handshake loss — see
						// sendYtCmd's re-listen comment) even though audio is genuinely
						// playing. infoDelivery's currentTime is an independent signal —
						// real progress on the active playback id is itself proof of
						// playback — so it can also promote out of requested/loading
						// without waiting for the (possibly lost) onStateChange event.
						// This is what keeps beginPlaybackTimeout's 12s watchdog from
						// skipping a track that is actually playing fine.
						const canObservePlaying =
							isSamePlayback &&
							(current.status === "playing" ||
								((current.status === "requested" ||
									current.status === "loading" ||
									current.status === "timeout") &&
									Number.isFinite(currentTime) &&
									currentTime > 0));
						if (canObservePlaying) {
							// The BUTTON state must follow this independent progress signal
							// too: with onStateChange(1) lost, audio played while the button
							// still showed "play", so clicking re-sent playVideo and the
							// video could never be paused (#457 — "정지되지 않음").
							setPlaying(true);
							const now = Date.now();
							const lastProgress = lastProgressObservationRef.current;
							if (
								lastProgress.playbackId === eventPlaybackId &&
								now - lastProgress.observedAt < 1_000
							)
								return;
							lastProgressObservationRef.current = {
								playbackId: eventPlaybackId,
								observedAt: now,
							};
							observePlayback("playing", {
								playbackId: eventPlaybackId,
								...(Number.isFinite(currentTime) && currentTime >= 0
									? { currentTime }
									: {}),
								...(Number.isFinite(duration) && duration >= 0
									? { duration }
									: {}),
							});
						}
					}
				} else if (msg.event === "onError") {
					setPlaying(false);
					const errored = observePlayback("error", {
						playbackId: eventPlaybackId,
						reason: String(msg.info ?? msg.data ?? "youtube_iframe_error"),
					});
					if (!errored) return;
					recoverAfterQueueExhausted(errored, "error");
				}
				if (msg.event === "initialDelivery" || msg.event === "onReady") {
					observePlayback("loading", { playbackId: eventPlaybackId });
					const iframe = document.querySelector(
						".app-bg-iframe",
					) as HTMLIFrameElement | null;
					if (!iframe?.contentWindow) return;
					iframe.contentWindow.postMessage(
						JSON.stringify({ event: "listening" }),
						"*",
					);
					const current = bgmPlayback.current();
					if (
						current && current.playbackId === eventPlaybackId &&
						["requested", "loading", "timeout"].includes(current.status)
					) {
						iframe.contentWindow.postMessage(
							JSON.stringify({ event: "command", func: "playVideo", args: [] }),
							"*",
						);
					}
					iframe.contentWindow.postMessage(
						JSON.stringify({
							event: "command",
							func: "setVolume",
							args: [Math.round(volumeRef.current * 100)],
						}),
						"*",
					);
				}
			} catch (error) {
				Logger.warn("BgmPlayer", "invalid YouTube iframe message", {
					error: String(error),
				});
			}
		}
		window.addEventListener("message", onYtMessage);
		return () => window.removeEventListener("message", onYtMessage);
	}, []);

	// ── Volume sync ───────────────────────────────────────────────────────────
	useEffect(() => {
		const audio = audioRef.current;
		if (audio) audio.volume = volume;
		if (source === "youtube") {
			const iframe = document.querySelector(
				".app-bg-iframe",
			) as HTMLIFrameElement | null;
			if (iframe?.contentWindow) {
				// Re-send listening before each command in case bridge was reset
				iframe.contentWindow.postMessage(
					JSON.stringify({ event: "listening" }),
					"*",
				);
				iframe.contentWindow.postMessage(
					JSON.stringify({
						event: "command",
						func: "setVolume",
						args: [Math.round(volume * 100)],
					}),
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
	// Expose currentYt via ref so the listener (created once) can see latest values.
	const currentYtRef = useRef<YtVideo | null>(null);
	useEffect(() => {
		currentYtRef.current = currentYt;
	}, [currentYt]);

	useEffect(() => {
		const handleBgmEvent = (e: { payload: string }) => {
			try {
				const msg = JSON.parse(e.payload) as Record<string, unknown>;
				if (msg.type === "bgm_youtube_play") {
				Logger.info("BgmPlayer", "received BGM command", {
					type: msg.type,
					playbackId: msg.playbackId,
					videoId: msg.videoId,
				});
					const video: YtVideo = {
						id: String(msg.videoId ?? ""),
						title: String(msg.title ?? ""),
						thumbnail: String(msg.thumbnail ?? ""),
						duration: "",
						channel: "",
					};
					handleYtSelect(
						video,
						typeof msg.playbackId === "string" ? msg.playbackId : undefined,
					);
				} else if (msg.type === "bgm_youtube_enqueue") {
					setQueueVersion((version) => version + 1);
				} else if (msg.type === "e2e_bgm_enqueue") {
					const result = bgmPlayback.enqueue({
						videoId: String(msg.videoId ?? ""),
						title: String(msg.title ?? ""),
					});
					if (result.disposition === "play") {
						handleYtSelect(
							{
								id: result.playback.selected.videoId,
								title: result.playback.selected.title,
								thumbnail: "",
								duration: "",
								channel: "",
							},
							result.playback.playbackId,
						);
					}
					setPlaybackSnapshot(bgmPlayback.current());
					setQueueVersion((version) => version + 1);
				} else if (msg.type === "bgm_youtube_stop") {
					cancelRadioDjRecovery();
					audioRef.current?.pause();
					setPlaying(false);
					if (useAvatarStore.getState().backgroundMediaType === "iframe") {
						setBackgroundVideoUrl(prevBgVideoRef.current);
						setBackgroundMediaType(prevBgMediaRef.current);
					}
					prevBgVideoRef.current = "";
					prevBgMediaRef.current = "";
					bgmPlayback.clearQueue();
					observePlayback("ended");
					setPlaybackSnapshot(bgmPlayback.current());
					setQueueVersion((version) => version + 1);
				} else if (msg.type === "bgm_youtube_fav_add") {
					const cur = currentYtRef.current;
					if (!cur) return;
					if (
						!libraryRef.current.likes.some(
							(track) => trackIdentity(track) === `youtube:${cur.id}`,
						)
					)
						updateLibrary((state) =>
							toggleBgmLike(state, ytVideoToLibraryTrack(cur)),
						);
				} else if (msg.type === "bgm_youtube_fav_remove") {
					const cur = currentYtRef.current;
					if (!cur) return;
					if (
						libraryRef.current.likes.some(
							(track) => trackIdentity(track) === `youtube:${cur.id}`,
						)
					)
						updateLibrary((state) =>
							toggleBgmLike(state, ytVideoToLibraryTrack(cur)),
						);
				} else if (msg.type === "bgm_youtube_pause") {
					const iframe = document.querySelector(
						".app-bg-iframe",
					) as HTMLIFrameElement | null;
					iframe?.contentWindow?.postMessage(
						JSON.stringify({ event: "command", func: "pauseVideo", args: [] }),
						"*",
					);
				} else if (msg.type === "bgm_youtube_resume") {
					const iframe = document.querySelector(
						".app-bg-iframe",
					) as HTMLIFrameElement | null;
					if (!iframe && currentYtRef.current) {
						handleYtSelect(currentYtRef.current);
					} else {
						iframe?.contentWindow?.postMessage(
							JSON.stringify({ event: "command", func: "playVideo", args: [] }),
							"*",
						);
					}
				} else if (msg.type === "bgm_youtube_next") {
					playNext();
				} else if (msg.type === "bgm_youtube_prev") {
					playPrev();
				} else if (msg.type === "bgm_playlist_create") {
					updateLibrary((state) => createPlaylist(state, String(msg.name ?? "")));
				} else if (msg.type === "bgm_playlist_shuffle") {
					updateLibrary((state) => ({ ...state, shuffle: msg.enabled !== false }));
				} else if (msg.type === "bgm_playlist_repeat") {
					const repeat = msg.repeat === "all" || msg.repeat === "one" ? msg.repeat : "off";
					updateLibrary((state) => ({ ...state, repeat }));
				} else if (msg.type === "bgm_playlist_add_current") {
					const video = currentYtRef.current;
					if (video) {
						const playlistId = typeof msg.playlistId === "string" ? msg.playlistId : libraryRef.current.activePlaylistId;
						if (playlistId) updateLibrary((state) => addTrackToPlaylist(state, playlistId, ytVideoToLibraryTrack(video)));
					}
				} else if (msg.type === "bgm_playlist_play") {
					const playlist = libraryRef.current.playlists.find((item) => item.id === msg.playlistId);
					const index = Math.max(0, Math.trunc(Number(msg.index) || 0));
					if (playlist?.tracks[index]) playLibraryTrack(playlist.tracks[index], index, playlist.id);
				} else if (msg.type === "bgm_library_like_add" || msg.type === "bgm_library_like_remove") {
					const video = currentYtRef.current;
					if (!video) return;
					const liked = libraryRef.current.likes.some((track) => trackIdentity(track) === `youtube:${video.id}`);
					if ((msg.type === "bgm_library_like_add" && !liked) || (msg.type === "bgm_library_like_remove" && liked)) updateLibrary((state) => toggleBgmLike(state, ytVideoToLibraryTrack(video)));
				} else if (msg.type === "bgm_youtube_volume") {
					const val = Number(msg.volume ?? 0.5);
					if (val >= 0 && val <= 1) setVolume(val);
				}
			} catch (err) {
				Logger.error("BgmPlayer", "BGM event parse error", {
					error: String(err),
				});
			}
		};
		// bgm_command is the Shell-owned path. Keep agent_response for native
		// Rust/legacy producers during the compatibility period.
		const unlistenPs = [
			listen<string>("bgm_command", handleBgmEvent),
			listen<string>("agent_response", handleBgmEvent),
		];
		return () => {
			Promise.all(unlistenPs).then((unlisteners) => {
				for (const unlisten of unlisteners) unlisten();
			});
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── App anchor position ─────────────────────────────────────────────────
	// appPos is always calculated so the portal stays in DOM for CSS animation.
	useEffect(() => {
		if (!playerRef.current) {
			setAppPos(null);
			return;
		}
		const rect = playerRef.current.getBoundingClientRect();
		// CSS .bgm-yt-app 의 width(380px)와 반드시 같은 값 — 어긋나면 우측 정렬 계산이 밀린다.
		const APP_W = Math.min(380, window.innerWidth - 16);
		// Right-align app to player's right edge, clamp so it doesn't overflow screen
		const safeLeft = Math.max(
			8,
			Math.min(rect.right - APP_W, window.innerWidth - APP_W - 8),
		);
		setAppPos({ top: rect.bottom + 4, left: safeLeft });
	}, [appExpanded, ytAppHeight]);

	// ── BGM state persistence ─────────────────────────────────────────────────
	// SoT = 앱 샌드박스 (app-store-protocol). 파일이 없으면 구 config/localStorage
	// 즐겨찾기를 1회 이관한다.
	useEffect(() => {
		void loadBgmLibraryFromSandbox(loadFavs().map(ytVideoToLibraryTrack)).then(
			(state) => {
				libraryRef.current = state;
				setLibrary(state);
			},
		);
		try {
			localStorage.removeItem(FAV_KEY);
		} catch {}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

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

	// FR-BGM-VIDEO.2 — CSS gate: .app-bg-iframe stays transparent until the
	// active playback is confirmed, so an unconfirmed/failed embed never
	// replaces the user's background with a black frame.
	useEffect(() => {
		document.documentElement.dataset.bgmYoutubeLive = videoLive
			? "true"
			: "false";
		return () => {
			delete document.documentElement.dataset.bgmYoutubeLive;
		};
	}, [videoLive]);

	useEffect(() => {
		document.documentElement.dataset.bgmYoutubeBackground =
			showYoutubeBackground ? "visible" : "hidden";
		const cfg = loadConfig();
		if (cfg)
			saveConfig({
				...cfg,
				bgmYoutubeBackgroundVideo: showYoutubeBackground,
			});
		return () => {
			delete document.documentElement.dataset.bgmYoutubeBackground;
		};
	}, [showYoutubeBackground]);

	useEffect(() => {
		const cfg = loadConfig();
		if (!cfg) return;
		const ytFields =
			source === "youtube" && currentYt
				? {
						bgmYoutubeVideoId: currentYt.id,
						bgmYoutubeTitle: currentYt.title,
						bgmYoutubeChannel: currentYt.channel,
						bgmYoutubeThumbnail: currentYt.thumbnail,
					}
				: {};
		saveConfig({ ...cfg, bgmSource: source, ...ytFields });
	}, [source, currentYt]);

	// Consume only an explicit playback request issued during this app session.
	// Persisted media metadata is never playback authority after a restart.
	useEffect(() => {
		// A chat turn can dispatch the app tool after the chat surface is ready
		// but before this widget's Tauri event listener is attached. The playback
		// authority already holds that request, so recover it instead of leaving a
		// title-only requested state with no iframe.
		const pending = bgmPlayback.current();
		if (pending && !["ended", "error", "timeout"].includes(pending.status)) {
			Logger.debug("BgmPlayer", "recovering pending playback on mount", {
				playbackId: pending.playbackId,
				status: pending.status,
			});
			const video: YtVideo = {
				id: pending.selected.videoId,
				title: pending.selected.title,
				thumbnail: "",
				duration: "",
				channel: "",
			};
			setPlaybackSnapshot(pending);
			setCurrentYt(video);
			lastYtRef.current = video;
			setSource("youtube");
			setPlaying(false);
			if (pending.status === "requested" || pending.status === "loading") {
				beginPlaybackTimeout(pending.playbackId);
			}
			setBackgroundVideoUrl(
				youtubeEmbedUrl(pending.selected.videoId, pending.playbackId),
			);
			setBackgroundMediaType("iframe");
			setVideoLive(pending.status === "playing");
			return;
		}
		const cfg = loadConfig();
		if (cfg?.bgmPlaying) saveConfig({ ...cfg, bgmPlaying: false });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── AI context push ───────────────────────────────────────────────────────
	// Provide full BGM state so Naia can control all player features via agent_response events.
	// Supported commands: bgm_youtube_play, bgm_youtube_stop, bgm_youtube_fav_add, bgm_youtube_fav_remove
	useEffect(() => {
		if (!naia) return;
		const observed = toBgmObservedContext(
			playbackSnapshot,
			Date.now(),
			bgmPlayback.queue(),
		);
		naia.pushContext({
			type: "bgm",
			data: {
				source,
				playing: observed.announceTrack,
				playIntentActive: playing,
				volume,
				...observed,
				// YouTube info
				currentVideoId: observed.currentTrack?.videoId ?? null,
				currentTitle:
					source === "youtube"
						? observed.announceTrack
							? (currentYt?.title ?? null)
							: null
						: (localNames[localIndex] ?? null),
				currentChannel: observed.announceTrack
					? (currentYt?.channel ?? null)
					: null,
				isCurrentLiked: currentYt
					? favs.some((f) => f.id === currentYt.id)
					: false,
				likesCount: library.likes.length,
				likesList: library.likes
					.slice(0, 10)
					.map((track) => ({ id: track.id, title: track.title, source: track.source })),
				activePlaylist: activePlaylist
					? {
							id: activePlaylist.id,
							name: activePlaylist.name,
							trackCount: activePlaylist.tracks.length,
							currentIndex: library.currentIndex,
						}
					: null,
				playlists: library.playlists.map((playlist) => ({ id: playlist.id, name: playlist.name, trackCount: playlist.tracks.length })),
				shuffle: library.shuffle,
				repeat: library.repeat,
				libraryQueueLength: library.queue.length,
				recentlyPlayedList: getBgmRecentTracks().map((track) => ({
					id: track.id,
					title: track.title,
					playedAt: track.playedAt,
				})),
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
	}, [
		naia,
		source,
		playing,
		volume,
		playbackSnapshot,
		queueVersion,
		currentYt,
		library,
		localNames,
		localIndex,
		localTracks.length,
	]);

	// ── Playback helpers ──────────────────────────────────────────────────────

	function handleYtSelect(video: YtVideo, requestedPlaybackId?: string) {
		if (!requestedPlaybackId) cancelRadioDjRecovery();
		audioRef.current?.pause();
		const current = bgmPlayback.current();
		const snapshot =
			requestedPlaybackId && current?.playbackId === requestedPlaybackId
				? current
				: bgmPlayback.request({ videoId: video.id, title: video.title });
		setPlaybackSnapshot(snapshot);
		beginPlaybackTimeout(snapshot.playbackId);
		setCurrentYt(video);
		lastYtRef.current = video;
		setSource("youtube");
		// Reflect the user's autoplay intent immediately in the controls and in
		// the checked background surface. Agent truth remains observation-gated.
		setPlaying(true);
		setVideoLive(true);
		emitAiInterferenceEvent({
			source: "bgm",
			action: "music_requested",
			summary: "BGM: internal YouTube playback was requested; it is not playing until a later music_started event confirms it.",
		});

		if (!prevBgVideoRef.current && prevBgMediaRef.current === "") {
			const { backgroundVideoUrl: curUrl, backgroundMediaType: curType } =
				useAvatarStore.getState();
			if (curType !== "iframe") {
				prevBgVideoRef.current = curUrl;
				prevBgMediaRef.current = curType;
			}
		}
		// The playback id makes the URL and React iframe key unique. Selecting the
		// same video again must create a fresh player instead of a Zustand no-op.
		const embedUrl = youtubeEmbedUrl(video.id, snapshot.playbackId);
		setBackgroundVideoUrl(embedUrl);
		setBackgroundMediaType("iframe");
	}

	function sendYtCmd(func: string) {
		const iframe = document.querySelector(
			".app-bg-iframe",
		) as HTMLIFrameElement | null;
		if (!iframe?.contentWindow) return false;
		// WebView2의 YouTube bridge는 iframe 교체 뒤 listening handshake가
		// 유실될 수 있다. 모든 transport 명령 직전에 다시 활성화한다.
		iframe.contentWindow.postMessage(
			JSON.stringify({ event: "listening" }),
			"*",
		);
		iframe.contentWindow.postMessage(
			JSON.stringify({ event: "command", func, args: [] }),
			"*",
		);
		return true;
	}

	function togglePlay() {
		if (source === "youtube") {
			if (playing) {
				manuallyStoppedPlaybackRef.current =
					bgmPlayback.current()?.playbackId ?? null;
				if (sendYtCmd("stopVideo")) {
					// iframe 이벤트가 늦거나 누락돼도 버튼이 다시 재생 상태로
					// 즉시 바뀌도록 사용자 의도를 낙관적으로 반영한다.
					setPlaying(false);
					observePlayback("paused");
				}
			} else {
				const iframe = document.querySelector(
					".app-bg-iframe",
				) as HTMLIFrameElement | null;
				if (!iframe && currentYt) {
					// No iframe yet (e.g. restored from config) — reload the video
					handleYtSelect(currentYt);
				} else {
					if (sendYtCmd("playVideo")) {
						setPlaying(true);
						setVideoLive(true);
					}
				}
			}
			return;
		}
		const audio = audioRef.current;
		if (!audio) return;
		if (playing) {
			audio.pause();
			audio.currentTime = 0;
			setPlaying(false);
		} else {
			if (localTracks.length > 0 && !audio.src) {
				audio.src = localTracks[localIndex];
			}
			audio
				.play()
				.then(() => setPlaying(true))
				.catch(() => {});
		}
	}

	function playLocalAt(idx: number) {
		if (localTracks.length === 0) return;
		cancelRadioDjRecovery();
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
		audio
			.play()
			.then(() => setPlaying(true))
			.catch(() => {});
	}

	function playLibraryTrack(track: BgmLibraryTrack, index: number, playlistId: string) {
		updateLibrary((state) => ({ ...state, activePlaylistId: playlistId, currentIndex: index }));
		if (track.source === "youtube") {
			const video = libraryTrackToYtVideo(track);
			if (video) handleYtSelect(video);
			return;
		}
		const paths = localPathsRef.current;
		const exact = track.path ? paths.indexOf(track.path) : -1;
		const fileName = track.path?.split(/[\\/]/).pop()?.toLocaleLowerCase();
		const fallback = exact >= 0 ? exact : paths.findIndex((path) => path.split(/[\\/]/).pop()?.toLocaleLowerCase() === fileName);
		if (fallback >= 0) {
			playLocalAt(fallback);
			return;
		}
		// Restored metadata may outlive a local file. Keep the player usable by
		// connecting to the first bundled/default naia-settings BGM when present.
		if (paths.length > 0) playLocalAt(0);
	}

	function playNext(): boolean {
		const state = libraryRef.current;
		if (state.queue.length > 0) {
			const [track, ...queue] = state.queue;
			updateLibrary((current) => ({ ...current, queue }));
			playLibraryTrack(track, state.currentIndex, state.activePlaylistId ?? activePlaylist.id);
			return true;
		}
		const nextIndex = nextPlaylistIndex(state, 1);
		const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
		if (!playlist || nextIndex < 0) return false;
		playLibraryTrack(playlist.tracks[nextIndex], nextIndex, playlist.id);
		return true;
	}

	function playPrev() {
		const state = libraryRef.current;
		const prevIndex = nextPlaylistIndex(state, -1);
		const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
		if (playlist && prevIndex >= 0) playLibraryTrack(playlist.tracks[prevIndex], prevIndex, playlist.id);
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
				setSearchError(t("bgm.agentUnavailable"));
			} else {
				setSearchError(`${t("bgm.searchError")}: ${msg}`);
			}
		} finally {
			setSearching(false);
		}
	}

	async function loadCategory(query: string) {
		setSearchQuery(query);
		await doSearch(query);
	}

	// ── Likes and playlists ───────────────────────────────────────────────────

	function isFav(id: string) {
		return favs.some((f) => f.id === id);
	}

	function toggleFav(video: YtVideo) {
		updateLibrary((state) => toggleBgmLike(state, ytVideoToLibraryTrack(video)));
	}

	function addToActivePlaylist(track: BgmLibraryTrack) {
		const playlistId = libraryRef.current.activePlaylistId ?? libraryRef.current.playlists[0]?.id;
		if (!playlistId) return;
		updateLibrary((state) => addTrackToPlaylist(state, playlistId, track));
	}

	function addCurrentToPlaylist() {
		if (source === "youtube" && currentYt) addToActivePlaylist(ytVideoToLibraryTrack(currentYt));
		if (source === "local" && localPaths[localIndex]) addToActivePlaylist(localLibraryTrack(localPaths[localIndex], localNames[localIndex]));
	}

	function toggleCurrentLike() {
		if (source === "youtube" && currentYt) toggleFav(currentYt);
		if (source === "local" && localPaths[localIndex]) updateLibrary((state) => toggleBgmLike(state, localLibraryTrack(localPaths[localIndex], localNames[localIndex])));
	}

	const currentLibraryTrack = source === "youtube" && currentYt
		? ytVideoToLibraryTrack(currentYt)
		: source === "local" && localPaths[localIndex]
			? localLibraryTrack(localPaths[localIndex], localNames[localIndex])
			: null;
	const currentLiked = currentLibraryTrack
		? library.likes.some((track) => trackIdentity(track) === trackIdentity(currentLibraryTrack))
		: false;

	// ── Track name display ────────────────────────────────────────────────────

	const trackLabel =
		source === "youtube"
			? (currentYt?.title ?? t("bgm.defaultYouTubeTrack"))
			: (localNames[localIndex] ?? t("bgm.localBgm"));

	// Always scroll when playing (so AI-triggered tracks with short titles also marquee)
	const isScrolling = playing || trackLabel.length > MARQUEE_THRESHOLD;

	// FR-RADIO-DJ.5 — `data-bgm-current-title` above is only the request receipt:
	// it is filled the moment a play command is accepted. This one is what a DJ
	// may say out loud. It runs the same announce gate the agent context uses
	// (`toBgmObservedContext`), so a requested-but-not-yet-playing track has no
	// announceable title at all. #557 restored it so the native radio queue E2E
	// can observe the receipt/announcement boundary again.
	const announceableTitle =
		toBgmObservedContext(playbackSnapshot).currentTrack?.title ?? "";

	// ── Render ────────────────────────────────────────────────────────────────

	return (
		<div
			className="bgm-player"
			ref={playerRef}
			data-bgm-playback-status={playbackSnapshot?.status ?? "idle"}
			data-bgm-current-title={playbackSnapshot?.selected.title ?? ""}
			data-bgm-announced-title={announceableTitle}
			data-bgm-queue-length={bgmPlayback.queue().length}
			data-bgm-current-time={playbackSnapshot?.currentTime ?? ""}
			data-bgm-duration={playbackSnapshot?.duration ?? ""}
		>
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
					title={t("bgm.appToggleTitle")}
					onClick={() => setAppExpanded((v) => !v)}
				>
					♫
				</span>

				<div className="bgm-player-sep" />

				<button
					type="button"
					className="bgm-btn"
					onClick={playPrev}
					title={t("bgm.prev")}
				>
					‹
				</button>
				<button
					type="button"
					className="bgm-btn bgm-btn--play"
					onClick={togglePlay}
					title={playing ? t("bgm.stop") : t("bgm.play")}
					aria-label={playing ? t("bgm.stop") : t("bgm.play")}
				>
					{playing ? "■" : "▶"}
				</button>
				<button
					type="button"
					className="bgm-btn"
					onClick={playNext}
					title={t("bgm.next")}
				>
					›
				</button>
				<button
					type="button"
					className={`bgm-btn${currentLiked ? " bgm-like--on" : ""}`}
					onClick={toggleCurrentLike}
					disabled={!currentLibraryTrack}
					title={currentLiked ? t("bgm.favRemove") : t("bgm.favAdd")}
				>
					{currentLiked ? "♥" : "♡"}
				</button>
				<button
					type="button"
					className="bgm-btn"
					onClick={addCurrentToPlaylist}
					disabled={!currentLibraryTrack}
					title={t("bgm.addToPlaylist")}
				>
					＋
				</button>

				{/* Track name — fixed width, marquee when long, click to toggle app */}
				<button
					type="button"
					className={`bgm-track-name bgm-track-toggle${appExpanded ? " bgm-track-name--open" : ""}`}
					title={appExpanded ? t("bgm.close") : t("bgm.appToggleTitle")}
					onClick={() => setAppExpanded((v) => !v)}
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

			{/* ── Unified BGM app — always in DOM when anchor ready, hidden via CSS ── */}
			{appPos &&
				createPortal(
					<div
						className={`bgm-yt-app${appExpanded ? "" : " bgm-yt-app--hidden"}`}
						style={{
							position: "fixed",
							top: appPos.top,
							left: appPos.left,
							zIndex: 10001,
							height: ytAppHeight,
						}}
					>
						{/* Mode tab header */}
						<div className="bgm-app-header">
							<div className="bgm-app-tabs">
								<button
									type="button"
									className={`bgm-app-tab${appTab === "youtube" ? " bgm-app-tab--active" : ""}`}
									onClick={() => setAppTab("youtube")}
								>
									▶ YouTube
								</button>
								<button
									type="button"
									className={`bgm-app-tab${appTab === "local" ? " bgm-app-tab--active" : ""}`}
									onClick={() => setAppTab("local")}
								>
									{t("bgm.tabLocal")}
								</button>
								<button
									type="button"
									className={`bgm-app-tab${appTab === "playlists" ? " bgm-app-tab--active" : ""}`}
									onClick={() => setAppTab("playlists")}
								>
									{t("bgm.tabPlaylists")}
								</button>
							</div>
							<button
								type="button"
								className="bgm-app-close"
								onClick={() => setAppExpanded(false)}
								title={t("bgm.close")}
							>
								✕
							</button>
						</div>

						{/* ── 활성 플레이리스트 툴바 — 모든 탭 공통 (선택·셔플·반복) ── */}
						<div className="bgm-playlist-toolbar">
							<select
								value={activePlaylist?.id ?? ""}
								onChange={(event) => updateLibrary((state) => ({ ...state, activePlaylistId: event.target.value, currentIndex: -1 }))}
							>
								{library.playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
							</select>
							<button type="button" className={`bgm-btn${library.shuffle ? " bgm-control--on" : ""}`} onClick={() => updateLibrary((state) => ({ ...state, shuffle: !state.shuffle }))} title={t("bgm.shuffle")}>⤨</button>
							<button type="button" className={`bgm-btn${library.repeat !== "off" ? " bgm-control--on" : ""}`} onClick={() => updateLibrary((state) => ({ ...state, repeat: state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off" }))} title={library.repeat === "one" ? t("bgm.repeatOne") : library.repeat === "all" ? t("bgm.repeatAll") : t("bgm.repeatOff")}>{library.repeat === "one" ? "↻1" : "↻"}</button>
						</div>

						{/* ── YouTube tab ── */}
						{appTab === "youtube" && (
							<>
								<label className="bgm-yt-background-option">
									<input
										type="checkbox"
										checked={showYoutubeBackground}
										onChange={(event) =>
											setShowYoutubeBackground(event.target.checked)
										}
									/>
									{t("bgm.showBackgroundVideo")}
								</label>
								<div className="bgm-yt-tabs">
									<button
										type="button"
										className={`bgm-yt-tab${ytView === "categories" ? " bgm-yt-tab--active" : ""}`}
										onClick={() => setYtView("categories")}
									>
										{t("bgm.tabGenres")}
									</button>
									<button
										type="button"
										className={`bgm-yt-tab${ytView === "search" ? " bgm-yt-tab--active" : ""}`}
										onClick={() => setYtView("search")}
									>
										{t("bgm.tabSearch")}
									</button>
									<button
										type="button"
										className={`bgm-yt-tab${ytView === "likes" ? " bgm-yt-tab--active" : ""}`}
										onClick={() => setYtView("likes")}
									>
										{t("bgm.tabFavorites")}{" "}
										{favs.length > 0 && `(${favs.length})`}
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
										<form
											className="bgm-yt-search-row"
											onSubmit={(e) => {
												e.preventDefault();
												doSearch(searchQuery);
											}}
										>
											<input
												type="text"
												className="bgm-yt-search-input"
												placeholder={t("bgm.searchPlaceholder")}
												value={searchQuery}
												onChange={(e) => setSearchQuery(e.target.value)}
											/>
											<button
												type="submit"
												className="bgm-btn"
												disabled={searching}
											>
												{searching ? "…" : "🔍"}
											</button>
										</form>

										{searching && (
											<div className="bgm-yt-status">{t("bgm.searching")}</div>
										)}
										{!searching && searchError && (
											<div className="bgm-yt-status bgm-yt-status--error">
												{searchError}
											</div>
										)}
										{!searching &&
											!searchError &&
											searchResults.length === 0 && (
												<div className="bgm-yt-status">
													{t("bgm.noResults")}
												</div>
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
												onAdd={() => addToActivePlaylist(ytVideoToLibraryTrack(v))}
											/>
										))}
									</div>
								)}

								{ytView === "likes" && (
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
												onAdd={() => addToActivePlaylist(ytVideoToLibraryTrack(v))}
											/>
										))}
									</div>
								)}

							</>
						)}

						{/* ── Playlists tab (YouTube+로컬 믹스) ── */}
						{appTab === "playlists" && (
									<div className="bgm-playlists">
										<form className="bgm-playlist-create" onSubmit={(event) => {
											event.preventDefault();
											updateLibrary((state) => createPlaylist(state, newPlaylistName));
											setNewPlaylistName("");
										}}>
											<input value={newPlaylistName} onChange={(event) => setNewPlaylistName(event.target.value)} placeholder={t("bgm.newPlaylist")} />
											<button type="submit" className="bgm-btn">＋</button>
										</form>
										{activePlaylist?.tracks.length === 0 && <div className="bgm-yt-status">{t("bgm.playlistEmpty")}</div>}
										<div className="bgm-yt-list">
											{activePlaylist?.tracks.map((track, index) => (
												<div
													key={`${track.id}-${index}`}
													className={`bgm-yt-row bgm-playlist-row${library.currentIndex === index ? " bgm-yt-row--playing" : ""}${dragOverTrackIndex === index && dragTrackIndex !== null && dragTrackIndex !== index ? " bgm-playlist-row--drop" : ""}${dragTrackIndex === index ? " bgm-playlist-row--dragging" : ""}`}
													data-track-index={index}
												>
													<span
													className="bgm-drag-handle"
													title={t("bgm.dragToReorder")}
													aria-hidden="true"
													onPointerDown={(event) => {
														event.preventDefault();
														dragOverRef.current = index;
														setDragOverTrackIndex(index);
														setDragTrackIndex(index);
													}}
												>⠿</span>
													<button type="button" className="bgm-playlist-track" onClick={() => playLibraryTrack(track, index, activePlaylist.id)}>
														<span>{track.source === "youtube" ? "▶" : "♪"}</span>
														<span>{track.title}</span>
													</button>
													<button type="button" className="bgm-yt-fav-btn" title={t("bgm.removeFromPlaylist")} onClick={() => updateLibrary((state) => removeTrackFromPlaylist(state, activePlaylist.id, index))}>×</button>
												</div>
											))}
										</div>
									</div>
								)}

						{/* ── Local tab ── */}
						{appTab === "local" && (
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
												<div className="bgm-yt-row-title">
													{localNames[idx]}
												</div>
											</div>
											<button
												type="button"
												className="bgm-yt-fav-btn"
												title={t("bgm.addToPlaylist")}
												onClick={(event) => {
													event.stopPropagation();
													addToActivePlaylist(localLibraryTrack(localPaths[idx], localNames[idx]));
												}}
											>
												＋
											</button>
										</div>
									);
								})}
							</div>
						)}
						{/* ── Drawer handle — inside app so it moves as one unit, no desync ── */}
						<button
							type="button"
							className="bgm-yt-drawer-handle"
							title={t("bgm.drawerTitle")}
							onPointerDown={(e) => {
								e.currentTarget.setPointerCapture(e.pointerId);
									handleDragRef.current = {
										startY: e.clientY,
										startH: ytAppHeight,
										moved: false,
									};
								dragHeightRef.current = ytAppHeight;
							}}
							onPointerMove={(e) => {
								const ref = handleDragRef.current;
								if (!ref) return;
								const delta = e.clientY - ref.startY;
								if (!ref.moved && Math.abs(delta) > 4) ref.moved = true;
								if (ref.moved) {
									const next = Math.max(
										YT_APP_H_MIN,
											Math.min(YT_APP_H_MAX, ref.startH + delta),
										);
										setYtAppHeight(next);
										dragHeightRef.current = next;
									}
							}}
							onPointerUp={() => {
								const ref = handleDragRef.current;
									handleDragRef.current = null;
									if (!ref?.moved) setAppExpanded(false);
									else
										void patchUiPreferences({
											[UI_PREFERENCE_KEYS.youtubeAppHeight]: dragHeightRef.current,
										});
							}}
							onPointerCancel={() => {
								handleDragRef.current = null;
							}}
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
	onAdd: () => void;
}

function YtTrackRow({ video, loading, playing, fav, onPlay, onFav, onAdd }: RowProps) {
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
					{loading
						? t("bgm.loading")
						: playing
							? "▶ " + video.title
							: video.title}
				</div>
				<div className="bgm-yt-row-meta">
					{video.channel && <span>{video.channel}</span>}
					{video.duration && <span>{video.duration}</span>}
				</div>
			</div>
			<button
				type="button"
				className="bgm-yt-fav-btn"
				title={t("bgm.addToPlaylist")}
				onClick={(event) => {
					event.stopPropagation();
					onAdd();
				}}
			>
				＋
			</button>
			<button
				type="button"
				className={`bgm-yt-fav-btn${fav ? " bgm-yt-fav-btn--on" : ""}`}
				title={fav ? t("bgm.favRemove") : t("bgm.favAdd")}
				onClick={(e) => {
					e.stopPropagation();
					onFav();
				}}
			>
				{fav ? "★" : "☆"}
			</button>
		</div>
	);
}
