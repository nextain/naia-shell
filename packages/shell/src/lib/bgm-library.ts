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

const BGM_DEFINITE_DECORATION_SINGLE_TOKENS = new Set([
	"official",
	"mv",
	"lyrics",
	"lyric",
	"hd",
	"4k",
	"1080p",
	"720p",
	"hq",
	"remastered",
	"remaster",
	"fancam",
	"karaoke",
	"tj",
	"ky",
	"visualizer",
	"1thek",
	"dingo",
	"sketchbook",
	"kbs",
	"mbc",
	"sbs",
	"mnet",
	"가사",
	"뮤직비디오",
	"뮤비",
	"오디오",
	"직캠",
	"원곡",
	"수록곡",
	"음원",
	"초고음질",
	"고음질",
	"음질",
	"초고화질",
	"고화질",
	"유희열의스케치북",
	"킬링보이스",
	"비긴어게인",
]);

const BGM_DEFINITE_DECORATION_TOKEN_PAIRS: readonly (readonly [string, string])[] = [
	["killing", "voice"],
	["its", "live"],
	["begin", "again"],
	["뮤직", "비디오"],
	["유희열의", "스케치북"],
	["킬링", "보이스"],
	["비긴", "어게인"],
];

const BGM_DEFINITE_DECORATION_RE =
	/\b(?:m\/v|mv|official|lyrics?|hd|4k|1080p|720p|hq|remastered|remaster|fancam|karaoke|tj|ky|visualizer|1thek|dingo|sketchbook|kbs|mbc|sbs|mnet|killing\s*voice|its\s*live|begin\s*again)\b|가사|뮤직\s*비디오|뮤비|오디오|직캠|원곡|수록곡|음원|초고음질|고음질|음질|초고화질|고화질|유희열의\s*스케치북|킬링\s*보이스|비긴\s*어게인/giu;

const BGM_AMBIGUOUS_DECORATION_SINGLE_TOKENS = new Set([
	"video",
	"audio",
	"live",
	"clip",
	"ver",
	"version",
	"full",
	"stage",
	"performance",
	"concert",
	"cover",
	"acoustic",
	"inst",
	"instrumental",
	"ost",
	"topic",
	"mr",
	"sound",
	"super",
	"loop",
	"반복",
	"무한반복",
	"연속재생",
	"연속듣기",
	"라이브",
	"세로라이브",
	"콘서트",
	"커버",
	"방송",
]);

const BGM_AMBIGUOUS_DECORATION_TOKEN_PAIRS: readonly (readonly [string, string])[] = [
	["music", "video"],
	["무한", "반복"],
	["연속", "재생"],
	["연속", "듣기"],
	["세로", "라이브"],
];

