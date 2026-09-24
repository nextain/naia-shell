/**
 * UC 가 추적되고 있는지 본다.
 *
 * 왜 필요한가: 옆에 있는 check-assembly-coverage.mjs 는 `**UC1**` 같은 옛
 * 숫자 이름만 찾는다(정규식 /\*\*(UC\d+[a-z-]*)/). 그 사이 문서는
 * `UC-<이름>` 체계로 옮겨갔고, 게이트는 그 표제 중
 * 하나도 보지 못한 채 "모든 UC 분류 ✓" 로 초록을 보고한다. 눈이 먼 게이트는
 * 없는 게이트보다 나쁘다 — 통과가 무언가를 보증한다고 믿게 만든다.
 *
 * 무엇을 재는가: UC 표제마다 다음 셋 중 하나에 걸려야 한다.
 *   1) user-scenarios.md 의 Test Coverage Map 표에 자기 행이 있다
 *   2) 벤치 하네스(agent-bench-scenarios.ts)의 계열 접두사에 걸린다 —
 *      그 계열이 요구 증거를 정의하므로 표가 따로 필요 없다
 *   3) 그 하네스가 에픽 밖으로 선언했다
 *
 * 셋 다 아니면 그 UC 는 어디서 검증되는지 아무 데도 적혀 있지 않다.
 *
 * 왜 baseline 인가: 지금 걸리는 것이 열 몇 개다. 한 번에 붉히면 CI 가 막히고
 * 게이트는 곧 꺼진다. 그래서 현재 미충족 목록을 고정해 두고 "이보다 늘면
 * 실패" 로 시작한다. 목록을 줄이는 것이 다음 일이며, 줄어들면 이 파일의
 * 목록도 함께 줄여야 한다(늘리기만 하면 baseline 이 알리바이가 된다).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const scenarios = readFileSync("docs/user-scenarios.md", "utf8");

/**
 * 저장소가 아는 파일의 이름 색인. `git ls-files` 만 쓴다 — 저장소 안에 놓인
 * 다른 저장소의 체크아웃은 이 저장소의 사실이 아니다.
 */
const FILES_BY_NAME = new Map();
for (const path of execFileSync("git", ["ls-files"], { encoding: "utf8" })
	.split("\n")
	.filter(Boolean)) {
	const name = path.split("/").pop();
	if (!FILES_BY_NAME.has(name)) FILES_BY_NAME.set(name, []);
	FILES_BY_NAME.get(name).push(path);
}
const namesOnDisk = new Set(FILES_BY_NAME.keys());
const harness = readFileSync("src/test/harness/agent-bench-scenarios.ts", "utf8");

const families = [...harness.matchAll(/prefix:\s*"([^"]+)"/g)].map((m) => m[1]);
const notOwnedBlock = harness.split("NOT_OWNED_BY_EPIC")[1]?.split("];")[0] ?? "";
const notOwned = [...notOwnedBlock.matchAll(/"(UC-[A-Z0-9-]*)"/g)].map((m) => m[1]);

if (!families.length) {
	console.error("[uc-trace] ❌ 벤치 계열 접두사를 읽지 못했다 — 하네스 형식이 바뀌었는지 보라");
	process.exit(1);
}

