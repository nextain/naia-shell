// 자격증명 등급의 살아 있는 기본 공급자가 격리 ADK 에 심기고, 키는 파일에 남지 않는다 (#547).
//
// 왜 이 테스트가 있는가: 에이전트는 셸이 실어 보내는 provider 를 gRPC 경계에서
// 버리고 워크스페이스의 `naia-settings/config.json` 으로 활성 공급자를 재구성한다.
// 그래서 e2e 가 격리 워크스페이스에 아무것도 심지 않으면 자격증명 등급 스펙들이
// 죽은 값을 물고 `provider error: fetch failed` 로 끝난다 — 두 기계에서 마흔다섯
// 개 중 서른셋이 그렇게 걸렸다.
//
// 여기서 재는 것은 둘이다. 하나, 심은 결과가 에이전트가 실제로 읽는 자리·모양인가.
// 둘, 그 파일에 자격증명이 한 글자도 없는가 — 키는 환경 변수 *이름*으로만 실린다.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// 모듈 표면은 여기 적는다. `typeof import("…/credentialed-adk-seed.js")` 로 가져오면
// 루트 tsc 프로그램이 셸 소스(config.ts → @nextain/naia-os-core → 자기 dist)를
// 끌어들여 rootDir 위반과 dist 덮어쓰기(TS5055)로 컴파일 무결성 게이트가 붉어진다.
// 실제 모듈은 아래 beforeAll 이 파일 경로로 동적 import 한다.
interface SeedModule {
	CREDENTIALED_MAIN_PROVIDER: string;
	CREDENTIALED_MAIN_MODEL: string;
	CREDENTIALED_KEY_ENV: string;
	credentialedSeedAvailable(env?: Record<string, string | undefined>): boolean;
	seedCredentialedAdk(
		adkPath: string,
		options?: { provider?: string; model?: string; credentialRefEnv?: string },
	): {
		adkPath: string;
		configPath: string;
		provider: string;
		model: string;
		credentialRefEnv: string;
	};
}

/**
 * 호출식의 callee 를 **바인딩**으로 되돌려 읽는 공용 모듈의 표면.
 *
 * 이 파일에서 정적으로 가져오면 루트 tsc 프로그램이 `.mjs` 와 자기 dist 를 함께
 * 끌어들여 컴파일 무결성 게이트가 붉어진다. 아래 beforeAll 이 파일 경로로
 * 동적 import 한다.
 */
interface BindingsModule {
	unwrap(node: ts.Node | undefined): ts.Node | null;
	resolveCallee(
		node: ts.Node,
		sf: ts.SourceFile,
		env?: unknown,
	): { module?: string; imported?: string; global?: string } | null;
}

let seedModule: SeedModule;
let bindings: BindingsModule;
const created: string[] = [];

function freshAdk(): string {
	const dir = mkdtempSync(resolve(tmpdir(), "naia-seed-contract-"));
	created.push(dir);
	return dir;
}

beforeAll(async () => {
	seedModule = (await import(
		fileURLToPath(
			new URL(
				"../../packages/shell/e2e-tauri/credentialed-adk-seed.ts",
				import.meta.url,
			),
		)
	)) as SeedModule;
	bindings = (await import(
		fileURLToPath(new URL("../../scripts/lib/bindings.mjs", import.meta.url))
	)) as BindingsModule;
});

afterEach(() => {
	while (created.length) {
		rmSync(created.pop() as string, { recursive: true, force: true });
	}
});

