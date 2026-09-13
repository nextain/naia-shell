/**
 * 되돌릴 수 없는 동작 앞에 확인이 있는지 본다.
 *
 * 왜 필요한가: 사용성 축은 "쓸 수 있는가" 만 재고 있었다. 그런데 사용성에서
 * 가장 비싼 실패는 못 쓰는 것이 아니라 **되돌릴 수 없게 잃는 것**이다.
 *
 * 이 게이트의 첫 판은 스스로가 그 부류의 실패였다. 명령 목록을 손으로 적었는데
 * 그중 셋이 Rust 내부 함수 이름이라 프런트가 부르는 이름과 달랐고, 결과적으로
 * 열두 개 명령 중 하나만 보면서 "4종 통과" 라고 초록을 냈다. 그 눈먼 자리에
 * 실제 결함이 살아 있었다 — STT 모델 파일 삭제와 기억 항목 삭제가 확인 없이
 * 돌고 있었다.
 *
 * 그래서 두 가지를 바꿨다.
 *
 *   1) 목록을 손으로 적지 않는다. Rust 의 `#[tauri::command]` 선언에서
 *      직접 뽑는다. 명령이 늘면 게이트도 같이 는다.
 *   2) 못 찾으면 통과시키지 않는다. 첫 판은 호출부를 찾지 못하면 방어된
 *      것으로 보았는데, React 컴포넌트는 `Component(` 꼴로 불리지 않으므로
 *      컴포넌트 안의 파괴적 호출이 전부 그 구멍으로 빠져나갔다. 지금은
 *      확인을 확인하지 못하면 무방비로 센다.
 *
 * 무엇을 재지 않는가: 확인 문구가 좋은지, 되돌리기가 실제로 동작하는지는
 * 정적으로 알 수 없다. 이 게이트는 "물어보기라도 하는가" 까지만 말한다.
 *
 * ## 호출부를 어떻게 찾는가 (10회차 지적 7 이후)
 *
 * 예전에는 `invoke\s*\(` 라는 **이름**을 찾았다. 그래서
 * `import { invoke as tauriInvoke }` 한 줄이면 확인 없는 기억 삭제가 호출부로도
 * 안 잡혔다 — 게이트가 "확인이 있다" 고 말한 것이 아니라 호출 자체를 못 본
 * 것이라, 결함이 초록 안에 숨었다.
 *
 * 이제 TypeScript 파서로 **바인딩**을 따라간다. `@tauri-apps/api/core` 에서
 * 들어온 `invoke` 가 이 파일에서 어떤 이름(별명·네임스페이스 포함)으로
 * 불리는지 읽고, 그 바인딩을 부르는 `CallExpression` 만 호출부로 센다. 첫 인자를
 * 그대로 넘기는 얇은 감싸기 함수도 한 단계 고정점으로 따라간다 — 파일을
 * 건너뛰어 `export` 된 것도 같다. 이름을 바꾸는 것으로는 빠져나갈 수 없다.
 *
 * ## 규칙을 알림 게이트와 합친 것 (12회차 지적 5 이후)
 *
 * 열한 번째까지 이 파일은 자기만의 바인딩 해석기를 들고 있었다. 그래서
 * `(0, invoke)("memory_delete_fact")` — 가져온 함수를 `this` 없이 부르는 흔한
 * 호출 — 가 여기서는 호출부가 아니었고, 같은 쉼표를 알림에 쓰면 복구 게이트도
 * 그것을 못 봤다. 두 게이트가 같은 구멍을 각자 들고 있었다.
 *
 * 이제 껍데기를 벗기는 것과 바인딩을 푸는 것은 `scripts/lib/bindings.mjs`
 * 하나가 한다. 괄호·`as`·`!`·쉼표식, import 별명, 같은 파일 const 별명,
 * 구조분해, `.bind`/`.call`/`.apply` 가 두 게이트에서 같은 규칙으로 읽힌다.
 * 이 파일에 남은 것은 이 게이트만의 보탬 하나뿐이다 — 첫 인자를 그대로 넘기는
 * **감싸기 함수**를 고정점으로 키우는 일이다(`wrapperOffset`). 별명·구조분해·
 * 네임스페이스·동적 import·모듈 이름 대조는 전부 공용 모듈이 한다. 예전에는
 * 그 해석이 이 파일에도 한 벌 있었고, 형제 모듈에서 고친 것이 옮겨 오지 않아
 * 같은 결함이 두 번 났다(17회차 지적 5·6).
 *
 * ## 이 게이트가 따라가지 않는 것 (보증 밖)
 *
 * `bindings.mjs` 의 보증 밖 목록을 그대로 물려받는다 — 동적 속성 이름
 * (`api[name]("cmd")`), `eval`/`new Function`/`Reflect.apply`/`Function.prototype`
 * 을 두 겹 이상 거친 호출, 고차 함수가 돌려준 함수, 배열·객체·`Map` 을 거쳐
 * 흘러간 함수, 실행할 때 조립되는 문자열. 명령 **이름**이 실행할 때 조립되는
 * 자리는 이 게이트가 따로 "조립 호출" 로 세어 사람이 사유를 적게 한다.
 * 이 경계 안쪽 형태는 모두 같은 규칙으로 잡히고, 경계 밖은 코드 리뷰의 몫이다.
 *
 * ## 이 저장소의 린트 경계가 금지하는 형태
 *
 * 아래는 게이트가 읽지 않기로 **선언**한 형태이고, 저장소에 들어오지 못한다 —
 * `scripts/check-lint-boundary.mjs` 가 막는다. 목록의 정본은
 * `scripts/lib/lint-boundary-forms.mjs` 하나이고, 이 머리말·린트 게이트·
 * `docs/quality-reviews/obfuscation-forms.md` 가 같은 목록을 본다. 셋이
 * 어긋나면 `src/test/lint-boundary.contract.test.ts` 가 붉어진다.
 *
 *   - `comma-operator` — 쉼표식 `(a, b)` · `(0, f)()`
 *   - `void-literal` — 리터럴에 씌운 `void` (`void 0`, `void "x"`)
 *   - `void-stacked` — 겹쳐 쌓은 `void` (`void void …`)
 *   - `computed-callee` — 리터럴 키로 곧바로 부르기 (`f["call"](…)`, `el["click"]()`)
 *
 * 이 모듈은 위 형태를 지금도 읽는다(이미 닫힌 자리다). 다만 **읽는 것에
 * 기대지 않는다** — 경계는 린트가 지고, 게이트는 자기가 읽는 범위를 지킨다.
 * 그래서 다음 회차의 도전은 린트를 통과하는 형태여야 한다.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { crateSourceRoots } from "./lib/crate-roots.mjs";
import {
	importBindings,
	isModuleOfPackage,
	resolveCallee,
	unwrap,
} from "./lib/bindings.mjs";
import { tauriCommandDeclarations } from "./lib/rust-tokens.mjs";

const SHELL = "packages/shell";

/**
 * 이름에 이것이 들어가면 파괴 후보로 본다.
 *
 * 낱말 목록은 그 자체가 수기 목록이다. `discard`/`unlink`/`truncate` 처럼
 * 흔한 이름이 빠져 있어서, `app_sandbox_discard_everything`(앱 구역 전체를
 * `remove_dir_all` 로 지운다)이 후보로도 잡히지 않았다. 목록을 넓히되,
 * 목록에 기대지 않는 판정을 아래 `destroysInBody` 로 함께 둔다.
 */
