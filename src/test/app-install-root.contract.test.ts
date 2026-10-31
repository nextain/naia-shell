// 앱 설치·목록·삭제가 **같은 자리 함수**를 쓰는지 고정한다.
//
// 왜 이 파일이 있는가: 설치는 성공했다고 말하는데 앱이 목록에도 앱바 탭에도
// 나타나지 않던 회귀가 있었다(#472). 뿌리는 자리가 둘이었다는 것 —
// 설치는 `~/.naia/panels` 로 가고 목록은 `~/.naia/apps` 를 읽었다. 사용자는
// "설치됨" 을 보고 앱을 찾지 못했고, 그것이 앱스토어 출시(#471 #473 #506)의
// 앞을 막았다.
//
// 지금은 `prepare_apps_root_with_legacy_home` 하나가 정본 자리를 정하고 옛
// `panels` 자리를 옮긴다. (선택한 ADK 에 앱을 두게 바꾸면서(49004927) 기기 단위
// 이주 출처를 따로 받는 이 함수가 정본이 되었고, `prepare_apps_root` 와 각 갈래의
// `*_with_legacy_home` 은 그리로 위임한다.) 그런데 함수가 있다는 것만으로는 부족하다 — 새 경로(스토어 설치)가
// 그 함수를 건너뛰고 자리를 직접 짚으면 같은 갈라짐이 그대로 되살아난다.
// 실제로 `app_install_store` 가 `data_home::direct_child_of` 를 직접 부르고
// 있었다. 그래서 여기서 재는 것은 "이주 코드가 있는가" 가 아니라 **모든 길이
// 그 한 함수를 지나는가** 다.
//
// 판정은 정규식이 아니라 Rust 토크나이저가 한다. 주석과 문자열은 코드가
// 아니므로, 주석에 함수 이름을 적어 두는 것으로는 이 계약을 만족시킬 수 없다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const APP_RS = resolve(
	ROOT,
	"packages",
	"shell",
	"src-tauri",
	"src",
	"app.rs",
);
const TOKENS_URL = pathToFileURL(
	resolve(ROOT, "scripts", "lib", "rust-tokens.mjs"),
).href;

/** 토크나이저 표면. `.mjs` 정적 import 는 루트 tsc 프로그램을 오염시킨다. */
interface RustTokens {
	tokenizeRust(source: string): { kind: string; text: string; line: number }[];
	skipBalanced(
		tokens: { kind: string; text: string }[],
		at: number,
		open: string,
		close: string,
	): number;
}

const load = async (): Promise<RustTokens> =>
	(await import(TOKENS_URL)) as unknown as RustTokens;

type Token = { kind: string; text: string; line: number };

/** 이 파일의 코드 토큰. 주석과 문자열은 코드가 아니므로 걸러 낸다. */
async function codeTokens(): Promise<Token[]> {
	const { tokenizeRust } = await load();
	return tokenizeRust(readFileSync(APP_RS, "utf8")).filter(
		(token) => token.kind !== "string" && token.kind !== "comment",
	);
}

/** `fn <이름>` 의 몸통 토큰. 없으면 null. */
async function bodyOf(name: string): Promise<Token[] | null> {
	const { skipBalanced } = await load();
	const tokens = await codeTokens();
	for (let i = 0; i < tokens.length - 1; i += 1) {
		if (tokens[i].text !== "fn" || tokens[i + 1].text !== name) continue;
		let open = i + 2;
		while (open < tokens.length && tokens[open].text !== "{") open += 1;
		if (open >= tokens.length) return null;
		return tokens.slice(open, skipBalanced(tokens, open, "{", "}"));
	}
	return null;
}

function calls(body: Token[] | null, name: string): boolean {
	return (body ?? []).some((token) => token.text === name);
}

/** 이 파일에 정의된 함수 이름 전부. */
async function definedFns(): Promise<Set<string>> {
	const tokens = await codeTokens();
	const names = new Set<string>();
	for (let i = 0; i < tokens.length - 1; i += 1) {
		if (tokens[i].text === "fn") names.add(tokens[i + 1].text);
	}
	return names;
}

/**
 * `name` 의 몸통이 `target` 을 부르거나, 이 파일 안의 다른 함수를 **호출**해(`이름(`)
 * 그 함수가 `target` 에 닿는가. 갈래가 `*_with_legacy_home` 같은 얇은 위임 함수를 거쳐도
 * 정본 자리 함수를 지나는지는 그대로 잰다 — 위임 사슬 어디에도 정본이 없으면 붉다.
 */