describe("자격증명 등급 시딩", () => {
	it("에이전트가 읽는 자리에 config.json 을 쓴다", () => {
		const adk = freshAdk();
		const result = seedModule.seedCredentialedAdk(adk);
		expect(result.configPath).toBe(resolve(adk, "naia-settings", "config.json"));
		const written = JSON.parse(readFileSync(result.configPath, "utf8"));
		// `llmRoles.main` 이 제품 정본이다 — 에이전트의 `fromConfigJson` 이 최상위
		// provider 보다 먼저 본다. 시딩이 적어야 하는 것은 이것뿐이다.
		expect(written.llmRoles.main.provider).toBe(
			seedModule.CREDENTIALED_MAIN_PROVIDER,
		);
		expect(written.llmRoles.main.model).toBe(seedModule.CREDENTIALED_MAIN_MODEL);
	});

	it("화면 기본값을 한 글자도 바꾸지 않는다", () => {
		// 한때 최상위 `provider`/`model` 거울과 `onboardingComplete`, 이름·로케일까지
		// 함께 적었다. 그 거울이 하이드레이션을 타고 화면에 들어가면
		// `ensureAppReady` 의 `config.provider || "gemini"` 왼쪽이 참이 되어 화면이
		// 게이트웨이 공급자로 고정된다. 그러면 공급자에 따라 갈리는 설정 목록이
		// 달라져, TTS 선택에서 `edge` 가 사라지고 여덟 스펙이 어긋났다(#568).
		//
		// 그러니 이 파일에는 에이전트가 읽는 열쇠 하나만 있어야 한다. 새 화면
		// 기본값을 여기에 얹으려는 다음 변경은 여기서 붉어진다.
		const adk = freshAdk();
		const result = seedModule.seedCredentialedAdk(adk);
		const written = JSON.parse(readFileSync(result.configPath, "utf8"));
		expect(Object.keys(written)).toEqual(["llmRoles"]);
		expect(Object.keys(written.llmRoles)).toEqual(["main"]);
		for (const key of [
			"provider",
			"model",
			"onboardingComplete",
			"ttsProvider",
			"locale",
			"apiKey",
			"workspaceRoot",
			"agentName",
			"userName",
			"persona",
			"vrmModel",
			"appVisible",
			"enableTools",
		]) {
			expect(written[key], `${key} 는 화면의 것이다 — 시딩이 적으면 안 된다`).toBe(
				undefined,
			);
		}
	});

	it("키 값을 파일에 남기지 않는다 — 환경 변수 이름만 적는다", () => {
		const adk = freshAdk();
		const secret = "test-gateway-key-placeholder";
		const previous = process.env[seedModule.CREDENTIALED_KEY_ENV];
		process.env[seedModule.CREDENTIALED_KEY_ENV] = secret;
		try {
			const result = seedModule.seedCredentialedAdk(adk);
			const raw = readFileSync(result.configPath, "utf8");
			expect(raw).not.toContain(secret);
			expect(raw).not.toMatch(/gw-[A-Za-z0-9_-]{8,}/);
			expect(JSON.parse(raw).llmRoles.main.credentialRef).toBe(
				seedModule.CREDENTIALED_KEY_ENV,
			);
		} finally {
			if (previous === undefined)
				delete process.env[seedModule.CREDENTIALED_KEY_ENV];
			else process.env[seedModule.CREDENTIALED_KEY_ENV] = previous;
		}
	});

	it("에이전트의 정책 신뢰 경계(processing.json)도 같이 둔다", () => {
		// 이것이 없으면 모델 변경마다 에이전트가 `loaded=false` 를 보고한다.
		const adk = freshAdk();
		seedModule.seedCredentialedAdk(adk);
		const policy = JSON.parse(
			readFileSync(resolve(adk, "naia-settings", "processing.json"), "utf8"),
		);
		expect(policy).toEqual({ version: 1, profiles: [], consents: [] });
	});

	it("키가 없으면 심지 않는다 — 결정론 등급은 예전 그대로 돈다", () => {
		expect(seedModule.credentialedSeedAvailable({})).toBe(false);
		expect(
			seedModule.credentialedSeedAvailable({
				[seedModule.CREDENTIALED_KEY_ENV]: "   ",
			}),
		).toBe(false);
		expect(
			seedModule.credentialedSeedAvailable({
				[seedModule.CREDENTIALED_KEY_ENV]: "gw-something",
			}),
		).toBe(true);
	});

	it("기본 설정이 그 시딩에 실제로 배선돼 있다", () => {
		// 배선을 지우면 여기가 붉어져야 한다. 시딩 함수만 남고 설정이 부르지 않으면
		// 계약은 초록인데 회귀는 여전히 fetch failed 로 죽는다.
		//
		// 예전에는 `/seedCredentialedAdk\(/` 같은 정규식 셋으로 쟀다. 그래서 실제
		// 호출을 지우고 그 줄을 주석으로 남기기만 해도 세 단정이 모두 참이었다 —
		// 배선을 빼면서 이유를 주석으로 적는 것이야말로 이 테스트가 막겠다고 적어
		// 둔 사고다(11회차 지적 8). 이제 파서로 **노드**를 찾는다. 주석에는 노드가
		// 없으므로 주석은 저절로 거짓이다. 10회차에 격리 계약
		// (`e2e-runtime-isolation.contract.test.ts`)이 같은 자리를 같은 방식으로
		// 닫았다.
		//
		// 그 다음 구멍은 호출을 **설정이 타지 않는 함수**로 옮기는 것이었다. 파일
		// 어딘가에 호출 노드가 있기만 하면 참이었으므로, `onPrepare` 의 호출을
		// 지우고 아무도 부르지 않는 `function unusedGhostSeed()` 안에 같은 호출을
		// 남기면 계약은 초록인데 격리 워크스페이스는 비어 있었다(12회차 지적 9).
		// 그래서 이제 파일이 아니라 **기본 설정이 실행하는 자리**에서 잰다 —
		// `config.onPrepare`/`config.before` 의 몸통에서 시작한 그래프 안에 호출이
		// 있어야 참이다. 안 쓰는 함수는 그 그래프에 없다.
		//
		// 그 그래프가 처음에는 **이름 언급**이었다. 식별자가 적히기만 하면 그 이름의
		// 몸통이 들어와, `onPrepare` 첫 줄에 `const _ghostSeed = unusedGhostSeed;`
		// 한 줄만 두면 아무도 부르지 않는 함수 안의 시딩이 배선으로 읽혔다(13회차
		// 지적 7). 이제 그래프는 **호출**이다 — 부르는 자리(callee, `new`, 즉시 실행,
		// 인자 자리로 넘긴 함수)만 따라가고, 값으로 적히기만 한 참조는 따라가지
		// 않는다. 상수를 거쳐 훅에 닿는 판단은 `consultedFrom` 이 따로 보되, 거기서도
		// 함수 몸통에는 들어가지 않는다.
		const tree = parseWdioConf();
		const bound = seedImportBindings(tree);
		const declarations = moduleScopeDeclarations(tree);

		const onPrepare = configHookBody(declarations, "onPrepare");
		expect(onPrepare, "기본 설정에 onPrepare 훅이 없다").toBeTruthy();

		// 시딩은 **불려야** 한다. 이름을 값으로 적어 두는 것은 배선이 아니다.
		expect(
			bound.get("seedCredentialedAdk"),
			"wdio.conf.ts 가 시딩 함수를 import 하지 않는다",
		).toBeTruthy();
		expect(
			callsSeedExport(calledFrom(onPrepare as ts.Node, declarations), tree, "seedCredentialedAdk"),
			"onPrepare 가 그 시딩을 실제로 부르지 않으면 격리 워크스페이스는 비어 있다",
		).toBe(true);

		// 가능 여부 판단은 상수 하나를 거쳐 훅에 닿는다 — 그 상수까지 본다.
		expect(
			bound.get("credentialedSeedAvailable"),
			"wdio.conf.ts 가 시딩 가능 여부 판단을 import 하지 않는다",
		).toBeTruthy();
		expect(
			callsSeedExport(
				consultedFrom(onPrepare as ts.Node, declarations),
				tree,
				"credentialedSeedAvailable",
			),
			"키가 있는지 실제로 물어야 결정론 등급이 예전 그대로 돈다",
		).toBe(true);

		// 워커도 같은 판단을 해야 스펙 앞에서 키를 실어 준다. 그 판단은 스펙 앞
		// 훅이 보는 값이어야 하므로 `config.before` 에서 닿아야 한다.
		const before = configHookBody(declarations, "before");
		expect(before, "기본 설정에 before 훅이 없다").toBeTruthy();
		expect(
			touchesProcessEnv(
				consultedFrom(before as ts.Node, declarations),
				"NAIA_E2E_CREDENTIALED_SEED",
			),
			"워커에게 넘기는 표시가 없으면 스펙은 키 없이 돈다",
		).toBe(true);
	});
});

