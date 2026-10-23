export const BGM_LIBRARY_SCHEMA_VERSION = 1 as const;
export const BGM_HISTORY_LIMIT = 50;
export const BGM_PLAYLIST_LIMIT = 100;
export const BGM_PLAYLIST_TRACK_LIMIT = 2_000;

export type BgmLibrarySource = "youtube" | "local";
export type BgmRepeatMode = "off" | "all" | "one";

export interface BgmLibraryTrack {
	id: string;
	source: BgmLibrarySource;
	title: string;
	/** Unix milliseconds when this track was confirmed playing (history only). */
	playedAt?: number;
	youtubeId?: string;
	path?: string;
	thumbnail?: string;
	channel?: string;
	durationSeconds?: number;
	fileSize?: number;
	fingerprint?: string;
}

export interface BgmPlaylist {
	id: string;
	name: string;
	tracks: BgmLibraryTrack[];
	createdAt: number;
	updatedAt: number;
}

export interface BgmLibraryState {
	schemaVersion: typeof BGM_LIBRARY_SCHEMA_VERSION;
	updatedAt: number;
	likes: BgmLibraryTrack[];
	playlists: BgmPlaylist[];
	activePlaylistId: string | null;
	currentIndex: number;
	shuffle: boolean;
	repeat: BgmRepeatMode;
	queue: BgmLibraryTrack[];
	history: BgmLibraryTrack[];
}

export interface LocalRelinkCandidate {
	path: string;
	fileName: string;
	fileSize?: number;
	durationSeconds?: number;
	fingerprint?: string;
}

function cleanText(value: unknown, max = 500): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function finiteNonNegative(value: unknown): number | undefined {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Normalize common YouTube decorations so alternate uploads count as one song. */
export function normalizeBgmTitle(title: string): string {
	return title
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(
			/[\[(]\s*(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|mv|가사|뮤직비디오|오디오)\s*[\])]/giu,
			" ",
		)
		.replace(/\b(?:official|audio|lyrics?|mv)\b/giu, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

const BGM_SONG_DECORATION_RE =
	/\b(?:m\/v|mv|official|music\s*video|video|audio|lyrics?|lyric\s*video|live|clip|ver(?:sion)?|full|hd|4k|hq|remastered|remaster|ost|stage|performance|concert|fancam|cover|acoustic|inst(?:rumental)?|karaoke|mr|tj|ky|visualizer|topic|sketchbook|kbs|mbc|sbs|mnet|1thek|dingo|killing\s*voice|its\s*live|begin\s*again)\b|가사|뮤직\s*비디오|뮤비|오디오|라이브|세로\s*라이브|콘서트|방송|직캠|커버|원곡|수록곡|음원|고음질|유희열의\s*스케치북|킬링\s*보이스|비긴\s*어게인/giu;

function compactBgmCoreKey(raw: string): string {
	return raw
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/m\s*\/\s*v/giu, " ")
		.replace(BGM_SONG_DECORATION_RE, " ")
		.replace(/[^\p{L}\p{N}]+/gu, "")
		.trim();
}

/**
 * Extract normalized core song title keys from a YouTube title (FR-RADIO-DJ.14).
 * Strips channel/show suffixes, leading tags (`[MV]`), artist prefixes (`Artist - ` / `Artist _ `),
 * bracketed/parenthesized decorations, and punctuation/whitespace, while retaining
 * parenthesized alternate-language song titles such as `Through the Night (밤편지)`.
 */
export function extractBgmSongCoreKeys(title: string): string[] {
	const cleaned = title
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/\s*[|｜].*$/gu, " ")
		.replace(/(?:^|\s)#[^\s#]+/gu, " ")
		.trim();
	if (!cleaned) return [];

	const withoutLeadingBrackets = cleaned
		.replace(/^\s*(?:[\[(【〈《][^\]）】〉》]*[\])】〉》]\s*)+/gu, "")
		.trim();
	const target = withoutLeadingBrackets || cleaned;

	const separatorParts = target
		.split(/\s+[-–—_~:]\s+|_\s+|\s+_/u)
		.map((part) => part.trim())
		.filter(Boolean);
	const songSegment =
		separatorParts.length >= 2
			? separatorParts.slice(1).join(" ")
			: target;

	const keys = new Set<string>();
	const withoutSquareBrackets = songSegment
		.replace(/[\[【〈《][^\]】〉》]*[\]】〉》]/gu, " ")
		.trim();

	for (const match of withoutSquareBrackets.matchAll(/\(([^()[\]]+)\)/gu)) {
		const inner = match[1]?.trim() ?? "";
		if (!inner || inner.includes("/")) continue;
		if (/^(?:feat|ft|prod|ver|version|ost)\b/iu.test(inner)) continue;
		const innerKey = compactBgmCoreKey(inner);
		if (innerKey && !/^\d+$/u.test(innerKey) && innerKey.length >= 2) {
			keys.add(innerKey);
		}
	}

	const strippedSongSegment = withoutSquareBrackets
		.replace(/\([^()]*\)/gu, " ")
		.trim();
	const primaryKey = compactBgmCoreKey(strippedSongSegment);
	if (primaryKey) {
		keys.add(primaryKey);
	}

	if (keys.size === 0) {
		const fallbackKey = compactBgmCoreKey(
			target.replace(/[\[(【〈《][^\]）】〉》]*[\])】〉》]/gu, " "),
		);
		if (fallbackKey) keys.add(fallbackKey);
	}

	return [...keys];
}

