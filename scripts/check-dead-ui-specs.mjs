/**
 * 앱에서 렌더되지 않는 화면을 검사하는 테스트를 잡는다.
 *
 * 왜 필요한가: 화면이 사라져도 그것을 검사하던 스펙은 남는다. 그 스펙은
 * 사라진 요소를 기다리다 시간을 다 쓰고 실패하는데, 그 실패는 "회귀가
 * 생겼다" 로 읽힌다. 실제로는 재는 대상이 없어진 것이다. 둘을 구별하지
 * 못하면 배포 판단이 흐려지고, 붉은 것이 상수가 되어 사람이 게이트를 끈다.
 *
 * 이 저장소에서 실제로 세 번 있었다.
 *   - 음성 깨우기 화면이 삭제됐는데(코드에 "UI + handlers deleted" 라고
 *     적혀 있다) 스펙 둘이 남아 그 화면을 기다렸다
 *   - Agents 탭이 옮겨 갔는데 스펙 넷이 옛 자리를 순서로 집고 있었다
 *   - 그 옮겨 간 자리(NaiaMetaArea)마저 앱 어디에서도 렌더되지 않는 죽은
 *     컴포넌트였다
 *
 * 무엇을 재는가: 스펙이 `data-testid` / `data-*-tab` 으로 집는 이름이 셸
 * 소스 어딘가에 실제로 있는지. 없으면 그 스펙은 없는 것을 기다린다.
 *
 * 무엇을 재지 않는가: 요소가 있어도 그 화면에 도달할 수 있는지는 정적으로
 * 알 수 없다. 렌더되지 않는 컴포넌트 안의 요소는 여기서 살아 있는 것으로
 * 보인다 — 그것은 실행이 잡는다.
 *
 * **없어야 한다고 단정하는 자리는 세지 않는다.** `toHaveCount(0)` 처럼 그
 * 요소가 사라졌음을 확인하는 테스트가 있고, 그런 자리는 소스에 이름이 없는
 * 것이 정상이다. 그것까지 결함으로 세면 게이트가 옳은 테스트를 지우라고
 * 말하게 된다.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
	alwaysTruthy,
	elementProps,
	jsxElementsIn,
	makeEnv,
	parseSource,
	staticChunks,
	stringCandidates,
	unwrapAll,
} from "./lib/jsx-static.mjs";
import { crateSourceRoots } from "./lib/crate-roots.mjs";
import { tauriCommandNames } from "./lib/rust-tokens.mjs";

const SHELL = "packages/shell";

/** 스펙이 요소를 집는 방식 중 소스와 대조할 수 있는 것. */
/**
 * 스펙이 요소를 집는 방식.
 *
 * 처음에는 대괄호 셀렉터만 봤다. 그래서 같은 결함을 `getByTestId("...")` 나
 * `querySelector(".voice-wake-panel")` 로 적으면 세지도 않았다. 실제 스펙에서
 * 쓰는 형태를 세어 보면 `querySelector` 가 가장 많다.
 */
