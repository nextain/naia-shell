/**
 * Azure AI Speech multilingual voice presets, smart voice resolution,
 * pricing estimation, and safe SSML builder for Naia Shell (Web / Mobile / Desktop).
 */

import type { TtsVoiceMeta } from "./types";

export type AzureSpeechVoiceTier = "neural" | "dragon-hd" | "multilingual";

export interface AzureSpeechVoicePreset extends TtsVoiceMeta {
	id: string;
	label: string;
	language: string;
	gender: "male" | "female" | "neutral";
	tier: AzureSpeechVoiceTier;
	/** Whether Azure Speech emits real-time Viseme ID (0..21) events for this voice. */
	supportsViseme: boolean;
	/** Supported mstts:express-as speaking styles, if any. */
	styles?: readonly string[];
	/** Retail USD cost per 1M characters (covered by Azure Sponsorship / Foundry credits). */
	costPerMillionCharsUsd: number;
}

/** Standard Neural TTS retail rate ($16 / 1M chars). */
export const AZURE_NEURAL_COST_PER_M_CHARS_USD = 16;

/** DragonHD Latest Neural TTS retail rate ($30 / 1M chars). */
export const AZURE_DRAGON_HD_COST_PER_M_CHARS_USD = 30;

export const DEFAULT_AZURE_SPEECH_VOICE_KO = "ko-KR-SunHiNeural";
export const DEFAULT_AZURE_SPEECH_VOICE_EN = "en-US-AriaNeural";
export const DEFAULT_AZURE_SPEECH_VOICE_JA = "ja-JP-NanamiNeural";
export const DEFAULT_AZURE_SPEECH_VOICE_ZH = "zh-CN-XiaoxiaoNeural";

/**
 * Curated multilingual Azure AI Speech voice catalog covering Korean, English,
 * Japanese, Chinese, and European locales, including Standard Neural,
 * Multilingual Neural, and DragonHD voices.
 */