function isCoreSongKeyContained(shorter: string, longer: string): boolean {
	if (shorter === longer) return true;
	const isAsciiOnly = /^[a-z0-9]+$/u.test(shorter);
	if (isAsciiOnly ? shorter.length < 4 : shorter.length < 2) {
		return false;
	}
	let searchFrom = 0;
	while (searchFrom <= longer.length - shorter.length) {
		const idx = longer.indexOf(shorter, searchFrom);
		if (idx === -1) return false;
		const nextChar = longer[idx + shorter.length] ?? "";
		if (/\d$/u.test(shorter) && /^\d/u.test(nextChar)) {
			searchFrom = idx + 1;
			continue;
		}
		return true;
	}
	return false;
}

/**
 * Determine whether two YouTube titles refer to the same song across alternate uploads,
 * bilingual titles, live stages, or lyric videos (FR-RADIO-DJ.14).
 */
export function isSameBgmSong(titleA: string, titleB: string): boolean {
	const keysA = extractBgmSongCoreKeys(titleA);
	const keysB = extractBgmSongCoreKeys(titleB);
	if (keysA.length === 0 || keysB.length === 0) {
		const normA = normalizeBgmTitle(titleA);
		const normB = normalizeBgmTitle(titleB);
		return Boolean(normA && normA === normB);
	}
	for (const a of keysA) {
		for (const b of keysB) {
			if (a === b) return true;
			const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
			if (isCoreSongKeyContained(shorter, longer)) {
				return true;
			}
		}
	}
	return false;
}

export function trackIdentity(track: Pick<BgmLibraryTrack, "source" | "youtubeId" | "path" | "id">): string {
	if (track.source === "youtube" && track.youtubeId) return `youtube:${track.youtubeId}`;
	if (track.source === "local" && track.path) return `local:${track.path.toLocaleLowerCase()}`;
	return track.id;
}