const ANCHORS = [
	/\[data-testid=["']([\w-]+)["']\]/g,
	/\[data-([\w-]+)-tab=["']([\w-]+)["']\]/g,
	/(?:getByTestId|findByTestId)\(\s*["'`]([\w-]+)["'`]/g,
];

/**
 * 소스에 없어도 두는 이름. 왜 없어도 되는지 적어야 한다.
 */
const ALLOWED_ABSENT = new Map([
	// 2026-09-06: 이 두 표지를 그리던 NaiaMetaArea 를 지웠다. DiagnosticsTab 과
	// WorkProgressArea 자체는 ChatArea 에 `activeTab === "diagnostics" | "progress"` 로
	// 남아 있지만 그 탭으로 바꾸는 버튼·호출이 제품 어디에도 없다 — 사용자가 닿을 수
	// 없는 화면이다(#579). 31·60·99-screenshots 는 탭이 안 뜨면 "graceful skip" 으로
	// 통과해 왔으므로 그 통과는 비어 있다. 되살릴지 지울지는 #579 에서 정한다. 그때까지
	// 이 사유를 남겨 게이트가 다른 새 결손을 계속 잡게 한다.
	['data-meta-tab="progress"', "#579 — 진입점 없음, 처분 대기"],
	['data-meta-tab="diagnostics"', "#579 — 진입점 없음, 처분 대기"],
]);

function tracked(dir, extension) {
	try {
		return execFileSync("git", ["ls-files", "--", dir], { encoding: "utf8" })
			.split("\n")
			.filter((f) => f.endsWith(extension));
	} catch {
		return [];
	}
}

/**
 * 셸 소스 파일과 그 내용. 파서에게 물을 때 쓴다.
 *
 * 아홉 번째까지 이 자리에 **주석을 지운 소스 전문**과 그 위에 얹은 정규식
 * `identifierContexts` 가 있었고, 이름의 "존재 증명" 이 거기서 나왔다.
 * 그 증명에는 파일이 없었다. 파일이 없으면 그 표지가 화면에 오르는지를
 * 이어서 물을 수 없다 — 그래서 고아 파일에 숨긴 표지가 존재 증명만으로
 * 살아났고, 살린 것은 표지가 아니라 `id={` 라는 **문맥**이었다.
 *
 * 이제 존재는 파서가 읽은 속성에서만 나온다. 속성에는 언제나 그것을 적은
 * 파일이 딸려 오므로, 존재 판정과 도달 가능성 판정이 같은 자리에서 이어진다.
 */
const shellSources = new Map(
	[...tracked(`${SHELL}/src`, ".tsx"), ...tracked(`${SHELL}/src`, ".ts")]
		.filter((f) => !/\.test\.|__tests__/.test(f))
		.map((f) => [f, readFileSync(f, "utf8")]),
);

/** 상수·타입을 import 너머로 따라갈 때 쓰는 환경. */
const env = makeEnv(shellSources);

/** 표지로 쓰는 data 속성인가. */
const MARKER_ATTR = /^data-(?:testid|app-id|[\w-]*tab)$/;

function addTo(map, key, value) {
	if (!map.has(key)) map.set(key, new Set());
	map.get(key).add(value);
}

/**
 * Rust 가 프런트에 내주는 **IPC 이름** 전부.
 *
 * 예전에는 명령 속성과 `fn` 사이를 원문에서 재는 정규식이었다(창 200자). 주석을
 * 버리지 않으므로 주석에 적어 둔 명령 속성 옆의 `fn` 이 명령으로 셌고, 창 길이도
 * 그대로였다 — 파괴 게이트가 11회차에 닫은 바로 그 측정 지점이 여기 남아 있었다
 * (19회차 지적 6). 스펙이 없는 명령을 불러도 주석 두 줄이면 초록이었다.
 *
 * 그 정규식은 이 파일에 다시 적히면 안 된다. `src/test/rust-command-list.contract.test.ts`
 * 가 그 사실을 고정한다.
 *
 * 이제 두 게이트가 같은 자리에서 센다. 이름은 `rust-tokens.mjs` 의
 * `tauriCommandNames`(토크나이저 — 주석과 문자열은 토큰이 아니고, `rename` 인자가
 * 있으면 그 IPC 이름이다), 소스 뿌리는 `crate-roots.mjs` 의 `crateSourceRoots`
 * (`Cargo.toml` 의 workspace·path 의존)다.
 */
function rustCommandNames() {
	const names = new Set();
	for (const root of crateSourceRoots()) {
		for (const file of tracked(root, ".rs")) {
			for (const name of tauriCommandNames(readFileSync(file, "utf8"))) {
				names.add(name);
			}
		}
	}
	return names;
}

/**
 * 지금 없는 채로 두는 명령. 왜 없는지 적어야 한다.
 *
 * 둘 다 스펙만 남고 구현이 없는 자리다. 지우거나 만들거나 둘 중 하나인데,
 * 그 판단은 그 기능을 아는 사람이 해야 한다.
 */
const KNOWN_MISSING_COMMANDS = new Map([
	["discord_api", "70-channel-sync-dm 이 부른다. 이름이 바뀌었을 수 있다"],
]);

/**
 * 영구히 꺼 둔 조작을 누르려는 스펙.
 *
 * 요소가 소스에 있다는 것과 사용자가 거기 도달할 수 있다는 것은 다른
 * 질문이다. 실측에서 드러났다 — 92-discord-secure-cancel 은 connections
 * 탭을 누른 뒤 그 패널을 30초 기다리는데, 그 탭은 `disabled` 가 조건 없이
 * 박혀 있고 라벨에 "곧 제공" 이 붙어 있다. 기능을 일부러 안 낸 상태인데
 * 스펙은 매번 30초를 쓰고 실패한다. 두 기계에서 똑같이 그랬다.
 *
 * 조건부 `disabled={...}` 는 상태에 따라 열리므로 여기서 보지 않는다.
 * **언제나 참인** `disabled` 만 영구로 본다 — 값 없이 박힌 것, `{true}`,
 * `{true as const}`, `"true"`, 그리고 같은 뜻인 `{off}`(위에서 `const off =
 * true`)와 `{true && true}` 까지. 아홉 번째까지는 앞의 넷만 영구로 봤는데,
 * React 에서는 뒤엣것도 똑같이 누를 수 없는 버튼이다. 뜻이 같으면 같게 본다.
 */
function permanentlyDisabledTestIds(files) {
	const out = new Map();
	for (const [file, text] of files) {
		const tree = parseSource(file, text);
		for (const element of jsxElementsIn(tree, tree, env)) {
			// 같은 요소에 붙은 속성끼리 본다. spread 와 `createElement` 의 props 도
			// 같은 목록으로 온다 — 꺼짐을 spread 로 적으면 열린 것으로 읽혔다.
			const { props } = elementProps(element, tree, env);
			// 값은 그 값이 **적혀 있는 파일**의 트리로 푼다. import 로 건너온
			// props 를 불러온 쪽 트리로 풀면, 우연히 같은 이름의 상수가 이쪽에
			// 있다는 이유로 꺼진 버튼이 열린 것으로 읽힌다.
			const off = props.some(
				(p) =>
					p.name === "disabled" &&
					(p.bare || alwaysTruthy(p.value, p.sf ?? tree, env)),
			);
			if (!off) continue;
			for (const p of props) {
				if (!MARKER_ATTR.test(p.name)) continue;
				for (const value of stringCandidates(p.value, p.sf ?? tree, env).values)
					out.set(value, true);
			}
		}
	}
	return out;
}

/** 파서에게 물을 파일 목록. */
const shellFiles = [...shellSources];

const disabledIds = permanentlyDisabledTestIds(shellFiles);

/** 저장소가 아는 파일. `existsSync` 는 git 이 모르는 파일도 참이다. */
const trackedFiles = new Set(
	execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean),
);

/**
 * 패키지로 배포되는 앱. 빌드가 실제로 묶는 것만 본다 — 소스에 표식 파일이
 * 있다는 것과 그 앱이 배포된다는 것은 다른 사실이다.
 */
const packagedApps = new Set(
	[...trackedFiles]
		.filter((f) => /\/apps\/[^/]+\/package-public\//.test(f))
		.map((f) => /\/apps\/([^/]+)\/package-public\//.exec(f)?.[1])
		.filter(Boolean),
);

/**
 * 지금 꺼 둔 채로 두는 조작. 왜 스펙이 남아 있는지 적어야 한다.
 */
// "connections" 는 2026-09-12 에 뺐다. 오너 결정으로 브라우저 미리보기에서도
// 연결 탭을 연다(ef3dc42c) — disabled 가 없어졌으므로 이 면제가 더는 걸리지
// 않고, 남겨 두면 "낡았다" 로 붉어진다.
const KNOWN_DISABLED = new Map([]);

/**
 * 렌더되지 않는 파일에만 있는 표지.
 *
 * 표지가 소스에 있다는 것과 그 표지가 화면에 오른다는 것은 다른 질문이다.
 * 실측에서 드러났다 — `coding-workers-toggle` 은 WorkspaceCenterArea.tsx
 * 에 멀쩡히 있는데, 그 파일(1,986줄)은 Herdr 통합 뒤로 값으로 import 되는
 * 곳이 하나도 없다. 타입만 쓰인다. 그래서 두 기계에서 똑같이 30초를 기다린
 * 뒤 실패했고, 기존 검사는 "소스에 있으니 살아 있다" 고 말했다.
 *
 * 판정은 단순하게 한다. 컴포넌트를 내보내는 파일이 다른 파일에서 값으로
 * import 되지 않으면 그 파일은 화면에 오르지 않는다. 진입점(App.tsx 등)과
 * 테스트는 빼고 본다.
 */
/**
 * 소스를 파서로 읽는다.
 *
 * 아홉 번째까지 이 파일의 지적이 매번 같은 모양이었다 — 내가 문법 형태를
 * 하나씩 열거하고, 리뷰어가 하나를 더 찾는다. `data-testid="x"` 를 막으면
 * `{"x"}` 로, 그것을 막으면 `` {`x`} `` 로, 다시 `{"x" as const}` 로 온다.
 * `import type` 을 막으면 `typeof import()` 로, `type _ =` 로, 줄바꿈으로 온다.
 *
 * 형태를 세는 한 이 경주는 끝나지 않는다. 파서에게 물으면 형태가 아니라
 * **뜻**을 묻게 된다 — 이 속성의 값이 정적 문자열인가, 이 import 가 타입
 * 자리인가. 6회차에 check-vacuous-tests 에서 얻은 교훈을 여기 늦게 적용한다.
 *
 * 열 번째에는 그 파서 읽기를 `scripts/lib/jsx-static.mjs` 한 곳으로 옮겼다.
 * 아홉 번째 회차에 같은 구멍이 이 파일과 check-recovery-affordance 에 따로
 * 났기 때문이다 — 한쪽을 고치면 다른 쪽이 옛 방식으로 남았고, 결함은 고치지
 * 않은 쪽으로 왔다. 속성을 읽는 자리가 하나면 구멍도 한 번만 막으면 된다.
 */

/** 값으로 끌어오는 import 의 대상. 타입 자리는 뺀다. */
function valueImportSpecifiers(tree) {
	const out = [];
	const visit = (node) => {
		// `import("x")` 가 **타입 자리**면 ImportTypeNode 다. 값 자리면
		// CallExpression 이다. 파서가 이미 갈라 준다 — 줄 머리를 볼 필요가 없다.
		if (ts.isImportTypeNode(node)) return;
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const spec = node.moduleSpecifier;
			if (!ts.isStringLiteral(spec)) return;
			// 부작용 import(절이 없다)는 값으로 끌어온다.
			if (!clause) {
				out.push(spec.text);
				return;
			}
			if (clause.isTypeOnly) return;
			const named = clause.namedBindings;
			if (
				!clause.name &&
				named &&
				ts.isNamedImports(named) &&
				named.elements.length > 0 &&
				named.elements.every((e) => e.isTypeOnly)
			)
				return;
			out.push(spec.text);
			return;
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			out.push(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return out;
}

function unreachableFiles() {
	const files = [
		...tracked(`${SHELL}/src`, ".tsx"),
		...tracked(`${SHELL}/src`, ".ts"),
	].filter((f) => !/\.test\.|__tests__/.test(f));
	// 주석을 지운다. `// import { X } from "./X"` 한 줄로 고아 파일을
	// 살려 낼 수 있었다.
	const code = new Map(
		files.map((f) => [
			f,
			readFileSync(f, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
				.replace(/(^|[^:])\/\/[^\n]*/g, "$1 "),
		]),
	);

	/** 이 파일이 값으로 끌어오는 파일들. */
	const edges = new Map();
	for (const [file, source] of code) {
		const out = new Set();
		// import 간선은 파서에게 묻는다. 형태를 열거하면 `typeof import()`,
		// `as import()`, 줄 나눈 `type _ =` 처럼 끝없이 하나씩 더 온다.
		// 파서는 타입 자리의 `import()` 를 ImportTypeNode 로 따로 준다.
		for (const spec of valueImportSpecifiers(parseSource(file, source))) {
			if (!spec.startsWith(".")) continue;
			out.add(resolveImport(file, spec, code));
		}
		edges.set(file, [...out].filter(Boolean));
	}

	// 진입점에서 닿는 파일만 살아 있다. 예전에는 "누군가 import 하는가" 를
	// 물었는데, 그러면 **죽은 부모의 자식**이 살아 있는 것으로 셌다 —
	// CodingWorkersApp 이 그랬다. 물어야 할 것은 도달 가능성이다.
	// 진입점. `main`·`App` 말고 앱 등록 파일도 진입점이다 — 슬라이드처럼
	// 패키지로 묶여 런타임에 매니페스트로 올라오는 앱은 정적 import 사슬에
	// 나타나지 않는다. 그것을 못 보면 살아 있는 화면을 죽었다고 말한다.
	// 앱 등록 파일도 뿌리이지만 **아무 것이나** 뿌리로 세면 안 된다.
	// 디렉터리가 남아 있다는 것과 앱이 등록된다는 것은 다른 사실이다 —
	// App.tsx 는 `sample-note app removed` 라고 적고 그 부작용 import 를
	// 뺐는데, 디렉터리 이름만으로 그 화면이 살아났다.
	//
	// 뿌리로 세는 것은 패키지로 묶여 런타임 매니페스트로 올라오는 앱뿐이다.
	// 그 표식은 `package-public/app.json` 이다. 정적으로 등록되는 앱은
	// App.tsx 의 import 사슬에서 저절로 닿는다.
	const roots = files.filter((f) => {
		if (/\/(?:main|App)\.tsx?$/.test(f)) return true;
		const app = /^(.*\/apps\/[^/]+)\/(?:index|standalone)\.tsx?$/.exec(f);
		if (!app) return false;
		// 표식 파일이 **있기만** 하면 뿌리로 세면 안 된다. `existsSync` 는 git
		// 이 모르는 파일도 참이라, 추적되지 않는 app.json 한 줄로 App 이 끊은
		// 앱이 되살아났다. 저장소가 아는 파일이어야 하고, 그것만으로도
		// 부족하다 — 런타임 설치 앱은 `~/.naia/apps` 의 매니페스트로 올라오지
		// 소스 트리의 package-public 으로 올라오지 않는다.
		//
		// 그래서 조건을 둘로 둔다. 저장소가 아는 표식이 있고, **그 앱이
		// 패키지로 배포되도록 빌드에 묶여 있어야** 한다.
		const manifest = `${app[1]}/package-public/app.json`;
		if (!trackedFiles.has(manifest)) return false;
		return packagedApps.has(app[1].split("/").pop());
	});
	const reachable = new Set();
	const stack = [...roots];
	while (stack.length) {
		const file = stack.pop();
		if (!file || reachable.has(file)) continue;
		reachable.add(file);
		for (const next of edges.get(file) ?? []) stack.push(next);
	}
	if (roots.length === 0 || reachable.size < 20) {
		console.error(
			`[dead-ui] 진입점에서 닿는 파일이 ${reachable.size}개뿐이다 — import 해석이 깨졌다`,
		);
		process.exit(2);
	}
	return files.filter((f) => !reachable.has(f));
}

/** 상대 import 를 실제 파일 경로로 맞춘다. */
function resolveImport(from, spec, code) {
	const base = from.split("/").slice(0, -1).join("/");
	const parts = `${base}/${spec}`.split("/");
	const stack = [];
	for (const part of parts) {
		if (part === "." || part === "") continue;
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	const path = stack.join("/").replace(/\.[jt]sx?$/, "");
	for (const candidate of [
		`${path}.tsx`,
		`${path}.ts`,
		`${path}/index.tsx`,
		`${path}/index.ts`,
	]) {
		if (code.has(candidate)) return candidate;
	}
	return null;
}

const unrendered = new Set(unreachableFiles());

/**
 * 표지가 어느 파일에서 정의되는지. 렌더 여부를 표지에 잇기 위해서다.
 *
 * 등록하는 것은 **모든 속성의 정적 문자열 후보 전부**다. 속성 이름을
 * `data-testid` 로 좁히면 합성이 빠져나간다 — `<Ghost id={"ghost-wake-panel"} />`
 * 과 `function Ghost({ id }) { return <div data-testid={id} />; }` 는 화면에
 * 그 표지를 올리는데, 그 이름이 적힌 자리는 `id` 속성뿐이다. 이름이 어느
 * 속성에 적혔든 그것을 적은 **파일**이 무엇인지가 여기서 물을 것이다.
 */
const definedIn = new Map();
/** 클래스 이름 → 그것을 붙이는 파일들. */
const classDefinedIn = new Map();
/** 표지 속성 이름 → (값 → 그 값을 붙이는 파일들). */
const attrValues = new Map();
/** 표지 속성 이름 → 값의 출처를 다 풀지 못한 파일들. */
const attrUnresolved = new Map();
/** 이름을 조립하는 자리의 고정 앞·뒷조각. 파일을 함께 적는다. */
const nameFragments = [];
/** 풀 수 없는 spread 가 있어 속성을 다 읽지 못한 파일. */
const spreadBlindFiles = new Set();

for (const [file, source] of shellSources) {
	const tree = parseSource(file, source);
	for (const element of jsxElementsIn(tree, tree, env)) {
		const { props, unknownSpread } = elementProps(element, tree, env);
		// 못 읽은 속성이 있는 파일은 표시해 둔다. "못 봤다" 를 "없다" 로 읽으면
		// 값을 한 겹 숨기는 것만으로 검사를 통과한다.
		if (unknownSpread) spreadBlindFiles.add(file);
		for (const prop of props) {
			// 값이 다른 파일에서 왔으면 그 파일 트리로 푼다. 이름을 등록하는
			// **파일**은 그대로 이 파일이다 — 화면에 그 표지를 올리는 것은
			// 상수를 적어 둔 파일이 아니라 요소를 렌더하는 이 파일이다.
			const valueTree = prop.sf ?? tree;
			const resolved = prop.bare
				? { values: new Set(), complete: true }
				: stringCandidates(prop.value, valueTree, env);
			for (const value of resolved.values) addTo(definedIn, value, file);
			if (MARKER_ATTR.test(prop.name)) {
				if (!attrValues.has(prop.name)) attrValues.set(prop.name, new Map());
				for (const value of resolved.values)
					addTo(attrValues.get(prop.name), value, file);
				if (!resolved.complete) addTo(attrUnresolved, prop.name, file);
			}
			// 클래스 이름도 화면의 표지다. 실측에서 드러났다 — `.workspace-app` 은
			// 렌더되지 않는 WorkspaceCenterArea.tsx 에만 있고, 스펙 셋이 그것으로
			// 화면을 집는다. data-testid 만 보면 이 부류가 통째로 빠진다.
			// `className="a b"`, `` className={`a ${x}`} ``, spread, createElement 를
			// 모두 같은 목록에서 읽는다.
			if (prop.name === "className") {
				for (const chunk of staticChunks(prop.value, valueTree, env))
					for (const cls of chunk.split(/\s+/).filter(Boolean))
						addTo(classDefinedIn, cls, file);
				continue;
			}
			// 이름을 코드로 조립하는 자리(`` data-testid={`${role}-llm-mode`} ``).
			// 고정 조각을 그 파일과 함께 적어 둔다 — 조각만으로 살아 있다고 하면
			// 그 표지가 어느 화면에 오르는지 이어서 물을 수 없다.
			if (!resolved.complete) {
				const expr = unwrapAll(prop.value);
				if (expr && ts.isTemplateExpression(expr) && expr.templateSpans.length > 0) {
					nameFragments.push({
						head: expr.head.text,
						tail: expr.templateSpans[expr.templateSpans.length - 1].literal.text,
						file,
					});
				}
			}
		}
	}
}


/**
 * 지금 렌더되지 않는 채로 두는 파일. 왜 남겨 두는지 적어야 한다.
 */
// WorkspaceCenterArea.tsx 와 CodingWorkersApp.tsx 는 2026-09-05 에 지웠다.
// 코딩 작업자 패널과 세션 대시보드가 없어졌고(#554), 그 자리는 Herdr 창의
// agents 탭과 IDE 뷰어가 대신한다. 파일이 사라졌으므로 이 목록에 남겨 두면
// "낡았다" 로 붉어진다.
const KNOWN_UNRENDERED = new Map([
	[
		"packages/shell/src/apps/sample-note/SampleNoteCenterArea.tsx",
		"App.tsx 가 `sample-note app removed — will be replaced by a proper memo app later` 라고 적고 등록 import 를 뺐다. 디렉터리는 남아 있지만 화면에 오르지 않는다. helpers/selectors.ts 와 90-app-system 이 이 표지를 집는다. 메모 앱이 새로 오면 그때 정리한다",
	],
	// NaiaMetaArea.tsx 는 2026-09-06 에 지웠다 — 자기 테스트만 import 하던 고아
	// 컴포넌트였고, 그 표지를 기다리던 14-skills-tab 은 설정 안의 스킬 화면으로 재조준했다.
	//
	// ConnectionsSettingsTab.tsx 는 2026-09-12 에 뺐다. ef3dc42c 가 SettingsTab
	// 에서 이 컴포넌트를 값으로 import 해 연결 탭에 렌더한다 — 다시 화면에
	// 오르므로 이 목록에 남기면 "낡았다" 로 붉어지고, 무엇보다 이 패널을
	// 기다리던 스펙들이 이제 통과할 수 있다.
]);

const specs = [
	...tracked(`${SHELL}/e2e-tauri`, ".ts"),
	...tracked(`${SHELL}/e2e`, ".ts"),
];

const missing = [];
const disabledAnchors = [];
const unrenderedAnchors = [];
const usedAllowances = new Set();
/** 클래스 선택자 중 그것을 붙이는 파일을 찾지 못한 것. */
const classWithoutHome = new Set();
let anchors = 0;

for (const file of specs) {
	const source = readFileSync(file, "utf8");
	const names = new Map();
	for (const match of source.matchAll(ANCHORS[0]))
		names.set(match[1], match.index);
	for (const match of source.matchAll(ANCHORS[1]))
		names.set(`data-${match[1]}-tab="${match[2]}"`, match.index);
	for (const match of source.matchAll(ANCHORS[2])) names.set(match[1], match.index);

	// 클래스 선택자는 렌더 검사에만 쓴다. CSS 파일은 훑지 않으므로
	// "소스에 없다" 판정에 넣으면 거짓 지적이 쏟아진다.
	for (const m of source.matchAll(/["'`]\.([a-z][\w-]{3,})["'`\s\]]/g)) {
		const cls = m[1];
		const homes = classDefinedIn.get(cls);
		if (!homes || homes.size === 0) {
			// 집이 비었다. 두 가지가 다르다 — 이 저장소 어디에도 그 클래스를 붙이는
			// 자리가 없는 것(대개 CSS 에만 있는 이름)과, 파서가 그 파일의 속성을 다
			// 읽지 못한 것(풀 수 없는 spread). 뒤엣것은 검사가 눈을 감은 자리이므로
			// 수를 세어 드러낸다. 조용히 건너뛰면 둘이 구별되지 않는다.
			classWithoutHome.add(cls);
			continue;
		}
		if (![...homes].every((f) => unrendered.has(f))) continue;
		unrenderedAnchors.push({
			file,
			name: cls,
			line: source.slice(0, m.index).split("\n").length,
			homes: [...homes],
		});
	}

	for (const [name, at] of names) {
		anchors += 1;
		// 소스에 있어도 영구히 꺼 둔 조작 뒤면 도달할 수 없다.
		const bare = name.replace(/^data-\w+-tab="|"$/g, "");
		// `data-meta-tab="progress"` 처럼 속성과 값을 함께 집는 자리는 **그
		// 속성에** 그 값이 붙는 파일만 집으로 센다. 이름만으로 집을 찾으면
		// 관계없는 속성에 같은 문자열이 있는 파일이 집을 늘려, 고아 화면을
		// 기다리는 스펙이 조용히 살아 있는 것으로 읽힌다.
		const attribute = name.startsWith("data-")
			? (/^(data-[\w-]+)=/.exec(name)?.[1] ?? name)
			: null;
		const wanted = attribute ? /=["']([^"']+)["']$/.exec(name)?.[1] : null;
		// 표지를 정의하는 파일이 전부 렌더되지 않으면 그 표지는 화면에
		// 오르지 않는다. 소스에 있다는 사실만으로는 살아 있다고 못 한다.
		const homes =
			attribute && wanted
				? attrValues.get(attribute)?.get(wanted)
				: definedIn.get(bare);
		if (homes && homes.size > 0 && [...homes].every((f) => unrendered.has(f))) {
			unrenderedAnchors.push({
				file,
				name: bare,
				line: source.slice(0, at).split("\n").length,
				homes: [...homes],
			});
		}
		if (disabledIds.has(name) || disabledIds.has(bare)) {
			disabledAnchors.push({
				file,
				name: bare,
				line: source.slice(0, at).split("\n").length,
			});
		}
		if (ALLOWED_ABSENT.has(name)) {
			usedAllowances.add(name);
			continue;
		}
		// 이 자리가 "없어야 한다" 를 확인하는 단정인가. 그렇다면 소스에
		// 이름이 없는 것이 정상이다.
		// 이 앵커가 든 **그 단정 하나**만 본다. 창을 넓게 잡으면 바로 다음 줄의
		// 관계없는 `.not.` 이 면제를 만들어 준다 — 실제로 그 우회가 실증됐다.
		// 단정은 `expect(...)` 로 시작해 세미콜론이나 줄 끝에서 끝난다.
		const statementStart = source.lastIndexOf("expect", at);
		const statementEnd = source.indexOf(";", at);
		const statement =
			statementStart >= 0 && statementEnd > at
				? source.slice(statementStart, statementEnd)
				: source.slice(at, at + 120);
		if (
			/toHaveCount\(\s*0\s*\)|\.not\.|toBeNull\(\)|toHaveLength\(\s*0\s*\)/.test(
				statement,
			)
		)
			continue;
		if (name.startsWith("data-")) {
			// `data-meta-tab="agents"` 처럼 값까지 집는 것. 값이 코드에서
			// 만들어지는 경우가 있어(`data-meta-tab={tab.id}`) 문자열로는 못
			// 만난다. 그때는 그 값이 무엇이 될 수 있는지를 파서에게 묻는다 —
			// `useState` 가 적어 둔 타입 유니언과 초기값, 세터에 넘기는 리터럴,
			// `xs.map((x) => …x.id…)` 이 도는 배열의 그 속성까지.
			//
			// 예전에는 그 파일의 **아무 `id:`** 나 탭 값으로 쳤다. 그래서 언어
			// 목록의 `{ id: "ko" }` 한 줄이 존재하지도 않는 설정 탭을 살려 냈다.
			// 값의 출처를 풀지 못하면 집이 없는 것이고, 집이 없으면 없는 이름이다.
			if (wanted && attrValues.get(attribute)?.has(wanted)) continue;
			missing.push({ file, name });
			continue;
		}
		// 파서가 속성으로 읽어 낸 이름이면 화면에 있는 것이다. 형태(`"x"`,
		// `{"x"}`, `` {`x`} ``, `{"x" as const}`, spread, `createElement`)는
		// 파서가 이미 같은 값으로 만들어 준다.
		if (definedIn.has(name)) continue;
		// 이름이 코드에서 조립되는 자리(`` data-testid={`${role}-llm-mode`} ``).
		// 파서가 읽은 템플릿의 고정 조각과만 맞춘다. 예전에는 소스 전문에
		// 정규식을 걸었고, 그 증명에는 파일이 없어 고아 화면이 그대로 살아났다.
		const fragmentHomes = [
			...new Set(
				nameFragments
					.filter(
						(f) =>
							(f.head.length > 3 && name.startsWith(f.head)) ||
							(f.tail.length > 3 && name.endsWith(f.tail)),
					)
					.map((f) => f.file),
			),
		];
		if (fragmentHomes.length > 0) {
			// 조각으로 살아난 이름도 도달 가능성을 묻는다.
			if (fragmentHomes.every((f) => unrendered.has(f)))
				unrenderedAnchors.push({
					file,
					name,
					line: source.slice(0, at).split("\n").length,
					homes: fragmentHomes,
				});
			continue;
		}
		missing.push({ file, name });
	}
}

/**
 * 스펙이 부르는 Tauri 명령이 실제로 있는지 본다.
 *
 * 사라진 화면과 같은 성격이다 — 명령이 없어지거나 이름이 바뀌어도 그것을
 * 부르는 스펙은 남고, 그 실패는 "회귀가 생겼다" 로 읽힌다. 실제로 두 스펙이
 * 존재하지 않는 명령을 부르고 있었고, 그중 하나는 e2e 전용으로 만들려다
 * 만 것이 스펙에만 남은 자리다.
 */
const commandNames = rustCommandNames();
const missingCommands = [];
for (const file of specs) {
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(
		/(?:tauriInvoke|invoke)\(\s*["'`]([a-z0-9_]+)["'`]/g,
	)) {
		const name = match[1];
		if (name.startsWith("plugin:") || commandNames.has(name)) continue;
		missingCommands.push({
			file,
			name,
			line: source.slice(0, match.index).split("\n").length,
		});
	}
}

const unrenderedNew = unrenderedAnchors.filter(
	(hit) => !hit.homes.every((f) => KNOWN_UNRENDERED.has(f)),
);
const unrenderedStale = [...KNOWN_UNRENDERED.keys()].filter(
	(f) => !unrendered.has(f),
);
if (unrenderedStale.length) {
	console.error(
		`  ❌ 렌더 안 되는 파일 목록이 낡았다(${unrenderedStale.length}) — 다시 화면에 올랐으니 목록에서 빼라:`,
	);
	for (const f of unrenderedStale) console.error(`     ${f}`);
	process.exit(1);
}
if (unrenderedNew.length) {
	console.error(
		`  ❌ 화면에 오르지 않는 표지를 기다리는 스펙 ${unrenderedNew.length}곳 — 이 스펙은 통과할 수 없다:`,
	);
	for (const hit of unrenderedNew)
		console.error(
			`     ${hit.file}:${hit.line} — ${hit.name} (정의: ${hit.homes.join(", ")})`,
		);
	console.error(
		"     그 파일을 다시 화면에 올리거나 스펙을 접어라. 지금 두는 이유가 있으면 KNOWN_UNRENDERED 에 적어라.",
	);
	process.exit(1);
}
if (unrenderedAnchors.length) {
	console.log(
		`  화면에 오르지 않는 표지를 기다리는 스펙 ${unrenderedAnchors.length}곳 (사유 적어 둠)`,
	);
}

const disabledNew = disabledAnchors.filter(
	(hit) => !KNOWN_DISABLED.has(hit.name),
);
const disabledStale = [...KNOWN_DISABLED.keys()].filter(
	(name) => !disabledAnchors.some((hit) => hit.name === name),
);
if (disabledStale.length) {
	console.error(
		`  ❌ 꺼 둔 조작 목록이 낡았다(${disabledStale.length}) — 이제 열렸거나 스펙이 없어졌으니 목록에서 빼라:`,
	);
	for (const name of disabledStale) console.error(`     ${name}`);
	process.exit(1);
}
if (disabledNew.length) {
	console.error(
		`  ❌ 영구히 꺼 둔 조작을 기다리는 스펙 ${disabledNew.length}곳 — 이 스펙은 통과할 수 없다:`,
	);
	for (const hit of disabledNew)
		console.error(`     ${hit.file}:${hit.line} — ${hit.name}`);
	console.error(
		"     기능을 열거나 스펙을 접어라. 지금 두는 이유가 있으면 KNOWN_DISABLED 에 적어라.",
	);
	process.exit(1);
}
if (disabledAnchors.length) {
	console.log(
		`  꺼 둔 조작을 기다리는 스펙 ${disabledAnchors.length}곳 (사유 적어 둠)`,
	);
}

// 같은 명령을 여러 번 불러도 결함은 하나다. 이름으로 센다.
const unexpectedCommands = missingCommands.filter(
	(hit) => !KNOWN_MISSING_COMMANDS.has(hit.name),
);
const staleKnown = [...KNOWN_MISSING_COMMANDS.keys()].filter(
	(name) => !missingCommands.some((hit) => hit.name === name),
);

if (staleKnown.length > 0) {
	console.error("\n없다고 적어 둔 명령이 이제 걸리지 않는다:");
	for (const name of staleKnown) console.error(`  ${name}`);
	console.error("\nKNOWN_MISSING_COMMANDS 에서 지워라 — 남겨 두면 다음 결함을 덮는다.");
	process.exit(1);
}

if (unexpectedCommands.length > 0) {
	console.error("\n스펙이 부르는데 Rust 에 없는 명령:");
	for (const hit of unexpectedCommands) {
		console.error(`  ${hit.file}:${hit.line} — ${hit.name}`);
	}
	console.error(
		"\n명령이 사라졌으면 그 스펙도 지워라. 이름이 바뀐 것이면 스펙을 따라오게 하라.",
	);
	process.exit(1);
}

console.log(
	`[dead-ui] 스펙이 집는 이름 ${anchors}개 / 셸 소스에 없는 것 ${missing.length}`,
);
// 집이 비어 렌더 검사를 건너뛴 자리를 드러낸다. 클래스 선택자는 CSS 에만
// 있는 이름일 수 있어 "없다" 로 세지 않는데, 그 침묵이 파서가 못 읽어서인지
// 정말 정의가 없어서인지는 구별돼야 한다.
if (classWithoutHome.size > 0 || spreadBlindFiles.size > 0) {
	console.log(
		`  클래스 집을 못 찾은 선택자 ${classWithoutHome.size}개 / 속성을 다 읽지 못한 파일 ${spreadBlindFiles.size}개(풀 수 없는 spread)`,
	);
}
if (attrUnresolved.size > 0) {
	const where = [...attrUnresolved.entries()]
		.map(([attr, files]) => `${attr}(${files.size})`)
		.join(", ");
	console.log(`  값의 출처를 못 푼 표지 속성: ${where}`);
}

// 걸리지도 않는 면제는 알리바이다. 남겨 두면 다음 결함이 그 이름으로 들어와
// 조용히 지나간다 — 실제로 `voice-wake-triggers` 면제가 그러고 있었다.
const staleAllowances = [...ALLOWED_ABSENT.keys()].filter(
	(name) => !usedAllowances.has(name),
);
if (staleAllowances.length > 0) {
	console.error("\n걸리지 않는 면제가 남아 있다:");
	for (const name of staleAllowances) console.error(`  ${name}`);
	console.error("\nALLOWED_ABSENT 에서 지워라 — 남겨 두면 다음 결함을 덮는다.");
	process.exit(1);
}

if (missing.length > 0) {
	console.error("\n스펙이 집는데 셸 소스에 없는 이름:");
	for (const hit of missing) console.error(`  ${hit.file} — ${hit.name}`);
	console.error(
		"\n화면이 사라졌으면 그 스펙도 지워라. 이름이 바뀐 것이면 스펙을 따라오게 하라.",
	);
	console.error(
		"없는 채로 두어야 할 이유가 있으면 ALLOWED_ABSENT 에 그 이유와 함께 적어라.",
	);
	process.exit(1);
}

console.log("  ✓ 사라진 화면을 기다리는 스펙 없음");
