import { LAB_GATEWAY_URL, loadConfig } from "../../config";
import { Logger } from "../../logger";
import { getSecretKey } from "../../secure-store";
import {
	SPEECH_UNITS,
	type SpeechPlan,
	type SpeechPlanEvent,
	type SpeechUnit,
} from "./vendor/speech-plan.js";

const LOG_NS = "NvaSpeech";
const CANONICAL_SPEECH_UNITS = new Set<string>(SPEECH_UNITS);

// Moved from naia-land-footer: src/features/studio-v2/live/engine/nva-speech/browser-speech-plan.ts
// (naia.land commit 8d5f3725a2facfc9db39212a893f90d389f4ec26).

export interface SpeechPlanUnitsWord {
	word: string;
	char_start: number;
	char_end: number;
	units: string[];
	weights?: number[];
}

export interface BrowserSpeechPlanInput {
	text: string;
	locale: string;
	words: SpeechPlanUnitsWord[];
	durationSeconds?: number;
}

interface WordAllocation {
	wordIndex: number;
	units: SpeechUnit[];
	weights: number[];
	start: number;
	end: number;
}

function asSpeechUnit(unit: string): SpeechUnit | null {
	return CANONICAL_SPEECH_UNITS.has(unit) ? (unit as SpeechUnit) : null;
}

function normalizeWordUnits(word: SpeechPlanUnitsWord): {
	units: SpeechUnit[];
	weights: number[];
} {
	const units: SpeechUnit[] = [];
	const weights: number[] = [];
	for (let index = 0; index < word.units.length; index += 1) {
		const unit = asSpeechUnit(word.units[index] ?? "");
		if (!unit || unit === "sil") continue;
		const rawWeight = word.weights?.[index];
		const weight =
			typeof rawWeight === "number" && Number.isFinite(rawWeight) && rawWeight > 0
				? rawWeight
				: 1;
		units.push(unit);
		weights.push(weight);
	}
	return { units, weights };
}

function defaultDurationSeconds(
	text: string,
	words: SpeechPlanUnitsWord[],
): number {
	const unitCount = words.reduce(
		(sum, word) => sum + Math.max(1, word.units.length),
		0,
	);
	const charCount = Array.from(text.trim()).length;
	return Math.max(0.75, unitCount * 0.082, charCount * 0.068);
}

interface RawSpeechSegment {
	start: number;
	end: number;
	unit: SpeechUnit;
	coarticulation_weight?: number;
}

