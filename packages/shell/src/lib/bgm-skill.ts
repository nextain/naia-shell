/**
 * UC8 공간분위기 — skill_youtube_bgm 앱(환경) 도구 (FR-BGM.1, 2026-07-16).
 *
 * BgmPlayer 위젯은 앱이 아니라 descriptor.tools 등록 경로가 없어 new-core 에서
 * 나이아가 BGM 존재를 몰랐다(이식 갭). 배선 = 앱 도구 경로(E1 — naia-agent 무변경):
 *   부팅 시 App.tsx 가 sendAppSkills(BGM_APP_ID, [SKILL_YOUTUBE_BGM]) 등록
 *   → agent appExec 가 LLM 에 노출 → app_tool_call
 *   → ChatArea dispatchAppToolCall 의 BGM 분기가 executeBgmSkill 실행
 *   → 위젯이 이미 듣는 `bgm_youtube_*` agent_response 이벤트로 제어 (BgmPlayer 무변경).
 *
 * 검색 = BGM 사이드카(:18791, Rust 가 기동 #335 — BgmPlayer.ytSearch 와 동일 표면).
 * 액션 모델·볼륨 clamp = naia-agent UC8 어댑터(youtube-bgm-skills.ts) 동형 — 어휘 드리프트 방지.
 */

import { emit } from "@tauri-apps/api/event";
import {
	type BgmLibraryState,
	type BgmLibraryTrack,
	isSameBgmSong,
	loadBgmLibrary,
	mergeBgmHistory,
	normalizeBgmTitle,
	recordBgmHistory,
} from "./bgm-library";
import { bgmLibraryCache, persistBgmLibrary } from "./bgm-library-store";
import {
	type BgmPlaybackPort,
	type BgmPlaybackSnapshot,
	bgmPlayback,
	toBgmObservedContext,
	toBgmPlayToolResult,
	toBgmQueuedToolResult,
} from "./bgm-playback";
import { bgmSidecarBaseUrl, ensureBgmSidecar } from "./bgm-sidecar-url";
import {
	BGM_ACTIONS,
	BGM_APP_ID,
	type BgmAction,
	SKILL_YOUTUBE_BGM,
} from "./bgm-skill-spec";
import { loadConfig } from "./config";
import { recordRadioDjLabEvent } from "./radio-dj-lab-observer";

export { BGM_ACTIONS, BGM_APP_ID, type BgmAction, SKILL_YOUTUBE_BGM };

/** Outlast the 12s iframe diagnostic so a late playing event can still ack. */
const PLAY_ACK_TIMEOUT_MS = 16_000;
const PLAY_ACK_POLL_MS = 200;
const OBSERVED_PLAY_STATUSES = new Set(["playing", "error", "ended"]);

/** Shell policy boundary: only the LLM's structured semantic choice activates DJ mode. */
export function shouldActivateRadioDj(args: Record<string, unknown>): boolean {
	return args.action === "play" && args.mode === "radio_dj";
}

export interface BgmSearchResult {
	id: string;
	title: string;
	thumbnail?: string;
	duration?: string | number;
	channel?: string;
}

const EXPLICIT_LONG_MIX_QUERY_RE =
	/\b(?:megamix|nonstop|full\s*album|\d+\s*hours?|\d+\s*hrs?|long\s*mix|24\/7|live(?:\s*stream|\s*radio)?)\b|긴\s*믹스|장시간|\d+\s*시간|라이브|생방송/i;
const HABITUAL_PLAYLIST_TOKEN_RE =
	/\b(?:playlists?|radio|mix(?:es)?|compilation|bgm)\b|플레이리스트|플리|라디오|모음집?|연속\s*듣기|브금/gi;
const SINGLE_TRACK_HINT_RE =
	/\b(?:official|audio|song|track|mv|lyric)\b|노래|곡|명곡/i;
const SHORT_TRACK_QUERY_RE =
	/\b(?:short|brief|[1-3]\s*min(?:ute)?s?)\b|짧은\s*곡|짧은\s*노래|짧게|[1-3]\s*분/i;
const LONG_MIX_TITLE_RE =
	/\b(?:playlists?|megamix|nonstop|compilation|full\s*album|live|radio|24\/7|\d+\s*hours?|\d+\s*hrs?|relaxing\s*music|meditation\s*music|stress\s*relief|sleep\s*music|healing\s*music)\b|플레이리스트|플리|모음집?|노래\s*모음|곡\s*모음|연속\s*듣기|연속\s*재생|\d+\s*시간|라이브|생방송|라디오|힐링\s*음악|수면\s*음악|명상\s*음악/i;

export function sanitizeRadioDjSearchQuery(query: string): string {
	const trimmed = query.trim();
	if (!trimmed || EXPLICIT_LONG_MIX_QUERY_RE.test(trimmed)) {
		return trimmed;
	}
	const stripped = trimmed
		.replace(HABITUAL_PLAYLIST_TOKEN_RE, " ")
		.replace(/\s+/g, " ")
		.trim();
	const base = stripped || "mood pop";
	if (SINGLE_TRACK_HINT_RE.test(base)) {
		return base;
	}
	return `${base} song Official Audio`;
}

export function buildSingleTrackRetryQuery(searchQuery: string): string {
	const trimmed = searchQuery.trim();
	if (!trimmed) return "pop single track Official Audio MV";
	if (/\bsingle\s+track\b/i.test(trimmed)) {
		return `${trimmed} Official MV`;
	}
	if (/\bofficial\s+audio\b/i.test(trimmed)) {
		const stripped = trimmed
			.replace(/\bsong\s+official\s+audio\b/i, "")
			.replace(/\s+/g, " ")
			.trim();
		return `${stripped || trimmed} single track Official MV`;
	}
	return `${trimmed} single track Official Audio`;
}

export function parseBgmDurationSeconds(
	raw: string | number | undefined,
): number | null {
	if (typeof raw === "number") {
		return Number.isFinite(raw) && raw > 0 ? raw : null;
	}
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (/^\d+$/.test(trimmed)) {
		const sec = Number(trimmed);
		return Number.isFinite(sec) && sec > 0 ? sec : null;
	}
	if (!/^\d+(?::\d{1,2}){1,2}$/.test(trimmed)) return null;
	const parts = trimmed.split(":").map((part) => Number(part));
	if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
	if (parts.length === 2) {
		return parts[0] * 60 + parts[1];
	}
	if (parts.length === 3) {
		return parts[0] * 3600 + parts[1] * 60 + parts[2];
	}
	return null;
}

export interface SingleTrackRejectionCounts {
	mix_title: number;
	no_duration: number;
	too_long: number;
	too_short: number;
}

export interface SingleTrackCandidateInspection {
	candidates: BgmSearchResult[];
	rejectedCounts: SingleTrackRejectionCounts;
}

