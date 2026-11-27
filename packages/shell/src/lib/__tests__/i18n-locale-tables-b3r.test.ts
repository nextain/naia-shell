import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setLocale, t } from "../i18n";

/**
 * b3r 묶음: knowledge.ts(39줄)와 browser-speech-plan.ts(38줄)에 박힌
 * 한국어 문자열 리터럴 50개를 locales/ 키로 옮긴다.
 * 이 시험은 새 키가 열네 로케일 모듈에 own property 로 있고,
 * ko/en 런타임 문구가 기존 표와 글자까지 같으며,
 * 호출부가 t() 를 쓰는지 본다. 고치기 전에는 실패한다(RED).
 *
 * b1 독립 검수 지적의 재발 방지:
 * - 호출부 단정은 `t("키")` 호출 자체를 소스에서 확인한다.
 *   호출부를 옛 리터럴 분기로 되돌리면 이 단정이 실패한다(회귀 검출).
 * - 로케일 조회는 상속 속성 접근(`table[key]`, `in`)을 쓰지 않고
 *   `hasOwnProperty.call` 로 own property 임을 확인한다.
 *   구현도 로케일 표를 직접 읽지 않고 t() 만 쓴다.
 */
const NEW_KEYS = [
	"kiosk.legacyPair.webFrom",
	"kiosk.legacyPair.webTo",
	"kiosk.legacyPair.scopeFrom",
	"kiosk.legacyPair.scopeTo",
	"kiosk.agentsMd",
	"kiosk.agentsMd.section4Heading",
	"kiosk.rulesMd",
	"kiosk.legacyWebIntro",
	"kiosk.sourceLabel",
	"kiosk.detectOld.keepBasis",
	"kiosk.detectOld.personaHeading",
	"kiosk.detectOld.sourceLine",
	"speech.reading.word.nextain",
	"speech.reading.word.naia",
	"speech.reading.word.ai",
	"speech.reading.word.ir",
	"speech.reading.word.gpu",
	"speech.reading.word.webgpu",
	"speech.reading.word.web",
	"speech.reading.word.pc",
	"speech.reading.word.pdf",
	"speech.reading.word.tts",
	"speech.reading.word.api",
	"speech.reading.word.app",
	"speech.reading.letter.a",
	"speech.reading.letter.b",
	"speech.reading.letter.c",
	"speech.reading.letter.d",
	"speech.reading.letter.e",
	"speech.reading.letter.f",
	"speech.reading.letter.g",
	"speech.reading.letter.h",
	"speech.reading.letter.i",
	"speech.reading.letter.j",
	"speech.reading.letter.k",
	"speech.reading.letter.l",
	"speech.reading.letter.m",
	"speech.reading.letter.n",
	"speech.reading.letter.o",
	"speech.reading.letter.p",
	"speech.reading.letter.q",
	"speech.reading.letter.r",
	"speech.reading.letter.s",
	"speech.reading.letter.t",
	"speech.reading.letter.u",
	"speech.reading.letter.v",
	"speech.reading.letter.w",
	"speech.reading.letter.x",
	"speech.reading.letter.y",
	"speech.reading.letter.z",
] as const;

const KNOWLEDGE_KEYS = NEW_KEYS.filter((key) => key.startsWith("kiosk."));
const SPEECH_KEYS = NEW_KEYS.filter((key) => key.startsWith("speech."));

const LOCALES = [
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
] as const;

