import { describe, expect, it } from "vitest";
import { type Locale, getLocale, setLocale, t } from "../i18n";
import type { TranslationKey } from "../locales/keys";
import ko from "../locales/ko";

/**
 * 사용성 축의 첫 자리 (UC-QUALITY-I18N-USER-FACING).
 *
 * 품질 프로세스는 사용성을 화면 문구가 아니라 i18n 키로 재기로 했다. 문구로
 * 재면 이 저장소에서 거짓 통과가 나기 때문이다 — 로케일이 열넷인데 단정이
 * `getByText("다시 시도")` 같은 취약한 쪽과 `/다시 시도|try again/i` 처럼
 * 어느 쪽이 나와도 통과하는 쪽으로 갈려 있었다.
 *
 * 이 테스트의 앞선 판은 스스로 그 부류였다. 로케일 모듈을 직접 import 해서
 * 키 집합만 견주었기 때문에, 런타임 해석 경로(`localeLoaders`)를 전혀 지나지
 * 않았다. 실제로 열두 로케일의 로더를 모두 영어로 바꿔 놓아도 초록이었다 —
 * 즉 열두 언어가 통째로 죽어도 이 테스트는 아무 말도 하지 않았다.
 *
 * 그래서 지금은 전부 `setLocale` 로 실제 전환하고 `t()` 로 읽는다. 배선이
 * 끊기면 여기서 걸린다.
 *
 * 재는 것은 넷이다.
 *   1. 로케일마다 실제로 다른 문구가 나온다 (열넷 배선이 각각 산다)
 *   2. 열네 로케일이 같은 키 집합을 갖는다 (한 언어만 빠지지 않는다)
 *   3. 사용자가 막혔을 때 다음을 알려 주는 문구가 키로 존재한다
 *   4. 값이 끼어드는 문구도 로케일을 지난다
 *
 * 이것이 통과한다고 화면이 아름다워지지는 않는다. 다만 "어떤 언어에서는
 * 아무 말도 안 나온다" 는 부류의 실패는 여기서 걸린다.
 */

const LOCALES: readonly Locale[] = [
	"ko",
	"en",
	"ja",
	"zh",
	"fr",
	"de",
	"ru",
	"es",
	"ar",
	"hi",
	"bn",
	"pt",
	"id",
	"vi",
];

/** 각 로케일을 실제로 켜고 표 전체를 런타임 경로로 읽어 온다. */
async function readThroughRuntime(): Promise<Map<Locale, Map<string, string>>> {
	const keys = Object.keys(ko) as TranslationKey[];
	const out = new Map<Locale, Map<string, string>>();
	for (const locale of LOCALES) {
		await setLocale(locale);
		expect(getLocale(), `setLocale("${locale}") 이 반영되지 않았다`).toBe(
			locale,
		);
		out.set(locale, new Map(keys.map((key) => [key, t(key)])));
	}
	await setLocale("ko");
	return out;
}

/**
 * 짝 일치율의 한계.
 *
 * 예전에는 어느 짝이든 0.6 이었다. 그런데 지금 실측 최대가 42.5%(es-pt)이고
 * 나머지는 36% 아래라, 0.6 은 **로케일 절반 이상이 영어여도 초록**인
 * 느슨함이었다. 실제로 한 로케일의 값 270개를 영어로 되돌려 55.9% 로 만들어도
 * 네 단정이 모두 통과했다.
 *
 * 실측한 천장 바로 위에 둔다. 스페인어와 포르투갈어는 같은 어족이라 짧은
 * 문구가 실제로 겹치므로 그 짝만 따로 잡는다 — 예외는 숫자가 아니라 이유로
 * 적는다.
 */
const SAME_RATIO_LIMIT = 0.5;
/**
 * 영어와의 짝은 더 좁게 본다. 이 테스트가 막으려는 실패는 "어떤 로케일이
 * 조용히 영어로 되돌아감" 이고, 실측에서도 영어 짝이 가장 낮다(최대 35.0%,
 * de-en). 실제로 한 로케일의 값 270개를 영어로 되돌리면 44.2% 가 되는데,
 * 일반 한계 0.5 로는 그것이 통과한다.
 */
const ENGLISH_RATIO_LIMIT = 0.4;
const SAME_RATIO_EXCEPTIONS = new Map<string, number>([
	// 실측 42.5%. 같은 어족이라 "OK", "Discord" 같은 짧은 문구가 겹친다.
	["es-pt", 0.48],
]);
const limitFor = (a: string, b: string) => {
	const exception = SAME_RATIO_EXCEPTIONS.get(`${a}-${b}`);
	if (exception !== undefined) return exception;
	if (a === "en" || b === "en") return ENGLISH_RATIO_LIMIT;
	return SAME_RATIO_LIMIT;
};