export function inspectSingleTrackCandidates(
	results: readonly BgmSearchResult[],
	query: string,
): SingleTrackCandidateInspection {
	const rejectedCounts: SingleTrackRejectionCounts = {
		mix_title: 0,
		no_duration: 0,
		too_long: 0,
		too_short: 0,
	};
	if (results.length === 0) {
		return { candidates: [], rejectedCounts };
	}
	if (EXPLICIT_LONG_MIX_QUERY_RE.test(query)) {
		return { candidates: [...results], rejectedCounts };
	}
	const wantShort = SHORT_TRACK_QUERY_RE.test(query);
	const minSec = wantShort ? 30 : 75;
	const maxSec = wantShort ? 210 : 450;

	const candidates: BgmSearchResult[] = [];
	for (const item of results) {
		if (LONG_MIX_TITLE_RE.test(item.title)) {
			rejectedCounts.mix_title += 1;
			continue;
		}
		const sec = parseBgmDurationSeconds(item.duration);
		if (sec === null) {
			rejectedCounts.no_duration += 1;
			continue;
		}
		if (sec < minSec) {
			rejectedCounts.too_short += 1;
			continue;
		}
		if (sec > maxSec) {
			rejectedCounts.too_long += 1;
			continue;
		}
		candidates.push(item);
	}

	return { candidates, rejectedCounts };
}

export function filterSingleTrackCandidates(
	results: readonly BgmSearchResult[],
	query: string,
): BgmSearchResult[] {
	return inspectSingleTrackCandidates(results, query).candidates;
}

export interface BgmRecentTrack extends BgmSearchResult {
	playedAt: number;
}

export const BGM_RECENT_KEY = "yt-bgm-recent-v1";
const RECENT_TRACK_LIMIT = 20;
let legacyRecentMigration: Promise<boolean> | null = null;

/** Keep the skill's existing public export while sharing the library rule. */
export {
	extractBgmSongCoreKeys,
	isSameBgmSong,
	normalizeBgmTitle,
} from "./bgm-library";