function buildEventsFromWordAllocations(
	allocations: WordAllocation[],
	totalDuration: number,
): { durationUs: number; events: SpeechPlanEvent[] } {
	const raw: RawSpeechSegment[] = [];
	const leadHold = Math.min(0.05, totalDuration * 0.06);
	const tailHold = Math.min(0.08, totalDuration * 0.08);
	let cursor = 0;

	if (leadHold >= 0.025) {
		raw.push({
			start: 0,
			end: leadHold,
			unit: "sil",
			coarticulation_weight: 0.25,
		});
		cursor = leadHold;
	}

	const usableEnd = Math.max(cursor + 0.16, totalDuration - tailHold);
	for (const allocation of allocations) {
		const wordStart = Math.max(cursor, allocation.start);
		const wordEnd = Math.min(usableEnd, Math.max(wordStart + 0.04, allocation.end));
		if (allocation.units.length === 0) continue;

		if (wordStart - cursor >= 0.035) {
			raw.push({
				start: cursor,
				end: wordStart,
				unit: "sil",
				coarticulation_weight: 0.28,
			});
		}

		const span = Math.max(0.04, wordEnd - wordStart);
		const weightTotal =
			allocation.weights.reduce((sum, weight) => sum + weight, 0) ||
			allocation.units.length;
		let unitCursor = wordStart;
		for (let i = 0; i < allocation.units.length; i += 1) {
			const unit = allocation.units[i]!;
			const weight = allocation.weights[i] ?? 1;
			const isLast = i === allocation.units.length - 1;
			const nextCursor = isLast
				? wordEnd
				: Math.min(wordEnd, unitCursor + (span * weight) / weightTotal);
			if (nextCursor - unitCursor >= 0.012) {
				raw.push({
					start: unitCursor,
					end: nextCursor,
					unit,
					coarticulation_weight: unit.startsWith("vowel-") ? 0.62 : 0.42,
				});
				unitCursor = nextCursor;
			}
		}
		cursor = Math.max(cursor, wordEnd);
	}

	if (totalDuration - cursor >= 0.02) {
		raw.push({
			start: cursor,
			end: totalDuration,
			unit: "sil",
			coarticulation_weight: 0.25,
		});
	} else if (raw.length > 0) {
		raw[raw.length - 1]!.end = totalDuration;
	}

	const merged: RawSpeechSegment[] = [];
	for (const seg of raw) {
		const prev = merged[merged.length - 1];
		if (prev && prev.unit === seg.unit && Math.abs(prev.end - seg.start) < 1e-6) {
			prev.end = seg.end;
			prev.coarticulation_weight = Math.max(
				prev.coarticulation_weight ?? 0,
				seg.coarticulation_weight ?? 0,
			);
		} else {
			merged.push({ ...seg });
		}
	}

	const durationUs = Math.max(
		100_000,
		Math.round(totalDuration * 1_000_000),
		merged.length * 10_000,
	);
	const events: SpeechPlanEvent[] = [];
	let cursorUs = 0;
	for (let i = 0; i < merged.length; i += 1) {
		const seg = merged[i]!;
		const isLast = i === merged.length - 1;
		const remainingEvents = merged.length - 1 - i;
		const maxEndUs = durationUs - remainingEvents * 5_000;
		const targetEndUs = isLast
			? durationUs
			: Math.min(maxEndUs, Math.max(cursorUs + 5_000, Math.round(seg.end * 1_000_000)));
		events.push({
			unit: seg.unit,
			start_us: cursorUs,
			end_us: targetEndUs,
		});
		cursorUs = targetEndUs;
	}
	if (events.length === 0) {
		events.push({ unit: "sil", start_us: 0, end_us: durationUs });
	}
	return { durationUs, events };
}

export function buildBrowserTimedSpeechPlan(
	input: BrowserSpeechPlanInput,
): SpeechPlan {
	const normalizedWords = input.words
		.map((word, wordIndex) => ({
			wordIndex,
			...normalizeWordUnits(word),
		}))
		.filter((word) => word.units.length > 0);
	if (normalizedWords.length === 0) {
		throw new Error("browser speech plan requires at least one speech unit");
	}

	const totalDuration =
		input.durationSeconds && input.durationSeconds > 0.2
			? input.durationSeconds
			: defaultDurationSeconds(input.text, input.words);
	const leadHold = Math.min(0.05, totalDuration * 0.06);
	const tailHold = Math.min(0.08, totalDuration * 0.08);
	const pauseCount = Math.max(0, normalizedWords.length - 1);
	const pauseDuration =
		pauseCount > 0 ? Math.min(0.045, (totalDuration * 0.08) / pauseCount) : 0;
	const activeSpan = Math.max(
		0.18,
		totalDuration - leadHold - tailHold - pauseDuration * pauseCount,
	);
	const totalWeight =
		normalizedWords.reduce(
			(sum, word) => sum + word.weights.reduce((wSum, weight) => wSum + weight, 0),
			0,
		) || normalizedWords.length;

	let cursor = leadHold;
	const allocations: WordAllocation[] = normalizedWords.map((word, idx) => {
		const wordWeight =
			word.weights.reduce((sum, weight) => sum + weight, 0) || word.units.length;
		const span = Math.max(0.045, (activeSpan * wordWeight) / totalWeight);
		const start = cursor;
		const end =
			idx === normalizedWords.length - 1
				? Math.max(start + 0.045, totalDuration - tailHold)
				: start + span;
		cursor = end + pauseDuration;
		return {
			wordIndex: word.wordIndex,
			units: word.units,
			weights: word.weights,
			start,
			end,
		};
	});

	const { durationUs, events } = buildEventsFromWordAllocations(
		allocations,
		totalDuration,
	);
	return {
		version: "1",
		text: input.text,
		quality_mode: "browser-timed",
		audio: { duration_us: durationUs },
		events,
	};
}

