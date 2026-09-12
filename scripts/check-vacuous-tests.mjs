/**
 * 아무것도 재지 않으면서 통과를 보고하는 테스트를 잡는다.
 *
 * 왜 필요한가: `expect(true).toBe(true)` 는 리포터에 PASS 로 올라가고 통과
 * 수치에 더해진다. 그 수치를 보고 "덮여 있다" 고 판단하면 실제로는 아무도
 * 보지 않는 자리를 덮였다고 믿게 된다. 96-w5-sold-out-ux.spec.ts 가 그 예다
 * — 파일 머리에는 "UI 가 매진 안내를 보여준다" 는 시나리오가 적혀 있는데
 * 단정은 `expect(true).toBe(true)` 하나뿐이고, 화면 문구는 아무것도 보지
 * 않는다. 2026-06-10 이후 그대로다.
 *
 * 조건 없는 skip 도 같은 성격이다. 환경이 없어 건너뛰는 것
 * (`test.skip(!process.env.X, ...)`)은 정당하지만, 이유 없이 꺼 둔 것은
 * 죽은 테스트이면서 파일 수에는 남는다.
 *
 * 지금 있는 것은 baseline 으로 고정하고 늘어나는 것만 막는다. 한 번에
 * 붉히면 게이트가 꺼지기 때문이다. 줄이면 이 목록도 함께 줄여야 한다.
 *
 * 이 게이트의 앞선 판은 스스로 좁혀 놓은 범위 때문에 거의 아무것도 보지
 * 못했다. 셸 아래 세 곳만 보았고 확장자도 `.ts(x)` 만 받았는데, 저장소
 * 뿌리의 `src/` 에 테스트가 아흔아홉 개(그중 열여덟은 `.mjs`) 더 있고 CI 는
 * 그것을 실제로 돌린다. 통과 수치의 큰 몫이 검사 밖에 있었던 셈이다.
 *
 * 패턴도 문자열 하나(`expect(true).toBe(true)`)뿐이라, 같은 뜻의 다른 형태가
 * 전부 빠져나갔다 — `expect(1).toBe(1)`, `expect(true).toBeTruthy()`,
 * 줄바꿈으로 쪼갠 같은 식, 변수로 우회한 자기 비교, Playwright 의 영구
 * 비활성화 `test.fixme`, 그리고 단정이 아예 없는 본문까지.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";
import { join } from "node:path";

const ROOTS = [
	"packages/shell/e2e",
	"packages/shell/e2e-tauri/specs",
	"packages/shell/src",
	// 셸 패키지의 스크립트 테스트. CI 의 `shell tests (vitest)` 가 실제로
	// 돌린다(130 케이스). 이 자리를 빼놓아 4회차에서 잡힌 것과 같은 부류가
	// 한 번 더 남아 있었다.
	"packages/shell/scripts",
	// 저장소 뿌리의 테스트. CI 가 `pnpm test` 와 훅 자체 검사로 실제 돌린다.
	"src",
	"scripts",
];

function walk(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (name === "node_modules" || name === "dist") continue;
		// 저장소 안에 놓인 다른 저장소의 체크아웃은 이 저장소의 사실이
		// 아니다. UC 게이트가 그것을 훑는 바람에 없는 파일을 있다고
		// 판정한 적이 있다.
		if (name.endsWith("-worktrees") || name === "worktrees") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) out.push(full);
	}
	return out;
}

const files = ROOTS.flatMap((root) => walk(root));
const vacuous = [];
const deadSkips = [];
const retired = [];
const pending = [];

/** 자기 자신만 확인하는 단정. 공백과 줄바꿈을 지운 뒤 본다. */
const SELF_ASSERTIONS = [
	/expect\(true\)\.toBe\(true\)/,
	/expect\(false\)\.toBe\(false\)/,
	/expect\((\d+)\)\.toBe\(\1\)/,
	/expect\(true\)\.toBeTruthy\(\)/,
	/expect\(false\)\.toBeFalsy\(\)/,
	/expect\(([A-Za-z_$][\w$]*)\)\.toBe\(\1\)/,
	/expect\(([A-Za-z_$][\w$]*)\)\.toEqual\(\1\)/,
];