function readLegacyRecentTracks(): BgmRecentTrack[] {
	try {
		if (typeof localStorage === "undefined") return [];
		const parsed = JSON.parse(localStorage.getItem(BGM_RECENT_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(item): item is BgmRecentTrack =>
					item !== null &&
					typeof item === "object" &&
					typeof item.id === "string" &&
					typeof item.title === "string" &&
					Number.isFinite(item.playedAt),
			)
			.slice(0, RECENT_TRACK_LIMIT);
	} catch {
		return [];
	}
}

function recentToLibraryTrack(track: BgmRecentTrack): BgmLibraryTrack {
	return {
		id: `youtube:${track.id}`,
		source: "youtube",
		youtubeId: track.id,
		title: track.title,
		...(track.thumbnail ? { thumbnail: track.thumbnail } : {}),
		playedAt: track.playedAt,
	};
}

function libraryToRecentTrack(track: BgmLibraryTrack): BgmRecentTrack | null {
	if (track.source !== "youtube" || !track.youtubeId) return null;
	return {
		id: track.youtubeId,
		title: track.title,
		...(track.thumbnail ? { thumbnail: track.thumbnail } : {}),
		playedAt: track.playedAt ?? 0,
	};
}

function recentIsRepresented(history: readonly BgmLibraryTrack[], recent: BgmRecentTrack): boolean {
	const normalized = normalizeBgmTitle(recent.title);
	return history.some(
		(track) =>
			track.source === "youtube" &&
			((track.youtubeId === recent.id || track.id === recent.id || track.id === `youtube:${recent.id}`) ||
				(Boolean(normalized) && normalizeBgmTitle(track.title) === normalized)),
	);
}

function allRecentRepresented(history: readonly BgmLibraryTrack[], recent: readonly BgmRecentTrack[]): boolean {
	return recent.every((item) => recentIsRepresented(history, item));
}

function legacyRecentSignature(recent: readonly BgmRecentTrack[]): string {
	return JSON.stringify(recent);
}

function removeLegacyRecentTracksIfUnchanged(expected: readonly BgmRecentTrack[]): void {
	try {
		if (typeof localStorage === "undefined") return;
		if (legacyRecentSignature(readLegacyRecentTracks()) !== legacyRecentSignature(expected)) return;
		localStorage.removeItem(BGM_RECENT_KEY);
	} catch {}
}

function scheduleLegacyRecentMigration(state: BgmLibraryState, legacy: readonly BgmRecentTrack[]): void {
	if (legacy.length === 0 || legacyRecentMigration) return;
	const merged = mergeBgmHistory(state, legacy.map(recentToLibraryTrack));
	legacyRecentMigration = persistBgmLibrary(merged)
		.then((persisted) => {
			if (persisted && allRecentRepresented(merged.history, legacy)) {
				removeLegacyRecentTracksIfUnchanged(legacy);
			}
			return persisted;
		})
		.catch(() => false)
		.finally(() => {
			legacyRecentMigration = null;
		});
}

export function getBgmRecentTracks(): BgmRecentTrack[] {
	const legacy = readLegacyRecentTracks();
	const cached = bgmLibraryCache();
	if (!cached) return legacy;
	const merged = legacy.length ? mergeBgmHistory(cached, legacy.map(recentToLibraryTrack)) : cached;
	if (legacy.length) scheduleLegacyRecentMigration(cached, legacy);
	return merged.history.flatMap((track) => {
		const recent = libraryToRecentTrack(track);
		return recent ? [recent] : [];
	}).slice(0, RECENT_TRACK_LIMIT);
}

/** Persist only a track that the iframe has actually reported as playing. */
export function recordBgmPlayedTrack(
	track: BgmSearchResult,
	playedAt = Date.now(),
): Promise<boolean> {
	const timestamp = Number.isFinite(playedAt) && playedAt >= 0 ? playedAt : Date.now();
	const legacyBeforeRecord = readLegacyRecentTracks();
	try {
		if (typeof localStorage !== "undefined") {
			const normalized = normalizeBgmTitle(track.title);
			const next = [
				{ ...track, playedAt: timestamp },
				...legacyBeforeRecord.filter(
					(item) =>
						item.id !== track.id &&
						(!normalized || normalizeBgmTitle(item.title) !== normalized),
				),
			].slice(0, RECENT_TRACK_LIMIT);
			localStorage.setItem(BGM_RECENT_KEY, JSON.stringify(next));
		}
	} catch {}

	const cached = bgmLibraryCache();
	if (!cached) return Promise.resolve(false);
	const recentAfterRecord = readLegacyRecentTracks();
	let nextLibrary = legacyBeforeRecord.length
		? mergeBgmHistory(cached, legacyBeforeRecord.map(recentToLibraryTrack))
		: cached;
	nextLibrary = recordBgmHistory(
		nextLibrary,
		{
			id: `youtube:${track.id}`,
			source: "youtube",
			youtubeId: track.id,
			title: track.title,
			...(track.thumbnail ? { thumbnail: track.thumbnail } : {}),
		},
		timestamp,
	);
	return persistBgmLibrary(nextLibrary)
		.then((persisted) => {
			if (persisted && allRecentRepresented(nextLibrary.history, recentAfterRecord)) {
				removeLegacyRecentTracksIfUnchanged(recentAfterRecord);
			}
			return persisted;
		})
		.catch(() => false);
}

/** 주입 가능 deps — 테스트 헤르메틱(사이드카/Tauri 불요). */
export interface BgmSkillDeps {
	search: (query: string) => Promise<BgmSearchResult[]>;
	/** 위젯(BgmPlayer)이 Shell 전용 bgm_command 이벤트로 받는 payload를 발사. */
	emitBgm: (payload: Record<string, unknown>) => Promise<void>;
	playback: BgmPlaybackPort;
	/** Wait until this playbackId is playing/error/ended. Tests omit this. */
	waitForAck?: (playbackId: string) => Promise<BgmPlaybackSnapshot | null>;
	/** Wait until playbackId changes and the new track is observed. */
	waitForNavigateAck?: (
		previousPlaybackId: string | undefined,
	) => Promise<BgmPlaybackSnapshot | null>;
	/** Number of YouTube favorites available to next/prev navigation. */
	favoriteCount?: () => number;
	favoriteTracks?: () => BgmSearchResult[];
	library?: () => BgmLibraryState;
	recentTracks?: () => BgmRecentTrack[];
	now?: () => number;
}

function isFavoriteTrack(item: unknown): item is BgmSearchResult {
	return (
		item !== null &&
		typeof item === "object" &&
		typeof (item as BgmSearchResult).id === "string" &&
		typeof (item as BgmSearchResult).title === "string"
	);
}

/**
 * Favorites SoT (#476): the workspace naia-settings config
 * (`bgmYoutubeFavorites`) once it exists; the legacy webview localStorage key
 * "yt-bgm-favorites" is only a pre-migration fallback (BgmPlayer migrates and
 * clears it on mount).
 */
export function persistedFavoriteTracks(): BgmSearchResult[] {
	const config = loadConfig();
	// SoT 는 샌드박스 — BgmPlayer 가 hydrate 한 캐시를 우선 읽는다.
	const cachedLibrary = bgmLibraryCache();
	if (cachedLibrary || config?.bgmLibrary) {
		return (cachedLibrary ?? loadBgmLibrary(config?.bgmLibrary)).likes.flatMap((track) =>
			track.source === "youtube" && track.youtubeId
				? [{ id: track.youtubeId, title: track.title, thumbnail: track.thumbnail }]
				: [],
		);
	}
	const stored = config?.bgmYoutubeFavorites;
	if (Array.isArray(stored)) return stored.filter(isFavoriteTrack);
	try {
		const parsed = JSON.parse(localStorage.getItem("yt-bgm-favorites") ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isFavoriteTrack);
	} catch {
		return [];
	}
}

function persistedFavoriteCount(): number {
	return persistedFavoriteTracks().length;
}

function persistedMusicLibrary(): BgmLibraryState {
	return bgmLibraryCache() ?? loadBgmLibrary(loadConfig()?.bgmLibrary);
}

/** 사이드카 검색 — BgmPlayer.ytSearch 동형 표면(GET /yt/search?q=&max=). */
function shouldWaitForPlayAck(): boolean {
	if (import.meta.env.MODE === "web") return false;
	return typeof window === "undefined" || !("__E2E_OUTBOUND__" in window);
}

interface WebCatalogEntry {
	id: string;
	title: string;
	channel: string;
	duration: string;
	keywords: string[];
}

export const WEB_YOUTUBE_CATALOG: readonly WebCatalogEntry[] = [
	{
		id: "jfKfPfyJRdk",
		title: "Lofi Girl - Cozy Study Session Beats (Official Audio)",
		channel: "Lofi Girl",
		duration: "3:42",
		keywords: [
			"lofi",
			"lo-fi",
			"로파이",
			"hip hop",
			"beats",
			"study",
			"relax",
			"공부",
			"집중",
			"잔잔한",
			"브금",
			"bgm",
			"유튜브",
			"유투브",
			"youtube",
			"음악",
			"노래",
		],
	},
	{
		id: "DWcJFNfaw9c",
		title: "ChilledCow - Midnight Coffee Lofi (Official Audio)",
		channel: "Lofi Girl",
		duration: "3:18",
		keywords: ["lofi", "로파이", "chill", "coffee", "카페", "밤", "새벽"],
	},
	{
		id: "Dx5qFachd3A",
		title: "Coffee Shop Trio - Warm Jazz Lounge (Official Audio)",
		channel: "Cafe Music BGM",
		duration: "3:54",
		keywords: ["jazz", "재즈", "cafe", "lounge", "카페", "분위기"],
	},
	{
		id: "4xDzrJKXOOY",
		title: "Synthwave Goose - Neon Horizon 1984 (Official Audio)",
		channel: "Lofi Synthwave",
		duration: "3:48",
		keywords: [
			"synthwave",
			"retrowave",
			"80s",
			"neon",
			"신스웨이브",
			"신나는",
			"일렉",
			"코딩",
		],
	},
	{
		id: "3jWRrafhO7M",
		title: "Joe Hisaishi - Summer Piano Theme (Studio Ghibli)",
		channel: "Ghibli Piano",
		duration: "3:36",
		keywords: ["ghibli", "studio ghibli", "지브리", "피아노", "애니"],
	},
	{
		id: "WPni755-Krg",
		title: "Yiruma - River Flows in You (Solo Piano Official Audio)",
		channel: "Yiruma Official",
		duration: "3:30",
		keywords: [
			"piano",
			"solo piano",
			"피아노",
			"이루마",
			"연주곡",
			"kdrama",
			"korean drama",
			"ost",
			"드라마",
		],
	},
	{
		id: "n61ULEU7CO0",
		title: "Clair de Lune - Debussy Classical Study Piece",
		channel: "Classical Halidon",
		duration: "4:12",
		keywords: [
			"classical",
			"클래식",
			"concentration",
			"dark academia",
			"darkacademia",
			"독서",
		],
	},
	{
		id: "7NOSDKb0HlU",
		title: "Tokyo Sunset - Japanese City Pop Groove (Official Audio)",
		channel: "City Pop Tokyo",
		duration: "3:58",
		keywords: [
			"citypop",
			"city pop",
			"japanese",
			"jpop",
			"j-pop",
			"시티팝",
			"제이팝",
			"일본",
		],
	},
	{
		id: "GdU6G7b8tqg",
		title: "Seoul Starlight - K-Pop Upbeat Drive (Official Audio)",
		channel: "K-Pop Studio",
		duration: "3:26",
		keywords: [
			"kpop",
			"k-pop",
			"케이팝",
			"가요",
			"아이돌",
			"인기",
			"신나는 노래",
			"hits",
			"popular",
		],
	},
	{
		id: "k3WkJq478To",
		title: "Rio Morning - Bossa Nova Acoustic Guitar (Official Audio)",
		channel: "Bossa Cafe",
		duration: "3:22",
		keywords: ["bossa", "bossa nova", "보사노바", "morning", "아침", "어쿠스틱"],
	},
	{
		id: "mPZkdNFkNps",
		title: "Rainy Window - Gentle Rain & Forest Soundscape",
		channel: "Nature Soundscape",
		duration: "4:05",
		keywords: [
			"rain",
			"nature",
			"forest",
			"birds",
			"water",
			"white noise",
			"비",
			"빗소리",
			"자연",
			"숲",
		],
	},
	{
		id: "1ZYbU82GVz4",
		title: "Deep Cosmos - Ambient Drone & New Age Soundscape",
		channel: "Ambient Worlds",
		duration: "4:15",
		keywords: [
			"ambient",
			"atmospheric",
			"drone",
			"meditation",
			"binaural",
			"new age",
			"new-age",
			"celtic",
			"fantasy",
			"앰비언트",
			"명상",
			"뉴에이지",
			"판타지",
		],
	},
];

function extractDirectYoutubeId(raw: string): string | null {
	const trimmed = raw.trim();
	if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
	try {
		const url = new URL(trimmed);
		const host = url.hostname.toLowerCase();
		if (host === "youtu.be" || host.endsWith(".youtu.be")) {
			const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
			return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
		}
		if (
			host === "youtube.com" ||
			host.endsWith(".youtube.com") ||
			host === "youtube-nocookie.com" ||
			host.endsWith(".youtube-nocookie.com")
		) {
			const v = url.searchParams.get("v") ?? "";
			if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
			if (url.pathname.startsWith("/embed/")) {
				const id = url.pathname.split("/")[2] ?? "";
				return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
			}
		}
	} catch {
		// Not a URL
	}
	return null;
}

export function searchWebYoutubeCatalog(query: string): BgmSearchResult[] {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const directId = extractDirectYoutubeId(trimmed);
	if (directId) {
		const existing = WEB_YOUTUBE_CATALOG.find((item) => item.id === directId);
		if (existing) {
			return [
				{
					id: existing.id,
					title: existing.title,
					channel: existing.channel,
					duration: existing.duration,
					thumbnail: `https://i.ytimg.com/vi/${existing.id}/hqdefault.jpg`,
				},
			];
		}
		return [
			{
				id: directId,
				title: `YouTube Video (${directId})`,
				channel: "YouTube",
				duration: "3:30",
				thumbnail: `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
			},
		];
	}
	const lower = trimmed.toLowerCase();
	const tokens = lower.split(/[\s,./!?]+/).filter(Boolean);
	const scored = WEB_YOUTUBE_CATALOG.map((entry, idx) => {
		let score = 0;
		const hay = `${entry.title} ${entry.channel} ${entry.keywords.join(" ")}`.toLowerCase();
		for (const kw of entry.keywords) {
			if (lower.includes(kw.toLowerCase())) score += 10;
		}
		for (const token of tokens) {
			if (token.length >= 2 && hay.includes(token)) score += 4;
		}
		return { entry, score, idx };
	});
	scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
	return scored.map(({ entry }) => ({
		id: entry.id,
		title: entry.title,
		channel: entry.channel,
		duration: entry.duration,
		thumbnail: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
	}));
}

const WEB_BGM_CATEGORY_MATCHERS: ReadonlyArray<{
	category: string;
	query: string;
	pattern: RegExp;
}> = [
	{ category: "kpop", query: "kpop hits popular songs playlist", pattern: /(?:케이팝|k-?pop|아이돌)/i },
	{ category: "jpop", query: "jpop anime ost popular songs", pattern: /(?:제이팝|j-?pop|애니)/i },
	{ category: "citypop", query: "japanese city pop 80s playlist", pattern: /(?:시티\s*팝|city\s*pop)/i },
	{ category: "chillhop", query: "chillhop jazzy hip hop beats", pattern: /(?:칠홉|chillhop)/i },
	{ category: "lofi", query: "lofi hip hop beats to study relax", pattern: /(?:로파이|lo-?fi)/i },
	{ category: "jazz", query: "smooth jazz cafe bossa nova", pattern: /(?:재즈|jazz|보사노바)/i },
	{ category: "classical", query: "classical music orchestra study", pattern: /(?:클래식|classical|오케스트라)/i },
	{ category: "piano", query: "relaxing piano music study", pattern: /(?:피아노|piano)/i },
	{ category: "acoustic", query: "acoustic guitar instrumental relaxing", pattern: /(?:어쿠스틱|acoustic|통기타)/i },
	{ category: "cinematic", query: "epic cinematic soundtrack instrumental", pattern: /(?:시네마틱|cinematic|영화\s*음악|ost)/i },
	{ category: "ambient", query: "ambient atmospheric space music", pattern: /(?:앰비언트|ambient|명상)/i },
	{ category: "synthwave", query: "synthwave retrowave 80s electronic", pattern: /(?:신스웨이브|synthwave|레트로)/i },
	{ category: "gugak", query: "국악 전통음악 가야금 해금 연주", pattern: /(?:국악|gugak|가야금|해금)/i },
	{ category: "rain", query: "rain sounds thunderstorm relaxing sleep", pattern: /(?:빗소리|비\s*소리|비\s*오는\s*소리|rain)/i },
	{ category: "nature", query: "nature sounds forest birds ocean waves", pattern: /(?:자연의?\s*소리|숲\s*소리|파도\s*소리|nature)/i },
	{ category: "cafe", query: "coffee shop background noise jazz", pattern: /(?:카페\s*음악|카페\s*소음|cafe)/i },
	{ category: "whitenoise", query: "white noise study focus concentration", pattern: /(?:화이트\s*노이즈|백색\s*소음|white\s*noise)/i },
	{ category: "pop", query: "pop hits english top songs", pattern: /(?:팝송|\bpop\b)/i },
];

export function classifyWebBgmIntent(
	rawText: string,
): Record<string, unknown> | null {
	const text = rawText.trim();
	if (!text) return null;
	const normalized = text.replace(/[.!?~]+$/g, "").trim();

	const hasMediaNoun =
		/(?:유튜브|유투브|youtube|음악|노래|브금|\bbgm\b|\bmusic\b)/i.test(
			normalized,
		);
	const matched = WEB_BGM_CATEGORY_MATCHERS.find(({ pattern }) =>
		pattern.test(normalized),
	);

	if (
		hasMediaNoun &&
		/(?:일시\s*정지|잠깐\s*멈춰|\bpause\b)/i.test(normalized)
	) {
		return { action: "pause" };
	}

	if (
		hasMediaNoun &&
		/(?:다시\s*틀|이어서?\s*틀|계속\s*틀|다시\s*재생|재개|\bresume\b)/i.test(
			normalized,
		)
	) {
		return { action: "resume" };
	}

	if (
		(hasMediaNoun &&
			/(?:멈춰|멈춤|꺼\s*줘|꺼줘|꺼\b|중지|정지|그만|종료|\bstop\b|\boff\b)/i.test(
				normalized,
			)) ||
		(bgmPlayback.current()?.status === "playing" &&
			/^(?:멈춰|멈춰\s*줘|멈춰줘|정지|중지|그만|꺼|꺼\s*줘|꺼줘|stop)$/i.test(
				normalized,
			))
	) {
		return { action: "stop" };
	}

	if (
		/^(?:다음\s*곡|다음\s*노래|유튜브\s*다음|유투브\s*다음|음악\s*다음)(?:\s*틀어\s*줘|\s*틀어줘|\s*줘)?$/i.test(
			normalized,
		)
	) {
		return { action: "next" };
	}

	if (
		/^(?:이전\s*곡|이전\s*노래|유튜브\s*이전|유투브\s*이전|음악\s*이전)(?:\s*틀어\s*줘|\s*틀어줘|\s*줘)?$/i.test(
			normalized,
		)
	) {
		return { action: "prev" };
	}

	const hasPlayVerb =
		/(?:틀어|재생|플레이|켜\s*줘|켜줘|들려\s*줘|들려줘|듣고\s*싶|\bplay\b)/i.test(
			normalized,
		);
	if (hasPlayVerb && (hasMediaNoun || Boolean(matched))) {
		return {
			action: "play",
			category: matched?.category ?? "lofi",
			query: matched?.query ?? "lofi hip hop beats to study relax",
		};
	}

	if (
		/^(?:유튜브|유투브|youtube)(?:\s*좀)?\s*(?:보여\s*줘|보여줘|열어\s*줘|열어줘)?$/i.test(
			normalized,
		)
	) {
		return {
			action: "play",
			category: "lofi",
			query: "lofi hip hop beats to study relax",
		};
	}

	return null;
}

function isObservedPlayback(
	current: BgmPlaybackSnapshot,
	opts: { playbackId?: string; previousPlaybackId?: string },
): boolean {
	if (!OBSERVED_PLAY_STATUSES.has(current.status)) return false;
	if (opts.playbackId && current.playbackId !== opts.playbackId) return false;
	if (
		opts.previousPlaybackId !== undefined &&
		current.playbackId === opts.previousPlaybackId
	) {
		return false;
	}
	return true;
}

/** Wait for confirmed playing (or a hard error/ended). Loading is not enough. */
export async function waitForBgmObservedPlayback(
	playback: BgmPlaybackPort,
	opts: {
		playbackId?: string;
		previousPlaybackId?: string;
		timeoutMs?: number;
		pollMs?: number;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<BgmPlaybackSnapshot | null> {
	const timeoutMs = opts.timeoutMs ?? PLAY_ACK_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? PLAY_ACK_POLL_MS;
	const now = opts.now ?? Date.now;
	const sleep =
		opts.sleep ??
		((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	const deadline = now() + timeoutMs;
	const navigateRequestDeadline =
		opts.previousPlaybackId !== undefined ? now() + Math.min(timeoutMs, 1_200) : deadline;
	while (now() < deadline) {
		const current = playback.current();
		if (current && isObservedPlayback(current, opts)) return current;
		if (
			opts.previousPlaybackId !== undefined &&
			now() >= navigateRequestDeadline &&
			(!current || current.playbackId === opts.previousPlaybackId)
		) {
			return current;
		}
		await sleep(pollMs);
	}
	return playback.current();
}

async function sidecarSearch(query: string): Promise<BgmSearchResult[]> {
	if (import.meta.env.MODE === "web") {
		return searchWebYoutubeCatalog(query);
	}
	const base = (await ensureBgmSidecar()) || bgmSidecarBaseUrl();
	const res = await fetch(
		`${base}/yt/search?q=${encodeURIComponent(query)}&max=12`,
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `BGM search server error (HTTP ${res.status})`);
	}
	const data = (await res.json()) as { results?: BgmSearchResult[] };
	return data.results ?? [];
}

const defaultDeps: BgmSkillDeps = {
	search: sidecarSearch,
	// Tauri emit은 JS bgm_command 리스너로 브로드캐스트되어 BgmPlayer가 즉시 반응한다.
	// Keep Shell-owned environment commands off the Agent protocol stream.
	// Broadcasting them as agent_response makes the core router diagnose every
	// queue operation as an unknown Agent variant.
	emitBgm: (payload) => emit("bgm_command", JSON.stringify(payload)),
	playback: bgmPlayback,
	waitForAck: (playbackId) => {
		if (import.meta.env.MODE === "web") {
			const cur = bgmPlayback.current();
			if (cur && cur.playbackId === playbackId && cur.status === "requested") {
				bgmPlayback.observe({
					playbackId,
					sequence: cur.sequence + 1,
					status: "playing",
				});
			}
			return Promise.resolve(bgmPlayback.current());
		}
		return shouldWaitForPlayAck()
			? waitForBgmObservedPlayback(bgmPlayback, { playbackId })
			: Promise.resolve(bgmPlayback.current());
	},
	waitForNavigateAck: (previousPlaybackId) =>
		shouldWaitForPlayAck()
			? waitForBgmObservedPlayback(bgmPlayback, { previousPlaybackId })
			: Promise.resolve(bgmPlayback.current()),
	favoriteCount: persistedFavoriteCount,
	favoriteTracks: persistedFavoriteTracks,
	library: persistedMusicLibrary,
	recentTracks: getBgmRecentTracks,
};

const RADIO_DJ_RECOVERY_SEARCH_LIMIT = 2;

interface RadioDjRecoveryPlan {
	generation: number;
	query: string;
	deps: BgmSkillDeps;
	playbackId: string;
	searches: number;
	attemptedIds: Set<string>;
	attemptedTitles: Set<string>;
	inFlight?: Promise<RadioDjRecoveryResult>;
}

export type RadioDjRecoveryResult =
	| { recovered: true; playbackId: string; selected: BgmSearchResult }
	| {
			recovered: false;
			reason: "not_active" | "stale_playback" | "cancelled" | "exhausted";
			searches: number;
	  };

let radioDjRecoveryGeneration = 0;
let radioDjRecoveryPlan: RadioDjRecoveryPlan | null = null;

/** Cancel any delayed search before a user-owned command can be overwritten. */
export function cancelRadioDjRecovery(): void {
	radioDjRecoveryGeneration += 1;
	radioDjRecoveryPlan = null;
}

/** Keep the same bounded recovery session when a prepared queue item starts. */
export function continueRadioDjRecoveryAfterQueueAdvance(
	previousPlaybackId: string,
	nextPlaybackId: string,
): void {
	if (radioDjRecoveryPlan?.playbackId === previousPlaybackId) {
		radioDjRecoveryPlan.playbackId = nextPlaybackId;
	}
}

function configureRadioDjRecovery(
	query: string,
	selected: BgmSearchResult,
	deps: BgmSkillDeps,
): void {
	const current = deps.playback.current();
	if (!current || current.selected.videoId !== selected.id) {
		cancelRadioDjRecovery();
		return;
	}
	const normalizedTitle = normalizeBgmTitle(selected.title);
	radioDjRecoveryGeneration += 1;
	radioDjRecoveryPlan = {
		generation: radioDjRecoveryGeneration,
		query,
		deps,
		playbackId: current.playbackId,
		searches: 0,
		attemptedIds: new Set([selected.id]),
		attemptedTitles: new Set(normalizedTitle ? [normalizedTitle] : []),
	};
}

/**
 * Search for a fresh Radio DJ candidate only after the prepared queue is empty.
 * Each session gets at most two recovery searches, and stale/late failures can
 * never replace a newer user-owned playback.
 */
export async function recoverRadioDjPlayback(
	failedPlaybackId: string,
): Promise<RadioDjRecoveryResult> {
	const plan = radioDjRecoveryPlan;
	if (!plan) return { recovered: false, reason: "not_active", searches: 0 };
	if (plan.playbackId !== failedPlaybackId) {
		return {
			recovered: false,
			reason: "stale_playback",
			searches: plan.searches,
		};
	}
	if (plan.inFlight) return plan.inFlight;

	const recovery = (async (): Promise<RadioDjRecoveryResult> => {
		while (plan.searches < RADIO_DJ_RECOVERY_SEARCH_LIMIT) {
			if (
				radioDjRecoveryPlan !== plan ||
				plan.generation !== radioDjRecoveryGeneration
			) {
				return {
					recovered: false,
					reason: "cancelled",
					searches: plan.searches,
				};
			}
			const current = plan.deps.playback.current();
			if (
				current?.playbackId !== failedPlaybackId ||
				!["error", "timeout"].includes(current.status)
			) {
				return {
					recovered: false,
					reason: "stale_playback",
					searches: plan.searches,
				};
			}

			plan.searches += 1;
			let results: BgmSearchResult[] = [];
			try {
				results = await plan.deps.search(plan.query);
			} catch {
				// A transient sidecar/network failure may use the one remaining bounded
				// attempt. The caller still receives one terminal result, never a loop.
				continue;
			}
			if (
				radioDjRecoveryPlan !== plan ||
				plan.generation !== radioDjRecoveryGeneration
			) {
				return {
					recovered: false,
					reason: "cancelled",
					searches: plan.searches,
				};
			}

			const recent = plan.deps.recentTracks?.() ?? [];
			const recentIds = new Set(recent.map((track) => track.id));
			const recentTitles = new Set(
				recent.map((track) => normalizeBgmTitle(track.title)).filter(Boolean),
			);
			const candidateResults = filterSingleTrackCandidates(
				results,
				sanitizeRadioDjSearchQuery(plan.query),
			);
			const selected = candidateResults.find((result) => {
				const normalizedTitle = normalizeBgmTitle(result.title);
				const matchesRecentSong = recent.some((track) =>
					isSameBgmSong(result.title, track.title),
				);
				const matchesAttemptedSong = [...plan.attemptedTitles].some(
					(attemptedTitle) => isSameBgmSong(result.title, attemptedTitle),
				);
				return (
					!plan.attemptedIds.has(result.id) &&
					!recentIds.has(result.id) &&
					!matchesRecentSong &&
					!matchesAttemptedSong &&
					(!normalizedTitle ||
						(!plan.attemptedTitles.has(normalizedTitle) &&
							!recentTitles.has(normalizedTitle)))
				);
			});
			if (!selected) continue;

			plan.attemptedIds.add(selected.id);
			const normalizedTitle = normalizeBgmTitle(selected.title);
			if (normalizedTitle) plan.attemptedTitles.add(normalizedTitle);
			const playback = plan.deps.playback.request({
				videoId: selected.id,
				title: selected.title,
			});
			plan.playbackId = playback.playbackId;
			await plan.deps.emitBgm({
				type: "bgm_youtube_play",
				playbackId: playback.playbackId,
				videoId: selected.id,
				title: selected.title,
				...(selected.thumbnail ? { thumbnail: selected.thumbnail } : {}),
				recovery: "radio_dj_search",
			});
			return {
				recovered: true,
				playbackId: playback.playbackId,
				selected,
			};
		}

		if (radioDjRecoveryPlan === plan) radioDjRecoveryPlan = null;
		return {
			recovered: false,
			reason: "exhausted",
			searches: plan.searches,
		};
	})();
	plan.inFlight = recovery;
	const result = await recovery;
	if (plan.inFlight === recovery) plan.inFlight = undefined;
	return result;
}

/** 도메인: volume 0..1 clamp(순수) — agent UC8 어댑터 clampVolume 동형. 비유한=0.5. */
export function clampVolume(v: unknown): number {
	const n = typeof v === "number" && Number.isFinite(v) ? v : 0.5;
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * skill_youtube_bgm 실행. 에이전트가 추측으로 성공을 판정하지 않도록
 * 모든 정상 실행 결과는 구조화 JSON으로 반환한다.
 */
export async function executeBgmSkill(
	args: Record<string, unknown>,
	deps: BgmSkillDeps = defaultDeps,
): Promise<string> {
	const action = args?.action;
	const safeAction =
		typeof action === "string" &&
		(BGM_ACTIONS as readonly string[]).includes(action)
			? (action as BgmAction)
			: undefined;
	if (safeAction) {
		recordRadioDjLabEvent("bgm.tool", {
			action: safeAction,
			phase: "request",
		});
	}
	try {
		const result = await executeBgmSkillCore(args, deps);
		if (safeAction) {
			let outcome: "accepted" | "queued" | "rejected" = "accepted";
			try {
				const parsed = JSON.parse(result) as { ok?: unknown; queued?: unknown };
				if (parsed.ok === false) outcome = "rejected";
				else if (parsed.queued) outcome = "queued";
			} catch {
				// A result that is not structured JSON is not exposed to the recorder.
			}
			recordRadioDjLabEvent("bgm.tool", {
				action: safeAction,
				phase: "result",
				outcome,
			});
		}
		return result;
	} catch (error) {
		if (safeAction) {
			recordRadioDjLabEvent("bgm.tool", {
				action: safeAction,
				phase: "result",
				outcome: "failed",
			});
		}
		throw error;
	}
}

async function executeBgmSkillCore(
	args: Record<string, unknown>,
	deps: BgmSkillDeps,
): Promise<string> {
	const action = args?.action;
	if (
		typeof action !== "string" ||
		!(BGM_ACTIONS as readonly string[]).includes(action)
	) {
		throw new Error(`unknown action (allowed: ${BGM_ACTIONS.join("/")})`);
	}
	const act = action as BgmAction;

	const enqueueTrack = async (
		track: BgmSearchResult,
		forceReplace = false,
	): Promise<string> => {
		// Speech activities such as Radio DJ own their current selection. A new
		// activity request means "change the music now", not "play this later".
		// Ordinary chat/tool requests keep the queue-preserving behavior below.
		if (forceReplace || args.replace === true) {
			const playback = deps.playback.request({
				videoId: track.id,
				title: track.title,
			});
			await deps.emitBgm({
				type: "bgm_youtube_play",
				playbackId: playback.playbackId,
				videoId: track.id,
				title: track.title,
				...(track.thumbnail ? { thumbnail: track.thumbnail } : {}),
			});
			const observed =
				(await deps.waitForAck?.(playback.playbackId)) ??
				(import.meta.env.MODE === "web"
					? deps.playback.observe({
							playbackId: playback.playbackId,
							sequence: playback.sequence + 1,
							status: "playing",
						})
					: null) ??
				playback;
			return JSON.stringify(toBgmPlayToolResult(observed));
		}
		const result = deps.playback.enqueue({
			videoId: track.id,
			title: track.title,
		});
		if (result.disposition === "play") {
			await deps.emitBgm({
				type: "bgm_youtube_play",
				playbackId: result.playback.playbackId,
				videoId: track.id,
				title: track.title,
				...(track.thumbnail ? { thumbnail: track.thumbnail } : {}),
			});
			const observed =
				(await deps.waitForAck?.(result.playback.playbackId)) ??
				(import.meta.env.MODE === "web"
					? deps.playback.observe({
							playbackId: result.playback.playbackId,
							sequence: result.playback.sequence + 1,
							status: "playing",
						})
					: null) ??
				result.playback;
			return JSON.stringify(toBgmPlayToolResult(observed));
		}
		await deps.emitBgm({
			type: "bgm_youtube_enqueue",
			videoId: track.id,
			title: track.title,
			queueId: result.queued.queueId,
			position: result.queued.position,
			...(track.thumbnail ? { thumbnail: track.thumbnail } : {}),
		});
		return JSON.stringify(
			toBgmQueuedToolResult(result.queued, result.queueLength),
		);
	};

	if (act === "status") {
		const recentTracks = (deps.recentTracks?.() ?? []).slice(0, 20).map((track) => ({
			videoId: track.id,
			title: track.title,
		}));
		const favoriteTracks = (deps.favoriteTracks?.() ?? []).slice(0, 10).map((track) => ({
			videoId: track.id,
			title: track.title,
		}));
		const observedContext = toBgmObservedContext(
			deps.playback.current(),
			deps.now?.() ?? Date.now(),
			deps.playback.queue(),
		);
		const instruction = observedContext.announceTrack && observedContext.currentTrack
			? `Now playing is confirmed: "${observedContext.currentTrack.title}". Answer with this track title.`
			: observedContext.pendingTrack
				? `Track "${observedContext.pendingTrack.title}" was requested and is awaiting playback confirmation (${observedContext.pendingTrack.status}). Tell the user this track was requested and is loading/confirming; do not claim no music was requested and do not call play again.`
				: "No active track is playing right now.";
		return JSON.stringify({
			library: summarizeLibrary(deps.library?.()),
			ok: true,
			action: act,
			...observedContext,
			recentTracks,
			favoriteTracks,
			instruction,
		});
	}

	if (act === "play") {
		const radioDjRequested = shouldActivateRadioDj(args);
		const preserveActive = args.preserveActive === true;
		const currentSnapshot = deps.playback.current();
		const activeStatus = currentSnapshot?.status;
		const hasActivePlayback =
			Boolean(currentSnapshot) &&
			(activeStatus === "playing" ||
				activeStatus === "requested" ||
				activeStatus === "loading");
		// Replacements and starts own the surface immediately. A queue-preserving
		// request may be a prepared DJ fallback, so it keeps the current plan.
		if (
			(radioDjRequested && !(preserveActive && hasActivePlayback)) ||
			args.replace === true ||
			!activeStatus ||
			["ended", "error", "timeout"].includes(activeStatus)
		) {
			cancelRadioDjRecovery();
		}
		const videoId = args.videoId;
		if (typeof videoId === "string" && videoId.trim()) {
			return enqueueTrack(
				{
					id: videoId,
					title: typeof args.title === "string" ? args.title : "",
				},
				radioDjRequested && !(preserveActive && hasActivePlayback),
			);
		}
		const rawQuery =
			typeof args.query === "string" && args.query.trim()
				? args.query
				: typeof args.category === "string" && args.category.trim()
					? (WEB_BGM_CATEGORY_MATCHERS.find(
							(m) => m.category === args.category,
						)?.query ?? args.category)
					: undefined;
		if (typeof rawQuery !== "string" || !rawQuery.trim())
			throw new Error("play requires query or videoId");
		const query = rawQuery;
		const searchQuery = radioDjRequested
			? sanitizeRadioDjSearchQuery(query)
			: query;
		const results = await deps.search(searchQuery);
		if (results.length === 0)
			return JSON.stringify({
				ok: false,
				action: act,
				reason: "no_search_results",
				query,
			});
		const currentVideoId = currentSnapshot?.selected.videoId;
		const currentTitle = currentSnapshot?.selected.title ?? "";
		const recent = deps.recentTracks?.() ?? [];
		const recentIds = new Set(recent.map((track) => track.id));
		const recentTitles = new Set(
			recent.map((track) => normalizeBgmTitle(track.title)).filter(Boolean),
		);
		const isFreshCandidate = (result: BgmSearchResult): boolean =>
			result.id !== currentVideoId &&
			!(
				(radioDjRequested || args.replace === true) &&
				currentTitle &&
				isSameBgmSong(result.title, currentTitle)
			) &&
			!recentIds.has(result.id) &&
			!recentTitles.has(normalizeBgmTitle(result.title)) &&
			!recent.some((track) => isSameBgmSong(result.title, track.title));

		const freshResults = results.filter(isFreshCandidate);
		if (radioDjRequested && freshResults.length === 0) {
			return JSON.stringify({
				ok: false,
				action: act,
				reason: "no_fresh_search_results",
				query,
			});
		}

		let activeSearchQuery = searchQuery;
		let retriedSearchQuery: string | undefined;
		let inspection = radioDjRequested
			? inspectSingleTrackCandidates(freshResults, searchQuery)
			: {
					candidates: [...freshResults],
					rejectedCounts: {
						mix_title: 0,
						no_duration: 0,
						too_long: 0,
						too_short: 0,
					},
				};
		let rejectedCounts = inspection.rejectedCounts;

		if (
			radioDjRequested &&
			inspection.candidates.length === 0 &&
			!EXPLICIT_LONG_MIX_QUERY_RE.test(searchQuery)
		) {
			const retryQuery = buildSingleTrackRetryQuery(searchQuery);
			if (retryQuery !== searchQuery) {
				retriedSearchQuery = retryQuery;
				activeSearchQuery = retryQuery;
				const retryResults = await deps.search(retryQuery);
				const retryFreshResults = retryResults.filter(isFreshCandidate);
				const retryInspection = inspectSingleTrackCandidates(
					retryFreshResults,
					retryQuery,
				);
				if (retryInspection.candidates.length > 0) {
					inspection = retryInspection;
					rejectedCounts = retryInspection.rejectedCounts;
				} else if (retryFreshResults.length > 0) {
					rejectedCounts = retryInspection.rejectedCounts;
				}
			}
		}

		const candidatePool = inspection.candidates;
		const enqueueAdditionalRadioCandidates = async (
			candidates: readonly BgmSearchResult[],
		): Promise<number> => {
			const filteredCandidates = filterSingleTrackCandidates(
				candidates,
				activeSearchQuery,
			);
			const seenIds = new Set<string>();
			const seenTitles: string[] = [];
			const currentSel = deps.playback.current()?.selected;
			if (currentSel?.videoId) seenIds.add(currentSel.videoId);
			if (currentSel?.title) seenTitles.push(currentSel.title);
			for (const queuedItem of deps.playback.queue()) {
				seenIds.add(queuedItem.selected.videoId);
				if (queuedItem.selected.title) {
					seenTitles.push(queuedItem.selected.title);
				}
			}
			for (const recentTrack of recent) {
				seenIds.add(recentTrack.id);
				if (recentTrack.title) {
					seenTitles.push(recentTrack.title);
				}
			}
			let queuedCount = 0;
			for (const candidate of filteredCandidates) {
				if (deps.playback.queue().length >= 3) break;
				if (!candidate.id || seenIds.has(candidate.id)) continue;
				if (
					seenTitles.some((existingTitle) =>
						isSameBgmSong(candidate.title, existingTitle),
					)
				) {
					continue;
				}
				seenIds.add(candidate.id);
				seenTitles.push(candidate.title);
				const enq = deps.playback.enqueue({
					videoId: candidate.id,
					title: candidate.title,
				});
				if (enq.disposition === "queued") {
					queuedCount += 1;
					await deps.emitBgm({
						type: "bgm_youtube_enqueue",
						videoId: candidate.id,
						title: candidate.title,
						queueId: enq.queued.queueId,
						position: enq.queued.position,
						...(candidate.thumbnail ? { thumbnail: candidate.thumbnail } : {}),
					});
				}
			}
			return queuedCount;
		};

		if (radioDjRequested && preserveActive && hasActivePlayback && currentSnapshot) {
			const queuedCount = await enqueueAdditionalRadioCandidates(candidatePool);
			if (queuedCount > 0) {
				configureRadioDjRecovery(
					activeSearchQuery,
					{
						id: currentSnapshot.selected.videoId,
						title: currentSnapshot.selected.title,
					},
					deps,
				);
			}
			const observed =
				(await deps.waitForAck?.(currentSnapshot.playbackId)) ?? currentSnapshot;
			return JSON.stringify({
				...toBgmPlayToolResult(observed),
				preservedActive: true,
				queuedCount,
				nextPrepared: queuedCount > 0,
				searchQuery: activeSearchQuery,
				...(queuedCount === 0 ? { rejectedCounts } : {}),
			});
		}

		if (radioDjRequested && candidatePool.length === 0) {
			return JSON.stringify({
				ok: false,
				action: act,
				reason: "no_single_track_candidates",
				query,
				searchQuery,
				...(retriedSearchQuery ? { retrySearchQuery: retriedSearchQuery } : {}),
				rejectedCounts,
			});
		}

		const selected = radioDjRequested
			? candidatePool[0]
			: args.replace === true
				? (freshResults[0] ??
					results.find((result) => result.id !== currentVideoId) ??
					results[0])
				: results[0];
		if (radioDjRequested) {
			const playback = deps.playback.request({
				videoId: selected.id,
				title: selected.title,
			});
			await deps.emitBgm({
				type: "bgm_youtube_play",
				playbackId: playback.playbackId,
				videoId: selected.id,
				title: selected.title,
				...(selected.thumbnail ? { thumbnail: selected.thumbnail } : {}),
			});
			if (candidatePool.length > 1) {
				await enqueueAdditionalRadioCandidates(candidatePool.slice(1));
			}
			configureRadioDjRecovery(activeSearchQuery, selected, deps);
			const observed =
				(await deps.waitForAck?.(playback.playbackId)) ?? playback;
			return JSON.stringify(toBgmPlayToolResult(observed));
		}
		const output = await enqueueTrack(selected, false);
		return output;
	}

	if (act === "playlist_list") {
		return JSON.stringify({ ok: true, action: act, library: summarizeLibrary(deps.library?.()) });
	}

	if (act === "playlist_create") {
		if (typeof args.name !== "string" || !args.name.trim())
			return JSON.stringify({ ok: false, action: act, reason: "name_required" });
		await deps.emitBgm({ type: "bgm_playlist_create", name: args.name.trim() });
		return JSON.stringify({ ok: true, action: act, requestedName: args.name.trim() });
	}

	if (act === "playlist_add_current") {
		const current = deps.playback.current();
		if (!current)
			return JSON.stringify({ ok: false, action: act, reason: "no_current_track" });
		await deps.emitBgm({ type: "bgm_playlist_add_current", ...(typeof args.playlistId === "string" ? { playlistId: args.playlistId } : {}) });
		return JSON.stringify({ ok: true, action: act, pending: true });
	}

	if (act === "playlist_play") {
		if (typeof args.playlistId !== "string" || !args.playlistId.trim())
			return JSON.stringify({ ok: false, action: act, reason: "playlist_id_required" });
		await deps.emitBgm({ type: "bgm_playlist_play", playlistId: args.playlistId.trim(), index: Number.isFinite(Number(args.index)) ? Math.max(0, Math.trunc(Number(args.index))) : 0 });
		return JSON.stringify({ ok: true, action: act, pending: true });
	}

	if (act === "shuffle") {
		await deps.emitBgm({ type: "bgm_playlist_shuffle", enabled: args.enabled !== false });
		return JSON.stringify({ ok: true, action: act, enabled: args.enabled !== false });
	}

	if (act === "repeat") {
		const repeat = args.repeat === "all" || args.repeat === "one" ? args.repeat : "off";
		await deps.emitBgm({ type: "bgm_playlist_repeat", repeat });
		return JSON.stringify({ ok: true, action: act, repeat });
	}

	if (act === "like_add" || act === "like_remove") {
		const current = deps.playback.current();
		if (!current)
			return JSON.stringify({ ok: false, action: act, reason: "no_current_track" });
		await deps.emitBgm({ type: act === "like_add" ? "bgm_library_like_add" : "bgm_library_like_remove" });
		return JSON.stringify({ ok: true, action: act, selected: current.selected });
	}

	if (act === "favorite_add" || act === "favorite_remove") {
		const current = deps.playback.current();
		if (!current) {
			return JSON.stringify({
				ok: false,
				action: act,
				reason: "no_current_track",
			});
		}
		await deps.emitBgm({
			type: `bgm_youtube_${act.replace("favorite_", "fav_")}`,
		});
		return JSON.stringify({
			ok: true,
			action: act,
			selected: current.selected,
		});
	}

	if (act === "favorites_play") {
		cancelRadioDjRecovery();
		const favorites = deps.favoriteTracks?.() ?? [];
		if (favorites.length === 0) {
			return JSON.stringify({
				ok: false,
				action: act,
				reason: "no_favorites",
			});
		}
		const currentVideoId = deps.playback.current()?.selected.videoId;
		const selected =
			favorites.find((track) => track.id !== currentVideoId) ?? favorites[0];
		return enqueueTrack(selected, true);
	}

	if (act === "volume") {
		const v = clampVolume(args.volume);
		await deps.emitBgm({ type: "bgm_youtube_volume", volume: v });
		return JSON.stringify({ ok: true, action: act, volume: v });
	}

	// stop / pause / resume / next / prev — 위젯 리스너 타입 1:1
	if (act === "stop" || act === "next" || act === "prev") {
		cancelRadioDjRecovery();
	}
	if (act === "next" || act === "prev") {
		const previousPlaybackId = deps.playback.current()?.playbackId;
		await deps.emitBgm({ type: `bgm_youtube_${act}` });
		if (
			!deps.waitForNavigateAck &&
			act === "next" &&
			deps.playback.current()?.playbackId === previousPlaybackId &&
			deps.playback.queue().length > 0
		) {
			deps.playback.advance();
		}
		const observed =
			(await deps.waitForNavigateAck?.(previousPlaybackId)) ??
			deps.playback.current();
		const advanced = Boolean(
			observed &&
				observed.playbackId !== previousPlaybackId &&
				!["ended", "error"].includes(observed.status),
		);
		const context = toBgmObservedContext(
			observed,
			deps.now?.() ?? Date.now(),
			deps.playback.queue(),
		);
		if (!advanced) {
			return JSON.stringify({
				ok: false,
				action: act,
				reason: "no_next_track",
				...context,
				instruction:
					"No next track was available in the queue or active playlist. Use action=play with a fresh search query to start a new track.",
			});
		}
		return JSON.stringify({
			ok: true,
			action: act,
			...context,
		});
	}
	const eventType = `bgm_youtube_${act}`;
	await deps.emitBgm({ type: eventType });
	if (import.meta.env.MODE === "web") {
		const cur = deps.playback.current();
		if (act === "stop" && cur && cur.status !== "ended") {
			deps.playback.clearQueue();
			deps.playback.observe({
				playbackId: cur.playbackId,
				sequence: cur.sequence + 1,
				status: "ended",
			});
		} else if (act === "pause" && cur && cur.status !== "paused") {
			deps.playback.observe({
				playbackId: cur.playbackId,
				sequence: cur.sequence + 1,
				status: "paused",
			});
		} else if (act === "resume" && cur && cur.status !== "playing") {
			deps.playback.observe({
				playbackId: cur.playbackId,
				sequence: cur.sequence + 1,
				status: "playing",
			});
		}
	}
	return JSON.stringify({ ok: true, action: act });
}

function summarizeLibrary(library: BgmLibraryState | undefined) {
	if (!library) return null;
	const active = library.playlists.find((playlist) => playlist.id === library.activePlaylistId);
	return {
		likesCount: library.likes.length,
		activePlaylist: active
			? { id: active.id, name: active.name, trackCount: active.tracks.length, currentIndex: library.currentIndex }
			: null,
		playlists: library.playlists.map((playlist) => ({ id: playlist.id, name: playlist.name, trackCount: playlist.tracks.length })),
		queueLength: library.queue.length,
		shuffle: library.shuffle,
		repeat: library.repeat,
	};
}