function splitInitialBgmTokens(raw: string): string[] {
	return raw
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/m\s*\/\s*v/giu, " mv ")
		.replace(/it['’]s\s+live/giu, " its live ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/u)
		.filter(Boolean);
}

function matchSingleDecorationToken(
	token: string,
): "definite" | "ambiguous" | null {
	if (BGM_DEFINITE_DECORATION_SINGLE_TOKENS.has(token)) return "definite";
	if (
		BGM_AMBIGUOUS_DECORATION_SINGLE_TOKENS.has(token) ||
		/^\d+(?:hours?|hrs?|시간)$/u.test(token)
	) {
		return "ambiguous";
	}
	return null;
}

function matchPairDecorationTokens(
	first: string,
	second: string,
): "definite" | "ambiguous" | null {
	for (const [a, b] of BGM_DEFINITE_DECORATION_TOKEN_PAIRS) {
		if (first === a && second === b) return "definite";
	}
	for (const [a, b] of BGM_AMBIGUOUS_DECORATION_TOKEN_PAIRS) {
		if (first === a && second === b) return "ambiguous";
	}
	if (/^\d+$/u.test(first) && /^(?:hours?|hrs?|시간)$/u.test(second)) {
		return "ambiguous";
	}
	return null;
}

function isDecorationOnlyBracketContent(raw: string): boolean {
	const tokens = splitInitialBgmTokens(raw);
	if (tokens.length === 0) return true;
	let index = 0;
	while (index < tokens.length) {
		if (
			index + 1 < tokens.length &&
			matchPairDecorationTokens(tokens[index]!, tokens[index + 1]!) !== null
		) {
			index += 2;
			continue;
		}
		if (matchSingleDecorationToken(tokens[index]!) !== null) {
			index += 1;
			continue;
		}
		return false;
	}
	return true;
}

function removeDefiniteDecorationsFromTokens(
	tokens: readonly string[],
): string[] {
	if (tokens.length === 0) return [];
	const filtered: string[] = [];
	let index = 0;
	while (index < tokens.length) {
		if (
			index + 1 < tokens.length &&
			matchPairDecorationTokens(tokens[index]!, tokens[index + 1]!) ===
				"definite"
		) {
			index += 2;
			continue;
		}
		if (matchSingleDecorationToken(tokens[index]!) === "definite") {
			index += 1;
			continue;
		}
		filtered.push(tokens[index]!);
		index += 1;
	}
	const joined = filtered
		.join(" ")
		.replace(BGM_DEFINITE_DECORATION_RE, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
	return joined ? joined.split(/\s+/u).filter(Boolean) : [];
}

function normalizeSongBodyTokens(raw: string): string[] {
	const withoutDecorationBrackets = raw.replace(
		/[\[(【〈《]([^\]）】〉》]*)[\])】〉》]/gu,
		(full, inner: string) => (isDecorationOnlyBracketContent(inner) ? " " : full),
	);
	const tokens = splitInitialBgmTokens(withoutDecorationBrackets);
	if (tokens.length === 0) return [];

	let pos = tokens.length;
	let suffixTokenCount = 0;
	let suffixHasDefinite = false;
	let bestCutPos = tokens.length;

	while (pos > 0) {
		const pairMatch =
			pos >= 2
				? matchPairDecorationTokens(tokens[pos - 2]!, tokens[pos - 1]!)
				: null;
		const singleMatch =
			pairMatch === null ? matchSingleDecorationToken(tokens[pos - 1]!) : null;
		if (pairMatch !== null) {
			pos -= 2;
			suffixTokenCount += 2;
			if (pairMatch === "definite") suffixHasDefinite = true;
		} else if (singleMatch !== null) {
			pos -= 1;
			suffixTokenCount += 1;
			if (singleMatch === "definite") suffixHasDefinite = true;
		} else {
			break;
		}

		if (suffixHasDefinite || suffixTokenCount >= 2) {
			const remainingAfterDefinite = removeDefiniteDecorationsFromTokens(
				tokens.slice(0, pos),
			);
			if (remainingAfterDefinite.length > 0) {
				bestCutPos = pos;
			}
		}
	}

	const afterTrailing = tokens.slice(0, bestCutPos);
	return removeDefiniteDecorationsFromTokens(afterTrailing);
}

function compactBgmCoreKey(raw: string): string {
	return normalizeSongBodyTokens(raw).join("");
}

function tokenizeBgmCorePhrase(raw: string): string {
	return normalizeSongBodyTokens(raw).join(" ");
}

function extractBgmSongArtistKeys(artistSegment: string): string[] {
	const withoutSquareBrackets = artistSegment
		.replace(/[\[【〈《][^\]】〉》]*[\]】〉》]/gu, " ")
		.trim();
	if (!withoutSquareBrackets) return [];

	const keys = new Set<string>();
	for (const match of withoutSquareBrackets.matchAll(/\(([^()[\]]+)\)/gu)) {
		const inner = match[1]?.trim() ?? "";
		if (!inner || inner.includes("/")) continue;
		if (/^(?:feat|ft|prod|ver|version|ost)\b/iu.test(inner)) continue;
		if (isDecorationOnlyBracketContent(inner)) continue;
		const innerKey = compactBgmCoreKey(inner);
		if (innerKey && !/^\d+$/u.test(innerKey) && innerKey.length >= 2) {
			keys.add(innerKey);
		}
	}

	const outer = withoutSquareBrackets
		.replace(/\([^()]*\)/gu, " ")
		.split(/\s*(?:,|&|\/|\bfeat\.?|\bft\.?|\bx\b|\bwith\b)\s*/giu)[0]
		?.trim() ?? "";
	const outerKey = compactBgmCoreKey(outer);
	if (outerKey && !/^\d+$/u.test(outerKey) && outerKey.length >= 2) {
		keys.add(outerKey);
	}
	return [...keys];
}

