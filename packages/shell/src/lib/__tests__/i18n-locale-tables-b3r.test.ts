import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { setLocale, t } from "../i18n";
import { createMemoryWebFs } from "../web-runtime/web-fs";
import {
	KIOSK_AGENTS_MD,
	KIOSK_RULES_MD,
	seedKioskAdkWorkspace,
	seedKioskKnowledge,
	sliceBeforeHeading,
} from "../kiosk-demo/knowledge";
import { replaceLatinWithHangulForSpeechUnits } from "../avatar/nva-speech/browser-speech-plan";

/**
 * b3r4 묶음: b3r 독립 검수 sol 지적 1~2를 고친다.
 *
 * 지적 1 [중간 구조] — 옛 시험은 파일 전체에서 `t("키")`가 한 번
 * 등장하는지만 봤다. 주석에 호출을 남기고 실제 호출을 옛 리터럴로
 * 되돌려도, 두 호출부의 키를 맞바꿔도 통과했다. 그래서 이 파일은
 * typescript 컴파일러 API 로 주석을 제외한 실제 호출만 모아
 * (호출 위치 → 키)를 함수 범위 단위로 단정한다. 호출 결과도 본다:
 * OPFS 지침 갱신 경로와 저장된 출처 라벨이 실제 fs 호출 결과와 같다.
 *
 * 지적 2 [중간 국소] — 발음 읽기표·마이그레이션 비교에는 UI 로케일을
 * 따르지 않는 결정적 한국어 조회 tKo() 를 쓴다. R10 원고는 제목 검색
 * 실패(indexOf -1)가 유효한 원고로 slice 되지 않게 막는다.
 *
 * 이 시험은 고치기 전(RED)에 실패하고 고친 뒤(GREEN)에 통과한다.
 */

const KNOWLEDGE_KEYS = [
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
] as const;

const SPEECH_KEYS = [
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

/** 호출이 들어 있어야 할 함수 범위 → 그 안에서만 나와야 할 키. */
const EXPECTED_KNOWLEDGE_SCOPES: Readonly<Record<string, readonly string[]>> = {
	LEGACY_MANUSCRIPT_TEXT: [
		"kiosk.legacyPair.webFrom",
		"kiosk.legacyPair.webTo",
		"kiosk.legacyPair.scopeFrom",
		"kiosk.legacyPair.scopeTo",
	],
	KIOSK_AGENTS_MD: ["kiosk.agentsMd"],
	KIOSK_AGENTS_MD_R10: ["kiosk.agentsMd.section4Heading"],
	KIOSK_RULES_MD: ["kiosk.rulesMd"],
	R13_OLD_WEB: ["kiosk.legacyWebIntro"],
	seedKioskKnowledge: ["kiosk.sourceLabel"],
	seedKioskAdkWorkspace: [
		"kiosk.detectOld.keepBasis",
		"kiosk.detectOld.personaHeading",
		"kiosk.detectOld.sourceLine",
	],
};

const EXPECTED_SPEECH_SCOPES: Readonly<Record<string, readonly string[]>> = {
	KO_SPEECH_UNITS_WORD_READINGS: (SPEECH_KEYS as readonly string[]).filter((key) =>
		key.startsWith("speech.reading.word."),
	),
	KO_SPEECH_UNITS_LETTER_READINGS: (
		SPEECH_KEYS as readonly string[]
	).filter((key) => key.startsWith("speech.reading.letter.")),
};

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

afterEach(() => {
	vi.unstubAllEnvs();
});

interface ActualCall {
	callee: string;
	key: string;
	line: number;
	scope: string;
}

/**
 * 주석을 제외한 실제 t()/tKo() 호출만 모은다. typescript AST 에는
 * 주석이 호출 노드로 들어가지 않으므로, 호출을 주석으로 옮기는
 * 변이는 여기서 키가 사라진 것으로 드러난다.
 */
function collectLocaleCalls(relativePath: string): ActualCall[] {
	const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
	const tree = ts.createSourceFile(
		relativePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const scopeOf = (node: ts.Node): string => {
		let current: ts.Node | undefined = node.parent;
		while (current) {
			if (ts.isFunctionDeclaration(current) && current.name)
				return current.name.text;
			if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name))
				return current.name.text;
			current = current.parent;
		}
		return "<module>";
	};
	const out: ActualCall[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			(node.expression.text === "t" || node.expression.text === "tKo") &&
			node.arguments.length >= 1 &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			const at = tree.getLineAndCharacterOfPosition(node.getStart(tree));
			out.push({
				callee: node.expression.text,
				key: node.arguments[0].text,
				line: at.line + 1,
				scope: scopeOf(node),
			});
		}
		node.forEachChild(visit);
	};
	visit(tree);
	return out;
}