const DESTRUCTIVE_NAME =
	/(^|_)(delete|remove|clear|reset|wipe|purge|revoke|uninstall|erase|forget|destroy|drop|prune|kill|overwrite|restore|discard|unlink|truncate|factory|nuke)(_|$)/;

/**
 * 이름이 무엇이든, **하는 일**이 파괴면 파괴다.
 *
 * 이름 목록은 늘 다음 이름에 진다. 명령 본문이 파일이나 디렉터리를 실제로
 * 없애는지 보고, 그러면 이름과 무관하게 후보로 센다.
 */
const DESTRUCTIVE_BODY = /remove_dir_all|remove_file|std::fs::remove/;

/**
 * 파괴 후보처럼 보이지만 되돌릴 수 있어 묻지 않는 것. 면제하려면 **왜 되돌릴
 * 수 있는지** 여기 적어야 한다. 이유 없는 면제는 baseline 과 같은 알리바이다.
 */
const REVERSIBLE = new Map([
	["clear_naia_path_cache", { why: "캐시다. 다음 조회에서 다시 채워진다" }],
	["reset_window_state", { why: "창 크기·위치다. 사용자가 다시 옮기면 된다" }],
	[
		"pty_kill",
		{
			why: "터미널 탭을 닫을 때 부른다. 닫기를 누르는 것 자체가 의사표시이고, 터미널은 다시 열 수 있다. 매번 물으면 사용자는 읽지 않고 누른다. 다만 실행 중인 명령이 끊기는 것은 알리지 않는다 — 그 자리는 열려 있다",
			// 이유가 "탭을 닫을 때" 이므로, 닫기 흐름 밖에서 부르면 그 이유가
			// 성립하지 않는다.
			callers: /close|dispose|cleanup|unmount|kill|exit|terminate/i,
		},
	],
	[
		"delete_naia_settings",
		{
			why: "설정 파일 하나를 지우면 기본값으로 돌아간다. 부르는 곳도 초기화 흐름 안이다",
			callers: /reset|clear|initial|bootstrap|onboard|factory/i,
		},
	],
]);

/**
 * 면제의 이유가 호출부를 말하면, 그 호출부에서만 면제한다.
 *
 * 예전에는 `REVERSIBLE` 에 이름이 있으면 그 명령은 어디서 불려도 후보에서
 * 통째로 빠졌다. 그래서 `delete_naia_settings` 의 사유가 "부르는 곳도 초기화
 * 흐름 안이다" 인데, 초기화와 무관한 자리에 확인 없는 새 호출을 넣어도
 * 아무 일도 일어나지 않았다 — 이유가 거짓이 되어도 면제는 그대로였다.
 */
function reversibleHereOrNull(command, wrapperName) {
	const entry = REVERSIBLE.get(command);
	if (!entry) return null;
	if (!entry.callers) return entry;
	if (wrapperName && entry.callers.test(wrapperName)) return entry;
	return null;
}

/**
 * 확인 또는 되돌리기가 있다고 볼 수 있는 표시.
 *
 * `confirm` 을 이름에 담은 식별자도 인정한다 — 이 저장소는 브라우저
 * `confirm()` 말고 상태 토글로 확인 화면을 띄우는 자리가 있고
 * (`setShowResetConfirm(true)`), 그것도 사용자에게 묻는 것은 같다.
 */
/**
 * 예전에는 `confirm` 이라는 **글자**가 함수 안에 있으면 방어로 쳤다. 단어
 * 경계도 없어서, 관계없는 `const emailConfirmedAt = Date.now();` 한 줄로
 * 확인 없는 삭제가 통과했다 — 4000자 상한과 무관하게, 네 줄짜리 함수에서도
 * 그랬다.
 *
 * 이제 **확인하는 동작**만 인정한다. 부르거나(`confirm(...)`), 확인 화면을
 * 띄우거나(`setShowResetConfirm(true)`, `<ConfirmDialog`), 되돌릴 수단을
 * 주는 자리다.
 */