/** `wdio.conf.ts` 를 노드로 읽는다. 글자가 아니라 노드로 재기 위해서다. */
function parseWdioConf(): ts.SourceFile {
	const path = fileURLToPath(
		new URL("../../packages/shell/e2e-tauri/wdio.conf.ts", import.meta.url),
	);
	return ts.createSourceFile(
		path,
		readFileSync(path, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}

/**
 * 시딩 모듈에서 들어온 이름 → 이 파일에서 쓰는 이름.
 *
 * 별명(`import { seedCredentialedAdk as seed }`)으로 바꿔도 따라간다 — 이름이
 * 아니라 바인딩을 본다.
 */
function seedImportBindings(tree: ts.SourceFile): Map<string, string> {
	const bound = new Map<string, string>();
	for (const statement of tree.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (!/(^|\/)credentialed-adk-seed(\.[jt]s)?$/.test(statement.moduleSpecifier.text))
			continue;
		const named = statement.importClause?.namedBindings;
		if (!named || !ts.isNamedImports(named)) continue;
		for (const element of named.elements) {
			bound.set((element.propertyName ?? element.name).text, element.name.text);
		}
	}
	return bound;
}

/**
 * 모듈 스코프에 선언된 이름과 그 정체.
 *
 *   - `function` — 부르면 실행되는 몸통(함수 선언, `const f = () => {…}`)
 *   - `alias` — 다른 이름을 그대로 가리키는 `const`(`const g = f`)
 *   - `value` — 그 밖의 `const` 초기화식(불리언, 객체, 문자열 조립…)
 *
 * 이 셋을 가르는 것이 이 계약의 핵심이다. **부름**은 `function`/`alias` 만 따라가고,
 * **참조**는 `value` 만 따라간다. 그래서 함수를 값으로 적기만 한 자리
 * (`const _ghostSeed = unusedGhostSeed;`)는 어느 쪽으로도 몸통에 닿지 못한다.
 */
type ModuleDeclaration =
	| { kind: "function"; body: ts.Node }
	| { kind: "alias"; target: string }
	| { kind: "value"; node: ts.Node };

function moduleScopeDeclarations(tree: ts.SourceFile): Map<string, ModuleDeclaration> {
	const declarations = new Map<string, ModuleDeclaration>();
	for (const statement of tree.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
			declarations.set(statement.name.text, { kind: "function", body: statement.body });
			continue;
		}
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
			const initializer = declaration.initializer;
			if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) {
				declarations.set(declaration.name.text, { kind: "function", body: initializer.body });
			} else if (ts.isIdentifier(initializer)) {
				declarations.set(declaration.name.text, { kind: "alias", target: initializer.text });
			} else {
				declarations.set(declaration.name.text, { kind: "value", node: initializer });
			}
		}
	}
	return declarations;
}