/** 주석과 문자열을 지운다. 설명을 잡아 고친 사람의 입을 막지 않기 위해서다. */
function codeOnly(text) {
	return text
		// 개행은 남긴다. 지우면 줄 수가 달라져 뒤에서 계산한 줄 번호가
		// 어긋나고, 게이트가 엉뚱한 줄을 지목한다.
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/**
 * 본문에 아무 단정도 없는 테스트.
 *
 * 머리말이 이 형태를 잡는다고 적어 두었는데 실제 검사가 없었다 — 적어 놓고
 * 하지 않은 것이 이 게이트가 없애려는 바로 그 형태다. 제목에는 시나리오가
 * 적혀 있고, 리포터에는 PASS 로 올라가고, 재는 것은 없다.
 *
 * 정규식으로 본문을 잘라 보려 했지만 오탐이 많았다 — 중괄호 균형과 줄
 * 번호가 어긋나 데이터 배열 한가운데를 "단정 없는 테스트" 로 지목했다.
 * 구문을 추측하는 대신 파서에게 묻는다.
 *
 * 단정으로 보는 것: `expect` 계열, `assert`, 그리고 실패할 수 있는 대기
 * (`waitUntil`, `waitForDisplayed` 등). 대기는 시간이 지나면 던지므로 그
 * 자체가 단정이다.
 *
 * `assert` 는 멤버 호출까지 본다. 예전 형태(`\bassert\w*\s*\(`)는 `assert(` 와
 * `assertEqual(` 만 잡고 `assert.equal(` 은 놓쳤다 — `node:assert/strict` 를
 * 쓰는 `scripts/qa-*.test.mjs` 스물일곱 자리가 통째로 "단정 없음" 으로
 * 잡혔는데, 그 본문들은 한 케이스에 예닐곱 개씩 단정하고 있었다. 검사기가
 * 형태 하나만 알아 진짜 단정을 못 본 것이므로 기준선이 아니라 이 규칙을
 * 고친다.
 */
const ASSERTS =
	/\bexpect\b|\bassert\w*(?:\s*\.\s*\w+)*\s*\(|waitUntil\s*\(|waitFor(?:Displayed|Exist|Enabled|Clickable|Function|URL|Selector)\s*\(|\.toThrow|rejects\./;

/**
 * 예전에는 이름이 `verify*` 이기만 하면 단정으로 셌다. 그래서 아무것도 재지
 * 않는 헬퍼 하나를 부르는 테스트가 통과했고, 헬퍼 이름만 바꾸면 같은 테스트가
 * 붉어졌다 — 이름을 재고 있었던 것이다.
 *
 * 이제는 **그 헬퍼가 실제로 단정하는지** 본다. 저장소의 함수 본문을 읽어
 * 단정하는 이름 집합을 만들고, 헬퍼가 헬퍼를 부르는 경우까지 고정점에
 * 이를 때까지 넓힌다.
 */
function assertingHelperNames() {
	const bodies = new Map();
	for (const dir of HELPER_ROOTS) walkAll(dir, bodies);
	const asserting = new Set();
	for (const [name, text] of bodies) if (ASSERTS.test(text)) asserting.add(name);
	// 헬퍼가 부르는 헬퍼도 단정한다. 더 늘지 않을 때까지 편다.
	for (;;) {
		let grew = false;
		for (const [name, text] of bodies) {
			if (asserting.has(name)) continue;
			for (const other of asserting) {
				if (new RegExp(`\\b${other}\\s*\\(`).test(text)) {
					asserting.add(name);
					grew = true;
					break;
				}
			}
		}
		if (!grew) break;
	}
	return asserting;
}

const HELPER_ROOTS = [
	"packages/shell/e2e",
	"packages/shell/e2e-tauri",
	"packages/shell/src",
	"packages/shell/scripts",
	"src",
	"scripts",
];

/** 이 디렉터리 아래 모든 ts/js 에서 이름 붙은 함수의 본문을 모은다. */
function walkAll(dir, out) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (name === "node_modules" || name === "dist") continue;
		if (name.endsWith("-worktrees") || name === "worktrees") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			walkAll(full, out);
			continue;
		}
		if (!/\.[cm]?[jt]sx?$/.test(name)) continue;
		const tree = ts.createSourceFile(
			full,
			readFileSync(full, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			/\.tsx?$/.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.JS,
		);
		const visit = (node) => {
			if (ts.isFunctionDeclaration(node) && node.name && node.body)
				out.set(node.name.text, node.body.getText(tree));
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				(ts.isArrowFunction(node.initializer) ||
					ts.isFunctionExpression(node.initializer))
			)
				out.set(node.name.text, node.initializer.getText(tree));
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	return out;
}

const ASSERTING_HELPERS = assertingHelperNames();

/** 본문이 단정하는가 — 직접 단정하거나, 단정하는 헬퍼를 부르는가. */
function bodyAsserts(text) {
	if (ASSERTS.test(text)) return true;
	for (const name of ASSERTING_HELPERS) {
		if (new RegExp(`\\b${name}\\s*\\(`).test(text)) return true;
	}
	return false;
}

/** 테스트를 여는 이름. `it.each` 같은 변형도 이름 부분만 본다. */
function testCallName(expression) {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression))
		return testCallName(expression.expression);
	if (ts.isCallExpression(expression)) return testCallName(expression.expression);
	return "";
}

/** 이 파일의 테스트 본문을 파서로 찾는다. */
function testBodies(file, source) {
	const tree = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const out = [];
	const visit = (node) => {
		if (
			ts.isCallExpression(node) &&
			["it", "test"].includes(testCallName(node.expression)) &&
			node.arguments.length >= 2
		) {
			const body = node.arguments[1];
			if (
				(ts.isArrowFunction(body) || ts.isFunctionExpression(body)) &&
				body.body
			) {
				out.push({
					text: body.body.getText(tree),
					line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
					// `it.skip` 은 따로 세므로 여기서 뺀다.
					skipped: /\.(skip|fixme|todo)\b/.test(node.expression.getText(tree)),
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return out;
}

for (const file of files) {
	const source = readFileSync(file, "utf8");
	const code = codeOnly(source);

	// 줄바꿈으로 쪼개 놓아도 걸리도록 공백을 지우고 본다.
	const dense = code.replace(/\s+/g, "");
	for (const pattern of SELF_ASSERTIONS) {
		if (pattern.test(dense)) {
			vacuous.push(`${file} (${pattern.source})`);
			break;
		}
	}

	for (const body of testBodies(file, source)) {
		// 꺼 둔 테스트와 본문이 빈 것은 skip 칸에서 센다.
		if (body.skipped) continue;
		if (body.text.replace(/[\s{}]/g, "").length === 0) continue;
		if (bodyAsserts(body.text)) continue;
		vacuous.push(`${file}:${body.line} (단정 없음)`);
	}

	// skip 판정은 원본 줄에서 한다. 주석을 지우면 여러 줄이 한 줄로 합쳐져
	// 줄 번호가 어긋나고, 사유를 적었는지도 볼 수 없다.
	source.split("\n").forEach((line, index) => {
		const where = `${file}:${index + 1}`;
		if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
		// 조건 없는 skip. 환경 변수로 거르는 형태(test.skip(!process.env.X, ...))는
		// 정당하므로 애초에 이 패턴에 걸리지 않는다.
		// `fixme` 는 Playwright 에서 영구 비활성화이므로 같은 칸에 센다.
		// `fixme` 는 "아직 구현되지 않았다" 는 뜻이고 `skip` 은 "지금은 끄자"
		// 는 뜻이다. 둘 다 돌지 않지만 성격이 다르므로 칸을 나눈다 — 섞으면
		// 배선을 기다리는 것과 방치된 것이 구별되지 않는다. 다만 fixme 도
		// 상한을 둔다. 상한 없는 대기 칸은 곧 쓰레기통이 된다.
		if (/^\s*(?:test|it|describe)(?:\.describe)?\.fixme\(\s*["'`]/.test(line)) {
			pending.push(where);
			return;
		}
		if (
			/^\s*(?:test|it|describe)(?:\.describe)?\.skip\(\s*["'`]/.test(line)
		) {
			// 이름 앞에 은퇴를 밝힌 것은 "왜 꺼져 있는지" 가 적힌 것이다. 그것까지
			// 같은 칸에 세면, 사유를 적은 사람과 아무 말 없이 끈 사람이 구별되지
			// 않는다. 따로 세되 눈에는 보이게 한다.
			if (/["'`]\s*(?:retired|rewrite-needed|은퇴|재작성필요)[:：]/.test(line))
				retired.push(where);
			else deadSkips.push(where);
		}
	});
}

// 오늘의 상태.
//
// retired 에도 상한을 둔다. 상한이 없으면 제목 앞에 사유만 붙여 죽은 테스트를
// 무제한 늘릴 수 있고, 그러면 이 게이트가 스스로 경고한 "baseline 이
// 알리바이가 된다" 를 이 게이트가 저지르게 된다. 사유를 적는 것은 면제가
// 아니라 기록일 뿐이다.
// 32 는 대부분 화면을 찍기만 하는 스크린샷 스펙이다. 그것도 통과 수치에
// 더해지므로 "덮였다" 로 읽히는 것은 같지만, 한 번에 고치면 아무도 검토할
// 수 없는 커밋이 된다. 지금 상태를 잠그고 늘어나는 것만 막는다.
//
// `expect(true).toBe(true)` 같은 자기 확인은 0 이다. 이 숫자는 전부 "본문에
// 단정이 하나도 없는" 쪽이다.
const BASELINE_VACUOUS = 25;
const BASELINE_DEAD_SKIPS = 0;
// 16 에서 19 로 올렸다. 늘어난 셋은 새로 꺼 둔 것이 아니라, 원래 **통과하는
// 테스트를 만들어 내던** 자리다 — 공급자 키가 없으면 `it("[SKIP] ...")` 로
// 빈 본문을 통과시켜, 그 공급자를 한 번도 재지 않고 커버로 세었다. 그것을
// 실제 skip 으로 바꾸자 이 칸에 잡혔다. 숫자는 늘었지만 거짓 통과가 줄었다.
//
// 19 에서 22 로 올렸다. 같은 이유의 나머지 셋이다 — 80 번 TTS 미리듣기
// 스펙(OpenAI·ElevenLabs·Google)이 키가 없을 때 본문 첫 줄에서 `[SKIP]` 을
// 찍고 그대로 반환해 PASS 로 올라가고 있었다. 덮개가 얇아진 것이 아니라,
// 재지 않은 것을 재지 않았다고 말하게 된 것이다.
//
// #557 마무리(2026-09-06): 93-radio-bgm-observation 은 시나리오 표에 대응 문장이
// 없는 일시정지·재개 검사만 남아 오너가 접기로 했고 파일을 지웠다. 옮긴 두 검사는
// 94-radio-bgm-queue 에 있다. 기준선은 22 로 돌아온다.
//
// #563 으로 23 이 되었다(2026-09-06). 93-discord-inbox-handoff 는 빈 Discord
// 대화함의 `Discord 연결 설정 열기` 가 연결 탭을 여는지를 재는데, 제품에 그
// 목적지가 없다 — 버튼이 부르는 `naia-open-settings` 를 듣는 곳이 저장소에
// 없고, 이어서 누르는 `[data-settings-tab="connections"]` 는 조건 없이
// disabled 이며, 표지를 정의하는 ConnectionsSettingsTab 은 제품 코드가 값으로
// 끌어오지 않는다. 그래서 이 스펙은 통과할 수 없는 것을 30초 기다린 뒤 매번
// 실패했고, 회귀 기록에서 진짜 회귀를 덮는 소음이 되고 있었다. 이번에는 스펙이
// 낡은 것이 아니라 제품이 정본(UC-DISCORD-1B·FR-DISCORD-SETUP-05)보다 뒤처진
// 쪽이므로 단정을 고치지 않고 그대로 끈다 — 고쳐서 통과시키면 없는 기능이
// 덮인 것으로 보인다. #563 이 닫히면 `it.skip` 을 되돌리고 이 기준선도 22 로
// 내린다. 늘린 이 한 칸은 유예의 값이지 면제가 아니다.
const BASELINE_RETIRED = 23;
// 배선을 기다리는 자리. 늘면 "나중에" 가 쌓이는 것이므로 함께 막는다.
const BASELINE_PENDING = 11;

console.log(
	`[vacuous-tests] 자명 단정 ${vacuous.length} (baseline ${BASELINE_VACUOUS})` +
		` / 이유 없는 skip ${deadSkips.length} (baseline ${BASELINE_DEAD_SKIPS})` +
		` / 사유 밝힌 skip ${retired.length} (baseline ${BASELINE_RETIRED})` +
		` / 구현 대기 fixme ${pending.length} (baseline ${BASELINE_PENDING})`,
);

let failed = false;
if (vacuous.length > BASELINE_VACUOUS) {
	console.error(`  ❌ 아무것도 재지 않는 단정이 늘었다(${vacuous.length} > ${BASELINE_VACUOUS}):`);
	const byFile = new Map();
	for (const where of vacuous) {
		const file = where.split(":")[0];
		byFile.set(file, (byFile.get(file) ?? 0) + 1);
	}
	for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
		console.error(`     ${String(count).padStart(3)} ${file}`);
	}
	console.error("     그 자리가 무엇을 확인해야 하는지 적거나, 테스트를 지워라.");
	failed = true;
}
if (retired.length > BASELINE_RETIRED) {
	console.error(`  ❌ 사유를 밝힌 채 꺼 둔 테스트가 늘었다(${retired.length} > ${BASELINE_RETIRED}):`);
	for (const where of retired.slice(-5)) console.error(`     ${where}`);
	console.error("     사유를 적는 것은 면제가 아니다. 되살리거나 지워라.");
	failed = true;
}
if (pending.length > BASELINE_PENDING) {
	console.error(`  ❌ 구현을 기다리는 테스트가 늘었다(${pending.length} > ${BASELINE_PENDING}):`);
	for (const where of pending.slice(-5)) console.error(`     ${where}`);
	console.error("     배선이 끝났으면 켜라. 안 할 것이면 지워라.");
	failed = true;
}
if (deadSkips.length > BASELINE_DEAD_SKIPS) {
	console.error("  ❌ 이유 없이 꺼 둔 테스트가 늘었다:");
	for (const where of deadSkips) console.error(`     ${where}`);
	console.error("     환경 조건으로 거르거나(test.skip(!process.env.X, ...)), 되살리거나, 지워라.");
	failed = true;
}
if (
	vacuous.length < BASELINE_VACUOUS ||
	deadSkips.length < BASELINE_DEAD_SKIPS ||
	retired.length < BASELINE_RETIRED ||
	pending.length < BASELINE_PENDING
)
	console.log("  ✓ 줄었다 — 이 파일의 baseline 도 함께 줄여라");
if (!failed) console.log("  ✓ 늘지 않았다");
process.exit(failed ? 1 : 0);