/** 옮긴 문구(짧은 키). 전수 대조용. 동작 변경 금지에 따라 ko/en/나머지 모두 같은 값이다. */
const SHORT_KEY_VALUES: Readonly<Record<string, string>> = {
	"kiosk.legacyPair.webFrom": "이번 IR 키오스크는 웹판에서",
	"kiosk.legacyPair.webTo": "이번 IR 시연은 웹판에서",
	"kiosk.legacyPair.scopeFrom": "시연 화면의 기능은 이 키오스크 범위와 연결된 것부터 안내합니다.",
	"kiosk.legacyPair.scopeTo": "시연 화면의 기능은 이번 시연 범위에 든 것부터 안내합니다.",
	"kiosk.agentsMd.section4Heading": "\n## 4. 웹판에서 할 수 있는 일과 없는 일",
	"kiosk.sourceLabel": "넥스테인·나이아 공개 지식",
	"kiosk.detectOld.keepBasis": "**근거와 기준일**을 보존하고",
	"kiosk.detectOld.personaHeading": "## 1. 지나가 누구인가",
	"kiosk.detectOld.sourceLine": "출처(`knowledge/*.md`)를 대답 근거로 남깁니다",
	"speech.reading.word.nextain": "넥스테인",
	"speech.reading.word.naia": "나이아",
	"speech.reading.word.ai": "에이아이",
	"speech.reading.word.ir": "아이알",
	"speech.reading.word.gpu": "지피유",
	"speech.reading.word.webgpu": "웹지피유",
	"speech.reading.word.web": "웹",
	"speech.reading.word.pc": "피씨",
	"speech.reading.word.pdf": "피디에프",
	"speech.reading.word.tts": "티티에스",
	"speech.reading.word.api": "에이피아이",
	"speech.reading.word.app": "앱",
	"speech.reading.letter.a": "에이",
	"speech.reading.letter.b": "비",
	"speech.reading.letter.c": "씨",
	"speech.reading.letter.d": "디",
	"speech.reading.letter.e": "이",
	"speech.reading.letter.f": "에프",
	"speech.reading.letter.g": "지",
	"speech.reading.letter.h": "에이치",
	"speech.reading.letter.i": "아이",
	"speech.reading.letter.j": "제이",
	"speech.reading.letter.k": "케이",
	"speech.reading.letter.l": "엘",
	"speech.reading.letter.m": "엠",
	"speech.reading.letter.n": "엔",
	"speech.reading.letter.o": "오",
	"speech.reading.letter.p": "피",
	"speech.reading.letter.q": "큐",
	"speech.reading.letter.r": "알",
	"speech.reading.letter.s": "에스",
	"speech.reading.letter.t": "티",
	"speech.reading.letter.u": "유",
	"speech.reading.letter.v": "브이",
	"speech.reading.letter.w": "더블유",
	"speech.reading.letter.x": "엑스",
	"speech.reading.letter.y": "와이",
	"speech.reading.letter.z": "지",
};

type LooseT = (key: string, params?: Record<string, string | number>) => string;
const looseT = t as LooseT;

describe("b3r 이관 키가 열네 로케일에 own property 로 있다", () => {
	it("모든 로케일 모듈이 새 키 50개를 상속 없이 갖는다", async () => {
		for (const locale of LOCALES) {
			const mod = (await import(`../locales/${locale}.ts`)) as {
				default: Record<string, string | undefined>;
			};
			const table =
				locale === "en"
					? {
							...mod.default,
							...(
								(await import("../locales/ollama-en")) as {
									default: Record<string, string | undefined>;
								}
							).default,
						}
					: mod.default;
			for (const key of NEW_KEYS) {
				expect(
					Object.prototype.hasOwnProperty.call(table, key),
					`${locale} 에 ${key} 없음`,
				).toBe(true);
				expect(table[key], `${locale} 의 ${key} 가 비었다`).toBeTruthy();
			}
		}
	});

	it("ko/en 런타임 문구가 기존 표와 글자까지 같다", async () => {
		for (const locale of ["ko", "en"] as const) {
			await setLocale(locale);
			for (const [key, value] of Object.entries(SHORT_KEY_VALUES)) {
				expect(looseT(key), `${locale} ${key}`).toBe(value);
			}
			// 긴 원고 3종은 기존 시험(knowledge.test.ts)이 전수 고정하므로
			// 여기서는 식별 조각만 본다.
			expect(looseT("kiosk.agentsMd")).toContain(
				"하네스 정본(Single Source of Truth)입니다.",
			);
			expect(looseT("kiosk.rulesMd")).toContain("**계획과 사실 구분**");
			expect(looseT("kiosk.legacyWebIntro")).toContain("# 웹판 브라우저 입구");
		}
		await setLocale("ko");
	});

	it("호출부가 t() 를 쓰고 옛 리터럴이 남지 않았다", () => {
		const knowledge = readFileSync(
			new URL("../kiosk-demo/knowledge.ts", import.meta.url),
			"utf8",
		);
		const speech = readFileSync(
			new URL("../avatar/nva-speech/browser-speech-plan.ts", import.meta.url),
			"utf8",
		);
		for (const key of KNOWLEDGE_KEYS) {
			expect(knowledge, `knowledge.ts 에 t("${key}") 없음`).toContain(
				`t("${key}")`,
			);
		}
		for (const key of SPEECH_KEYS) {
			expect(speech, `browser-speech-plan.ts 에 t("${key}") 없음`).toContain(
				`t("${key}")`,
			);
		}
		// 옛 분기로 되돌리면 위 단정과 함께 이 단정도 실패한다.
		expect(knowledge).not.toContain('"이번 IR 키오스크는 웹판에서"');
		expect(knowledge).not.toContain('"넥스테인·나이아 공개 지식"');
		expect(speech).not.toContain('"넥스테인"');
		expect(speech).not.toContain('"에이아이"');
	});
});