export const AZURE_SPEECH_VOICE_PRESETS: readonly AzureSpeechVoicePreset[] = [
	{
		id: "ko-KR-SunHiNeural",
		label: "선희 (SunHi · 한국어 표준 Neural)",
		language: "ko-KR",
		gender: "female",
		tier: "neural",
		supportsViseme: true,
		styles: ["cheerful", "sad", "angry", "friendly"],
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "ko-KR-SunHi:DragonHDLatestNeural",
		label: "선희 HD (SunHi DragonHD · 초자연 한국어)",
		language: "ko-KR",
		gender: "female",
		tier: "dragon-hd",
		supportsViseme: false,
		costPerMillionCharsUsd: AZURE_DRAGON_HD_COST_PER_M_CHARS_USD,
	},
	{
		id: "ko-KR-HyunsuMultilingualNeural",
		label: "현수 다국어 (Hyunsu Multilingual · 한/영/일 자연 전환)",
		language: "ko-KR",
		gender: "male",
		tier: "multilingual",
		supportsViseme: true,
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "ko-KR-Hyunsu:DragonHDLatestNeural",
		label: "현수 HD (Hyunsu DragonHD · 초자연 한국어 남성)",
		language: "ko-KR",
		gender: "male",
		tier: "dragon-hd",
		supportsViseme: false,
		costPerMillionCharsUsd: AZURE_DRAGON_HD_COST_PER_M_CHARS_USD,
	},
	{
		id: "ko-KR-InJoonNeural",
		label: "인준 (InJoon · 한국어 남성 Neural)",
		language: "ko-KR",
		gender: "male",
		tier: "neural",
		supportsViseme: true,
		styles: ["cheerful", "sad"],
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "ko-KR-YuJinNeural",
		label: "유진 (YuJin · 한국어 밝은 여성 Neural)",
		language: "ko-KR",
		gender: "female",
		tier: "neural",
		supportsViseme: true,
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "en-US-AriaNeural",
		label: "Aria (English US · Standard Neural)",
		language: "en-US",
		gender: "female",
		tier: "neural",
		supportsViseme: true,
		styles: ["chat", "cheerful", "empathetic", "customerservice", "newscast"],
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "en-US-AvaMultilingualNeural",
		label: "Ava Multilingual (English US · Multilingual Neural)",
		language: "en-US",
		gender: "female",
		tier: "multilingual",
		supportsViseme: true,
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "en-US-Ava:DragonHDLatestNeural",
		label: "Ava HD (English US · DragonHD)",
		language: "en-US",
		gender: "female",
		tier: "dragon-hd",
		supportsViseme: false,
		costPerMillionCharsUsd: AZURE_DRAGON_HD_COST_PER_M_CHARS_USD,
	},
	{
		id: "en-US-GuyNeural",
		label: "Guy (English US · Male Neural)",
		language: "en-US",
		gender: "male",
		tier: "neural",
		supportsViseme: true,
		styles: ["newscast", "cheerful", "friendly"],
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "en-US-Andrew:DragonHDLatestNeural",
		label: "Andrew HD (English US · Male DragonHD)",
		language: "en-US",
		gender: "male",
		tier: "dragon-hd",
		supportsViseme: false,
		costPerMillionCharsUsd: AZURE_DRAGON_HD_COST_PER_M_CHARS_USD,
	},
	{
		id: "ja-JP-NanamiNeural",
		label: "七海 (Nanami · 日本語 Neural)",
		language: "ja-JP",
		gender: "female",
		tier: "neural",
		supportsViseme: true,
		styles: ["chat", "cheerful", "customerservice"],
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "ja-JP-KeitaNeural",
		label: "圭太 (Keita · 日本語 男性 Neural)",
		language: "ja-JP",
		gender: "male",
		tier: "neural",
		supportsViseme: true,
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "ja-JP-Masaru:DragonHDLatestNeural",
		label: "マサル HD (Masaru · 日本語 DragonHD)",
		language: "ja-JP",
		gender: "male",
		tier: "dragon-hd",
		supportsViseme: false,
		costPerMillionCharsUsd: AZURE_DRAGON_HD_COST_PER_M_CHARS_USD,
	},
	{
		id: "zh-CN-XiaoxiaoNeural",
		label: "晓晓 (Xiaoxiao · 中文普通话 Neural)",
		language: "zh-CN",
		gender: "female",
		tier: "neural",
		supportsViseme: true,
		styles: ["chat", "cheerful", "affectionate", "gentle"],
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "zh-CN-YunxiNeural",
		label: "云希 (Yunxi · 中文普通话 男声 Neural)",
		language: "zh-CN",
		gender: "male",
		tier: "neural",
		supportsViseme: true,
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "zh-CN-Xiaochen:DragonHDLatestNeural",
		label: "晓辰 HD (Xiaochen · 中文 DragonHD)",
		language: "zh-CN",
		gender: "female",
		tier: "dragon-hd",
		supportsViseme: false,
		costPerMillionCharsUsd: AZURE_DRAGON_HD_COST_PER_M_CHARS_USD,
	},
	{
		id: "es-ES-ElviraNeural",
		label: "Elvira (Español · Neural)",
		language: "es-ES",
		gender: "female",
		tier: "neural",
		supportsViseme: true,
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "fr-FR-DeniseNeural",
		label: "Denise (Français · Neural)",
		language: "fr-FR",
		gender: "female",
		tier: "neural",
		supportsViseme: true,
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
	{
		id: "de-DE-KatjaNeural",
		label: "Katja (Deutsch · Neural)",
		language: "de-DE",
		gender: "female",
		tier: "neural",
		supportsViseme: true,
		costPerMillionCharsUsd: AZURE_NEURAL_COST_PER_M_CHARS_USD,
	},
] as const;

const PRESET_BY_ID = new Map<string, AzureSpeechVoicePreset>(
	AZURE_SPEECH_VOICE_PRESETS.map((preset) => [preset.id.toLowerCase(), preset]),
);

const VOICE_ALIASES: Record<string, string> = {
	default: DEFAULT_AZURE_SPEECH_VOICE_KO,
	"naia-default": DEFAULT_AZURE_SPEECH_VOICE_KO,
	sunhi: "ko-KR-SunHiNeural",
	"sunhi-hd": "ko-KR-SunHi:DragonHDLatestNeural",
	"ko-hd": "ko-KR-SunHi:DragonHDLatestNeural",
	dragonhd: "ko-KR-SunHi:DragonHDLatestNeural",
	"dragon-hd": "ko-KR-SunHi:DragonHDLatestNeural",
	hyunsu: "ko-KR-HyunsuMultilingualNeural",
	"hyunsu-hd": "ko-KR-Hyunsu:DragonHDLatestNeural",
	injoon: "ko-KR-InJoonNeural",
	yujin: "ko-KR-YuJinNeural",
	aria: "en-US-AriaNeural",
	ava: "en-US-AvaMultilingualNeural",
	"ava-hd": "en-US-Ava:DragonHDLatestNeural",
	guy: "en-US-GuyNeural",
	nanami: "ja-JP-NanamiNeural",
	keita: "ja-JP-KeitaNeural",
	xiaoxiao: "zh-CN-XiaoxiaoNeural",
	yunxi: "zh-CN-YunxiNeural",
	// OpenAI / Gateway friendly voice aliases
	nova: "ko-KR-SunHiNeural",
	shimmer: "ko-KR-YuJinNeural",
	alloy: "ko-KR-SunHiNeural",
	echo: "ko-KR-HyunsuMultilingualNeural",
	onyx: "ko-KR-InJoonNeural",
	fable: "en-US-AriaNeural",
};

const LOCALE_DEFAULT_VOICE: Record<string, string> = {
	ko: DEFAULT_AZURE_SPEECH_VOICE_KO,
	"ko-kr": DEFAULT_AZURE_SPEECH_VOICE_KO,
	en: DEFAULT_AZURE_SPEECH_VOICE_EN,
	"en-us": DEFAULT_AZURE_SPEECH_VOICE_EN,
	"en-gb": "en-GB-SoniaNeural",
	ja: DEFAULT_AZURE_SPEECH_VOICE_JA,
	"ja-jp": DEFAULT_AZURE_SPEECH_VOICE_JA,
	zh: DEFAULT_AZURE_SPEECH_VOICE_ZH,
	"zh-cn": DEFAULT_AZURE_SPEECH_VOICE_ZH,
	es: "es-ES-ElviraNeural",
	"es-es": "es-ES-ElviraNeural",
	fr: "fr-FR-DeniseNeural",
	"fr-fr": "fr-FR-DeniseNeural",
	de: "de-DE-KatjaNeural",
	"de-de": "de-DE-KatjaNeural",
};

const AZURE_VOICE_ID_PATTERN =
	/^[a-z]{2,3}-[A-Z]{2,4}(?:-[A-Za-z0-9]+)?-[A-Za-z0-9:_-]+Neural$/;

const HANGUL_RE = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const KANA_RE = /[\u3040-\u30ff]/;
const CJK_RE = /[\u4e00-\u9fff]/;

/** Returns true if the voice identifier targets an Azure DragonHD model. */
export function isDragonHdVoice(voiceId: string): boolean {
	return /dragonhd/i.test(voiceId);
}

/** Look up a known preset by exact or case-insensitive voice ID. */
export function getAzureSpeechVoicePreset(
	voiceId: string,
): AzureSpeechVoicePreset | undefined {
	return PRESET_BY_ID.get(voiceId.trim().toLowerCase());
}

/** Infer BCP-47 locale from an Azure voice ID (e.g. `ko-KR-SunHiNeural` -> `ko-KR`). */
export function inferLocaleFromAzureVoice(voiceId: string): string {
	const match = /^([a-z]{2,3}-[A-Z]{2,4})\b/.exec(voiceId.trim());
	return match?.[1] ?? "ko-KR";
}

/** Detect dominant language locale from spoken text when no explicit locale is given. */
export function detectTextLocaleHint(text: string): string {
	if (HANGUL_RE.test(text)) return "ko-KR";
	if (KANA_RE.test(text)) return "ja-JP";
	if (CJK_RE.test(text)) return "zh-CN";
	if (/[A-Za-z]/.test(text)) return "en-US";
	return "ko-KR";
}

export interface ResolvedAzureVoice {
	voiceId: string;
	language: string;
	isDragonHd: boolean;
	supportsViseme: boolean;
	preset?: AzureSpeechVoicePreset;
}

/**
 * Resolve any user/config voice identifier, alias, or locale hint into a valid
 * Azure AI Speech Neural / DragonHD voice descriptor.
 */
export function resolveAzureSpeechVoice(
	voiceOrAlias?: string | null,
	localeOrTextHint?: string | null,
): ResolvedAzureVoice {
	const raw = (voiceOrAlias ?? "").trim();
	const lower = raw.toLowerCase();

	let resolvedId: string | undefined;

	if (raw) {
		const exactPreset = PRESET_BY_ID.get(lower);
		if (exactPreset) {
			resolvedId = exactPreset.id;
		} else if (VOICE_ALIASES[lower]) {
			resolvedId = VOICE_ALIASES[lower];
		} else if (LOCALE_DEFAULT_VOICE[lower]) {
			resolvedId = LOCALE_DEFAULT_VOICE[lower];
		} else if (AZURE_VOICE_ID_PATTERN.test(raw)) {
			resolvedId = raw;
		}
	}

	if (!resolvedId && localeOrTextHint) {
		const hintTrimmed = localeOrTextHint.trim();
		const hintLower = hintTrimmed.toLowerCase();
		const baseLang = hintLower.split(/[-_]/)[0] ?? "";
		if (LOCALE_DEFAULT_VOICE[hintLower]) {
			resolvedId = LOCALE_DEFAULT_VOICE[hintLower];
		} else if (baseLang && LOCALE_DEFAULT_VOICE[baseLang]) {
			resolvedId = LOCALE_DEFAULT_VOICE[baseLang];
		} else {
			const detected = detectTextLocaleHint(hintTrimmed).toLowerCase();
			resolvedId =
				LOCALE_DEFAULT_VOICE[detected] ?? DEFAULT_AZURE_SPEECH_VOICE_KO;
		}
	}

	const finalVoiceId = resolvedId ?? DEFAULT_AZURE_SPEECH_VOICE_KO;
	const preset = PRESET_BY_ID.get(finalVoiceId.toLowerCase());
	const dragonHd =
		preset?.tier === "dragon-hd" || isDragonHdVoice(finalVoiceId);

	return {
		voiceId: preset?.id ?? finalVoiceId,
		language: preset?.language ?? inferLocaleFromAzureVoice(finalVoiceId),
		isDragonHd: dragonHd,
		supportsViseme: preset ? preset.supportsViseme : !dragonHd,
		preset,
	};
}

/** Estimate Azure Speech synthesis cost in USD from character count and voice tier. */
export function estimateAzureSpeechCostUsd(
	textLength: number,
	voiceId?: string,
): number {
	if (textLength <= 0) return 0;
	const resolved = resolveAzureSpeechVoice(voiceId);
	const perMillion =
		resolved.preset?.costPerMillionCharsUsd ??
		(resolved.isDragonHd
			? AZURE_DRAGON_HD_COST_PER_M_CHARS_USD
			: AZURE_NEURAL_COST_PER_M_CHARS_USD);
	return (perMillion / 1_000_000) * textLength;
}

/** Escape XML 1.0 text / attribute characters and strip illegal control codepoints. */
export function escapeSsmlXml(input: string): string {
	let cleaned = "";
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0d ||
			(code >= 0x20 && code <= 0xd7ff) ||
			(code >= 0xe000 && code <= 0xfffd)
		) {
			cleaned += input[i];
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
			const next = input.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				cleaned += input[i] + input[i + 1];
				i++;
			}
		}
	}
	return cleaned
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function formatProsodyRate(rate?: number | string): string | undefined {
	if (rate === undefined || rate === null || rate === "") return undefined;
	if (typeof rate === "number") {
		if (!Number.isFinite(rate) || rate <= 0) return undefined;
		const clamped = Math.min(3.0, Math.max(0.25, rate));
		const deltaPct = Math.round((clamped - 1) * 100);
		if (deltaPct === 0) return undefined;
		return `${deltaPct > 0 ? "+" : ""}${deltaPct}%`;
	}
	const trimmed = rate.trim();
	return trimmed ? escapeSsmlXml(trimmed) : undefined;
}