export function updateBrowserTimedSpeechPlanForWordBoundary(input: {
	text: string;
	locale: string;
	words: SpeechPlanUnitsWord[];
	charIndex: number;
	elapsedSeconds: number;
	previousBoundaries?: Map<number, number>;
}): SpeechPlan | null {
	if (!Number.isFinite(input.elapsedSeconds) || input.elapsedSeconds < 0) {
		return null;
	}
	const wordIndex = input.words.findIndex(
		(word, idx) =>
			(input.charIndex >= word.char_start && input.charIndex < word.char_end) ||
			(idx === input.words.length - 1 && input.charIndex >= word.char_start),
	);
	if (wordIndex < 0) return null;

	const boundaries = new Map(input.previousBoundaries ?? []);
	boundaries.set(wordIndex, input.elapsedSeconds);
	const normalizedWords = input.words
		.map((word, idx) => ({
			wordIndex: idx,
			...normalizeWordUnits(word),
		}))
		.filter((word) => word.units.length > 0);
	if (normalizedWords.length === 0) return null;

	const currentPos = normalizedWords.findIndex((w) => w.wordIndex === wordIndex);
	if (currentPos < 0) return null;

	const wordWeights = normalizedWords.map(
		(word) =>
			word.weights.reduce((sum, weight) => sum + weight, 0) || word.units.length,
	);
	const weightBefore = wordWeights
		.slice(0, currentPos)
		.reduce((sum, weight) => sum + weight, 0);
	const totalWeight =
		wordWeights.reduce((sum, weight) => sum + weight, 0) ||
		normalizedWords.length;
	const defaultTotal = defaultDurationSeconds(input.text, input.words);
	const defaultSecPerWeight = defaultTotal / totalWeight;
	const observedSecPerWeight =
		weightBefore > 0 && input.elapsedSeconds > 0.08
			? Math.min(
					0.22,
					Math.max(0.038, input.elapsedSeconds / weightBefore),
				)
			: defaultSecPerWeight;

	const allocations: WordAllocation[] = [];
	let cursor = Math.min(0.04, Math.max(0.02, input.elapsedSeconds * 0.25));
	for (let pos = 0; pos < normalizedWords.length; pos += 1) {
		const word = normalizedWords[pos]!;
		const weight = wordWeights[pos] ?? 1;
		const knownStart = boundaries.get(word.wordIndex);
		const nextWord = normalizedWords[pos + 1];
		const knownNextStart = nextWord
			? boundaries.get(nextWord.wordIndex)
			: undefined;
		const start =
			knownStart !== undefined ? Math.max(cursor, knownStart) : cursor;
		const estimatedSpan = Math.max(0.045, weight * observedSecPerWeight);
		const end =
			knownNextStart !== undefined && knownNextStart > start + 0.03
				? Math.max(start + 0.03, knownNextStart - 0.015)
				: start + estimatedSpan;
		allocations.push({
			wordIndex: word.wordIndex,
			units: word.units,
			weights: word.weights,
			start,
			end,
		});
		cursor = end + 0.018;
	}

	const totalDuration = Math.max(cursor + 0.06, input.elapsedSeconds + 0.18);
	const { durationUs, events } = buildEventsFromWordAllocations(
		allocations,
		totalDuration,
	);
	return {
		version: "1",
		text: input.text,
		quality_mode: "browser-timed",
		audio: { duration_us: durationUs },
		events,
	};
}