export function normalizeBgmTrack(value: unknown): BgmLibraryTrack | null {
	if (!value || typeof value !== "object") return null;
	const input = value as Record<string, unknown>;
	const source = input.source === "local" ? "local" : input.source === "youtube" ? "youtube" : null;
	if (!source) return null;
	const youtubeId = cleanText(input.youtubeId, 64) || undefined;
	const path = cleanText(input.path, 2_048) || undefined;
	if (source === "youtube" && !youtubeId) return null;
	if (source === "local" && !path) return null;
	const id = cleanText(input.id, 2_200) || (source === "youtube" ? `youtube:${youtubeId}` : `local:${path}`);
	return {
		id,
		source,
		title: cleanText(input.title) || (source === "youtube" ? youtubeId! : path!.split(/[\\/]/).pop() || path!),
		...(finiteNonNegative(input.playedAt) !== undefined ? { playedAt: finiteNonNegative(input.playedAt) } : {}),
		...(youtubeId ? { youtubeId } : {}),
		...(path ? { path } : {}),
		...(cleanText(input.thumbnail, 2_048) ? { thumbnail: cleanText(input.thumbnail, 2_048) } : {}),
		...(cleanText(input.channel) ? { channel: cleanText(input.channel) } : {}),
		...(finiteNonNegative(input.durationSeconds) !== undefined ? { durationSeconds: finiteNonNegative(input.durationSeconds) } : {}),
		...(finiteNonNegative(input.fileSize) !== undefined ? { fileSize: finiteNonNegative(input.fileSize) } : {}),
		...(cleanText(input.fingerprint, 256) ? { fingerprint: cleanText(input.fingerprint, 256) } : {}),
	};
}

function historyEquivalent(left: BgmLibraryTrack, right: BgmLibraryTrack): boolean {
	if (trackIdentity(left) === trackIdentity(right)) return true;
	return (
		left.source === "youtube" &&
		right.source === "youtube" &&
		Boolean(normalizeBgmTitle(left.title)) &&
		normalizeBgmTitle(left.title) === normalizeBgmTitle(right.title)
	);
}

function uniqueHistoryTracks(values: unknown, limit: number): BgmLibraryTrack[] {
	if (!Array.isArray(values)) return [];
	const tracks: BgmLibraryTrack[] = [];
	for (const value of values) {
		const track = normalizeBgmTrack(value);
		if (!track || tracks.some((item) => historyEquivalent(item, track))) continue;
		tracks.push(track);
		if (tracks.length >= limit) break;
	}
	return tracks;
}

function uniqueTracks(values: unknown, limit: number): BgmLibraryTrack[] {
	if (!Array.isArray(values)) return [];
	const seen = new Set<string>();
	const tracks: BgmLibraryTrack[] = [];
	for (const value of values) {
		const track = normalizeBgmTrack(value);
		if (!track) continue;
		const identity = trackIdentity(track);
		if (seen.has(identity)) continue;
		seen.add(identity);
		tracks.push(track);
		if (tracks.length >= limit) break;
	}
	return tracks;
}

export function createEmptyBgmLibrary(now = Date.now()): BgmLibraryState {
	return {
		schemaVersion: BGM_LIBRARY_SCHEMA_VERSION,
		updatedAt: now,
		likes: [],
		playlists: [{ id: "default", name: "My Playlist", tracks: [], createdAt: now, updatedAt: now }],
		activePlaylistId: "default",
		currentIndex: -1,
		shuffle: false,
		repeat: "off",
		queue: [],
		history: [],
	};
}

