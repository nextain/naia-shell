import englishTranslations from "./locales/en";
import koTranslations from "./locales/ko";
import type { TranslationKey } from "./locales/keys";

export type Locale =
	| "ko"
	| "en"
	| "ja"
	| "zh"
	| "fr"
	| "de"
	| "ru"
	| "es"
	| "ar"
	| "hi"
	| "bn"
	| "pt"
	| "id"
	| "vi";

export type { TranslationKey };

type TranslationTable = Readonly<Partial<Record<TranslationKey, string>>>;
type LocaleModule = { default: TranslationTable };

const localeLoaders: Record<Locale, () => Promise<LocaleModule>> = {
	ko: () => import("./locales/ko"),
	en: async () => {
		const { default: ollamaTranslations } = await import("./locales/ollama-en");
		return {
			default: {
				...englishTranslations,
				...ollamaTranslations,
			} as TranslationTable,
		};
	},
	ja: () => import("./locales/ja"),
	zh: () => import("./locales/zh"),
	fr: () => import("./locales/fr"),
	de: () => import("./locales/de"),
	ru: () => import("./locales/ru"),
	es: () => import("./locales/es"),
	ar: () => import("./locales/ar"),
	hi: () => import("./locales/hi"),
	bn: () => import("./locales/bn"),
	pt: () => import("./locales/pt"),
	id: () => import("./locales/id"),
	vi: () => import("./locales/vi"),
};

function detectLocale(): Locale {
	try {
		const raw = localStorage.getItem("naia-config");
		if (raw) {
			const locale = JSON.parse(raw).locale as Locale;
			if (Object.prototype.hasOwnProperty.call(localeLoaders, locale))
				return locale;
		}
	} catch {
		// Fall through to the browser locale.
	}

	const code = navigator.language.toLowerCase().split("-")[0] as Locale;
	return Object.prototype.hasOwnProperty.call(localeLoaders, code)
		? code
		: "en";
}

let currentLocale: Locale = "en";
let currentTranslations = englishTranslations as TranslationTable;
const loadedTranslations = new Map<Locale, TranslationTable>();
let localeRequest = 0;

export async function initializeI18n(): Promise<void> {
	try {
		await setLocale(detectLocale());
	} catch {
		// Keep the shell usable if an optional locale chunk cannot be loaded.
		await setLocale("en");
	}
}

export function getLocale(): Locale {
	return currentLocale;
}

export async function setLocale(locale: Locale): Promise<void> {
	const request = ++localeRequest;
	const cached = loadedTranslations.get(locale);
	const next = cached ?? (await localeLoaders[locale]()).default;
	loadedTranslations.set(locale, next);
	if (request !== localeRequest) return;
	currentLocale = locale;
	currentTranslations = next;
}

/**
 * 번역 문자열을 가져온다. 값이 끼어드는 문구는 `{name}` 자리를 두고
 * 두 번째 인자로 채운다.
 *
 * 왜 자리표시자인가: 값이 낀 문구를 코드에서 이어 붙이면 어순이 언어마다
 * 다른 것을 표현할 수 없다. "3초 녹음됨" 과 "Recorded 3 s" 는 값의 위치가
 * 다르고, 아랍어처럼 방향이 다른 언어는 더 그렇다. 자리표시자를 문자열
 * 안에 두면 그 배치를 번역자가 정한다.
 */
export function t(
	key: TranslationKey,
	params?: Readonly<Record<string, string | number>>,
): string {
	const value = currentTranslations[key] ?? key;
	if (!params) return value;
	return value.replace(/\{(\w+)\}/g, (whole, name) =>
		Object.prototype.hasOwnProperty.call(params, name)
			? String(params[name])
			: whole,
	);
}

/**
 * 한국어 고정값이 필요한 내부 읽기표·마이그레이션 비교용 결정적
 * 한국어 조회. UI 로케일(`t()`)을 따르지 않고 ko 정본 표에서만 읽는다.
 * 발음 읽기, 옛 OPFS 원고 판별, 저장 출처 라벨처럼 화면 언어가 바뀌어도
 * 같은 값이어야 하는 자리에 쓴다. 번역이 바뀌거나 키가 빠져도
 * 과거 원고 판별이 조용히 빗나가지 않는다.
 */
const koTable = koTranslations as TranslationTable;
/**
 * ko 정본 표에만 들어 있는 키. ko 표에 없는 키를 받으면 컴파일 단계에서
 * 걸린다.
 */
export type KoTranslationKey = Extract<TranslationKey, keyof typeof koTranslations>;
/**
 * 한국어 고정값 조회. ko 표에 키가 없으면 키 이름을 돌려주지 않고 던진다.
 * 키 이름 대체는 `includes` 판별을 조용히 빗나가게 해서(옛 지침이 있는데도
 * 없다고 보고 갱신을 건너뜀) 과거 원고 판별을 깨뜨리므로, 없으면 크게
 * 드러낸다.
 */
export function tKo(key: KoTranslationKey): string {
	const value = koTable[key];
	if (value === undefined) throw new Error(`missing_ko_translation:${key}`);
	return value;
}