export interface BrowserTimedSpeechController {
	readonly initialPlan: SpeechPlan;
	clock(): number;
	markStarted(): void;
	updateForBoundary(
		charIndex: number,
		elapsedTime?: number,
	): SpeechPlan | null;
}

const KO_SPEECH_UNITS_WORD_READINGS: Readonly<Record<string, string>> = {
	nextain: "넥스테인",
	naia: "나이아",
	ai: "에이아이",
	ir: "아이알",
	gpu: "지피유",
	webgpu: "웹지피유",
	web: "웹",
	pc: "피씨",
	pdf: "피디에프",
	tts: "티티에스",
	api: "에이피아이",
	app: "앱",
};

const KO_SPEECH_UNITS_LETTER_READINGS: Readonly<Record<string, string>> = {
	a: "에이",
	b: "비",
	c: "씨",
	d: "디",
	e: "이",
	f: "에프",
	g: "지",
	h: "에이치",
	i: "아이",
	j: "제이",
	k: "케이",
	l: "엘",
	m: "엠",
	n: "엔",
	o: "오",
	p: "피",
	q: "큐",
	r: "알",
	s: "에스",
	t: "티",
	u: "유",
	v: "브이",
	w: "더블유",
	x: "엑스",
	y: "와이",
	z: "지",
};

export function replaceLatinWithHangulForSpeechUnits(text: string): string {
	return text.replace(/[A-Za-z]+/g, (chunk) => {
		const wordReading = KO_SPEECH_UNITS_WORD_READINGS[chunk.toLowerCase()];
		if (wordReading) return wordReading;
		let out = "";
		for (const ch of chunk) {
			out += KO_SPEECH_UNITS_LETTER_READINGS[ch.toLowerCase()] ?? "";
		}
		return out;
	});
}

export function speechUnitsLanguage(tag: string | null | undefined): string {
	const primary = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
	if (primary === "cmn" || primary === "yue") return "zh";
	return primary || "ko";
}

export async function fetchSpeechPlanUnits(
	text: string,
	locale: string,
): Promise<SpeechPlanUnitsWord[] | null> {
	try {
		const language = speechUnitsLanguage(locale);
		const requestText =
			language === "ko" ? replaceLatinWithHangulForSpeechUnits(text) : text;
		const res = await fetch("/api/studio/speech-plan/units", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: requestText, language }),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { words?: SpeechPlanUnitsWord[] };
		return Array.isArray(body.words) && body.words.length > 0
			? body.words
			: null;
	} catch {
		return null;
	}
}

export function createBrowserTimedSpeechControllerFromWords(
	text: string,
	locale: string,
	words: SpeechPlanUnitsWord[],
	durationSeconds?: number,
): BrowserTimedSpeechController | null {
	let initialPlan: SpeechPlan;
	try {
		initialPlan = buildBrowserTimedSpeechPlan({
			text,
			locale,
			words,
			durationSeconds,
		});
	} catch {
		return null;
	}

	const boundaries = new Map<number, number>();
	let startedAtMs: number | null = null;
	const nowMs = () =>
		typeof performance !== "undefined" ? performance.now() : Date.now();

	return {
		initialPlan,
		markStarted() {
			if (startedAtMs === null) startedAtMs = nowMs();
		},
		clock() {
			if (startedAtMs === null) return 0;
			return Math.max(0, (nowMs() - startedAtMs) / 1000);
		},
		updateForBoundary(charIndex: number, elapsedTime?: number) {
			if (startedAtMs === null) startedAtMs = nowMs();
			const wallSeconds = Math.max(0, (nowMs() - startedAtMs) / 1000);
			const rawElapsed =
				typeof elapsedTime === "number" &&
				Number.isFinite(elapsedTime) &&
				elapsedTime >= 0
					? elapsedTime > 60
						? elapsedTime / 1000
						: elapsedTime
					: wallSeconds;
			const elapsedSeconds = rawElapsed > 0.005 ? rawElapsed : wallSeconds;
			return updateBrowserTimedSpeechPlanForWordBoundary({
				text,
				locale,
				words,
				charIndex,
				elapsedSeconds,
				previousBoundaries: boundaries,
			});
		},
	};
}