function formatProsodyAttr(value?: string): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed ? escapeSsmlXml(trimmed) : undefined;
}

export type AzureVisemeRequestType =
	| "Redlips_front"
	| "FacialExpression"
	| "none";

export interface AzureSpeechSsmlOptions {
	text: string;
	voice?: string;
	language?: string;
	/** Speaking rate multiplier (e.g. `1.1` -> `+10%`) or SSML rate token (`"+15%"`, `"fast"`). */
	rate?: number | string;
	/** SSML pitch adjustment (e.g. `"+4%"`, `"-2st"`). */
	pitch?: string;
	/** SSML volume adjustment (e.g. `"+10%"`, `"loud"`). */
	volume?: string;
	/** Optional `mstts:express-as` speaking style (e.g. `"cheerful"`, `"chat"`). */
	style?: string;
	/** Optional style intensity (`0.01` .. `2.0`). */
	styleDegree?: number;
	/** Request `<mstts:viseme>` metadata in the SSML payload (default `"Redlips_front"` when supported). */
	visemeType?: AzureVisemeRequestType;
}

/**
 * Construct a spec-compliant Microsoft Azure Speech SSML document with
 * `<mstts:viseme>` lip-sync tag, optional `<mstts:express-as>`, and `<prosody>`.
 */