interface ParsedBgmSongIdentity {
	readonly coreKeys: string[];
	readonly tokenPhrases: string[];
	readonly artistKeys: string[];
}

function parseBgmSongIdentity(title: string): ParsedBgmSongIdentity {
	const cleaned = title
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/\s*[|｜].*$/gu, " ")
		.replace(/(?:^|\s)#[^\s#]+/gu, " ")
		.trim();
	if (!cleaned) return { coreKeys: [], tokenPhrases: [], artistKeys: [] };

	const withoutLeadingBrackets = cleaned
		.replace(/^\s*(?:[\[(【〈《][^\]）】〉》]*[\])】〉》]\s*)+/gu, "")
		.trim();
	const target = withoutLeadingBrackets || cleaned;

	const separatorParts = target
		.split(/\s+[-–—_~:]\s+|_\s+|\s+_/u)
		.map((part) => part.trim())
		.filter(Boolean);
	const artistSegment = separatorParts.length >= 2 ? separatorParts[0]! : "";
	const songSegment =
		separatorParts.length >= 2
			? separatorParts.slice(1).join(" ")
			: target;

	const artistKeys = artistSegment ? extractBgmSongArtistKeys(artistSegment) : [];
	const keys = new Set<string>();
	const phrases = new Set<string>();

	// Square/angle-bracket groups are channel, label, or show tags (e.g. "[PurplePine Entertainment]",
	// "[Lyrics Video]") and never alternate song titles, so only parenthesized groups become keys.
	const withoutSquareBrackets = songSegment
		.replace(/[\[【〈《][^\]】〉》]*[\]】〉》]/gu, " ")
		.trim();
	for (const match of withoutSquareBrackets.matchAll(/\(([^()[\]]+)\)/gu)) {
		const inner = (match[1] ?? "").trim();
		if (!inner || inner.includes("/")) continue;
		if (/^(?:feat|ft|prod|ver|version|ost)\b/iu.test(inner)) continue;
		if (isDecorationOnlyBracketContent(inner)) continue;
		const innerKey = compactBgmCoreKey(inner);
		if (innerKey && !/^\d+$/u.test(innerKey) && innerKey.length >= 2) {
			keys.add(innerKey);
			const innerPhrase = tokenizeBgmCorePhrase(inner);
			if (innerPhrase) phrases.add(innerPhrase);
		}
	}

	const strippedSongSegment = songSegment
		.replace(/[\[(【〈《][^\]）】〉》]*[\])】〉》]/gu, " ")
		.trim();
	const primaryKey = compactBgmCoreKey(strippedSongSegment);
	if (primaryKey) {
		keys.add(primaryKey);
		const primaryPhrase = tokenizeBgmCorePhrase(strippedSongSegment);
		if (primaryPhrase) phrases.add(primaryPhrase);
	}

	if (keys.size === 0) {
		const fallbackRaw = target.replace(/[\[(【〈《][^\]）】〉》]*[\])】〉》]/gu, " ");
		const fallbackKey = compactBgmCoreKey(fallbackRaw);
		if (fallbackKey) {
			keys.add(fallbackKey);
			const fallbackPhrase = tokenizeBgmCorePhrase(fallbackRaw);
			if (fallbackPhrase) phrases.add(fallbackPhrase);
		}
	}

	return {
		coreKeys: [...keys],
		tokenPhrases: [...phrases],
		artistKeys,
	};
}

/**
 * Extract normalized core song title keys from a YouTube title (FR-RADIO-DJ.14).
 * Strips channel/show suffixes, leading tags (`[MV]`), artist prefixes (`Artist - ` / `Artist _ `),
 * bracketed/parenthesized decorations, and punctuation/whitespace, while retaining
 * parenthesized alternate-language song titles such as `Through the Night (밤편지)`.
 */
export function extractBgmSongCoreKeys(title: string): string[] {
	return parseBgmSongIdentity(title).coreKeys;
}

const BGM_CORE_KEY_CONTAINMENT_MIN_RATIO = 0.6;