export async function createBrowserTimedSpeech(
	text: string,
	locale: string,
): Promise<BrowserTimedSpeechController | null> {
	const words = await fetchSpeechPlanUnits(text, locale);
	if (!words) return null;
	return createBrowserTimedSpeechControllerFromWords(text, locale, words);
}

// ── Hangul & Latin deterministic pronunciation decomposition (G2P fallback) ──

const HANGUL_ONSET_UNITS: readonly (SpeechUnit | null)[] = [
	"velar", // ㄱ
	"velar", // ㄲ
	"alveolar", // ㄴ
	"alveolar", // ㄷ
	"alveolar", // ㄸ
	"alveolar", // ㄹ
	"closed", // ㅁ
	"closed", // ㅂ
	"closed", // ㅃ
	"alveolar", // ㅅ
	"alveolar", // ㅆ
	null, // ㅇ (silent onset)
	"postalveolar", // ㅈ
	"postalveolar", // ㅉ
	"postalveolar", // ㅊ
	"velar", // ㅋ
	"alveolar", // ㅌ
	"closed", // ㅍ
	"glottal", // ㅎ
];

const HANGUL_NUCLEUS_UNITS: readonly (readonly [SpeechUnit, number] | readonly [SpeechUnit, number, SpeechUnit, number])[] = [
	["vowel-open", 1.15], // ㅏ
	["vowel-mid", 1.1], // ㅐ
	["palatal", 0.45, "vowel-open", 1.05], // ㅑ
	["palatal", 0.45, "vowel-mid", 1.0], // ㅒ
	["vowel-mid", 1.15], // ㅓ
	["vowel-mid", 1.1], // ㅔ
	["palatal", 0.45, "vowel-mid", 1.05], // ㅕ
	["palatal", 0.45, "vowel-mid", 1.0], // ㅖ
	["vowel-round", 1.15], // ㅗ
	["vowel-round", 0.55, "vowel-open", 0.95], // ㅘ
	["vowel-round", 0.55, "vowel-mid", 0.95], // ㅙ
	["vowel-round", 0.6, "vowel-spread", 0.9], // ㅚ
	["palatal", 0.45, "vowel-round", 1.05], // ㅛ
	["vowel-round", 1.15], // ㅜ
	["vowel-round", 0.55, "vowel-mid", 0.95], // ㅝ
	["vowel-round", 0.55, "vowel-mid", 0.95], // ㅞ
	["vowel-round", 0.55, "vowel-spread", 0.95], // ㅟ
	["palatal", 0.45, "vowel-round", 1.05], // ㅠ
	["vowel-mid", 1.0], // ㅡ
	["vowel-mid", 0.5, "vowel-spread", 0.95], // ㅢ
	["vowel-spread", 1.1], // ㅣ
];

const HANGUL_CODA_UNITS: readonly (SpeechUnit | null)[] = [
	null, // (none)
	"velar", // ㄱ
	"velar", // ㄲ
	"velar", // ㄳ
	"alveolar", // ㄴ
	"alveolar", // ㄵ
	"alveolar", // ㄶ
	"alveolar", // ㄷ
	"alveolar", // ㄹ
	"velar", // ㄺ
	"closed", // ㄻ
	"closed", // ㄼ
	"alveolar", // ㄽ
	"alveolar", // ㄾ
	"closed", // ㄿ
	"alveolar", // ㅀ
	"closed", // ㅁ
	"closed", // ㅂ
	"closed", // ㅄ
	"alveolar", // ㅅ
	"alveolar", // ㅆ
	"velar", // ㅇ
	"alveolar", // ㅈ
	"alveolar", // ㅊ
	"velar", // ㅋ
	"alveolar", // ㅌ
	"closed", // ㅍ
	"alveolar", // ㅎ
];