export function loadBgmLibrary(raw: unknown, legacyYoutubeLikes: readonly unknown[] = [], now = Date.now()): BgmLibraryState {
	const empty = createEmptyBgmLibrary(now);
	if (!raw || typeof raw !== "object") {
		return { ...empty, likes: uniqueTracks(legacyYoutubeLikes, BGM_HISTORY_LIMIT) };
	}
	const input = raw as Record<string, unknown>;
	const playlists = Array.isArray(input.playlists)
		? input.playlists.slice(0, BGM_PLAYLIST_LIMIT).flatMap((value, index) => {
			if (!value || typeof value !== "object") return [];
			const playlist = value as Record<string, unknown>;
			const id = cleanText(playlist.id, 100) || `playlist-${index + 1}`;
			return [{
				id,
				name: cleanText(playlist.name, 100) || `Playlist ${index + 1}`,
				tracks: uniqueTracks(playlist.tracks, BGM_PLAYLIST_TRACK_LIMIT),
				createdAt: finiteNonNegative(playlist.createdAt) ?? now,
				updatedAt: finiteNonNegative(playlist.updatedAt) ?? now,
			}];
		})
		: [];
	const safePlaylists = playlists.length > 0 ? playlists : empty.playlists;
	const requestedActive = cleanText(input.activePlaylistId, 100) || null;
	const activePlaylistId = safePlaylists.some((playlist) => playlist.id === requestedActive)
		? requestedActive
		: safePlaylists[0].id;
	const activeLength = safePlaylists.find((playlist) => playlist.id === activePlaylistId)?.tracks.length ?? 0;
	const requestedIndex = Math.trunc(Number(input.currentIndex));
	const currentIndex = Number.isFinite(requestedIndex) && requestedIndex >= 0 && requestedIndex < activeLength ? requestedIndex : -1;
	return {
		schemaVersion: BGM_LIBRARY_SCHEMA_VERSION,
		updatedAt: finiteNonNegative(input.updatedAt) ?? now,
		likes: uniqueTracks(Array.isArray(input.likes) ? input.likes : legacyYoutubeLikes, BGM_HISTORY_LIMIT),
		playlists: safePlaylists,
		activePlaylistId,
		currentIndex,
		shuffle: input.shuffle === true,
		repeat: input.repeat === "all" || input.repeat === "one" ? input.repeat : "off",
		queue: uniqueTracks(input.queue, BGM_PLAYLIST_TRACK_LIMIT),
		history: uniqueHistoryTracks(input.history, BGM_HISTORY_LIMIT),
	};
}

export function createPlaylist(state: BgmLibraryState, name: string, now = Date.now()): BgmLibraryState {
	if (state.playlists.length >= BGM_PLAYLIST_LIMIT) return state;
	const safeName = cleanText(name, 100) || `Playlist ${state.playlists.length + 1}`;
	const id = `playlist-${now}-${Math.random().toString(36).slice(2, 8)}`;
	return { ...state, playlists: [...state.playlists, { id, name: safeName, tracks: [], createdAt: now, updatedAt: now }], activePlaylistId: id, currentIndex: -1, updatedAt: now };
}

export function addTrackToPlaylist(state: BgmLibraryState, playlistId: string, trackValue: BgmLibraryTrack, now = Date.now()): BgmLibraryState {
	const track = normalizeBgmTrack(trackValue);
	if (!track) return state;
	let changed = false;
	const playlists = state.playlists.map((playlist) => {
		if (playlist.id !== playlistId || playlist.tracks.length >= BGM_PLAYLIST_TRACK_LIMIT) return playlist;
		if (playlist.tracks.some((item) => trackIdentity(item) === trackIdentity(track))) return playlist;
		changed = true;
		return { ...playlist, tracks: [...playlist.tracks, track], updatedAt: now };
	});
	return changed ? { ...state, playlists, updatedAt: now } : state;
}

export function removeTrackFromPlaylist(state: BgmLibraryState, playlistId: string, index: number, now = Date.now()): BgmLibraryState {
	let changed = false;
	const playlists = state.playlists.map((playlist) => {
		if (playlist.id !== playlistId || index < 0 || index >= playlist.tracks.length) return playlist;
		changed = true;
		return { ...playlist, tracks: playlist.tracks.filter((_, trackIndex) => trackIndex !== index), updatedAt: now };
	});
	if (!changed) return state;
	const currentIndex = state.activePlaylistId === playlistId
		? state.currentIndex === index ? -1 : state.currentIndex > index ? state.currentIndex - 1 : state.currentIndex
		: state.currentIndex;
	return { ...state, playlists, currentIndex, updatedAt: now };
}