describe("사용자에게 보이는 문구는 i18n 을 지난다 (UC-QUALITY-I18N-USER-FACING)", () => {
	it("열네 로케일이 각각 서로 다른 문구를 낸다", async () => {
		const tables = await readThroughRuntime();

		// 예전에는 각 로케일을 **영어와만** 견주었다. 그래서 베트남어 자리에
		// 인도네시아어가, 포르투갈어 자리에 스페인어가 실려도 초록이었다.
		// 로케일 로더는 한 줄씩 이어진 표라 복사·붙여넣기 오배선이 가장 있을
		// 법한 결함인데, 그것만 정확히 빠져나갔다.
		//
		// 이제 모든 짝을 견준다. 두 로케일이 서로 거의 같은 문구를 내면 둘 중
		// 하나가 다른 하나를 가리키고 있다는 뜻이다.
		for (const a of LOCALES) {
			for (const b of LOCALES) {
				if (a >= b) continue;
				const left = tables.get(a)!;
				const right = tables.get(b)!;
				let same = 0;
				for (const [key, value] of left) {
					if (value === right.get(key)) same += 1;
				}
				const ratio = same / left.size;
				expect(
					ratio,
					`${a} 와 ${b} 의 ${Math.round(ratio * 100)}% 가 글자까지 같다 — 한쪽 로더가 다른 쪽을 가리키고 있을 수 있다`,
				).toBeLessThan(limitFor(a, b));
			}
		}
	});

	it("모든 로케일이 같은 키 집합을 갖는다", async () => {
		const tables = await readThroughRuntime();
		// `readThroughRuntime` 은 ko 의 키로 모든 표를 만든다. 그래서 그 표들끼리
		// 견주면 키 집합은 **원리적으로 언제나 같다** — 이 단정은 아무것도 재지
		// 않았다. 각 로케일 모듈이 스스로 가진 키를 읽어 견준다.
		const modules = await Promise.all(
			LOCALES.map(async (locale) => {
				const mod = await import(`../locales/${locale}.ts`);
				const translations =
					locale === "en"
						? {
								...mod.default,
								...(await import("../locales/ollama-en")).default,
							}
						: mod.default;
				return [locale, Object.keys(translations).sort()] as const;
			}),
		);
		const union = [...new Set(modules.flatMap(([, keys]) => keys))].sort();
		for (const [locale, keys] of modules) {
			const missing = union.filter((key) => !keys.includes(key));
			expect(
				missing,
				`${locale} 에 없는 키 ${missing.length}개: ${missing.slice(0, 5).join(", ")}`,
			).toEqual([]);
		}

		const base = union;

		for (const locale of LOCALES) {
			const keys = [...tables.get(locale)!.keys()].sort();
			expect(keys, `${locale} 의 키 집합이 다르다`).toEqual(base);
			// 런타임에서 빈 값이 나오면 그 자리는 화면에서 아무 말도 못 한다.
			const empty = [...tables.get(locale)!.entries()]
				.filter(([, value]) => !value || value.length === 0)
				.map(([key]) => key);
			// 빈 문자열이 의도인 키는 여기 적는다. 언어의 문법상 비는 자리다.
			const INTENTIONALLY_EMPTY = new Set(["common.honorificSuffix"]);
			expect(
				empty.filter((key) => !INTENTIONALLY_EMPTY.has(key)),
				`${locale} 에서 빈 문구: ${empty.slice(0, 5).join(", ")}`,
			).toEqual([]);
		}
	});

	it("실패와 복구를 알리는 문구가 모든 로케일에 있다", async () => {
		const tables = await readThroughRuntime();
		// 사용자가 막혔을 때 다음에 무엇을 하라고 말하는 자리들.
		const required: TranslationKey[] = [
			"appbar.appStore",
			"settings.nvaCreate",
			"settings.nvaCreateDesc",
			"workspace.herdrRetry",
			"apps.removeConfirm",
			"adk.setup.recreateConfirm",
			"voice.ref.errRecord",
			"settings.ollamaThinkingUnsupported",
			"settings.ollamaPullStartPolicyPending",
			"settings.ollamaPullConfirmExactTag",
			"settings.ollamaPullRetryButton",
			"settings.ollamaPullErrorVerification",
		];
		for (const locale of LOCALES) {
			for (const key of required) {
				const value = tables.get(locale)!.get(key);
				expect(value, `${locale} 에 ${key} 가 비어 있다`).toBeTruthy();
			}
		}
	});

	it("값이 끼어드는 문구도 로케일을 지난다", async () => {
		await setLocale("ko");
		const korean = t("voice.ref.recording", { seconds: 7 });
		await setLocale("ja");
		const japanese = t("voice.ref.recording", { seconds: 7 });
		await setLocale("ko");

		expect(korean).toContain("7");
		expect(japanese).toContain("7");
		expect(
			korean,
			"값이 낀 문구가 로케일을 지나지 않는다 — 코드에서 이어 붙였을 수 있다",
		).not.toBe(japanese);
	});
});