/** 그 이름을 **부르면** 실행되는 몸통. `const` 별명은 한 단계씩 따라간다. */
function callableBody(
	name: string,
	declarations: Map<string, ModuleDeclaration>,
): ts.Node | null {
	const seen = new Set<string>();
	let current = name;
	while (!seen.has(current)) {
		seen.add(current);
		const declaration = declarations.get(current);
		if (!declaration) return null;
		if (declaration.kind === "function") return declaration.body;
		if (declaration.kind !== "alias") return null;
		current = declaration.target;
	}
	return null;
}

/** 기본 설정 객체의 훅 몸통. 메서드·함수식·화살표·같은 파일 함수 참조를 모두 푼다. */
function configHookBody(
	declarations: Map<string, ModuleDeclaration>,
	hook: string,
): ts.Node | null {
	const config = declarations.get("config");
	if (!config || config.kind !== "value" || !ts.isObjectLiteralExpression(config.node))
		return null;
	for (const property of config.node.properties) {
		const name = property.name;
		const key =
			name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null;
		if (key !== hook) continue;
		if (ts.isMethodDeclaration(property)) return property.body ?? null;
		if (ts.isPropertyAssignment(property)) {
			const value = property.initializer;
			if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) return value.body;
			if (ts.isIdentifier(value)) return callableBody(value.text, declarations);
			return null;
		}
		if (ts.isShorthandPropertyAssignment(property))
			return callableBody(property.name.text, declarations);
	}
	return null;
}