export function buildAzureSpeechSsml(options: AzureSpeechSsmlOptions): {
	ssml: string;
	resolvedVoice: ResolvedAzureVoice;
	visemeRequested: boolean;
} {
	const resolvedVoice = resolveAzureSpeechVoice(
		options.voice,
		options.language ?? options.text,
	);
	const lang = escapeSsmlXml(
		options.language?.trim() || resolvedVoice.language,
	);
	const voiceName = escapeSsmlXml(resolvedVoice.voiceId);
	const escapedText = escapeSsmlXml(options.text);

	const desiredViseme = options.visemeType ?? "Redlips_front";
	const visemeRequested =
		desiredViseme !== "none" && resolvedVoice.supportsViseme;
	const visemeTag = visemeRequested
		? `<mstts:viseme type="${escapeSsmlXml(desiredViseme)}"/>`
		: "";

	const rateAttr = formatProsodyRate(options.rate);
	const pitchAttr = formatProsodyAttr(options.pitch);
	const volumeAttr = formatProsodyAttr(options.volume);

	const prosodyAttrs: string[] = [];
	if (rateAttr) prosodyAttrs.push(`rate="${rateAttr}"`);
	if (pitchAttr) prosodyAttrs.push(`pitch="${pitchAttr}"`);
	if (volumeAttr) prosodyAttrs.push(`volume="${volumeAttr}"`);

	let innerContent = escapedText;
	if (prosodyAttrs.length > 0) {
		innerContent = `<prosody ${prosodyAttrs.join(" ")}>${innerContent}</prosody>`;
	}

	const style = formatProsodyAttr(options.style);
	if (style && !resolvedVoice.isDragonHd) {
		const degreeAttr =
			typeof options.styleDegree === "number" &&
			Number.isFinite(options.styleDegree)
				? ` styledegree="${Math.min(2, Math.max(0.01, options.styleDegree)).toFixed(2)}"`
				: "";
		innerContent = `<mstts:express-as style="${style}"${degreeAttr}>${innerContent}</mstts:express-as>`;
	}

	const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${voiceName}">${visemeTag}${innerContent}</voice></speak>`;

	return {
		ssml,
		resolvedVoice,
		visemeRequested,
	};
}