const LATIN_CHAR_UNITS: Record<string, readonly [SpeechUnit, number]> = {
	a: ["vowel-open", 1.1],
	b: ["closed", 0.7],
	c: ["velar", 0.7],
	d: ["alveolar", 0.7],
	e: ["vowel-mid", 1.05],
	f: ["labiodental", 0.75],
	g: ["velar", 0.7],
	h: ["glottal", 0.65],
	i: ["vowel-spread", 1.05],
	j: ["postalveolar", 0.75],
	k: ["velar", 0.7],
	l: ["alveolar", 0.7],
	m: ["closed", 0.75],
	n: ["alveolar", 0.7],
	o: ["vowel-round", 1.1],
	p: ["closed", 0.7],
	q: ["velar", 0.7],
	r: ["alveolar", 0.7],
	s: ["alveolar", 0.75],
	t: ["alveolar", 0.7],
	u: ["vowel-round", 1.05],
	v: ["labiodental", 0.75],
	w: ["vowel-round", 0.75],
	x: ["alveolar", 0.75],
	y: ["palatal", 0.75],
	z: ["alveolar", 0.75],
	"0": ["vowel-round", 1.0],
	"1": ["vowel-spread", 1.0],
	"2": ["vowel-spread", 1.0],
	"3": ["vowel-open", 1.0],
	"4": ["vowel-open", 1.0],
	"5": ["vowel-round", 1.0],
	"6": ["vowel-round", 1.0],
	"7": ["vowel-spread", 1.0],
	"8": ["vowel-open", 1.0],
	"9": ["vowel-round", 1.0],
};

/**
 * Deterministic Hangul + Latin G2P decomposition into the 13 canonical speech units.
 * Used when the Studio `/v1/studio/speech-plan/units` endpoint is offline or unmocked.
 */
export function synthesizePronunciationWordsFromText(
	text: string,
): SpeechPlanUnitsWord[] {
	const words: SpeechPlanUnitsWord[] = [];
	const tokenPattern = /[\p{L}\p{N}]+/gu;
	for (const match of text.matchAll(tokenPattern)) {
		const word = match[0];
		const charStart = match.index ?? 0;
		const charEnd = charStart + word.length;
		const units: SpeechUnit[] = [];
		const weights: number[] = [];

		const pushUnit = (unit: SpeechUnit | null | undefined, weight: number) => {
			if (!unit) return;
			if (units[units.length - 1] === unit) {
				weights[weights.length - 1] =
					Math.round(((weights[weights.length - 1] ?? 1) + weight * 0.45) * 100) /
					100;
				return;
			}
			units.push(unit);
			weights.push(weight);
		};

		for (const ch of word) {
			const code = ch.codePointAt(0) ?? 0;
			if (code >= 0xac00 && code <= 0xd7a3) {
				const syllableIndex = code - 0xac00;
				const onsetIdx = Math.floor(syllableIndex / 588);
				const nucleusIdx = Math.floor((syllableIndex % 588) / 28);
				const codaIdx = syllableIndex % 28;

				pushUnit(HANGUL_ONSET_UNITS[onsetIdx], 0.7);
				const nucleus = HANGUL_NUCLEUS_UNITS[nucleusIdx];
				if (nucleus) {
					pushUnit(nucleus[0], nucleus[1]);
					if (nucleus.length === 4) {
						pushUnit(nucleus[2], nucleus[3]);
					}
				}
				pushUnit(HANGUL_CODA_UNITS[codaIdx], 0.65);
			} else {
				const mapped = LATIN_CHAR_UNITS[ch.toLowerCase()];
				if (mapped) {
					pushUnit(mapped[0], mapped[1]);
				}
			}
		}

		if (units.length > 0) {
			words.push({
				word,
				char_start: charStart,
				char_end: charEnd,
				units,
				weights,
			});
		}
	}
	return words;
}