async function reaches(
	name: string,
	target: string,
	depth = 4,
	seen: Set<string> = new Set(),
): Promise<boolean> {
	if (seen.has(name)) return false;
	seen.add(name);
	const body = await bodyOf(name);
	if (body === null) return false;
	if (calls(body, target)) return true;
	if (depth <= 0) return false;
	const fns = await definedFns();
	for (let i = 0; i < body.length - 1; i += 1) {
		const callee = body[i].text;
		if (body[i + 1].text !== "(" || !fns.has(callee)) continue;
		if (await reaches(callee, target, depth - 1, seen)) return true;
	}
	return false;
}

/** 정본 자리 함수. 자리를 정하고 옛 자리를 옮기는 몸통이 실제로 여기 있다. */
const CANONICAL = "prepare_apps_root_with_legacy_home";

/**
 * 시험 모듈(`#[cfg(test)] mod … { … }`) 밖에서 그 이름이 코드로 나오는 횟수.
 *
 * 줄 번호로 자르지 않는다 — 이 파일에는 `#[cfg(test)]` 가 여럿이고, 첫 번째가
 * 정작 재려는 helper 들보다 위에 있다. 중괄호를 세어 모듈 구간을 통째로 뺀다.
 */
async function outsideTestModules(name: string): Promise<number> {
	const { skipBalanced } = await load();
	const tokens = await codeTokens();
	const skip: Array<[number, number]> = [];
	for (let i = 0; i + 3 < tokens.length; i += 1) {
		if (tokens[i].text !== "#") continue;
		if (tokens[i + 1].text !== "[" || tokens[i + 2].text !== "cfg") continue;
		let j = i + 3;
		while (j < tokens.length && tokens[j].text !== "]") j += 1;
		// `#[cfg(test)]` 뒤에 곧바로 오는 `mod <이름> {` 만 뺀다.
		if (tokens[j + 1]?.text !== "mod") continue;
		let open = j + 2;
		while (open < tokens.length && tokens[open].text !== "{") open += 1;
		if (open >= tokens.length) continue;
		skip.push([open, skipBalanced(tokens, open, "{", "}")]);
	}
	let count = 0;
	for (let i = 0; i < tokens.length; i += 1) {
		if (tokens[i].text !== name) continue;
		if (skip.some(([from, to]) => i >= from && i < to)) continue;
		count += 1;
	}
	return count;
}

/**
 * 앱 자리를 짚는 네 갈래. 하나라도 빠지면 그 갈래가 다른 자리를 쓸 수 있다.
 * 이름이 바뀌면 이 계약이 붉어지고, 그때 사람이 그 갈래를 다시 확인한다.
 */
const PATHS = [
	"list_installed_from",
	"remove_installed_from",
	"app_install",
	"app_install_store",
];

describe("앱 설치·목록·삭제의 자리", () => {
	it("네 갈래가 모두 같은 자리 함수를 지난다", async () => {
		for (const name of PATHS) {
			const body = await bodyOf(name);
			expect(body, `${name} 을 app.rs 에서 찾지 못했다`).not.toBeNull();
			expect(
				await reaches(name, CANONICAL),
				`${name} 이 ${CANONICAL} 를 지나지 않는다 — 자리가 갈라질 수 있다(#472)`,
			).toBe(true);
		}
		// 옛 이름의 입구도 정본으로 위임해야 한다. 입구가 따로 자리를 정하면 같은 갈라짐이다.
		expect(await reaches("prepare_apps_root", CANONICAL)).toBe(true);
	});

	it("자리를 직접 짚는 곳은 그 자리를 정하는 두 함수뿐이다", async () => {
		const helperBodies = [
			await bodyOf("apps_root"),
			await bodyOf("legacy_apps_root"),
		];
		const inHelpers = helperBodies
			.flatMap((body) => body ?? [])
			.filter((token) => token.text === "direct_child_of").length;

		// 두 helper 밖에서 자리를 직접 지으면 이주도 탈출 검사도 건너뛴다.
		// `app_install_store` 가 정확히 그렇게 서 있었다.
		expect(inHelpers).toBe(2);
		// 시험 모듈은 자리를 직접 지어 검사하는 것이 정상이므로 뺀다. 이 파일에는
		// `#[cfg(test)]` 가 여럿이라 "첫 번째 아래" 같은 줄 자르기로는 안 된다 —
		// 실제로 그렇게 셌다가 두 helper 마저 잘려 나갔다.
		expect(await outsideTestModules("direct_child_of")).toBe(inHelpers);
	});

	it("정본 자리 함수는 옛 자리를 실제로 옮긴다", async () => {
		const body = await bodyOf(CANONICAL);
		expect(body).not.toBeNull();

		// 이 함수가 이름만 남고 이주를 잃으면, 옛 `panels` 자리에 설치된 앱이
		// 영영 목록에 오르지 않는다 — 고쳤다고 적어 둔 그 회귀 그대로다.
		expect(calls(body, "legacy_apps_root")).toBe(true);
		expect(calls(body, "apps_root")).toBe(true);
	});
});