/**
 * 이 몸통에서 **실제로 실행되는** 노드를 훑는다.
 *
 * 안 부르는 함수식의 몸통에는 들어가지 않는다. 그 몸통은 누가 부를 때에만
 * 뿌리로 따로 들어온다 — 즉시 실행이거나, 인자 자리로 넘겨졌거나, 이름으로
 * 불렸을 때다.
 */
function forEachExecutedNode(root: ts.Node, fn: (node: ts.Node) => void): void {
	const visit = (node: ts.Node): void => {
		if (node !== root && isFunctionLike(node)) return;
		fn(node);
		node.forEachChild(visit);
	};
	visit(root);
}

function isFunctionLike(node: ts.Node): boolean {
	return (
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node)
	);
}

/** 호출식의 callee 가 가리키는 지역 이름. `(0, f)()` · `f.call(…)` 도 같은 f 다. */
function calleeLocalName(callee: ts.Node | null): string | null {
	if (!callee) return null;
	if (ts.isIdentifier(callee)) return callee.text;
	if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
		const method = ts.isPropertyAccessExpression(callee)
			? callee.name.text
			: ts.isStringLiteralLike(callee.argumentExpression)
				? callee.argumentExpression.text
				: null;
		if (method !== "call" && method !== "apply" && method !== "bind") return null;
		const base = bindings.unwrap(callee.expression);
		return base && ts.isIdentifier(base) ? base.text : null;
	}
	return null;
}

/**
 * 입구에서 **불려서** 실행되는 몸통 전부 — 이름 언급이 아니라 호출 그래프다.
 *
 * 12회차는 식별자가 **적히기만** 해도 그 이름의 몸통을 넣었다. 그래서 `onPrepare`
 * 첫 줄에 `const _ghostSeed = unusedGhostSeed;` 한 줄만 두면, 아무도 부르지 않는
 * 함수 안의 시딩 호출이 배선으로 읽혔다(13회차 지적 7).
 *
 * 이제 따라가는 것은 실행으로 이어지는 자리뿐이다 — 호출식의 callee(식별자,
 * 껍데기를 벗긴 쉼표식, `f.call`/`f.apply`/`f.bind`, 같은 파일 `const` 별명),
 * `new X()`, 즉시 실행 함수식, 그리고 인자 자리로 넘겨진 함수 참조·함수식
 * (`then(fn)`, `forEach(fn)`, `setTimeout(fn)`). 값으로 적히기만 한 참조는
 * 따라가지 않는다.
 */
function calledFrom(entry: ts.Node, declarations: Map<string, ModuleDeclaration>): ts.Node[] {
	const roots: ts.Node[] = [entry];
	const seen = new Set<string>();
	const enqueueName = (name: string): void => {
		if (seen.has(name)) return;
		seen.add(name);
		const body = callableBody(name, declarations);
		if (body) roots.push(body);
	};
	const enqueueValue = (node: ts.Node | null): void => {
		if (!node) return;
		if (ts.isIdentifier(node)) {
			enqueueName(node.text);
			return;
		}
		if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) roots.push(node.body);
	};

	for (let i = 0; i < roots.length; i += 1) {
		forEachExecutedNode(roots[i], (node) => {
			if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
			// callee: 이름으로 불렀거나, 함수식을 그 자리에서 바로 부른 것(IIFE).
			enqueueValue(bindings.unwrap(node.expression));
			const name = calleeLocalName(bindings.unwrap(node.expression));
			if (name) enqueueName(name);
			// 인자 자리로 넘긴 함수는 그 호출이 부른다.
			for (const argument of node.arguments ?? []) enqueueValue(bindings.unwrap(argument));
		});
	}
	return roots;
}

