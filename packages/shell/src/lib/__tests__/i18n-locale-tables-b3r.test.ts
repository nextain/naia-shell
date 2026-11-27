import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { setLocale, t, tKo } from "../i18n";
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

/**
 * 호출이 들어 있어야 할 함수 범위 → 그 안에서 순서대로 나와야 할 키.
 * 정렬해서 견주면 같은 범위 안에서 키를 맞바꾼 변이가 그대로 통과하므로
 * 순서를 그대로 둔다.
 */
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

/**
 * 범위별 실제 사용 위치. 같은 함수 안에서 검사 대상(`existingAgents` 대
 * `existingRules`)을 옮기면 키 집합은 그대로라 순서 단정만으로 못 잡는다.
 * 그래서 호출 결과가 어디에 쓰이는지도 함께 연결한다: `X.includes(...)` 의
 * 인자면 `X.includes`, 객체 속성값이면 `prop:이름`, 배열 원소면 `elem:번호`,
 * 일반 호출의 인자면 `함수:arg번호`, 변수 초기화면 `init` 이다.
 */
const EXPECTED_KNOWLEDGE_USAGES: Readonly<Record<string, readonly string[]>> = {
	LEGACY_MANUSCRIPT_TEXT: ["elem:0", "elem:1", "elem:0", "elem:1"],
	KIOSK_AGENTS_MD: ["init"],
	KIOSK_AGENTS_MD_R10: ["sliceBeforeHeading:arg1"],
	KIOSK_RULES_MD: ["init"],
	R13_OLD_WEB: ["init"],
	seedKioskKnowledge: ["prop:label"],
	seedKioskAdkWorkspace: [
		"existingAgents.includes",
		"existingAgents.includes",
		"existingRules.includes",
	],
};

/** 읽기표는 속성 이름이 키 끝자리와 같아야 한다(바꿔 끼우기 방지). */
function expectedSpeechUsages(keys: readonly string[]): readonly string[] {
	return keys.map((key) => `prop:${key.split(".").pop()!}`);
}

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
	usage: string;
}

/**
 * 호출 결과가 어디에 쓰이는지. 부모가 `X.includes(호출)` 이면 검사 대상을
 * 함께 적어 같은 함수 안의 이동 변이(`existingAgents` → `existingRules`)를
 * 드러낸다. 그 외는 속성·배열·인자·초기화 자리를 적는다.
 */
function usageOf(call: ts.CallExpression): string {
	const parent = call.parent;
	if (ts.isCallExpression(parent)) {
		const argIndex = parent.arguments.indexOf(call);
		if (ts.isPropertyAccessExpression(parent.expression)) {
			return `${parent.expression.expression.getText()}.${parent.expression.name.text}`;
		}
		if (ts.isIdentifier(parent.expression)) {
			return `${parent.expression.text}:arg${argIndex}`;
		}
		return `call:arg${argIndex}`;
	}
	if (ts.isPropertyAssignment(parent)) return `prop:${parent.name.getText()}`;
	if (ts.isArrayLiteralExpression(parent))
		return `elem:${parent.elements.indexOf(call)}`;
	if (ts.isVariableDeclaration(parent)) return "init";
	return ts.SyntaxKind[parent.kind] ?? "other";
}

/**
 * `tKo` 가 i18n 에서 별명 없이 들어왔는지. `import { t as tKo }` 로
 * UI 로케일 조회를 도로 끼우면 호출 모양은 그대로라 callee 단정만으로 못
 * 잡는다.
 */
