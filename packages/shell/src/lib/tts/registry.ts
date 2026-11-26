import type { Locale } from "../i18n";
import copy from "./provider-voice-catalog.json";
import type { TtsProviderMeta, TtsVoiceMeta } from "./types";

const providers = new Map<string, TtsProviderMeta>();

export function registerTtsProviderMeta(meta: TtsProviderMeta): void {
	providers.set(meta.id, meta);
}

export function getTtsProviderMeta(id: string): TtsProviderMeta | undefined {
	return providers.get(id);
}

export function listTtsProviderMetas(): TtsProviderMeta[] {
	const providerOrder = ["edge", "naia-local-voice", "nextain"];
	return Array.from(providers.values()).sort((left, right) => {
		const leftPriority = providerOrder.indexOf(left.id);
		const rightPriority = providerOrder.indexOf(right.id);
		if (leftPriority >= 0 || rightPriority >= 0) {
			if (leftPriority < 0) return 1;
			if (rightPriority < 0) return -1;
			return leftPriority - rightPriority;
		}
		return 0;
	});
}

// ── Providers (order: free → local → Naia managed) ──

registerTtsProviderMeta({
	id: "browser",
	name: "Browser TTS",
	description:
		"Browser built-in speech synthesis. No API key, no cost. Voice quality varies by OS.",
	requiresApiKey: false,
	isFree: true,
	isClientSide: true,
	pricing: "Free",
});

registerTtsProviderMeta({
	id: "edge",
	name: "Microsoft Edge TTS",
	// Real MS neural voices, keyless — synthesized in the bgm/media sidecar
	// (node msedge-tts), since the in-app webview can't do the MS WS handshake
	// (can't set the required headers/Origin). Shell → sidecar /edge-tts (#363).
	description:
		"Free, no API key. Neural voices for 14+ languages (via local sidecar).",
	requiresApiKey: false,
	isFree: true,
	pricing: "Free",
	voices: copy.edgeVoices as TtsVoiceMeta[],
});

export const DRAGON_CLOUD_VOICES: readonly TtsVoiceMeta[] = copy.dragonVoices as TtsVoiceMeta[];

/**
 * Canonical Dragon voice mapping for all 14 supported UI locales (`Locale`).
 * Locales without a primary eastus2 Dragon voice (`ru`, `hi`, `bn`, and male
 * counterparts for `zh` / `vi`) map to the verified Azure `eastus2` DragonHD
 * 92-locale multilingual voices (`Ava` / `Andrew`).
 */
export const DRAGON_LOCALE_DEFAULT_VOICES: Readonly<
	Record<Locale, { readonly female: string; readonly male: string }>
> = {
	ko: {
		female: "ko-KR-SunHi:DragonHDLatestNeural",
		male: "ko-KR-Hyunsu:DragonHDLatestNeural",
	},
	en: {
		female: "en-US-Ava:DragonHDLatestNeural",
		male: "en-US-Andrew:DragonHDLatestNeural",
	},
	ja: {
		female: "ja-JP-Nanami:DragonHDLatestNeural",
		male: "ja-JP-Masaru:DragonHDLatestNeural",
	},
	zh: {
		female: "zh-CN-Xiaochen:DragonHDLatestNeural",
		male: "en-US-Andrew:DragonHDLatestNeural",
	},
	fr: {
		female: "fr-FR-Vivienne:DragonHDLatestNeural",
		male: "fr-FR-Remy:DragonHDLatestNeural",
	},
	de: {
		female: "de-DE-Seraphina:DragonHDLatestNeural",
		male: "de-DE-Florian:DragonHDLatestNeural",
	},
	ru: {
		female: "en-US-Ava:DragonHDLatestNeural",
		male: "en-US-Andrew:DragonHDLatestNeural",
	},
	es: {
		female: "es-ES-Ximena:DragonHDLatestNeural",
		male: "es-ES-Tristan:DragonHDLatestNeural",
	},
	ar: {
		female: "ar-EG-Hoda:DragonLatestNeural",
		male: "ar-SA-Hamed:DragonLatestNeural",
	},
	hi: {
		female: "en-US-Ava:DragonHDLatestNeural",
		male: "en-US-Andrew:DragonHDLatestNeural",
	},
	bn: {
		female: "en-US-Ava:DragonHDLatestNeural",
		male: "en-US-Andrew:DragonHDLatestNeural",
	},
	pt: {
		female: "pt-BR-Thalita:DragonHDLatestNeural",
		male: "pt-BR-Macerio:DragonHDLatestNeural",
	},
	id: {
		female: "id-ID-Gadis:DragonHDLatestNeural",
		male: "id-ID-Ardi:DragonHDLatestNeural",
	},
	vi: {
		female: "vi-VN-HoaiMy:DragonLatestNeural",
		male: "en-US-Andrew:DragonHDLatestNeural",
	},
};

function normalizeLocaleCode(rawLocale?: string): Locale {
	const code = (rawLocale || "ko").trim().toLowerCase().split(/[-_]/)[0];
	return Object.prototype.hasOwnProperty.call(
		DRAGON_LOCALE_DEFAULT_VOICES,
		code,
	)
		? (code as Locale)
		: "ko";
}

export function getDefaultDragonVoiceForLocale(
	rawLocale?: string,
	gender: "female" | "male" = "female",
): string {
	const locale = normalizeLocaleCode(rawLocale);
	return DRAGON_LOCALE_DEFAULT_VOICES[locale][gender];
}