/**
 * 입구가 **보는** 값까지 넓힌 범위. 부름 그래프에 모듈 스코프 `value` 상수의
 * 초기화식을 더한다.
 *
 * 판단이 상수 하나를 거쳐 훅에 닿는 배선(`const SEEDS_… = … && available(); if
 * (SEEDS_…)`)을 읽기 위해서다. 값만 따라가고 **함수 몸통에는 절대 들어가지
 * 않으므로**, 함수를 값으로 적기만 한 참조는 여기서도 배선이 되지 못한다.
 */
function consultedFrom(entry: ts.Node, declarations: Map<string, ModuleDeclaration>): ts.Node[] {
	const roots = calledFrom(entry, declarations);
	const seen = new Set<string>();
	for (let i = 0; i < roots.length; i += 1) {
		const names: string[] = [];
		referencedNames(roots[i], names);
		for (const name of names) {
			if (seen.has(name)) continue;
			seen.add(name);
			const declaration = declarations.get(name);
			if (declaration?.kind === "value") roots.push(declaration.node);
		}
	}
	return roots;
}

/** 이 노드가 이름으로 참조하는 것들. `a.b` 는 `a` 만 이름이다. */
function referencedNames(node: ts.Node, out: string[]): void {
	const visit = (n: ts.Node): void => {
		if (ts.isPropertyAccessExpression(n)) {
			visit(n.expression);
			return;
		}
		if (ts.isQualifiedName(n)) {
			visit(n.left);
			return;
		}
		if (ts.isIdentifier(n)) {
			out.push(n.text);
			return;
		}
		n.forEachChild(visit);
	};
	visit(node);
}

/**
 * 시딩 모듈의 그 export 를 **부르는** 호출이 범위 안에 있는가.
 *
 * 이름이 아니라 바인딩으로 묻는다 — `scripts/lib/bindings.mjs` 의 `resolveCallee`
 * 가 별명·쉼표식·`.call`/`.apply`/`.bind` 를 모두 같은 답으로 되돌린다.
 */
function callsSeedExport(roots: ts.Node[], tree: ts.SourceFile, exported: string): boolean {
	let found = false;
	for (const root of roots) {
		forEachExecutedNode(root, (node) => {
			if (found || !ts.isCallExpression(node)) return;
			const binding = bindings.resolveCallee(node, tree);
			if (!binding?.module || binding.imported !== exported) return;
			if (/(^|\/)credentialed-adk-seed(\.[jt]s)?$/.test(binding.module)) found = true;
		});
	}
	return found;
}

/** `process.env.<key>` 를 **실제로** 대입하거나 읽는 노드가 도달 범위 안에 있는가. */
function touchesProcessEnv(roots: ts.Node[], key: string): boolean {
	const isProcessEnv = (node: ts.Expression): boolean =>
		ts.isPropertyAccessExpression(node) &&
		node.name.text === "env" &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "process";
	let found = false;
	for (const root of roots) {
		forEachExecutedNode(root, (node) => {
			if (found) return;
			if (
				ts.isPropertyAccessExpression(node) &&
				node.name.text === key &&
				isProcessEnv(node.expression)
			) {
				found = true;
				return;
			}
			if (
				ts.isElementAccessExpression(node) &&
				node.argumentExpression &&
				ts.isStringLiteralLike(node.argumentExpression) &&
				node.argumentExpression.text === key &&
				isProcessEnv(node.expression)
			) {
				found = true;
			}
		});
	}
	return found;
}
