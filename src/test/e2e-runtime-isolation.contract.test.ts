// e2e 가 운영 앱의 데이터 홈을 밟지 않는다.
//
// 왜 이 테스트가 있는가: Rust 는 `CAFE_DEBUG_E2E=1` 일 때만, 그리고
// `NAIA_E2E_RUNTIME_DIR` 이 절대 경로로 있을 때만 로그·리스·PID 를 그 아래에 둔다
// (packages/shell/src-tauri/src/lib.rs 의 log_dir / e2e_runtime_dir / run_dir).
// 전용 설정 둘은 그 변수를 잡는데 **기본 설정만 빠져 있었다**. 그래서 이 설정으로
// 도는 스펙 백여 개가 운영 앱과 같은 `~/.naia/run`·`~/.naia/logs` 를 썼고,
// 앞 스펙이 흘린 에이전트가 리스를 쥔 채 남아 다음 스펙이
// `agent_lease_live_blocked` 로 뇌 없이 돌았다(그렇게 고아가 된 에이전트 30개).
//
// 배선을 지우면 여기가 붉어져야 한다. 그래서 파일을 읽어 문자열을 세지 않고,
// 설정을 실제로 import 해서 그 결과로 남는 환경을 잰다.
import { readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

/** Rust 를 토큰으로 읽는 공용 모듈의 표면. `.mjs` 는 동적으로 가져온다. */
interface RustTokensModule {
	tokenizeRust(source: string): Array<{
		kind: string;
		text: string;
		value?: string;
		line: number;
	}>;
	skipBalanced(
		tokens: Array<{ kind: string; text: string }>,
		at: number,
		open: string,
		close: string,
	): number;
	isKeyword(token: unknown, word: string): boolean;
}

const CONFIGS = {
	"wdio.conf.ts": "일반 설정",
	"codex-e2e-environment.ts": "codex 전용 환경",
	"radio-queue-e2e-environment.ts": "radio-queue 전용 환경",
} as const;

/**
 * 그 소스가 `process.env.NAIA_E2E_RUNTIME_DIR` 에 **실제로 값을 넣는가**.
 *
 * 예전에는 `/process\.env\.NAIA_E2E_RUNTIME_DIR\s*=/` 문자열을 찾았다. 그래서
 * 배선을 지우고 그 줄을 주석으로 남기기만 해도 이 단정이 참이었다 — 전용 설정에서
 * 배선을 빼면서 이유를 주석으로 적는 것이야말로 이 테스트가 막겠다고 적어 둔
 * 사고다. 이제 파서로 대입식을 찾는다. 주석에는 노드가 없으므로 주석은 저절로
 * 거짓이다.
 */
function assignsRuntimeDir(name: string, source: string): boolean {
	const tree = ts.createSourceFile(
		name,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	let found = false;
	const targetsRuntimeDir = (node: ts.Expression): boolean => {
		// `process.env.NAIA_E2E_RUNTIME_DIR`
		if (
			ts.isPropertyAccessExpression(node) &&
			node.name.text === "NAIA_E2E_RUNTIME_DIR"
		)
			return isProcessEnv(node.expression);
		// `process.env["NAIA_E2E_RUNTIME_DIR"]`
		if (
			ts.isElementAccessExpression(node) &&
			node.argumentExpression &&
			ts.isStringLiteralLike(node.argumentExpression) &&
			node.argumentExpression.text === "NAIA_E2E_RUNTIME_DIR"
		)
			return isProcessEnv(node.expression);
		return false;
	};
	const isProcessEnv = (node: ts.Expression): boolean =>
		ts.isPropertyAccessExpression(node) &&
		node.name.text === "env" &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === "process";
	const visit = (node: ts.Node): void => {
		if (
			!found &&
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			targetsRuntimeDir(node.left as ts.Expression)
		)
			found = true;
		if (!found) node.forEachChild(visit);
	};
	visit(tree);
	return found;
}

/** `parent` 안(또는 그 자신)인가. 문자열 접두사 비교는 `/tmp2` 를 `/tmp` 안으로 센다. */
function isInside(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

describe("하네스는 사람의 herdr 세션에 붙지 않는다", () => {
	// 워크스페이스 탭이 사람의 herdr 세션을 그대로 보여 주는 것은 설계다. 그런데
	// 하네스가 그 설계를 그대로 타면, e2e 가 워크스페이스를 열 때마다 사람이 지금
	// 쓰고 있는 세션에 클라이언트가 하나 더 붙어 그 세션을 앱 터미널 크기로
	// 리사이즈한다 — `~/.config/herdr/herdr-server.log` 에 `client resize …
	// cols=80 rows=24` 가 남는 것으로 실측했다(#573 조사).
	//
	// herdr 은 이름 있는 세션마다 디렉터리와 소켓을 따로 둔다. 그래서 하네스일 때만
	// `--session <이름>` 을 얹는다. 여기서는 그 배선이 **한 자리**에 있고 실행 자리
	// (`e2e_runtime_dir`)에만 걸려 있다는 것을 고정한다 — 글자를 세지 않고 토큰으로
	// 함수 본문을 잘라서 본다.
	let rust: RustTokensModule;
	const rustSource = (relativePath: string) =>
		readFileSync(
			fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
			"utf8",
		);

	/** `fn <이름>` 의 본문 토큰. 주석과 문자열은 토크나이저가 이미 갈라 두었다. */
	function functionBody(source: string, fnName: string) {
		const tokens = rust.tokenizeRust(source);
		for (let i = 0; i + 1 < tokens.length; i += 1) {
			if (!rust.isKeyword(tokens[i], "fn")) continue;
			if (tokens[i + 1].text !== fnName) continue;
			for (let j = i + 2; j < tokens.length; j += 1) {
				if (tokens[j].kind !== "punct") continue;
				if (tokens[j].text === ";") return [];
				if (tokens[j].text === "{")
					return tokens.slice(j, rust.skipBalanced(tokens, j, "{", "}"));
			}
		}
		return [];
	}

	beforeAll(async () => {
		rust = (await import(
			fileURLToPath(new URL("../../scripts/lib/rust-tokens.mjs", import.meta.url))
		)) as RustTokensModule;
	});

	it("세션 이름은 실행 자리가 있을 때에만 생긴다", () => {
		// 제품 실행에는 실행 자리가 없으므로 이름도 없고, `--session` 도 붙지 않는다.
		const body = functionBody(
			rustSource("packages/shell/src-tauri/src/herdr/config.rs"),
			"herdr_session_name",
		);
		expect(body.length, "herdr_session_name 이 없다").toBeGreaterThan(0);
		expect(
			body.some((token) => token.text === "e2e_runtime_dir"),
			"실행 자리에 걸려 있지 않으면 제품 실행에서도 세션이 갈린다",
		).toBe(true);
	});

	it("herdr 을 부르는 깔때기가 그 세션을 얹는다", () => {
		const body = functionBody(
			rustSource("packages/shell/src-tauri/src/herdr/config.rs"),
			"herdr_command",
		);
		expect(body.length, "herdr_command 가 없다").toBeGreaterThan(0);
		expect(body.some((token) => token.text === "herdr_session_name")).toBe(true);
		expect(
			body.some((token) => token.kind === "string" && token.value === "--session"),
			"`--session` 은 하위 명령보다 앞에 오는 전역 옵션이다",
		).toBe(true);
	});

	it("하네스 teardown 과 Rust 가 같은 이름을 만든다", async () => {
		// 이름 규칙이 두 자리에 있다 — Rust 가 세션을 만들고, wdio teardown 이 그
		// 세션을 내린다. 어긋나면 실행마다 herdr 서버 하나와 세션 디렉터리 하나가
		// 쌓인다. 같은 예제 하나로 두 끝을 묶는다.
		//
		// 이름 규칙은 부수효과 없는 모듈에 따로 두었다 — wdio 설정을 여기서 import
		// 하면 아래 describe 가 재는 환경을 이 import 가 먼저 정해 버린다.
		const { harnessHerdrSessionName } = (await import(
			fileURLToPath(
				new URL("../../packages/shell/e2e-tauri/herdr-session.mjs", import.meta.url),
			)
		)) as { harnessHerdrSessionName: (runtimeDir: string) => string };
		expect(harnessHerdrSessionName("/tmp/naia-shell-e2e-4448")).toBe("naia-e2e-4448");

		// 전용 환경의 실행 자리는 일반어로 끝난다
		// (`codex-e2e-environment.ts` 의 `resolve(E2E_ROOT, "runtime")`). 마지막 마디만
		// 보면 codex 실행이 전부 `naia-e2e-runtime` 한 이름을 나눠 갖고, 그 세션이
		// 사람 홈 `~/.config/herdr/sessions/` 에 남는다(2026-09-06 실측).
		expect(harnessHerdrSessionName("/tmp/naia-shell-e2e-codex-4455/runtime")).toBe(
			"naia-e2e-codex-4455",
		);
		expect(harnessHerdrSessionName("/tmp/naia-shell-e2e-4448/runtime")).not.toBe(
			"naia-e2e-runtime",
		);
		expect(harnessHerdrSessionName("/tmp/naia-shell-e2e-codex-4455/runtime")).not.toBe(
			harnessHerdrSessionName("/tmp/naia-shell-e2e-codex-4456/runtime"),
		);

		// wdio teardown 이 그 규칙을 실제로 부르는가.
		const conf = readFileSync(
			fileURLToPath(
				new URL("../../packages/shell/e2e-tauri/wdio.conf.ts", import.meta.url),
			),
			"utf8",
		);
		expect(conf).toContain('from "./herdr-session.mjs"');
		expect(conf).toContain("stopHarnessHerdrSession");

		// Rust 쪽 단위 시험이 같은 예제를 고정하고 있는가.
		const literals = rust
			.tokenizeRust(rustSource("packages/shell/src-tauri/src/herdr/config.rs"))
			.filter((token) => token.kind === "string")
			.map((token) => token.value);
		expect(literals).toContain("/tmp/naia-shell-e2e-4448");
		expect(literals).toContain("naia-e2e-4448");
		// codex 예제도 양쪽에 있어야 규칙이 갈라지지 않는다.
		expect(literals).toContain("/tmp/naia-shell-e2e-codex-4455/runtime");
		expect(literals).toContain("naia-e2e-codex-4455");
	});

	it("PTY 로 띄우는 클라이언트도 같은 세션을 쓴다", () => {
		// 깔때기를 지나지 않는 자리는 여기 하나뿐이다(portable-pty 의 CommandBuilder).
		const body = functionBody(
			rustSource("packages/shell/src-tauri/src/herdr/pty.rs"),
			"herdr_pty_create",
		);
		expect(body.length, "herdr_pty_create 가 없다").toBeGreaterThan(0);
		expect(body.some((token) => token.text === "herdr_session_name")).toBe(true);
		expect(
			body.some((token) => token.kind === "string" && token.value === "--session"),
		).toBe(true);
	});
});

describe("앱 프로필도 실행 자리 아래로 간다", () => {
	// e2e 바이너리의 identifier 는 `com.naia.shell.e2e` 라, 리눅스의 XDG 기본값으로는
	// 설정·데이터가 `~/.config/com.naia.shell.e2e/` 에 **사람 홈 아래 고정**이었다.
	// 실행 자리와 무관하므로 WebKit 의 localStorage·IndexedDB 가 스펙 사이는 물론
	// 실행 사이에도 살아남고, 앞 스펙이 남긴 화면 상태가 다음 스펙의 "기본 상태"
	// 단정을 깬다. 하네스 어디에도 스펙 사이 초기화가 없다는 것도 확인했다.
	let xdg: {
		applyHarnessXdg: (
			env?: Record<string, string | undefined>,
			platform?: string,
		) => Record<string, string> | null;
		xdgDirsFor: (runtimeDir: string) => Record<string, string>;
	};

	beforeAll(async () => {
		xdg = (await import(
			fileURLToPath(new URL("../../packages/shell/e2e-tauri/e2e-xdg.mjs", import.meta.url))
		)) as typeof xdg;
	});

	it("실행 자리가 있으면 XDG 셋을 그 아래로 세운다", () => {
		const env: Record<string, string | undefined> = {
			NAIA_E2E_RUNTIME_DIR: "/tmp/naia-shell-e2e-4448",
		};
		const dirs = xdg.applyHarnessXdg(env, "linux");
		expect(dirs).toEqual({
			XDG_CONFIG_HOME: "/tmp/naia-shell-e2e-4448/xdg/config",
			XDG_DATA_HOME: "/tmp/naia-shell-e2e-4448/xdg/data",
			XDG_CACHE_HOME: "/tmp/naia-shell-e2e-4448/xdg/cache",
		});
		expect(env.XDG_CONFIG_HOME).toBe("/tmp/naia-shell-e2e-4448/xdg/config");
	});

	it("실행 자리가 없으면(제품 실행) 아무 XDG 도 건드리지 않는다", () => {
		// 이것이 무너지면 사람이 쓰는 앱의 설정 자리가 옮겨진다. 하네스 밖에서는
		// 한 글자도 바뀌면 안 된다.
		const env: Record<string, string | undefined> = {
			XDG_CONFIG_HOME: "/home/user/.config",
		};
		expect(xdg.applyHarnessXdg(env, "linux")).toBeNull();
		expect(env.XDG_CONFIG_HOME).toBe("/home/user/.config");
		expect(env.XDG_DATA_HOME).toBeUndefined();
		expect(env.XDG_CACHE_HOME).toBeUndefined();
	});

	it("윈도우에서는 XDG 를 쓰지 않는다", () => {
		// WebView2 는 `WEBVIEW2_USER_DATA_FOLDER` 로 자리를 받는다(전용 설정 둘이
		// 그렇게 한다). XDG 는 리눅스 규약이다.
		const env: Record<string, string | undefined> = {
			NAIA_E2E_RUNTIME_DIR: "C:\\tmp\\naia-shell-e2e-4448",
		};
		expect(xdg.applyHarnessXdg(env, "win32")).toBeNull();
		expect(env.XDG_CONFIG_HOME).toBeUndefined();
	});

	it("데이터 홈(`~/.naia`)은 XDG 를 옮겨도 그대로다", () => {
		// `data_home.rs` 는 `$HOME` 에서 홈을 구한다(`dirs::home_dir`). XDG 를 옮기는
		// 것과 무관하다 — 그 경계는 이 변경이 건드리지 않는다.
		const env: Record<string, string | undefined> = {
			HOME: "/home/luke",
			NAIA_E2E_RUNTIME_DIR: "/tmp/naia-shell-e2e-4448",
		};
		const before = resolve(env.HOME as string, ".naia");
		xdg.applyHarnessXdg(env, "linux");
		expect(env.HOME).toBe("/home/luke");
		expect(resolve(env.HOME as string, ".naia")).toBe(before);
		expect(before.startsWith("/tmp/")).toBe(false);
	});

	it("기본 설정이 그 배선을 지니고 있다", async () => {
		const conf = readFileSync(
			fileURLToPath(
				new URL("../../packages/shell/e2e-tauri/wdio.conf.ts", import.meta.url),
			),
			"utf8",
		);
		expect(conf).toContain('from "./e2e-xdg.mjs"');
		expect(conf).toContain("applyHarnessXdg()");
		// 자리는 실행 자리를 비운 **뒤**에 만들어야 한다 — 순서가 뒤집히면 방금 만든
		// 자리를 rmSync 가 지운다.
		expect(conf.indexOf("isolated runtime dir")).toBeLessThan(
			conf.indexOf("isolated app profile"),
		);
	});
});

describe("기본 e2e 설정이 운영 앱의 데이터 홈과 실행 자리를 나눈다", () => {
	let runtimeDir: string | undefined;

	beforeAll(async () => {
		// 밖에서 들어온 값이 있으면 이 설정은 그것을 정본으로 두므로, 잰 것이
		// 설정의 배선인지 알 수 없다. 비우고 import 한다.
		process.env.NAIA_E2E_RUNTIME_DIR = undefined;
		delete process.env.NAIA_E2E_RUNTIME_DIR;
		const conf = fileURLToPath(
			new URL("../../packages/shell/e2e-tauri/wdio.conf.ts", import.meta.url),
		);
		// 짝 저장소가 없는 기계에서는 import 가 뒤쪽에서 실패한다. 그 실패는 이
		// 계약과 무관하고, 격리 배선은 그보다 앞에 있어야 한다 — 배선이 뒤로
		// 밀리면 아래 단정이 그대로 붉어진다.
		await import(conf).catch(() => undefined);
		runtimeDir = process.env.NAIA_E2E_RUNTIME_DIR;
	});

	it("설정을 import 하면 실행 자리가 정해져 있다", () => {
		expect(
			runtimeDir,
			"NAIA_E2E_RUNTIME_DIR 이 없으면 Rust 는 리스·PID·로그를 ~/.naia 아래에 둔다",
		).toBeTruthy();
	});

	it("그 자리가 데이터 홈 아래가 아니다", () => {
		expect(isInside(resolve(homedir(), ".naia"), runtimeDir as string)).toBe(
			false,
		);
		expect(isInside(homedir(), runtimeDir as string)).toBe(false);
	});

	it("그 자리가 저장소 안이 아니다", () => {
		const repo = fileURLToPath(new URL("../..", import.meta.url));
		expect(
			isInside(repo, runtimeDir as string),
			"저장소 안에 두면 `git add` 에 딸려 들어간다",
		).toBe(false);
	});

	it("그 자리가 OS 임시 디렉터리 아래의 절대 경로다", () => {
		// Rust 는 절대 경로가 아니면 그 값을 버리고 데이터 홈으로 되돌아간다
		// (lib.rs e2e_runtime_dir 의 is_absolute 필터).
		expect(resolve(runtimeDir as string)).toBe(runtimeDir);
		expect(isInside(tmpdir(), runtimeDir as string)).toBe(true);
	});

	it("Rust 가 그 값을 읽는 조건도 같이 서 있다", () => {
		// log_dir 은 CAFE_DEBUG_E2E=1 일 때만 실행 자리를 본다.
		expect(process.env.CAFE_DEBUG_E2E).toBe("1");
	});

	it.each(Object.entries(CONFIGS))(
		"%s 가 실행 자리를 잡는 배선을 지니고 있다",
		async (name) => {
			const source = await import("node:fs/promises").then((fs) =>
				fs.readFile(
					fileURLToPath(
						new URL(`../../packages/shell/e2e-tauri/${name}`, import.meta.url),
					),
					"utf8",
				),
			);
			expect(
				assignsRuntimeDir(name, source),
				"주석이 아니라 실제 대입이어야 한다 — 배선을 빼고 이유만 주석으로 남기면 여기가 붉어진다",
			).toBe(true);
		},
	);
});

// ── 어느 설정·환경 모듈도 데이터 홈을 실행 자리로 쓰지 않는다 (#577) ──────────
//
// 앞의 단정들은 **기본 설정 하나**를 import 해서 그 결과를 잰다. 그것으로는 전용
// 설정이 자기 자리를 어디에 두는지 알 수 없었고, 실제로 codex 전용 환경만 2026-09-06
// 까지 `~/.naia/run/codex-live-e2e-<포트>` 를 썼다. 오너 규칙은 데이터 홈에
// `adk-path` 포인터 하나만 두는 것이고(FR-SHELL-ISO · docs/storage-locations.md),
// 그 위반의 대가는 실측으로 드러났다 — 그 자리를 물고 있던 BGM 사이드카 여덟이
// 자리가 지워진 뒤에도 남아 포트를 막았다.
//
// 왜 Rust 게이트로는 안 잡혔는가: `check-data-home-boundary.mjs` 는 Rust 만 읽는다.
// TS 하네스에는 같은 눈이 없었다. 여기가 그 자리다.
//
// 글자를 세지 않는다. 주석의 `~/.naia` 는 설명이고 코드가 아니다 — 위의 배선
// 단정이 주석 때문에 한 번 뚫렸던 것과 같은 함정이다. 그래서 파서로 **문자열
// 리터럴 노드**와 **`homedir()` 호출 노드**만 본다.
describe("어느 e2e 설정·환경 모듈도 데이터 홈을 실행 자리로 쓰지 않는다", () => {
	const HARNESS_DIR = fileURLToPath(
		new URL("../../packages/shell/e2e-tauri", import.meta.url),
	);

	/**
	 * 홈 바로 아래에 두어도 되는 자리와 그 이유.
	 *
	 * 숫자가 아니라 **마디 이름**으로 적는다. 개수로 적으면 같은 파일에 하나가
	 * 더 늘 때만 붉어지고, 이름이 `.naia` 로 바뀌는 것은 못 잡는다.
	 */
	const ALLOWED_HOME_CHILDREN = new Map<string, string>([
		[
			".cargo",
			"tauri-driver 는 cargo 가 설치한다 — 우리가 무엇을 쓰는 자리가 아니라 남이 둔 것을 읽는 자리다",
		],
	]);

	/** `.naia` 가 경로 **마디**로 들어 있는가. `com.naia.shell` 은 마디가 아니다. */
	const DATA_HOME_SEGMENT = /(^|[/\\])\.naia($|[/\\])/;

	function parse(name: string, source: string): ts.SourceFile {
		return ts.createSourceFile(
			name,
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
	}

	/** 괄호·`as` 껍데기를 벗긴다. 껍데기 하나로 판정이 비껴가면 안 된다. */
	function unwrap(node: ts.Expression): ts.Expression {
		let cur: ts.Expression = node;
		while (
			ts.isParenthesizedExpression(cur) ||
			ts.isAsExpression(cur) ||
			ts.isNonNullExpression(cur)
		)
			cur = cur.expression;
		return cur;
	}

	/**
	 * 이 식이 언제나 되는 문자열. 이어붙이기(`"." + "naia"`)까지 접는다 —
	 * 리터럴 하나만 보면 조각으로 나눠 적는 것만으로 비껴간다.
	 */
	function staticText(node: ts.Expression): string | undefined {
		const n = unwrap(node);
		if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
			return n.text;
		if (
			ts.isBinaryExpression(n) &&
			n.operatorToken.kind === ts.SyntaxKind.PlusToken
		) {
			const left = staticText(n.left);
			const right = staticText(n.right);
			return left !== undefined && right !== undefined ? left + right : undefined;
		}
		// 템플릿은 앞머리까지만 확정이다. 첫 마디를 읽는 데는 그것으로 충분하다.
		if (ts.isTemplateExpression(n)) return n.head.text;
		return undefined;
	}

	/** 이 호출이 `homedir()` 인가. `os.homedir()` 도 같다. */
	function isHomedirCall(node: ts.Node): boolean {
		if (!ts.isCallExpression(node)) return false;
		const callee = unwrap(node.expression);
		if (ts.isIdentifier(callee)) return callee.text === "homedir";
		return (
			ts.isPropertyAccessExpression(callee) && callee.name.text === "homedir"
		);
	}

	/** 이 호출이 경로를 잇는 자리인가 (`resolve`/`join`). */
	function isPathJoin(node: ts.CallExpression): boolean {
		const callee = unwrap(node.expression);
		if (ts.isIdentifier(callee)) return /^(?:resolve|join)$/.test(callee.text);
		return (
			ts.isPropertyAccessExpression(callee) &&
			/^(?:resolve|join)$/.test(callee.name.text)
		);
	}

	interface Findings {
		/** `.naia` 마디를 담은 정적 문자열. */
		dataHomeStrings: string[];
		/** 홈 아래 첫 마디로 쓰인 이름. 정적으로 못 읽으면 `undefined` 가 들어온다. */
		homeChildren: Array<string | undefined>;
		/** `resolve`/`join` 밖에서 부른 `homedir()`. 그 결과를 우리가 못 따라간다. */
		looseHomedirCalls: number;
	}

	function inspect(name: string, source: string): Findings {
		const tree = parse(name, source);
		const findings: Findings = {
			dataHomeStrings: [],
			homeChildren: [],
			looseHomedirCalls: 0,
		};
		const noteString = (text: string): void => {
			if (DATA_HOME_SEGMENT.test(text)) findings.dataHomeStrings.push(text);
		};
		const visit = (node: ts.Node): void => {
			if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
				noteString(node.text);
			if (ts.isTemplateExpression(node)) {
				noteString(node.head.text);
				for (const span of node.templateSpans) noteString(span.literal.text);
			}
			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.PlusToken
			) {
				const folded = staticText(node);
				if (folded !== undefined) noteString(folded);
			}
			if (ts.isCallExpression(node) && isPathJoin(node)) {
				node.arguments.forEach((argument, index) => {
					if (!isHomedirCall(unwrap(argument as ts.Expression))) return;
					const next = node.arguments[index + 1] as ts.Expression | undefined;
					// 홈만 넘기고 끝나는 호출은 자리를 만들지 않는다.
					if (!next) return;
					const text = staticText(next);
					findings.homeChildren.push(
						text === undefined ? undefined : text.split(/[/\\]/)[0],
					);
				});
			}
			if (isHomedirCall(node)) {
				const parent = node.parent;
				const inJoin =
					parent &&
					ts.isCallExpression(parent) &&
					isPathJoin(parent) &&
					parent.arguments.some((argument) => argument === node);
				if (!inJoin) findings.looseHomedirCalls += 1;
			}
			node.forEachChild(visit);
		};
		visit(tree);
		return findings;
	}

	/** 이 디렉터리의 설정·환경 모듈 전부. 새로 들어오는 전용 환경도 저절로 걸린다. */
	const modules = readdirSync(HARNESS_DIR)
		.filter((name) => /\.(?:ts|mjs)$/.test(name) && !name.endsWith(".d.ts"))
		.sort();

	it("검사 대상이 비어 있지 않다", () => {
		// 목록이 비면 아래 단정이 전부 공짜로 통과한다.
		expect(modules.length).toBeGreaterThan(10);
		expect(modules).toContain("wdio.conf.ts");
		expect(modules).toContain("codex-e2e-environment.ts");
		expect(modules).toContain("radio-queue-e2e-environment.ts");
	});

	it.each(modules)("%s 가 `.naia` 를 경로로 조립하지 않는다", (name) => {
		const findings = inspect(
			name,
			readFileSync(resolve(HARNESS_DIR, name), "utf8"),
		);
		expect(
			findings.dataHomeStrings,
			"데이터 홈에는 adk-path 포인터 하나만 둔다 — 실행 자리는 OS 임시 디렉터리 아래다",
		).toEqual([]);
	});

	it.each(modules)("%s 가 홈 아래에 새 자리를 만들지 않는다", (name) => {
		const findings = inspect(
			name,
			readFileSync(resolve(HARNESS_DIR, name), "utf8"),
		);
		for (const child of findings.homeChildren) {
			expect(
				child,
				"홈 아래 첫 마디를 정적으로 읽을 수 없다 — 읽을 수 없으면 규칙을 지키는지도 말할 수 없다",
			).toBeDefined();
			expect(
				ALLOWED_HOME_CHILDREN.has(child as string),
				`홈 아래 \`${child}\` 는 허용 목록에 없다. 정말 필요하면 이유와 함께 적어라`,
			).toBe(true);
		}
		expect(
			findings.looseHomedirCalls,
			"`resolve`/`join` 밖에서 부른 homedir() 는 어디로 가는지 여기서 따라갈 수 없다",
		).toBe(0);
	});

	it("허용 목록에 `.naia` 를 넣어 두는 길이 막혀 있다", () => {
		// 목록 자체가 우회로가 되면 안 된다.
		for (const child of ALLOWED_HOME_CHILDREN.keys()) {
			expect(DATA_HOME_SEGMENT.test(`/${child}/`)).toBe(false);
			expect(ALLOWED_HOME_CHILDREN.get(child)?.length ?? 0).toBeGreaterThan(10);
		}
	});

	it("탐지기가 실제로 `~/.naia` 형태를 잡는다", () => {
		// 반증. 이 단정이 없으면 위의 초록이 "규칙을 지킨다" 가 아니라 "아무것도
		// 안 본다" 일 수 있다.
		const planted = inspect(
			"planted.ts",
			[
				`import { homedir } from "node:os";`,
				`import { resolve } from "node:path";`,
				`export const RUN = resolve(homedir(), ".naia", "run");`,
			].join("\n"),
		);
		expect(planted.dataHomeStrings.length).toBeGreaterThan(0);
		expect(planted.homeChildren).toEqual([".naia"]);

		// 조각으로 나눠 적어도 같다.
		const assembled = inspect(
			"assembled.ts",
			[
				`import { homedir } from "node:os";`,
				`import { join } from "node:path";`,
				`export const RUN = join(homedir(), "." + "naia", "run");`,
			].join("\n"),
		);
		expect(assembled.homeChildren).toEqual([".naia"]);

		// 템플릿으로 감싸도 앞머리에서 잡힌다.
		const templated = inspect(
			"templated.ts",
			[
				`import { homedir } from "node:os";`,
				`import { resolve } from "node:path";`,
				"export const RUN = resolve(homedir(), `.naia/run/${port}`);",
			].join("\n"),
		);
		expect(templated.dataHomeStrings.length).toBeGreaterThan(0);
		expect(templated.homeChildren).toEqual([".naia"]);

		// 값을 못 읽는 자리도 통과가 아니다.
		const opaque = inspect(
			"opaque.ts",
			[
				`import { homedir } from "node:os";`,
				`import { resolve } from "node:path";`,
				`export const RUN = resolve(homedir(), whereverThisPointsTo);`,
			].join("\n"),
		);
		expect(opaque.homeChildren).toEqual([undefined]);
	});

	it("주석에 적힌 `~/.naia` 는 위반이 아니다", () => {
		// 이 사고의 반대편. 왜 그 자리를 옮겼는지 적어 두는 것까지 막으면, 다음
		// 사람은 이유를 모른 채 되돌린다.
		const commented = inspect(
			"commented.ts",
			["// 예전에는 `~/.naia/run` 이었다 (#577).", `export const RUN = "/tmp/x";`].join(
				"\n",
			),
		);
		expect(commented.dataHomeStrings).toEqual([]);
	});
});

// ── 전용 환경이 실제로 내놓는 자리 (#577) ────────────────────────────────────
//
// 위의 파서는 소스를 본다. 여기서는 모듈을 **실제로 import 해서** 그것이 내놓는
// 경로를 잰다. 둘 다 필요하다 — 소스 검사는 값이 환경 변수로 들어오는 경우를
// 모르고, 값 검사는 그 값을 만드는 형태가 바뀌는 것을 모른다.
describe("전용 e2e 환경의 실행 자리도 임시 디렉터리 아래다", () => {
	const ROOTS: Array<[string, string[]]> = [
		["codex-e2e-environment.ts", ["E2E_ROOT", "E2E_RUNTIME"]],
		["radio-queue-e2e-environment.ts", ["root", "runtime"]],
	];

	const importEnvironment = async (name: string, url: string) => {
		const previousVitePort = process.env.NAIA_E2E_VITE_PORT;
		if (name === "radio-queue-e2e-environment.ts") {
			// The radio binary is compiled against Vite 1422.  The surrounding
			// WDIO config may leave a synthetic port in the process environment;
			// isolate that caller state while importing the fixed-port fixture.
			process.env.NAIA_E2E_VITE_PORT = "1422";
		}
		try {
			return (await import(url)) as Record<string, unknown>;
		} finally {
			if (previousVitePort === undefined) {
				delete process.env.NAIA_E2E_VITE_PORT;
			} else {
				process.env.NAIA_E2E_VITE_PORT = previousVitePort;
			}
		}
	};

	for (const [name, exported] of ROOTS) {
		it(`${name} 의 자리가 데이터 홈 밖의 임시 디렉터리다`, async () => {
			const url = fileURLToPath(
				new URL(`../../packages/shell/e2e-tauri/${name}`, import.meta.url),
			);
			const loaded = await importEnvironment(name, url);
			for (const key of exported) {
				const value = loaded[key];
				expect(typeof value, `${name} 이 ${key} 를 내놓지 않는다`).toBe("string");
				const path = value as string;
				expect(resolve(path), `${key} 가 절대 경로가 아니다`).toBe(path);
				expect(
					isInside(resolve(homedir(), ".naia"), path),
					`${key} 가 데이터 홈 아래다 — 그 규칙은 adk-path 하나만 허용한다`,
				).toBe(false);
				expect(isInside(homedir(), path), `${key} 가 홈 아래다`).toBe(false);
				expect(
					isInside(tmpdir(), path),
					`${key} 가 OS 임시 디렉터리 아래가 아니다`,
				).toBe(true);
			}
			// 실행 자리는 그 뿌리 안에 있어야 한다. 밖에 있으면 뿌리를 지워도
			// 리스와 PID 파일이 남는다.
			expect(isInside(loaded[exported[0]] as string, loaded[exported[1]] as string)).toBe(
				true,
			);
		});
	}

	it("두 전용 환경의 자리가 기본 설정의 자리와 이름으로 갈린다", async () => {
		// 기본 설정은 `<tmpdir>/naia-shell-e2e-<포트>` 를 통째로 지운다. 이름이
		// 겹치면 그것이 살아 있는 전용 실행의 자리를 지운다 — 윈도우의 기본 포트는
		// `4450 + (pid % 37)` 라 codex 의 기본값 4450 과 겹칠 수 있다.
		const codex = (await import(
			fileURLToPath(
				new URL(
					"../../packages/shell/e2e-tauri/codex-e2e-environment.ts",
					import.meta.url,
				),
			)
		)) as Record<string, unknown>;
		const name = codex.E2E_ROOT_NAME as string;
		expect(name).toMatch(/^naia-shell-e2e-codex-\d+$/);
		expect(/^naia-shell-e2e-\d+$/.test(name)).toBe(false);
	});
});