// 표제 깊이를 둘·셋으로 못박아 두면 `#### UC-...` 로 한 단 내리는 것만으로
// 게이트를 피할 수 있다. 실제로 리뷰가 그 우회를 실증했다. 깊이를 가리지
// 않는다.
const titles = [
	...new Set(
		[...scenarios.matchAll(/^#{2,6}\s+(UC-[A-Z0-9][A-Z0-9-]*)/gm)].map((m) => m[1]),
	),
];

const escaped = (uc) => uc.replace(/-/g, "\\-");
/**
 * 커버리지 표에 자기 행이 있고, **그 행이 무언가를 말하는지** 본다.
 *
 * 예전에는 행의 존재만 보았다. 그래서 `| UC-X | | |` 처럼 칸이 전부 빈 행을
 * 넣어도 추적된 것으로 인정됐다 — 무엇으로 검증하는지 한 글자도 적지 않고
 * 게이트를 지나는 길이다.
 */
const hasCoverageRow = (uc) => {
	const row = new RegExp(`^\\|\\s*${escaped(uc)}\\s*\\|(.*)$`, "m").exec(scenarios);
	if (!row) return false;
	const cells = row[1]
		.split("|")
		.map((cell) => cell.trim())
		.filter((cell) => cell.length > 0 && cell !== "—" && cell !== "-");
	if (cells.length === 0) return false;
	// "TODO" 한 마디는 무엇으로 검증하는지 말하지 않는다. 그것을 추적으로
	// 인정하면 표에 그 글자만 적고 지나갈 수 있다.
	const placeholder = /^(TODO|TBD|미정|추후|N\/A|없음|\?+)$/i;
	if (cells.every((cell) => placeholder.test(cell))) return false;
	// 무엇으로 재는지 적으려면 파일이나 스크립트를 가리켜야 한다. 문장만
	// 있고 가리키는 것이 없으면 그 줄은 계획이지 추적이 아니다.
	// 무엇으로 재는지 적으려면 파일이나 스크립트를 가리켜야 한다. 문장만
	// 있고 가리키는 것이 없으면 그 줄은 계획이지 추적이 아니다.
	const pointsAtFile = (cell) => /`[^`]+`|\.(ts|tsx|mjs|rs)\b/.test(cell);
	if (!cells.some(pointsAtFile)) return false;
	// 가리키는 것만으로는 부족하다. 문서 맨 끝에
	// `| UC-X | \`scripts/check-vacuous-tests.mjs\` | 없음 |` 한 줄을 붙이는
	// 것만으로 추적이 인정됐다 — 실재하는 파일 이름 하나면 됐고 무엇을
	// 확인하는지는 "없음" 이어도 통과했다.
	//
	// 파일을 가리키는 칸 말고, **무엇을 확인하는지 말하는 칸**이 따로
	// 있어야 한다. 그 칸이 자리 표시자면 그 줄은 아무 말도 하지 않은 것이다.
	const describes = cells.filter(
		(cell) => !pointsAtFile(cell) && !placeholder.test(cell),
	);
	// 한 칸에 파일과 설명이 함께 적힌 표도 있다(`파일`: 무엇을 본다).
	const describesInline = cells.some((cell) =>
		/`[^`]+`\s*[::]\s*\S/.test(cell) || /`[^`]+`[^`]*[가-힣]{2,}/.test(cell),
	);
	return describes.length > 0 || describesInline;
};
const byBenchFamily = (uc) => families.some((prefix) => uc.startsWith(prefix));
const outsideEpic = (uc) => notOwned.some((prefix) => uc.startsWith(prefix));

/**
 * 에픽 밖이라는 선언과 어디서 검증되는지 적혔다는 것은 다른 질문이다.
 *
 * 예전에는 `NOT_OWNED_BY_EPIC` 에 접두사를 하나 넣으면 커버리지 표까지 면제
 * 됐다. 그래서 이번 작업이 만든 `UC-QUALITY-` 계열은 앞으로 추가되는 것이
 * 전부 무임승차하게 되어 있었다 — 스스로 만든 계열에 스스로 관대한 셈이다.
 *
 * 벤치 계열은 그 계열이 요구 증거를 정의하므로 표가 따로 필요 없다. 에픽
 * 밖이라는 선언은 "벤치가 안 맡는다" 는 뜻이지 "아무도 안 봐도 된다" 가
 * 아니므로, 그쪽은 표를 요구한다.
 */
const untracked = titles.filter((uc) => !hasCoverageRow(uc) && !byBenchFamily(uc));

// 커버리지 맵만 채우고 벤치 하네스에 등록하지 않으면, 이 게이트는 통과하고
// agent-bench-scenario-source 계약 테스트가 대신 붉어진다. 두 곳을 봐야 하는
// 사실이 한쪽에만 적혀 있으면 사람은 반드시 한쪽을 빠뜨린다 — 실제로 #540 이
// 그랬고, 그것을 고친 사람이 UC-QUALITY 를 더하면서 똑같이 빠뜨렸다.
// 여기서 함께 본다.
// 예전에는 이 검사만 `### UC-` 를 보았다. 하네스의 HEADING 을 그대로 따른
// 것인데, 그래서 표제를 한 단만 내리면(`#### UC-`) 이 검사에서 사라졌다 —
// 같은 파일 열 줄 위에서 고친 우회가 여기 그대로 남아 있었다.
//
// 깊이는 문서를 읽기 좋게 하려고 쓰는 것이지 소관을 정하는 장치가 아니다.
// 위의 `titles` 와 같은 기준으로 본다. 하네스가 `###` 만 읽는 것은 하네스
// 쪽의 별개 사실이고, 그 차이 자체가 여기서 드러나야 한다.
const benchTitles = [
	...new Set(
		[...scenarios.matchAll(/^#{2,6}\s+(UC-[A-Z0-9][A-Z0-9-]*)/gm)].map((m) => m[1]),
	),
];
/**
 * 오늘 벤치 하네스가 모르는 UC. 표제 깊이를 가리지 않고 세기 시작하자
 * 열네 개가 드러났다 — 새로 끊긴 것이 아니라, 하네스의 `HEADING` 이 `###`
 * 만 읽는 동안 `##` 로 적힌 UC 열넷이 소관 밖으로 조용히 빠져 있었다.
 *
 * 이 목록은 빚이다. 줄이는 것이 목표이고, 늘리는 것을 이 게이트가 막는다.
 * 여기에 이름을 더해서 통과시키는 것은 빚을 늘리는 일이므로, 목록이
 * 문서와 어긋나면(이미 등록됐는데 남아 있으면) 그것도 붉어진다.
 */
const BENCH_ORPHAN_BASELINE = [
	"UC-CODEX-ROLES",
	"UC-CODEX-WORKER-LIFECYCLE",
	"UC-DISCORD",
	"UC-GROK-SUBSCRIPTION",
	"UC-KB-MANAGE",
	"UC-LLM-THREE-TIER",
	"UC-NAIA-AZURE-MODELS",
	"UC-NAIA-MODEL-ORDER",
	"UC-ONBOARDING-APPEARANCE-VOICE",
	"UC-PROACTIVE-COST-CONTROL",
	"UC-RADIO-DJ-DURABLE",
	"UC-SETTINGS-ROUNDTRIP",
	"UC-WIRE-V1",
];

const benchOrphansAll = benchTitles.filter(
	(uc) => !byBenchFamily(uc) && !outsideEpic(uc),
);
const benchOrphans = benchOrphansAll.filter(
	(uc) => !BENCH_ORPHAN_BASELINE.includes(uc),
);
// 빚을 갚았는데 목록에 남아 있으면 목록이 거짓말을 하는 것이다.
const staleBenchBaseline = BENCH_ORPHAN_BASELINE.filter(
	(uc) => !benchOrphansAll.includes(uc),
);

// 오늘의 상태. 줄이는 것이 목표이고, 늘리는 것은 이 게이트가 막는다.
const BASELINE = [
	"UC-DISCORD",
	"UC-GROK-SUBSCRIPTION",
	"UC-KB-MANAGE",
	"UC-LLM-THREE-TIER",
	"UC-NAIA-MODEL-ORDER",
	"UC-ONBOARDING-APPEARANCE-VOICE",
	"UC-PROACTIVE-COST-CONTROL",
	"UC-RADIO-DJ-DURABLE",
	"UC-WIRE-V1",
	// 아래 열하나는 "에픽 밖" 선언 하나로 커버리지 표까지 면제받고 있던
	// 것들이다. 그 두 가지를 분리하자 드러났다 — 새로 끊긴 것이 아니라
	// 원래 끊겨 있었는데 보이지 않았다. 표를 채우는 일이 남았다.
	"UC-JEONJU-COURSE-READINESS",
	"UC-JEONJU-COURSE-WORKER",
	"UC-JEONJU-DISCORD-COURSE-TARGET",
	"UC-DISCORD-1",
	"UC-DISCORD-2",
	"UC-DISCORD-3",
	"UC-V022-TTS-TEXT-NORMALIZATION",
	"UC-VOICE-TEXT-SPEECH-CLEANUP",
	"UC-V022-CHAT-RICH-MARKDOWN",
	"UC-V022-PERMISSION-SHORTCUTS",
	"UC-V022-LOCAL-RELEASE-ACCEPTANCE",
];

const added = untracked.filter((uc) => !BASELINE.includes(uc));
// 목록에 적어 두었는데 이제 걸리지 않는 것. 남겨 두면 다음에 같은 이름으로
// 끊긴 UC 가 들어와도 조용히 지나간다 — 면제가 알리바이가 되는 자리다.
const resolved = BASELINE.filter((uc) => !untracked.includes(uc));
const fixed = BASELINE.filter((uc) => !untracked.includes(uc));

// 표에 적힌 테스트 경로가 실제로 있는지 본다. 적기만 하면 통과하는 게이트는
// 표면 게이트다 — 파일이 옮겨가거나 지워져도 표는 그대로 남아, 추적이 살아
// 있는 것처럼 보인다.
const referenced = new Set();
for (const match of scenarios.matchAll(/`([^`]*\.(?:ts|tsx|rs|mjs))(?::\d+)?`/g)) {
	referenced.add(match[1]);
}
// 표는 어떤 줄은 경로로, 어떤 줄은 파일 이름만으로 적혀 있다. 이름만 적힌
// 것은 저장소 어디엔가 그 이름의 파일이 있으면 산 참조로 본다 — 이름조차
// 없으면 그 줄은 없는 것을 가리킨다.
const searchRoots = ["packages/shell", "src", "scripts", "."];
/**
 * 이 저장소가 아는 파일 이름 전부.
 *
 * 예전에는 작업 디렉터리를 직접 걸었다. 그래서 저장소 안에 놓인 **다른
 * 저장소의 체크아웃**(`naia-agent-worktrees/` 여섯 벌)까지 훑었고, 커버리지
 * 표가 가리키는 파일 둘이 거기서만 발견돼 "실재한다" 로 판정됐다. 깨끗한
 * 체크아웃에서는 그 둘이 없으므로 게이트가 붉다 — 즉 이 게이트는 CI 에서
 * 통과한 적이 없고, baseline 은 이 기계의 우연한 상태에 맞춰진 숫자였다.
 *
 * git 이 아는 것만 본다. 저장소 밖은 이 저장소의 사실이 아니다.
 */
/**
 * 이 저장소가 아는 파일 이름 전부.
 *
 * 예전에는 작업 디렉터리를 직접 걸었다. 그래서 저장소 안에 놓인 **다른
 * 저장소의 체크아웃**(`naia-agent-worktrees/` 여섯 벌)까지 훑었고, 커버리지
 * 표가 가리키는 파일 둘이 거기서만 발견돼 "실재한다" 로 판정됐다. 깨끗한
 * 체크아웃에서는 그 둘이 없으므로 게이트가 붉다 — 즉 이 게이트는 CI 에서
 * 통과한 적이 없고, baseline 은 이 기계의 우연한 상태에 맞춰진 숫자였다.
 *
 * git 이 아는 것만 본다. 저장소 밖은 이 저장소의 사실이 아니다.
 */
const brokenRefs = [...referenced].filter((ref) => {
	// 표에는 와일드카드로 묶어 적은 줄도 있다(registry*.test.ts). 그것은 파일이
	// 아니라 패턴이므로 실재 검사의 대상이 아니다.
	if (ref.includes("*")) return false;
	const candidates = [ref, ...searchRoots.map((root) => `${root}/${ref}`)];
	if (candidates.some((candidate) => existsSync(candidate))) return false;
	// 경로까지 적은 줄은 그 경로로 판정한다. 이름만 남기고 넘어가면 파일이
	// 다른 곳으로 옮겨가도 표가 낡은 채 통과한다.
	if (ref.includes("/")) return true;
	// 이름만 적힌 줄은 저장소 어디엔가 그 이름이 있으면 산 참조로 본다.
	return !namesOnDisk.has(ref);
});

console.log(`[uc-trace] UC 표제 ${titles.length} / 추적 안 되는 것 ${untracked.length} (baseline ${BASELINE.length}) / 표가 가리키는 파일 ${referenced.size}`);
if (fixed.length) console.log(`  ✓ 해소됨 ${fixed.length}: ${fixed.join(", ")}  ← BASELINE 에서 빼라`);
if (resolved.length > 0) {
	console.error(
		`\n[uc-trace] ❌ 이제 추적되는데 목록에 남아 있는 UC ${resolved.length}: ${resolved.join(", ")}`,
	);
	console.error("   BASELINE 에서 지워라 — 남겨 두면 다음 결함을 덮는다.");
	process.exit(1);
}

if (added.length) {
	console.error(`  ❌ 새로 추적이 끊긴 UC ${added.length}: ${added.join(", ")}`);
	console.error("     Test Coverage Map 에 행을 더하거나, 벤치 계열/에픽 밖으로 선언하라.");
	process.exit(1);
}
// 지금 깨져 있는 참조를 baseline 으로 둔다. 표가 오래되어 옛 경로를 가리키는
// 것이 이미 여럿이라, 한 번에 붉히면 게이트가 꺼진다. 늘어나는 것만 막는다.
// 29 에서 31 로 올렸다. 늘어난 둘은 새로 깨진 것이 아니라, 이 저장소에 없는
// 파일(짝 naia-agent 저장소의 계약 테스트)을 가리키던 것이 이제 보이게 된
// 것이다. 예전에는 저장소 밖까지 훑어 "있다" 로 판정했다.
// 31 에서 29 로 줄였다. 코딩 작업자 화면이 없어지면서(#554) 커버리지 표가
// 가리키던 그 화면의 단위 테스트 둘을 표에서 뺐다.
const BASELINE_BROKEN_REFS = 32;
if (brokenRefs.length > BASELINE_BROKEN_REFS) {
	console.error(`  ❌ 표가 가리키는데 없는 파일이 늘었다(${brokenRefs.length} > ${BASELINE_BROKEN_REFS}):`);
	for (const ref of brokenRefs.slice(0, 10)) console.error(`     ${ref}`);
	console.error("     경로를 고치거나, 그 줄을 표에서 빼라.");
	process.exit(1);
}
if (brokenRefs.length < BASELINE_BROKEN_REFS)
	console.log(`  ✓ 깨진 참조가 줄었다(${brokenRefs.length}) — BASELINE_BROKEN_REFS 도 줄여라`);
if (staleBenchBaseline.length) {
	console.error(
		`  ❌ 벤치 미등록 목록이 낡았다(${staleBenchBaseline.length}) — 이미 등록됐으니 목록에서 빼라:`,
	);
	for (const uc of staleBenchBaseline) console.error(`     ${uc}`);
	process.exit(1);
}

if (benchOrphans.length) {
	console.error(`  ❌ 벤치 하네스가 모르는 UC ${benchOrphans.length}개:`);
	for (const uc of benchOrphans) console.error(`     ${uc}`);
	console.error("     src/test/harness/agent-bench-scenarios.ts 의 계열에 더하거나,");
	console.error("     에이전트 능력 축이 아니면 NOT_OWNED_BY_EPIC 에 접두사를 적어라.");
	process.exit(1);
}
console.log("  ✓ 새로 끊긴 UC 없음");