function expectTKoImportBinding(relativePath: string, specifier: string): void {
	const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
	const tree = ts.createSourceFile(
		relativePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const bindings: { imported: string; local: string; from: string }[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteralLike(node.moduleSpecifier) &&
			node.importClause?.namedBindings &&
			ts.isNamedImports(node.importClause.namedBindings)
		) {
			for (const element of node.importClause.namedBindings.elements) {
				bindings.push({
					imported: element.propertyName?.text ?? element.name.text,
					local: element.name.text,
					from: node.moduleSpecifier.text,
				});
			}
		}
		node.forEachChild(visit);
	};
	visit(tree);
	const tko = bindings.filter(
		(binding) => binding.local === "tKo" && binding.from === specifier,
	);
	expect(
		tko.map((binding) => `${binding.from}:${binding.imported} as ${binding.local}`),
		`${relativePath} tKo 묶음`,
	).toEqual([`${specifier}:tKo as tKo`]);
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
				usage: usageOf(node),
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
	expectedUsages: Readonly<Record<string, readonly string[]>>,
	allKeys: readonly string[],
) {
	const actual = collectLocaleCalls(relativePath);
	const expectedTotal = Object.values(expected).reduce(
		(sum, keys) => sum + keys.length,
		0,
	);
	expect(
		actual.map(
			(call) =>
				`${call.scope}@${call.line}:${call.callee}("${call.key}")=>${call.usage}`,
		),
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
		const inScope = actual.filter((call) => call.scope === scope);
		expect(
			inScope.map((call) => call.key),
			`${label} ${scope}()의 키(순서대로)`,
		).toEqual([...keys]);
		expect(
			inScope.map((call) => call.usage),
			`${label} ${scope}()의 사용 위치(순서대로)`,
		).toEqual([...(expectedUsages[scope] ?? [])]);
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
		expectTKoImportBinding("../kiosk-demo/knowledge.ts", "../i18n");
		expectTKoImportBinding(
			"../avatar/nva-speech/browser-speech-plan.ts",
			"../../i18n",
		);
		expectScopeMapping(
			"knowledge.ts",
			"../kiosk-demo/knowledge.ts",
			EXPECTED_KNOWLEDGE_SCOPES,
			EXPECTED_KNOWLEDGE_USAGES,
			KNOWLEDGE_KEYS,
		);
		expectScopeMapping(
			"browser-speech-plan.ts",
			"../avatar/nva-speech/browser-speech-plan.ts",
			EXPECTED_SPEECH_SCOPES,
			Object.fromEntries(
				Object.entries(EXPECTED_SPEECH_SCOPES).map(([scope, keys]) => [
					scope,
					expectedSpeechUsages(keys),
				]),
			),
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

	/**
	 * 지적 2 [국소] — 발음표가 만들어지는 모듈 평가 시점을 검증한다.
	 * 위 시험은 모듈을 미리 불러온 뒤 문자열 변환만 실행하므로, 평가 시점의
	 * UI 로케일 추종(`import { t as tKo }`)을 못 잡는다. 영어 표 값이
	 * 한국어 표와 우연히 같아서다. 그래서 UI를 en으로 두고 발음 키마다
	 * 한국어 표와 다른 영어값을 주입한 뒤 발음 모듈을 새로 불러와, 한국어
	 * 요청 본문이 그대로 나가는지 가짜 fetch 로 단정한다.
	 */
	it("en UI에서 주입된 영어값과 무관하게 발음 모듈은 한국어 표로 평가된다", async () => {
		await setLocale("en");
		const koFixture = Object.fromEntries(
			SPEECH_KEYS.map(
				(key) => [key, (SHORT_KEY_VALUES as Record<string, string>)[key]] as const,
			),
		);
		const enInjected = Object.fromEntries(
			SPEECH_KEYS.map((key) => [key, `EN:${key}`] as const),
		);
		vi.doMock("../i18n", () => ({
			tKo: (key: string) => koFixture[key] ?? key,
			t: (key: string) => enInjected[key] ?? key,
		}));
		try {
			const fresh = (await import(
				/* @vite-ignore */ "../avatar/nva-speech/browser-speech-plan.ts?fx1-speech-en"
			)) as typeof import("../avatar/nva-speech/browser-speech-plan");
			expect(
				fresh.replaceLatinWithHangulForSpeechUnits("AI"),
				"주입된 영어값이 발음표에 스며들었다",
			).toBe("에이아이");
			const bodies: string[] = [];
			const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
				bodies.push(
					(JSON.parse((init as { body: string }).body) as { text: string })
						.text,
				);
				return { ok: true, json: async () => ({ words: [] }) } as unknown as Response;
			});
			vi.stubGlobal("fetch", fetchMock);
			try {
				await fresh.fetchSpeechPlanUnits("AI Web", "ko");
			} finally {
				vi.unstubAllGlobals();
			}
			expect(bodies, "한국어 요청 본문").toEqual(["에이아이 웹"]);
		} finally {
			vi.doUnmock("../i18n");
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

	/**
	 * 지적 1 [구조] — OPFS 옛 문구는 조건마다 독립적으로 시험한다.
	 * 위 묶음 시험은 모든 판별 문구를 한 원고에 넣으므로, 같은 함수 안에서
	 * 검사 대상을 옮기는 변이(`existingAgents` → `existingRules`)가 그대로
	 * 통과한다. 각 판별식만 든 원고를 따로 두고, 근거 없는 원고는 두도록
	 * 단정한다.
	 */
	it("OPFS 옛 판별식은 각각 단독으로도 AGENTS를 갱신한다", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		await setLocale("en");
		try {
			const keepBasis = (SHORT_KEY_VALUES as Record<string, string>)[
				"kiosk.detectOld.keepBasis"
			]!;
			const personaHeading = (SHORT_KEY_VALUES as Record<string, string>)[
				"kiosk.detectOld.personaHeading"
			]!;
			const section4Heading = (SHORT_KEY_VALUES as Record<string, string>)[
				"kiosk.agentsMd.section4Heading"
			]!;
			const cases: Array<readonly [string, string]> = [
				["keepBasis만", `옛 안내\n${keepBasis}\n`],
				["personaHeading만", `옛 안내\n${personaHeading}\n`],
				["skill_memory_save만", "옛 안내\nskill_memory_save\n"],
				["R10 원문", sliceBeforeHeading(KIOSK_AGENTS_MD, section4Heading)],
			];
			for (const [name, content] of cases) {
				const fs = createMemoryWebFs();
				await fs.writeBytes("naia-adk/AGENTS.md", content);
				await seedKioskAdkWorkspace(fs);
				expect(await fs.readText("naia-adk/AGENTS.md"), `AGENTS ${name}`).toBe(
					KIOSK_AGENTS_MD,
				);
			}
			const untouched = createMemoryWebFs();
			const custom = "손님이 고친 안내\n";
			await untouched.writeBytes("naia-adk/AGENTS.md", custom);
			await seedKioskAdkWorkspace(untouched);
			expect(
				await untouched.readText("naia-adk/AGENTS.md"),
				"AGENTS 근거없음",
			).toBe(custom);
		} finally {
			await setLocale("ko");
		}
	});

	it("OPFS 규칙 옛 출처줄은 단독으로 갱신되고 keepBasis만으로는 안 된다", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		await setLocale("en");
		try {
			const sourceLine = (SHORT_KEY_VALUES as Record<string, string>)[
				"kiosk.detectOld.sourceLine"
			]!;
			const keepBasis = (SHORT_KEY_VALUES as Record<string, string>)[
				"kiosk.detectOld.keepBasis"
			]!;
			const withMarker = createMemoryWebFs();
			await withMarker.writeBytes(
				"naia-adk/rules/response-rules.md",
				`옛 규칙\n${sourceLine}\n`,
			);
			await seedKioskAdkWorkspace(withMarker);
			expect(
				await withMarker.readText("naia-adk/rules/response-rules.md"),
				"rules 출처줄",
			).toBe(KIOSK_RULES_MD);
			// keepBasis 검사가 규칙 쪽으로 옮겨지면 이 원고까지 덮어쓴다.
			const misplaced = createMemoryWebFs();
			const custom = `손님이 고친 규칙\n${keepBasis}\n`;
			await misplaced.writeBytes("naia-adk/rules/response-rules.md", custom);
			await seedKioskAdkWorkspace(misplaced);
			expect(
				await misplaced.readText("naia-adk/rules/response-rules.md"),
				"rules keepBasis만",
			).toBe(custom);
		} finally {
			await setLocale("ko");
		}
	});

	it("tKo는 ko 표에 없는 키를 키 이름으로 돌려주지 않는다", () => {
		const missing = "no.such.ko.key";
		expect(() => (tKo as (key: string) => string)(missing)).toThrow(
			"missing_ko_translation",
		);
	});
});