function isPhraseLongEnoughForContainment(compact: string): boolean {
	if (!compact) return false;
	const isAsciiOnly = /^[a-z0-9]+$/u.test(compact);
	return isAsciiOnly ? compact.length >= 4 : compact.length >= 2;
}

function isTokenPhraseContainedAtBoundary(
	shorterPhrase: string,
	longerPhrase: string,
): boolean {
	const shorterTokens = shorterPhrase.split(" ").filter(Boolean);
	const longerTokens = longerPhrase.split(" ").filter(Boolean);
	if (shorterTokens.length === 0 || shorterTokens.length > longerTokens.length) {
		return false;
	}
	const shorterCompact = shorterTokens.join("");
	const longerCompact = longerTokens.join("");
	if (!shorterCompact || !longerCompact) return false;
	if (shorterCompact === longerCompact) return true;
	if (!isPhraseLongEnoughForContainment(shorterCompact)) {
		return false;
	}
	if (shorterCompact.length / longerCompact.length < BGM_CORE_KEY_CONTAINMENT_MIN_RATIO) {
		return false;
	}
	for (let start = 0; start <= longerTokens.length - shorterTokens.length; start += 1) {
		let matches = true;
		for (let offset = 0; offset < shorterTokens.length; offset += 1) {
			if (longerTokens[start + offset] !== shorterTokens[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) return true;
	}
	return false;
}

function expandArtistStrippedPhrases(
	phrases: readonly string[],
	artistKeySet: ReadonlySet<string>,
): { bodyPhrases: string[]; allPhrases: string[] } {
	if (artistKeySet.size === 0) {
		return { bodyPhrases: [...phrases], allPhrases: [...phrases] };
	}
	const bodyPhrases = new Set<string>();
	const allPhrases = new Set<string>();
	for (const phrase of phrases) {
		allPhrases.add(phrase);
		const tokens = phrase.split(" ").filter(Boolean);
		if (tokens.length === 0) continue;

		const remainingTokens: string[] = [];
		const segments: string[][] = [];
		let currentSegment: string[] = [];
		let index = 0;
		while (index < tokens.length) {
			let matchedEnd = -1;
			for (let end = tokens.length; end > index; end -= 1) {
				const spanCompact = tokens.slice(index, end).join("");
				if (artistKeySet.has(spanCompact)) {
					matchedEnd = end;
					break;
				}
			}
			if (matchedEnd !== -1) {
				if (currentSegment.length > 0) {
					segments.push(currentSegment);
					currentSegment = [];
				}
				index = matchedEnd;
			} else {
				const token = tokens[index]!;
				remainingTokens.push(token);
				currentSegment.push(token);
				index += 1;
			}
		}
		if (currentSegment.length > 0) {
			segments.push(currentSegment);
		}

		if (remainingTokens.length > 0 && remainingTokens.length < tokens.length) {
			const strippedJoined = remainingTokens.join(" ");
			bodyPhrases.add(strippedJoined);
			allPhrases.add(strippedJoined);
			if (segments.length >= 2) {
				for (const segment of segments) {
					const segCompact = segment.join("");
					if (segCompact.length >= 2) {
						allPhrases.add(segment.join(" "));
					}
				}
			}
		} else {
			bodyPhrases.add(phrase);
		}
	}
	return {
		bodyPhrases: [...bodyPhrases],
		allPhrases: [...allPhrases],
	};
}

function areAllTokenPhrasesContainedNonOverlapping(
	sourcePhrases: readonly string[],
	targetBodyPhrase: string,
): boolean {
	const uniquePhrases: { tokens: string[]; compact: string }[] = [];
	const seenCompact = new Set<string>();
	for (const phrase of sourcePhrases) {
		const tokens = phrase.split(" ").filter(Boolean);
		const compact = tokens.join("");
		if (!compact || seenCompact.has(compact)) continue;
		if (!isPhraseLongEnoughForContainment(compact)) return false;
		seenCompact.add(compact);
		uniquePhrases.push({ tokens, compact });
	}
	if (uniquePhrases.length < 2) return false;

	const targetTokens = targetBodyPhrase.split(" ").filter(Boolean);
	const targetCompact = targetTokens.join("");
	if (!targetCompact) return false;

	const totalSourceCompactLength = uniquePhrases.reduce(
		(sum, item) => sum + item.compact.length,
		0,
	);
	if (
		totalSourceCompactLength / targetCompact.length <
		BGM_CORE_KEY_CONTAINMENT_MIN_RATIO
	) {
		return false;
	}

	const sortedPhrases = [...uniquePhrases].sort(
		(a, b) =>
			b.tokens.length - a.tokens.length ||
			b.compact.length - a.compact.length,
	);
	const occurrencesByPhrase: [number, number][][] = sortedPhrases.map(
		({ tokens }) => {
			const ranges: [number, number][] = [];
			for (
				let start = 0;
				start <= targetTokens.length - tokens.length;
				start += 1
			) {
				let matches = true;
				for (let offset = 0; offset < tokens.length; offset += 1) {
					if (targetTokens[start + offset] !== tokens[offset]) {
						matches = false;
						break;
					}
				}
				if (matches) {
					ranges.push([start, start + tokens.length]);
				}
			}
			return ranges;
		},
	);
	if (occurrencesByPhrase.some((ranges) => ranges.length === 0)) {
		return false;
	}

	const chosenRanges: [number, number][] = [];
	function backtrack(phraseIndex: number): boolean {
		if (phraseIndex >= occurrencesByPhrase.length) return true;
		for (const [start, end] of occurrencesByPhrase[phraseIndex]!) {
			const overlaps = chosenRanges.some(
				([usedStart, usedEnd]) => start < usedEnd && end > usedStart,
			);
			if (overlaps) continue;
			chosenRanges.push([start, end]);
			if (backtrack(phraseIndex + 1)) return true;
			chosenRanges.pop();
		}
		return false;
	}

	return backtrack(0);
}

function areExtractedArtistsCompatible(
	artistsA: readonly string[],
	artistsB: readonly string[],
): boolean {
	if (artistsA.length === 0 || artistsB.length === 0) return true;
	return artistsA.some((a) => artistsB.includes(a));
}

/**
 * Determine whether two YouTube titles refer to the same song across alternate uploads,
 * bilingual titles, live stages, or lyric videos (FR-RADIO-DJ.14).
 */
export function isSameBgmSong(titleA: string, titleB: string): boolean {
	const parsedA = parseBgmSongIdentity(titleA);
	const parsedB = parseBgmSongIdentity(titleB);
	if (!areExtractedArtistsCompatible(parsedA.artistKeys, parsedB.artistKeys)) {
		return false;
	}
	const keysA = parsedA.coreKeys;
	const keysB = parsedB.coreKeys;
	if (keysA.length === 0 || keysB.length === 0) {
		const normA = normalizeBgmTitle(titleA);
		const normB = normalizeBgmTitle(titleB);
		return Boolean(normA && normA === normB);
	}
	for (const a of keysA) {
		for (const b of keysB) {
			if (a === b) return true;
		}
	}

	const combinedArtistKeys = new Set<string>([
		...parsedA.artistKeys,
		...parsedB.artistKeys,
	]);
	const strippedA = expandArtistStrippedPhrases(
		parsedA.tokenPhrases,
		combinedArtistKeys,
	);
	const strippedB = expandArtistStrippedPhrases(
		parsedB.tokenPhrases,
		combinedArtistKeys,
	);

	for (const phraseA of strippedA.allPhrases) {
		const compactA = phraseA.replace(/\s+/gu, "");
		if (!compactA) continue;
		for (const phraseB of strippedB.allPhrases) {
			const compactB = phraseB.replace(/\s+/gu, "");
			if (!compactB) continue;
			if (compactA === compactB) return true;
			const [shorter, longer] =
				phraseA.length <= phraseB.length ? [phraseA, phraseB] : [phraseB, phraseA];
			if (isTokenPhraseContainedAtBoundary(shorter, longer)) {
				return true;
			}
		}
	}

	for (const bodyB of strippedB.bodyPhrases) {
		if (areAllTokenPhrasesContainedNonOverlapping(strippedA.bodyPhrases, bodyB)) {
			return true;
		}
	}
	for (const bodyA of strippedA.bodyPhrases) {
		if (areAllTokenPhrasesContainedNonOverlapping(strippedB.bodyPhrases, bodyA)) {
			return true;
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