export interface GatewaySpeechPlanUnitsDeps {
	getConfig?: () => { gatewayUrl?: string; locale?: string } | null;
	getNaiaKey?: () => Promise<string | undefined>;
	fetchImpl?: typeof fetch;
}

function resolveGatewayBaseUrl(config?: { gatewayUrl?: string } | null): string {
	const raw =
		config?.gatewayUrl?.trim() || LAB_GATEWAY_URL || "https://api.nextain.io";
	return raw.replace(/\/+$/, "");
}

async function resolveGatewayNaiaKey(
	getNaiaKey?: () => Promise<string | undefined>,
): Promise<string> {
	if (getNaiaKey) {
		const provided = (await getNaiaKey())?.trim();
		if (provided) return provided;
	}
	const secret = (await getSecretKey("naiaKey"))?.trim();
	if (secret) return secret;
	if (typeof localStorage !== "undefined") {
		const remote = localStorage.getItem("naia-remote-key")?.trim();
		if (remote) return remote;
	}
	return "";
}

/**
 * Fetch pronunciation units for `text` from Studio gateway `POST /v1/studio/speech-plan/units`,
 * falling back to deterministic Hangul/Latin pronunciation decomposition when offline.
 */
export async function fetchGatewaySpeechPlanUnits(
	text: string,
	locale: string,
	deps: GatewaySpeechPlanUnitsDeps = {},
): Promise<SpeechPlanUnitsWord[]> {
	const trimmed = text.trim();
	if (!trimmed) return [];

	const getConfig = deps.getConfig ?? loadConfig;
	const fetchFn = deps.fetchImpl ?? fetch;
	const config = getConfig();
	const baseUrl = resolveGatewayBaseUrl(config);
	const naiaKey = await resolveGatewayNaiaKey(deps.getNaiaKey);

	if (baseUrl && naiaKey) {
		try {
			const language = speechUnitsLanguage(locale);
			const requestText =
				language === "ko"
					? replaceLatinWithHangulForSpeechUnits(trimmed)
					: trimmed;
			const resp = await fetchFn(`${baseUrl}/v1/studio/speech-plan/units`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AnyLLM-Key": `Bearer ${naiaKey}`,
				},
				body: JSON.stringify({
					text: requestText,
					language,
				}),
			});
			if (resp.ok) {
				const contentType =
					resp.headers?.get?.("content-type")?.toLowerCase() ?? "";
				if (!contentType.startsWith("audio/")) {
					const body = (await resp.json()) as { words?: SpeechPlanUnitsWord[] };
					if (Array.isArray(body.words) && body.words.length > 0) {
						return body.words;
					}
				}
			} else {
				Logger.debug(LOG_NS, "Gateway speech-plan/units HTTP non-OK, using G2P fallback", {
					status: resp.status,
				});
			}
		} catch (err) {
			Logger.debug(LOG_NS, "Gateway speech-plan/units request failed, using G2P fallback", {
				error: String(err),
			});
		}
	}

	return synthesizePronunciationWordsFromText(trimmed);
}

/**
 * Estimate audio duration from WAV base64 header (byteRate at offset 28..32) or byte length.
 */
export function estimateAudioDurationSecondsFromBase64(
	audioBase64: string,
	text: string,
	words: SpeechPlanUnitsWord[],
): number {
	const fallback = defaultDurationSeconds(text, words);
	if (!audioBase64) return fallback;
	try {
		const approxByteLen = Math.floor((audioBase64.length * 3) / 4);
		if (audioBase64.startsWith("UklGR") && approxByteLen > 44) {
			const headerSlice = atob(audioBase64.slice(0, 64));
			if (headerSlice.length >= 32 && headerSlice.slice(0, 4) === "RIFF") {
				const b0 = headerSlice.charCodeAt(28) & 0xff;
				const b1 = headerSlice.charCodeAt(29) & 0xff;
				const b2 = headerSlice.charCodeAt(30) & 0xff;
				const b3 = headerSlice.charCodeAt(31) & 0xff;
				const byteRate = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
				if (byteRate >= 8000 && byteRate <= 384000) {
					const dur = (approxByteLen - 44) / byteRate;
					if (Number.isFinite(dur) && dur >= 0.25 && dur <= 120) {
						return dur;
					}
				}
			}
		}
	} catch {
		// Fall back to text/unit duration estimate
	}
	return fallback;
}