export function movePlaylistTrack(state: BgmLibraryState, playlistId: string, from: number, to: number, now = Date.now()): BgmLibraryState {
	if (from === to) return state;
	let nextIndex = state.currentIndex;
	const playlists = state.playlists.map((playlist) => {
		if (playlist.id !== playlistId || from < 0 || to < 0 || from >= playlist.tracks.length || to >= playlist.tracks.length) return playlist;
		const tracks = [...playlist.tracks];
		const [track] = tracks.splice(from, 1);
		tracks.splice(to, 0, track);
		if (state.activePlaylistId === playlistId) {
			if (state.currentIndex === from) nextIndex = to;
			else if (from < state.currentIndex && to >= state.currentIndex) nextIndex--;
			else if (from > state.currentIndex && to <= state.currentIndex) nextIndex++;
		}
		return { ...playlist, tracks, updatedAt: now };
	});
	return { ...state, playlists, currentIndex: nextIndex, updatedAt: now };
}

export function toggleBgmLike(state: BgmLibraryState, trackValue: BgmLibraryTrack, now = Date.now()): BgmLibraryState {
	const track = normalizeBgmTrack(trackValue);
	if (!track) return state;
	const identity = trackIdentity(track);
	const exists = state.likes.some((item) => trackIdentity(item) === identity);
	return { ...state, likes: exists ? state.likes.filter((item) => trackIdentity(item) !== identity) : [track, ...state.likes].slice(0, BGM_HISTORY_LIMIT), updatedAt: now };
}

export function recordBgmHistory(state: BgmLibraryState, trackValue: BgmLibraryTrack, now = Date.now()): BgmLibraryState {
	const track = normalizeBgmTrack({ ...trackValue, playedAt: now });
	if (!track) return state;
	return {
		...state,
		history: [track, ...state.history.filter((item) => !historyEquivalent(item, track))].slice(0, BGM_HISTORY_LIMIT),
		updatedAt: now,
	};
}

/**
 * Add legacy recent-play records behind the existing ADK history.
 * Existing ADK records always win identity/title collisions and retain their
 * metadata/timestamps.
 */
export function mergeBgmHistory(
	state: BgmLibraryState,
	tracks: readonly BgmLibraryTrack[],
	now = Date.now(),
): BgmLibraryState {
	const history = [...state.history];
	for (const value of tracks) {
		const track = normalizeBgmTrack(value);
		if (!track || history.some((item) => historyEquivalent(item, track))) continue;
		history.push(track);
		if (history.length >= BGM_HISTORY_LIMIT) break;
	}
	if (history.length === state.history.length) return state;
	return { ...state, history, updatedAt: now };
}

export function nextPlaylistIndex(state: BgmLibraryState, direction: 1 | -1, random: () => number = Math.random): number {
	const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
	const length = playlist?.tracks.length ?? 0;
	if (length === 0) return -1;
	if (state.repeat === "one" && state.currentIndex >= 0) return state.currentIndex;
	if (state.shuffle && length > 1) {
		const offset = 1 + Math.floor(Math.max(0, Math.min(0.999999, random())) * (length - 1));
		return ((Math.max(state.currentIndex, 0) + direction * offset) % length + length) % length;
	}
	const candidate = state.currentIndex + direction;
	if (candidate >= 0 && candidate < length) return candidate;
	return state.repeat === "all" ? (direction === 1 ? 0 : length - 1) : -1;
}

export function findLocalRelink(track: BgmLibraryTrack, candidates: readonly LocalRelinkCandidate[]): string | null {
	if (track.source !== "local" || !track.path) return null;
	const originalName = track.path.split(/[\\/]/).pop()?.toLocaleLowerCase();
	const scored = candidates.map((candidate) => {
		let score = candidate.fileName.toLocaleLowerCase() === originalName ? 4 : 0;
		if (track.fingerprint && candidate.fingerprint === track.fingerprint) score += 16;
		if (track.fileSize !== undefined && candidate.fileSize === track.fileSize) score += 4;
		if (track.durationSeconds !== undefined && candidate.durationSeconds !== undefined && Math.abs(track.durationSeconds - candidate.durationSeconds) <= 1) score += 2;
		return { path: candidate.path, score };
	}).filter((candidate) => candidate.score >= 4).sort((a, b) => b.score - a.score);
	if (scored.length === 0 || (scored[1] && scored[1].score === scored[0].score)) return null;
	return scored[0].path;
}
