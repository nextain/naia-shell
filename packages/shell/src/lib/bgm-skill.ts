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
import type { NaiaTool } from "./app-registry";
import {
	type BgmLibraryState,
	type BgmLibraryTrack,
	loadBgmLibrary,
	mergeBgmHistory,
	normalizeBgmTitle,
	recordBgmHistory,
} from "./bgm-library";
import { bgmLibraryCache, persistBgmLibrary } from "./bgm-library-store";
import {
	type BgmPlaybackPort,
	bgmPlayback,
	toBgmObservedContext,
	toBgmPlayToolResult,
	toBgmQueuedToolResult,
} from "./bgm-playback";
import { BGM_SIDECAR_BASE_URL, ensureBgmSidecar } from "./bgm-sidecar-url";
import { loadConfig } from "./config";

/** appExec 등록용 앱 id — 위젯 전용(앱 아님), app_skills_clear 대상 아님(항상 유지). */
export const BGM_APP_ID = "bgm-widget";

const YT_BASE = BGM_SIDECAR_BASE_URL;

export const BGM_ACTIONS = [
	"play",
	"stop",
	"pause",
	"resume",
	"next",
	"prev",
	"favorite_add",
	"favorite_remove",
	"favorites_play",
	"like_add",
	"like_remove",
	"playlist_list",
	"playlist_create",
	"playlist_add_current",
	"playlist_play",
	"shuffle",
	"repeat",
	"status",
	"volume",
] as const;
export type BgmAction = (typeof BGM_ACTIONS)[number];

export const SKILL_YOUTUBE_BGM: NaiaTool = {
	name: "skill_youtube_bgm",
	description:
		"Naia 음악 플레이어 제어. 좋아요는 선호 표시일 뿐 재생 목록이 아니다. next/prev는 활성 플레이리스트와 실행 큐를 사용한다. playlist_list/create/add_current/play, like_add/remove, shuffle, repeat(off/all/one)를 구분해서 사용한다. 도구 결과가 requested이면 재생 성공이라고 말하지 말고 observed playing만 실제 재생으로 표현한다.",
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: [...BGM_ACTIONS],
				description: BGM_ACTIONS.join(" | "),
			},
			query: {
				type: "string",
				description: "검색어 (play 에서 videoId 없을 때)",
			},
			videoId: { type: "string", description: "YouTube video id (play, 선택)" },
			title: { type: "string", description: "제목 (play+videoId, 선택)" },
			volume: { type: "number", description: "0.0~1.0 (volume)" },
			playlistId: { type: "string", description: "플레이리스트 ID" },
			name: { type: "string", description: "새 플레이리스트 이름" },
			index: { type: "number", description: "재생할 플레이리스트 항목 번호(0부터)" },
			enabled: { type: "boolean", description: "셔플 사용 여부" },
			repeat: {
				type: "string",
				enum: ["off", "all", "one"],
			},
			mode: {
				type: "string",
				enum: ["player", "radio_dj"],
				description:
					"Semantic intent chosen by the LLM in any language. Use radio_dj only when the user asks for an ongoing autonomous DJ/radio-host experience (including synonyms or similar phrasing); use player for ordinary song, playlist, or BGM playback.",
			},
		},
		required: ["action"],
	},
	tier: 0, // App.tsx 부팅 시 addAllowedTool("skill_youtube_bgm") — 저위험 환경 조작
};

/** Shell policy boundary: only the LLM's structured semantic choice activates DJ mode. */
export function shouldActivateRadioDj(args: Record<string, unknown>): boolean {
	return args.action === "play" && args.mode === "radio_dj";
}

export interface BgmSearchResult {
	id: string;
	title: string;
	thumbnail?: string;
}

export interface BgmRecentTrack extends BgmSearchResult {
	playedAt: number;
}

export const BGM_RECENT_KEY = "yt-bgm-recent-v1";
const RECENT_TRACK_LIMIT = 20;
let legacyRecentMigration: Promise<boolean> | null = null;

/** Keep the skill's existing public export while sharing the library rule. */
export { normalizeBgmTitle } from "./bgm-library";

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
async function sidecarSearch(query: string): Promise<BgmSearchResult[]> {
	await ensureBgmSidecar();
	const res = await fetch(
		`${YT_BASE}/yt/search?q=${encodeURIComponent(query)}&max=5`,
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `BGM 검색 서버 오류 (HTTP ${res.status})`);
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
			const selected = results.find((result) => {
				const normalizedTitle = normalizeBgmTitle(result.title);
				return (
					!plan.attemptedIds.has(result.id) &&
					!recentIds.has(result.id) &&
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
			return JSON.stringify(toBgmPlayToolResult(playback));
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
			return JSON.stringify(toBgmPlayToolResult(result.playback));
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
		return JSON.stringify({
			library: summarizeLibrary(deps.library?.()),
			ok: true,
			action: act,
			...toBgmObservedContext(
				deps.playback.current(),
				deps.now?.() ?? Date.now(),
				deps.playback.queue(),
			),
			recentTracks,
			favoriteTracks,
		});
	}

	if (act === "play") {
		const radioDjRequested = shouldActivateRadioDj(args);
		const activeStatus = deps.playback.current()?.status;
		// Replacements and starts own the surface immediately. A queue-preserving
		// request may be a prepared DJ fallback, so it keeps the current plan.
		if (
			radioDjRequested ||
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
				radioDjRequested,
			);
		}
		const query = args.query;
		if (typeof query !== "string" || !query.trim())
			throw new Error("play requires query or videoId");
		const results = await deps.search(query);
		if (results.length === 0)
			return JSON.stringify({
				ok: false,
				action: act,
				reason: "no_search_results",
				query,
			});
		const currentVideoId = deps.playback.current()?.selected.videoId;
		const recent = deps.recentTracks?.() ?? [];
		const recentIds = new Set(recent.map((track) => track.id));
		const recentTitles = new Set(
			recent.map((track) => normalizeBgmTitle(track.title)).filter(Boolean),
		);
		const freshResults = results.filter(
			(result) =>
				result.id !== currentVideoId &&
				!recentIds.has(result.id) &&
				!recentTitles.has(normalizeBgmTitle(result.title)),
		);
		if (radioDjRequested && freshResults.length === 0) {
			return JSON.stringify({
				ok: false,
				action: act,
				reason: "no_fresh_search_results",
				query,
			});
		}
		const selected = radioDjRequested
			? freshResults[0]
			: args.replace === true
				? (freshResults[0] ??
					results.find((result) => result.id !== currentVideoId) ??
					results[0])
				: results[0];
		const output = await enqueueTrack(selected, radioDjRequested);
		if (radioDjRequested) configureRadioDjRecovery(query, selected, deps);
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
	const eventType = `bgm_youtube_${act}`;
	await deps.emitBgm({ type: eventType });
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