/**
 * Build a `quality_mode: "browser-timed"` `SpeechPlan` anchored across `durationSeconds`
 * for `AudioQueue` / `CanonicalSpeechStage.playExternal(clock)`.
 * Note: `validateSpeechPlan` requires at least one word-boundary re-anchor when
 * `quality_mode === "browser-timed"`, so we anchor the final word boundary proportionally
 * against `durationSeconds` via `updateBrowserTimedSpeechPlanForWordBoundary`.
 */
export async function createAudioTimedBrowserSpeechPlan(
	input: {
		text: string;
		locale?: string;
		audioBase64?: string;
		durationSeconds?: number;
	},
	deps: GatewaySpeechPlanUnitsDeps = {},
): Promise<SpeechPlan | null> {
	const trimmed = input.text.trim();
	if (!trimmed) return null;
	const locale = input.locale || deps.getConfig?.()?.locale || "ko-KR";
	const words = await fetchGatewaySpeechPlanUnits(trimmed, locale, deps);
	if (words.length === 0) return null;

	const duration =
		typeof input.durationSeconds === "number" && input.durationSeconds > 0.2
			? input.durationSeconds
			: estimateAudioDurationSecondsFromBase64(
					input.audioBase64 ?? "",
					trimmed,
					words,
				);

	try {
		const initial = buildBrowserTimedSpeechPlan({
			text: trimmed,
			locale,
			words,
			durationSeconds: duration,
		});
		if (words.length >= 2) {
			const boundaries = new Map<number, number>();
			const leadHold = Math.min(0.05, duration * 0.06);
			const tailHold = Math.min(0.08, duration * 0.08);
			const usableSpan = Math.max(0.18, duration - leadHold - tailHold);
			const wordWeights = words.map((w) =>
				Math.max(
					1,
					(w.weights ?? []).reduce((s, x) => s + x, 0) || w.units.length,
				),
			);
			const totalWeight =
				wordWeights.reduce((s, x) => s + x, 0) || words.length;
			let accWeight = 0;
			for (let idx = 0; idx < words.length; idx += 1) {
				const startSec = leadHold + (usableSpan * accWeight) / totalWeight;
				boundaries.set(idx, startSec);
				accWeight += wordWeights[idx] ?? 1;
			}
			const lastWord = words[words.length - 1]!;
			const lastStart =
				boundaries.get(words.length - 1) ?? Math.max(0.08, duration * 0.65);
			const anchored = updateBrowserTimedSpeechPlanForWordBoundary({
				text: trimmed,
				locale,
				words,
				charIndex: lastWord.char_start,
				elapsedSeconds: lastStart,
				previousBoundaries: boundaries,
			});
			if (anchored) return anchored;
		}
		return initial;
	} catch (err) {
		Logger.warn(LOG_NS, "Failed to build audio-timed browser speech plan", {
			error: String(err),
		});
		return null;
	}
}

/**
 * Create a `BrowserTimedSpeechController` backed by gateway `/v1/studio/speech-plan/units`
 * (with Hangul/Latin G2P fallback) for browser `speechSynthesis` (`onboundary`).
 */
export async function createGatewayBrowserTimedSpeech(
	text: string,
	locale = "ko-KR",
	deps: GatewaySpeechPlanUnitsDeps = {},
): Promise<BrowserTimedSpeechController | null> {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const words = await fetchGatewaySpeechPlanUnits(trimmed, locale, deps);
	if (words.length === 0) return null;
	return createBrowserTimedSpeechControllerFromWords(trimmed, locale, words);
}