const AFFORDANCE =
	// `confirmed === true` 처럼 **불리언 변수 이름**이 확인으로 세던 자리를
	// 뺐다. 사용자에게 묻지 않는 지역 변수 하나로 확인 없는 삭제가 통과했다.
	// 확인은 묻는 동작이지 이름이 아니다. 상태로 확인 화면을 띄우는 자리는
	// `set*Confirm(` 로 이미 인정한다.
	/\bconfirm\s*\(|\bwindow\.confirm\b|Confirm(?:Dialog|Modal|Sheet)\b|\bset\w*Confirm\w*\s*\(|\bundo\s*\(|\bmoveToTrash\b|\btrash\s*\(/;

/**
 * 주석과 문자열을 지운 코드. 리뷰에서 실증된 우회가 있었다 —
 * `// no undo needed` 라고 적기만 해도 방어로 세어졌다. 사람이 적은 말이
 * 아니라 코드가 하는 일로 판정해야 한다.
 */
function codeOnly(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * 검사기가 확인을 확인하지 못하는 자리. **숫자가 아니라 자리로** 적는다 —
 * 숫자 baseline 은 무엇이 면제됐는지 숨기지만, 자리 목록은 드러내고 새로
 * 생긴 것과 섞이지 않는다.
 *
 * 여기 적으려면 사람이 그 자리를 열어 보고 방어가 실제로 있는지 확인해야
 * 하고, 왜 검사기가 못 보는지 적어야 한다.
 */
const ACKNOWLEDGED = new Map([
	[
		"packages/shell/src/lib/adk-store.ts:reset_naia_config_files",
		"SettingsTab 의 executeReset 이 부르고, 그 앞에 setShowResetConfirm 로 뜨는 확인 화면이 있다. 확인 상태와 실행 함수가 서로 다른 함수에 있어 이 검사기의 추적 범위를 벗어난다",
	],
	[
		"packages/shell/src/lib/tab-skills.ts:capture_screen_region",
		"화면을 찍어 돌려주는 명령이다. 본문의 remove_file 은 자기가 방금 만든 임시 PNG 를 지우는 것이라 사용자 자산을 없애지 않는다 — 이름이 아니라 하는 일로 판정하기 시작하면서 후보가 됐다",
	],
	[
		"packages/shell/src/components/AppInstallDialog.tsx:app_install",
		"이 대화상자 자체가 확인이다. 사용자가 주소를 적고 설치를 눌러야 이 자리에 온다. 확인 화면의 이름이 ConfirmDialog 가 아니라 AppInstallDialog 라서 표시로 잡히지 않는다",
	],
	[
		"packages/shell/src/lib/device-store.ts:device_token_revoke",
		"DevicePairingSection 이 setRevokeConfirmId 로 확인 화면을 띄운 뒤에만 부른다. 확인 상태와 실행 함수가 서로 다른 함수에 있어 이 검사기의 추적 범위를 벗어난다",
	],
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
 * Rust 가 프런트에 내주는 명령 이름 전부와 그 본문.
 *
 * ## 어디서 재는가 (11회차 지적 7 이후)
 *
 * 예전에는 `#\[tauri::command[^\]]*\][\s\S]{0,200}?fn` 이라는 **글자 창**으로
 * 뽑았다. 그래서 속성과 `fn` 사이에 321자짜리 문서 주석을 적으면 그 명령이
 * 후보에도 오르지 않았고, 프런트의 `invoke("…")` 는 `commands.includes` 에서
 * 조용히 건너뛰어졌다 — 확인 없는 전체 삭제가 문서를 길게 적는 것만으로
 * 통과했다.
 *
 * 창을 넓히는 대신 측정 지점을 옮겼다. `scripts/lib/rust-tokens.mjs` 의
 * 토크나이저가 주석을 버리고, 속성·가시성·`async`·`unsafe` 를 토큰으로
 * 건너뛴 뒤 `fn <이름>` 을 읽는다. 데이터 홈 경계 검사가 쓰는 것과 같은
 * 토크나이저다 — 세는 자리가 하나면 뚫린 자리도 하나에서 고쳐진다.
 *
 * **어느 크레이트를 훑는가**도 이 파일이 정하지 않는다.
 * `scripts/lib/crate-roots.mjs` 가 `Cargo.toml` 에게 물어 소스 뿌리를 준다 —
 * 명령 목록을 뽑는 게이트가 둘이고(이 게이트와 죽은 UI 게이트) 둘이 서로 다른
 * 자리에서 세면 한쪽에서 닫은 구멍이 다른 쪽에 남기 때문이다(19회차 지적 6).
 * 그래서 이 파일에는 `Cargo.toml` 을 읽는 코드가 없다.
 *
 * 프런트가 부르는 **IPC 이름** → 그 명령의 본문과 Rust 함수 이름.
 *
 * 열쇠는 함수 이름이 아니라 IPC 이름이다. `#[tauri::command(rename = "…")]` 은
 * 프런트가 부르는 이름을 바꾸므로, 함수 이름으로 목록을 만들면
 * `invoke("ghost_wipe_everything")` 이 `commands.includes` 에서 그냥 건너뛴다
 * (18회차 지적 7). 사람에게 보여 줄 때는 함수 이름도 함께 적는다 — 소스에서
 * 찾을 이름은 그쪽이다.
 */
function tauriCommands() {
	const names = new Map();
	for (const root of crateSourceRoots()) {
		for (const file of tracked(root, ".rs")) {
			for (const decl of tauriCommandDeclarations(readFileSync(file, "utf8"))) {
				names.set(decl.ipcName, { body: decl.body, fnName: decl.fnName });
			}
		}
	}
	return names;
}

function enclosingBlock(source, at) {
	let depth = 0;
	let start = -1;
	for (let i = at; i >= 0; i--) {
		const ch = source[i];
		if (ch === "}") depth++;
		else if (ch === "{") {
			if (depth === 0) {
				start = i;
				break;
			}
			depth--;
		}
	}
	if (start < 0) return null;

	let end = source.length;
	depth = 0;
	for (let i = start; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	return { start, end, text: source.slice(start, end) };
}

const FUNCTION_HEAD =
	/(?:function\s*[A-Za-z0-9_]*\s*\([^)]*\)\s*(?::[^{]*)?|=>\s*|\)\s*(?::\s*[^{]+)?)\s*$/;

/**
 * 호출을 감싼 **함수** 본문. 한 단계만 올라가면 `try {` 같은 안쪽 블록에서
 * 멈춘다 — 확인은 대개 try 바깥에 있으므로 함수 머리가 나올 때까지 넓힌다.
 */
/**
 * 감싼 함수가 이보다 크면 그 안에 무슨 글자가 있든 방어로 볼 수 없다.
 *
 * 왜 상한을 두는가: 이 저장소에서 가장 파괴적인 동작이 모인 화면이 가장 큰
 * 파일이다. 함수 머리를 찾아 올라가다 그 컴포넌트 본문 전체(19만 자)를
 * 집으면, 그 덩어리 어딘가에 있는 `Confirm` 한 글자가 방어로 인정된다.
 * 실제로 그 탓에 확인 없이 파일을 지우는 경로가 게이트를 통과하고 있었다 —
 * 사각지대가 위험이 가장 큰 자리에 정확히 겹쳤다.
 *
 * 사람이 한 화면에서 읽고 "이 확인이 저 삭제를 막는다" 고 말할 수 있는 크기가
 * 판정의 한계다. 그보다 크면 못 본 것으로 센다.
 */
const READABLE_FUNCTION_CHARS = 4000;

function enclosingFunction(source, at) {
	let cursor = at;
	let widest = null;
	// 바깥으로 한 겹씩 나간다. 겹의 수는 세지 않는다 — 중첩을 몇 겹 더 쌓으면
	// 감싼 함수를 못 찾는가는 눈금이지 한계가 아니다. `cursor` 가 매번 앞으로
	// 줄어들고 0 에서 멈추므로 이 반복은 반드시 끝난다.
	for (;;) {
		const block = enclosingBlock(source, cursor);
		if (!block) break;
		widest = block;
		if (
			FUNCTION_HEAD.test(
				source.slice(Math.max(0, block.start - 200), block.start),
			)
		)
			return block;
		if (block.start === 0) break;
		cursor = block.start - 1;
	}
	return widest;
}

/** 함수 본문 바로 앞에서 그 함수의 이름을 읽는다. 못 읽으면 null. */
function functionNameBefore(source, blockStart) {
	const head = source.slice(Math.max(0, blockStart - 240), blockStart);
	// 앞을 greedy 로 먹어 **마지막** 선언을 잡는다. 그러지 않으면 앞선
	// 함수의 이름을 집는다 — 실제로 `deleteAgentFact` 를 바로 위의
	// `getAllAgentFacts` 로 잘못 읽어, 확인이 걸린 자리를 무방비로 셌다.
	const named =
		/[\s\S]*(?:function|const|let|var)\s+([A-Za-z0-9_$]+)/.exec(head) ??
		/[\s\S]*?([A-Za-z0-9_$]+)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>\s*$/.exec(
			head,
		);
	return named ? named[1] : null;
}

const files = [
	...tracked(`${SHELL}/src`, ".ts"),
	...tracked(`${SHELL}/src`, ".tsx"),
].filter((f) => !/\.test\.|__tests__|\/locales\//.test(f));

const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

const commandBodies = tauriCommands();
// 이름으로 파괴 후보를 고를 때는 IPC 이름과 함수 이름을 **둘 다** 본다.
// `rename` 으로 한쪽만 무해해 보이게 적는 것이 곧 이번 회차의 우회였다.
const commands = [...commandBodies.keys()].filter((name) => {
	const decl = commandBodies.get(name) ?? {};
	return (
		DESTRUCTIVE_NAME.test(name) ||
		DESTRUCTIVE_NAME.test(decl.fnName ?? "") ||
		DESTRUCTIVE_BODY.test(decl.body ?? "")
	);
});

/**
 * 이름이 가리키는 함수 안에 확인이 있는지, 없으면 그 함수를 부르는 쪽으로
 * 한 단계 더 올라가 본다. 부르는 쪽을 하나도 찾지 못하면 방어를 확인하지
 * 못한 것이므로 무방비로 센다.
 */
function guarded(name, depth = 0) {
	if (depth > 3) return false;
	let sawCaller = false;
	for (const [file, source] of sources) {
		for (const call of source.matchAll(
			new RegExp(`\\b${name}\\s*\\(`, "g"),
		)) {
			const head = source.slice(0, call.index);
			if (/(?:function|const|let|var)\s+$/.test(head)) continue;
			sawCaller = true;
			const block = enclosingFunction(source, call.index);
			if (!block) return false;
			if (
			block.text.length <= READABLE_FUNCTION_CHARS &&
			AFFORDANCE.test(codeOnly(block.text))
		)
			continue;
			const outer = functionNameBefore(source, block.start);
			if (!outer || !guarded(outer, depth + 1)) return false;
		}
	}
	return sawCaller;
}

const unguarded = [];
// 상수를 거쳐 부른 파괴 명령도 확인이 필요하다. 잇지 않으면 세기만 하고
// 판정에 들어가지 않아, 감춘 쪽이 이득을 본다.
/**
 * 명령 이름을 조립해 부르는 자리.
 *
 * 이 게이트는 이름을 리터럴로 찾는다. 그래서 ``invoke(`${FACT_CMD}_fact`)``
 * 로 바꾸면 호출부가 통째로 사라졌다 — 확인 없는 삭제가 그대로 통과한다.
 * 조립은 그 자체로 이 게이트를 무력화하므로 여기서 막는다.
 */
const composedInvokes = [];
/** 상수를 거쳐 부른 파괴 명령. 리터럴 호출과 같이 본다. */
const resolvedLiteralCalls = [];
/**
 * 오늘 이미 있는 조립 호출. 포트(경계 객체)라서 이름을 인자로 받는 자리다.
 * 면제하려면 **무엇이 그 자리를 지나는지 어디서 정하는지** 적어야 한다.
 * 새로 생기는 조립은 막고, 사라진 항목은 아래에서 낡은 면제로 잡는다.
 */
// 면제는 **그 자리**에 건다. 파일 전체에 걸면 같은 파일에 확인 없는 파괴
// 호출을 새로 조립해 넣어도 삼킨다 — 면제 이유가 거짓이 되어도 통과한다.
// 자리는 감싼 함수 이름으로 적는다. 줄 번호로 적으면 위에 한 줄만 넣어도
// 어긋나고, 그때마다 목록을 고치게 되어 아무도 읽지 않게 된다.
/**
 * `invoke` 가 들어오는 **패키지**. 여기서 온 이름만 Tauri 호출로 본다.
 *
 * 적힌 문자열이 아니라 패키지 이름으로 대조한다 — `@tauri-apps/api/core.js`·
 * `@tauri-apps/api/core/index.js` 는 같은 값인데 글자가 다르다. 요소 모듈에서
 * 한 번 같은 사고가 났고(16회차 지적 5), 여기서 또 났다(17회차 지적 5).
 * 대조하는 자리는 모두 `bindings.mjs` 의 `packageOf` 를 지난다.
 */
const INVOKE_PACKAGES = new Set(["@tauri-apps/api"]);

/** 이 바인딩이 Tauri 의 `invoke` 인가. */
function isTauriInvoke(binding) {
	return (
		!!binding &&
		!!binding.module &&
		binding.imported === "invoke" &&
		isModuleOfPackage(binding.module, INVOKE_PACKAGES)
	);
}

/** 주석을 길이 그대로 공백으로 바꾼다. 파서가 준 위치와 어긋나지 않게 한다. */
function blankComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

function parse(file, text) {
	return ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		/\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

/** 상대 경로 import 를 저장소 안 파일로 푼다. */
function resolveImport(from, spec, files) {
	if (!spec.startsWith(".")) return null;
	const stack = from.split("/").slice(0, -1);
	for (const part of spec.split("/")) {
		if (part === "." || part === "") continue;
		else if (part === "..") stack.pop();
		else stack.push(part);
	}
	const base = stack.join("/").replace(/\.[jt]sx?$/, "");
	for (const candidate of [
		`${base}.tsx`,
		`${base}.ts`,
		`${base}/index.tsx`,
		`${base}/index.ts`,
	]) {
		if (files.has(candidate)) return candidate;
	}
	return null;
}

function eachNode(node, visit) {
	visit(node);
	node.forEachChild((child) => eachNode(child, visit));
}

/**
 * 이 **이름**을 부르면 Tauri 명령을 부르는 것인가. 그렇다면 명령 이름이 몇 번째
 * 인자인지, 아니면 `null`.
 *
 * 여기 남은 것은 이 게이트만의 보탬 하나다 — 고정점이 키운 **감싸기 함수 이름**.
 * 별명·구조분해·네임스페이스·모듈 이름 해석은 전부 `scripts/lib/bindings.mjs`
 * 가 한다(17회차 지적 5·6). 예전에는 그 해석이 이 파일에도 한 벌 있었고, 형제
 * 모듈에서 고친 것이 여기로 옮겨 오지 않아 같은 결함이 두 번 났다.
 */
function wrapperOffset(expr, bindings) {
	const node = unwrap(expr);
	if (!node || !ts.isIdentifier(node)) return null;
	return bindings.local.has(node.text) ? (bindings.offsets.get(node.text) ?? 0) : null;
}

/**
 * 파일마다 "이 이름을 부르면 Tauri 명령을 부르는 것" 인 이름 집합을 만든다.
 *
 * 씨앗은 `@tauri-apps/api/core` 의 `invoke` 이고, 첫 인자를 그대로 그 이름에
 * 넘기는 감싸기 함수가 나올 때마다 집합이 자란다. 더 자라지 않을 때까지 돈다.
 */
function invokeBindings(sources) {
	const trees = new Map();
	for (const [file, source] of sources) trees.set(file, parse(file, source));

	const local = new Map(); // file -> Set<감싸기 함수 이름>
	const exported = new Map(); // file -> Set<내보낸 감싸기 이름>
	// 이름 -> 명령 이름이 몇 번째 인자인가. `invoke.call(null, "cmd")` 처럼 한 칸
	// 밀리는 별명이 있어 자리마다 따로 든다. -1 은 알 수 없다(`.apply`)는 뜻.
	const offsets = new Map(); // file -> Map<이름, 오프셋>
	for (const file of sources.keys()) {
		local.set(file, new Set());
		exported.set(file, new Set());
		offsets.set(file, new Map());
	}
	// 공용 모듈이 파일을 건너갈 때 쓰는 환경. 알림 게이트가 쓰는 것과 같은
	// 모양이다 — 상대 경로 import 를 저장소 안 파일로 풀어 그 트리를 준다.
	const env = {
		has: (path) => sources.has(path),
		sourceFile: (path) => trees.get(path) ?? null,
		resolve: (from, spec) => resolveImport(from, spec, sources),
	};
	const bindingsFor = (file) => ({
		local: local.get(file),
		offsets: offsets.get(file),
		sourceFile: trees.get(file) ?? null,
		env,
	});

	// 씨앗을 따로 두지 않는다. `import { invoke as tauriInvoke }`·네임스페이스·
	// 구조분해·`.bind` 는 전부 `bindings.mjs` 가 호출식에서 바로 답한다. 이
	// 집합에는 아래 고정점이 찾아낸 **감싸기 함수 이름**만 담긴다.

	/** 이 호출이 Tauri 명령 호출이면 명령 이름의 인자 자리, 아니면 null. */
	const invokeCallOffset = (node, file) => {
		if (!ts.isCallExpression(node)) return null;
		const bindings = bindingsFor(file);
		// 먼저 공용 모듈에게 **호출식 전체**를 묻는다. 그러면 `.call`/`.apply`/`.bind`
		// 와 리터럴 키(`invoke["call"]`)가 알림·무음 게이트와 같은 규칙으로 풀리고,
		// 인자 자리도 그쪽이 아는 `argShift`/`argsUnknown` 이 그대로 답한다. 옛 코드는
		// callee 식에 `resolveBinding` 만 걸어, 공용 모듈이 이미 아는 답을 버렸다
		// (14회차 지적 6).
		if (bindings.sourceFile) {
			const callee = resolveCallee(node, bindings.sourceFile, bindings.env);
			if (isTauriInvoke(callee)) return callee.argsUnknown ? -1 : callee.argShift;
		}
		// 못 풀면 이 게이트만의 보탬으로 내려간다 — 고정점이 키운 감싸기 함수들이다.
		return wrapperOffset(node.expression, bindings);
	};
	const callsInvoke = (node, file) => invokeCallOffset(node, file) !== null;

	// 고정점: 첫 인자를 그대로 넘기는 감싸기 함수도 호출부다.
	//
	// 겹의 수를 세지 않는다. 예전에는 여섯 바퀴만 돌았는데, 그런 숫자는 한계가
	// 아니라 "감싸기를 몇 겹 더 쌓으면 통과하는가" 를 알려 주는 눈금이다 —
	// 13회차에 별명 깊이·상수 사슬에서, 14회차에 `void` 겹에서 없앤 것과 같은
	// 종류의 자리다.
	//
	// 끝나는 이유는 세는 것이 아니라 **더 자라지 않는 것**이다. 이름 집합은
	// 한 방향으로만 자라고(이미 있는 이름은 `has` 로 걸러 다시 넣지 않는다),
	// 저장소의 선언 수는 유한하다. 그래서 이 반복은 반드시 끝난다 — 그 집합
	// 자체가 "이미 지난 자리" 표시다.
	for (;;) {
		let grew = false;
		for (const [file, tree] of trees) {
			const declare = (name, node, isExported) => {
				if (!name || local.get(file).has(name)) return;
				let forwards = false;
				eachNode(node, (inner) => {
					if (forwards) return;
					const at = invokeCallOffset(inner, file);
					if (at === null || at < 0) return;
					const first = inner.arguments[at];
					const param = node.parameters?.[0];
					if (
						first &&
						param &&
						ts.isIdentifier(first) &&
						ts.isIdentifier(param.name) &&
						first.text === param.name.text
					)
						forwards = true;
				});
				if (!forwards) return;
				local.get(file).add(name);
				if (isExported) exported.get(file).add(name);
				grew = true;
			};
			for (const statement of tree.statements) {
				const isExported = !!statement.modifiers?.some(
					(m) => m.kind === ts.SyntaxKind.ExportKeyword,
				);
				if (ts.isFunctionDeclaration(statement) && statement.name) {
					declare(statement.name.text, statement, isExported);
				} else if (ts.isVariableStatement(statement)) {
					for (const d of statement.declarationList.declarations) {
						if (!d.initializer || !ts.isIdentifier(d.name)) continue;
						if (
							ts.isArrowFunction(d.initializer) ||
							ts.isFunctionExpression(d.initializer)
						)
							declare(d.name.text, d.initializer, isExported);
					}
				}
			}
			// 감싸기 함수를 import 한 파일도 그 이름으로 부른다.
			// import 선언을 읽는 자리도 공용 모듈 하나다 — 그래야
			// `import { "wrap" as w }` 같은 형태가 여기서만 빠지지 않는다.
			for (const [localName, hit] of importBindings(tree)) {
				const target = resolveImport(file, hit.module, sources);
				if (!target) continue;
				if (!exported.get(target)?.has(hit.imported)) continue;
				if (local.get(file).has(localName)) continue;
				local.get(file).add(localName);
				offsets.get(file).set(localName, offsets.get(target)?.get(hit.imported) ?? 0);
				grew = true;
			}
		}
		if (!grew) break;
	}

	// 호출부 수집
	const sites = [];
	for (const [file, tree] of trees) {
		eachNode(tree, (node) => {
			const at = invokeCallOffset(node, file);
			if (at === null) return;
			// `-1` 은 명령 이름이 호출부의 몇 번째 인자인지 알 수 없다는 뜻이다 —
			// `.apply` 로 배열을 넘긴 것, 그리고 이름을 `.bind` 로 미리 먹인 것.
			// 리터럴이 아닌 것으로 세면 아래 조립 검사가 그 자리를 막는다.
			const first = at < 0 ? undefined : node.arguments[at];
			const start = node.getStart(tree);
			const literal =
				first &&
				(ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
					? first.text
					: null;
			sites.push({
				file,
				start,
				literal,
				argText: first
					? first.getText(tree).slice(0, 40)
					: at < 0
						? "이름자리모름"
						: "",
				hasArg: !!first,
				// 명령 이름이 호출부 인자에 없다는 표시(`.apply`, 이름을 미리 먹인
				// `.bind`). 세어서 보고 줄에 드러낸다 — 0 이 아니면 그만큼 이
				// 게이트가 이름을 못 읽고 있다는 뜻이다.
				nameUnknown: at < 0,
			});
		});
	}
	return sites;
}

const invokeSites = invokeBindings(sources);

const COMPOSED_ALLOWED = new Map([
	[
		"packages/shell/src/lib/environment-skill.ts::tauriCommands",
		"EnvironmentCommandPort 어댑터. 지나가는 이름은 environment-skill 의 동작 표에서 리터럴로 정한다",
	],
]);
let callSites = 0;

for (const site of invokeSites) {
	{
		const file = site.file;
		const source = sources.get(file);
		// 인자의 **형태**를 봐야 하므로 주석만 지운 코드를 쓴다. 길이를 지켜
		// 파서가 준 위치와 어긋나지 않게 한다.
		const code = blankComments(source);
		const match = { index: site.start };
		const arg = site.argText.trim();
		// 리터럴 이름이면 이 게이트가 볼 수 있다.
		if (site.literal !== null) continue;
		// 이름을 상수에 담아 두는 것은 조립이 아니다 — **그 상수의 값을 실제로
		// 따라갈 수 있을 때만** 그렇다. 예전에는 대문자 이름이면 무조건
		// 넘겼는데, 리터럴 호출 검사는 `invoke("...")` 만 보므로 그 자리가
		// 통째로 사라졌다. 값을 찾아 그 이름으로 판정한다.
		const constant = new RegExp(
			`\\b(?:const|let|var)\\s+${arg}\\s*(?::[^=]+)?=\\s*["']([a-z0-9_]+)["']`,
		).exec(code);
		if (constant) {
			if (!commands.includes(constant[1])) continue;
			// 파괴 명령을 상수로 감춘 것이다. 리터럴로 부른 것과 같이 본다.
			resolvedLiteralCalls.push({
				file,
				line: source.slice(0, match.index).split("\n").length,
				command: constant[1],
			});
			continue;
		}
		// 이름을 변수로 받아도, 그 변수의 타입이 리터럴 합집합으로 묶여 있으면
		// 어떤 명령이 지나는지 정해져 있다. 손으로 면제하지 말고 그 리터럴을
		// 읽어 판정한다 — 면제 목록은 이유가 거짓이 되어도 그대로 남는다.
		// 앞에서부터 **첫** 일치를 쓰면 파일 위쪽의 관계없는 서명이 잡힌다 —
		// 파괴 아닌 명령을 받는 함수 하나를 위에 두면 아래의 조립 호출이
		// 통째로 사라졌다. 이 호출을 감싼 함수 서명 안에서만 읽는다.
		// 서명은 본문 밖에 있으므로 함수 시작 조금 앞부터 본다. 파일 전체를
		// 보면 위쪽의 관계없는 서명이 잡힌다.
		const scope = enclosingFunction(code, match.index);
		const scopeText = scope
			? code.slice(Math.max(0, scope.start - 400), match.index)
			: code.slice(Math.max(0, match.index - 400), match.index);
		const union = new RegExp(
			`\\b${arg}\\s*:\\s*((?:["'][a-z0-9_]+["']\\s*\\|\\s*)*["'][a-z0-9_]+["'])`,
		).exec(scopeText);
		if (union) {
			const names = [...union[1].matchAll(/["']([a-z0-9_]+)["']/g)].map(
				(m) => m[1],
			);
			if (names.length > 0 && !names.some((n) => commands.includes(n))) continue;
		}
		const enclosing = enclosingFunction(source, match.index);
		const owner = enclosing
			? functionNameBefore(source, enclosing.start)
			: null;
		composedInvokes.push({
			file,
			site: `${file}::${owner ?? "(이름 없는 자리)"}`,
			line: source.slice(0, match.index).split("\n").length,
			arg: arg.slice(0, 40),
		});
	}
}

for (const site of invokeSites) {
	{
		const file = site.file;
		const source = sources.get(file);
		const command = site.literal;
		// 예전에는 이름 문자열이 파일 어디에 있든 호출로 셌다. 그래서
		// 에이전트에게 보내는 메시지(`{ type: "app_install" }`)까지 호출로
		// 잡혔다. 파서가 짚은 실제 호출 자리만 본다.
		{
			if (command === null || !commands.includes(command)) continue;
			const match = { index: site.start };
			callSites++;
			const block = enclosingFunction(source, match.index);
			const line = source.slice(0, match.index).split("\n").length;
			if (
				block &&
				block.text.length <= READABLE_FUNCTION_CHARS &&
				AFFORDANCE.test(codeOnly(block.text))
			)
				continue;

			const wrapper = block ? functionNameBefore(source, block.start) : null;
			// 되돌릴 수 있다는 면제는 **이유가 말하는 자리에서만** 성립한다.
			if (reversibleHereOrNull(command, wrapper)) continue;
			if (wrapper && guarded(wrapper)) continue;

			unguarded.push({ file, line, command, wrapper });
		}
	}
}

// 면제는 그 자리의 **그 호출 하나**에만 걸린다. 자리로 좁혔더니 같은 함수
// 안에 확인 없는 파괴를 하나 더 조립해 넣는 것을 그대로 삼켰다 — 면제
// 이유("동작 표에서 리터럴로 정한 이름만 지난다")가 거짓이 되어도 통과했다.
// 자리마다 몇 개까지 면제인지 함께 적는다.
const composedSeen = new Map();
const composedNew = composedInvokes.filter((hit) => {
	if (!COMPOSED_ALLOWED.has(hit.site)) return true;
	const used = composedSeen.get(hit.site) ?? 0;
	composedSeen.set(hit.site, used + 1);
	// 면제된 자리는 조립 호출이 하나뿐이라는 것이 이유의 전제다. 둘째부터는
	// 그 전제가 깨진 것이므로 막는다.
	return used >= 1;
});
const composedStale = [...COMPOSED_ALLOWED.keys()].filter(
	(site) => !composedInvokes.some((hit) => hit.site === site),
);
if (composedStale.length) {
	console.error(
		`  ❌ 조립 호출 면제가 낡았다(${composedStale.length}) — 그 자리가 없어졌으니 목록에서 빼라:`,
	);
	for (const file of composedStale) console.error(`     ${file}`);
	process.exit(1);
}
if (composedNew.length) {
	console.error(
		`  ❌ 명령 이름을 조립해 부르는 자리 ${composedNew.length}곳 — 이 게이트는 리터럴 이름만 본다:`,
	);
	for (const hit of composedNew)
		console.error(`     ${hit.file}:${hit.line} — invoke(${hit.arg})`);
	console.error(
		"     Tauri 명령은 리터럴 문자열로 불러라. 조립하면 확인 검사가 그 자리를 통째로 놓친다.",
	);
	process.exit(1);
}

for (const hit of resolvedLiteralCalls) {
	const source = sources.get(hit.file) ?? "";
	const at = source.split("\n").slice(0, hit.line).join("\n").length;
	const block = enclosingFunction(source, Math.max(0, at - 1));
	const guardedHere =
		block &&
		block.text.length <= READABLE_FUNCTION_CHARS &&
		AFFORDANCE.test(codeOnly(block.text));
	if (guardedHere) continue;
	const wrapper = block ? functionNameBefore(source, block.start) : null;
	if (reversibleHereOrNull(hit.command, wrapper)) continue;
	if (wrapper && guarded(wrapper)) continue;
	unguarded.push({ file: hit.file, line: hit.line, command: hit.command, wrapper });
}

// 명령 이름 자리를 못 읽은 호출. 지금은 0 이고, 0 이 아니면 그 수만큼 이
// 게이트가 무엇을 부르는지 모른 채 지나간 것이다. 그런 자리는 아래 조립 호출
// 검사가 잡아 사람이 사유를 적게 한다 — 초록으로 흘려보내지 않는다.
const unknownNameSites = invokeSites.filter((site) => site.nameUnknown).length;

console.log(
	`[destructive] Rust 명령 ${tauriCommands().size}개 중 파괴 후보 ${commands.length}개` +
		` (되돌릴 수 있어 면제 ${REVERSIBLE.size}개) / 프런트 호출 ${callSites}곳` +
		` / 이름 자리를 못 읽은 호출 ${unknownNameSites}곳`,
);

const unexpected = unguarded.filter(
	(hit) => !ACKNOWLEDGED.has(`${hit.file}:${hit.command}`),
);
const stale = [...ACKNOWLEDGED.keys()].filter(
	(key) => !unguarded.some((hit) => `${hit.file}:${hit.command}` === key),
);

if (unexpected.length > 0) {
	console.error(
		`\n되돌릴 수 없는 동작 ${unexpected.length}곳에 확인도 되돌리기도 없다:`,
	);
	for (const hit of unexpected) {
		console.error(
			`  ${hit.file}:${hit.line} — ${hit.command}` +
				(hit.wrapper ? ` (감싼 함수 ${hit.wrapper})` : " (감싼 함수를 못 읽음)"),
		);
	}
	console.error(
		"\n확인을 걸거나(confirm/ConfirmDialog), 되돌릴 수 있게 만들어라(undo/trash).",
	);
	console.error(
		"되돌릴 수 있는 동작이면 REVERSIBLE 에, 검사기가 못 보는 것뿐이면 ACKNOWLEDGED 에 이유와 함께 적어라.",
	);
	process.exit(1);
}

if (stale.length > 0) {
	console.error("\n확인을 확인하지 못한다고 적어 둔 자리가 이제 걸리지 않는다:");
	for (const key of stale) console.error(`  ${key}`);
	console.error("\nACKNOWLEDGED 에서 지워라 — 남겨 두면 다음 결함을 덮는다.");
	process.exit(1);
}

if (unguarded.length > 0) {
	console.log(`  검사기가 확인을 확인하지 못하는 자리 ${unguarded.length} (사람이 확인해 적어 둠):`);
	for (const hit of unguarded) console.log(`    ${hit.file}:${hit.line} — ${hit.command}`);
}
console.log("  ✓ 확인 없는 파괴적 동작 없음");