function expectScopeMapping(
	label: string,
	relativePath: string,
	expected: Readonly<Record<string, readonly string[]>>,
	allKeys: readonly string[],
) {
	const actual = collectLocaleCalls(relativePath);
	const expectedTotal = Object.values(expected).reduce(
		(sum, keys) => sum + keys.length,
		0,
	);
	expect(
		actual.map((call) => `${call.scope}@${call.line}:${call.callee}("${call.key}")`),
		`${label} 실제 호출 목록`,
	).toHaveLength(expectedTotal);
	for (const call of actual) {
		expect(call.callee, `${label} ${call.scope}@${call.line} 결정적 한국어 조회가 아니다`).toBe(
			"tKo",
		);
		expect(allKeys, `${label} ${call.scope}@${call.line} 낯선 키 ${call.key}`).toContain(
			call.key,
		);
	}
	for (const [scope, keys] of Object.entries(expected)) {
		const inScope = actual
			.filter((call) => call.scope === scope)
			.map((call) => call.key)
			.sort();
		expect(inScope, `${label} ${scope}()의 키`).toEqual([...keys].sort());
	}
}

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
			for (const key of [...KNOWLEDGE_KEYS, ...SPEECH_KEYS]) {
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

	it("AST 실제 호출이 각 위치와 키를 결정적 조회로 연결한다", () => {
		expectScopeMapping(
			"knowledge.ts",
			"../kiosk-demo/knowledge.ts",
			EXPECTED_KNOWLEDGE_SCOPES,
			KNOWLEDGE_KEYS,
		);
		expectScopeMapping(
			"browser-speech-plan.ts",
			"../avatar/nva-speech/browser-speech-plan.ts",
			EXPECTED_SPEECH_SCOPES,
			SPEECH_KEYS,
		);
		const knowledge = readFileSync(
			new URL("../kiosk-demo/knowledge.ts", import.meta.url),
			"utf8",
		);
		const speech = readFileSync(
			new URL("../avatar/nva-speech/browser-speech-plan.ts", import.meta.url),
			"utf8",
		);
		// 옛 분기로 되돌리면 위 단정과 함께 이 단정도 실패한다.
		expect(knowledge).not.toContain('"이번 IR 키오스크는 웹판에서"');
		expect(knowledge).not.toContain('"넥스테인·나이아 공개 지식"');
		expect(knowledge).not.toContain('"**근거와 기준일**을 보존하고"');
		expect(speech).not.toContain('"넥스테인"');
		expect(speech).not.toContain('"에이아이"');
	});

	it("en 로케일에서도 한국어 발음 요청이 한국어 표를 쓴다", async () => {
		await setLocale("en");
		try {
			expect(replaceLatinWithHangulForSpeechUnits("AI를")).toBe("에이아이를");
			expect(replaceLatinWithHangulForSpeechUnits("nextain")).toBe("넥스테인");
			expect(
				replaceLatinWithHangulForSpeechUnits(
					"nextain naia ai ir gpu webgpu web pc pdf tts api app",
				),
			).toBe(
				"넥스테인 나이아 에이아이 아이알 지피유 웹지피유 웹 피씨 피디에프 티티에스 에이피아이 앱",
			);
			expect(replaceLatinWithHangulForSpeechUnits("XYZ")).toBe("엑스와이지");
		} finally {
			await setLocale("ko");
		}
	});

	it("OPFS 지침 갱신 경로와 저장된 출처 라벨이 호출 결과와 같다", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		await setLocale("en");
		try {
			// 옛 지침(옛 마커 포함)은 새 지침으로 바뀐다.
			const fs = createMemoryWebFs();
			await fs.writeBytes(
				"naia-adk/AGENTS.md",
				"옛 안내\n**근거와 기준일**을 보존하고\n## 1. 지나가 누구인가\n",
			);
			await fs.writeBytes(
				"naia-adk/rules/response-rules.md",
				"옛 규칙\n출처(`knowledge/*.md`)를 대답 근거로 남깁니다\n",
			);
			await seedKioskAdkWorkspace(fs);
			expect(await fs.readText("naia-adk/AGENTS.md")).toBe(KIOSK_AGENTS_MD);
			expect(await fs.readText("naia-adk/rules/response-rules.md")).toBe(
				KIOSK_RULES_MD,
			);

			// R10 판별: 제목을 찾지 못하면 빈 원고가 되어 어떤 원고와도
			// 같아지지 않는다(유효한 원고로 slice 되지 않는다).
			expect(
				sliceBeforeHeading("앞부분\n## 4. 웹판에서 할 수 있는 일과 없는 일\n뒷부분", "\n## 4. 웹판에서 할 수 있는 일과 없는 일"),
			).toBe("앞부분");
			expect(sliceBeforeHeading("제목 없는 원고", "\n## 4. 웹판에서 할 수 있는 일과 없는 일")).toBe(
				"",
			);

			// 저장된 출처 라벨은 UI 로케일과 무관하게 한국어 고정값이다.
			const seeded = createMemoryWebFs();
			await seedKioskKnowledge(seeded);
			const config = JSON.parse(
				String(await seeded.readText("naia-adk/naia-settings/knowledge.json")),
			) as {
				scope: string;
				sources: { path: string; label: string }[];
			};
			expect(config.sources).toHaveLength(1);
			expect(config.sources[0]?.label).toBe("넥스테인·나이아 공개 지식");
		} finally {
			await setLocale("ko");
		}
	});
});