export function getRecommendedDragonVoicesForLocale(
	rawLocale?: string,
): TtsVoiceMeta[] {
	const locale = normalizeLocaleCode(rawLocale);
	const pair = DRAGON_LOCALE_DEFAULT_VOICES[locale];
	const byId = new Map(DRAGON_CLOUD_VOICES.map((voice) => [voice.id, voice]));
	const recommended: TtsVoiceMeta[] = [];
	const seen = new Set<string>();
	const pushVoice = (voice: TtsVoiceMeta | undefined) => {
		if (!voice || seen.has(voice.id)) return;
		seen.add(voice.id);
		recommended.push(voice);
	};
	pushVoice(byId.get(pair.female));
	pushVoice(byId.get(pair.male));
	for (const voice of DRAGON_CLOUD_VOICES) {
		if (voice.language === locale) pushVoice(voice);
	}
	return recommended;
}

/** UI 14개 언어 순서. 목소리 묶음 순서도 이것을 따른다. */
const VOICE_LANGUAGE_ORDER: readonly string[] = [
	"ko", "en", "ja", "zh", "fr", "de", "ru", "es", "ar", "hi", "bn", "pt", "id", "vi",
];

const VOICE_LANGUAGE_LABELS: Readonly<Record<string, string>> = copy.languageLabels;

/** 브라우저 speechSynthesis 목소리(SpeechSynthesisVoice 모양)를 묶을 수 있는 형태로 바꾼다. */
export function browserVoicesToTtsVoiceMetas(
	voices: readonly { name: string; lang?: string; voiceURI?: string }[],
): TtsVoiceMeta[] {
	return voices.map((voice) => {
		const language = (voice.lang ?? "").trim().toLowerCase().split(/[-_]/)[0];
		return {
			id: voice.voiceURI || voice.name,
			label: voice.lang ? `${voice.name} (${voice.lang})` : voice.name,
			...(language ? { language } : {}),
		};
	});
}

export interface TtsVoiceGroup {
	/** 언어 코드. 언어 정보가 없는 목소리는 "". */
	readonly language: string;
	readonly label: string;
	/** 현재 UI 언어로 말할 수 있는 목소리 묶음(맨 앞). */
	readonly current: boolean;
	readonly voices: readonly TtsVoiceMeta[];
}

/**
 * R25-v: 목소리 목록을 언어별로 묶는다. 현재 UI 언어로 말할 수 있는 목소리
 * (그 언어 목소리 + 그 언어를 지원하는 다국어 목소리)를 맨 앞 묶음에 두고,
 * 나머지는 14개 언어 순서, 그 밖의 언어는 뒤에 둔다. 한국어 화면에
 * 포르투갈어 목소리가 섞여 보이던 문제를 막는다.
 */
export function groupTtsVoicesForLocale(
	voices: readonly TtsVoiceMeta[],
	rawLocale?: string,
): TtsVoiceGroup[] {
	const locale = normalizeLocaleCode(rawLocale);
	const speaksLocale = (voice: TtsVoiceMeta) =>
		voice.language === locale ||
		(voice.secondaryLocales?.includes(locale) ?? false);
	const current = voices.filter(speaksLocale);
	const rest = new Map<string, TtsVoiceMeta[]>();
	for (const voice of voices) {
		if (speaksLocale(voice)) continue;
		const lang = voice.language ?? "";
		const list = rest.get(lang) ?? [];
		list.push(voice);
		rest.set(lang, list);
	}
	const rank = (lang: string) => {
		const i = VOICE_LANGUAGE_ORDER.indexOf(lang);
		return i >= 0 ? i : lang ? VOICE_LANGUAGE_ORDER.length : VOICE_LANGUAGE_ORDER.length + 1;
	};
	const groups: TtsVoiceGroup[] = [];
	if (current.length > 0) {
		groups.push({
			language: locale,
			label: VOICE_LANGUAGE_LABELS[locale] ?? locale,
			current: true,
			voices: current,
		});
	}
	for (const lang of [...rest.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
		groups.push({
			language: lang,
			label: VOICE_LANGUAGE_LABELS[lang] ?? (lang || "—"),
			current: false,
			voices: rest.get(lang) ?? [],
		});
	}
	return groups;
}

registerTtsProviderMeta({
	id: "nextain",
	name: "Naia Cloud TTS (Dragon)",
	description:
		"Azure Dragon HD / Dragon Neural voices for 14 languages, billed in Naia credits via the gateway.",
	requiresApiKey: false,
	requiresNaiaKey: true,
	pricing: "Naia credits",
	voices: [...DRAGON_CLOUD_VOICES],
});

// ── Local vLLM TTS (OpenAI-compatible /v1/audio/speech) ──

registerTtsProviderMeta({
	id: "vllm",
	name: "vLLM TTS",
	description:
		"Local vLLM TTS server — supports Kokoro and other TTS models via /v1/audio/speech.",
	requiresApiKey: false,
	isFree: true,
	pricing: "Free (local)",
	isLocal: true,
});

// ── Naia Local Voice (VoxCPM2 GPU TTS) ──

registerTtsProviderMeta({
	id: "naia-local-voice",
	name: "Naia Host Voice (GPU)",
	description: copy.hostDescription,
	requiresApiKey: false,
	requiresNaiaKey: true,
	isFree: true,
	pricing: "Free (local GPU)",
	isLocal: true,
	// 고정 voice 목록 없음(의도) — 로컬 음성은 **ref-audio 클로닝**(음성 참조 / 내 목소리
	// 만들기 = RefAudioSection)으로 음색을 정한다. 그래서 클라우드 TTS용 일반 voice 드롭다운
	// ("기본음색 + 미리듣기")을 띄우지 않는다. ttsVoice 는 SettingsTab 이 "default" 로 설정
	// (synthVllm 이 voice 미지정 시 "default" 사용 — VoxCPM2 가 ref audio 로 음색 결정).
});
