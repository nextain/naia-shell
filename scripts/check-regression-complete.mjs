/**
 * 배포 전 회귀가 실제로 전부 돌았는지 본다.
 *
 * 왜 필요한가: 기계마다 자기 몫을 돌리면 각자는 "내 몫은 됐다" 고 말할 수
 * 있지만, 그것을 합쳐도 전체가 덮였는지는 아무도 모른다. 123개 중 무엇이
 * 한 번도 실행되지 않았는지 세는 자리가 없으면, 돌지 않은 것이 통과처럼
 * 보인다 — 리눅스 음성 결함이 넉 달 산 이유가 그것이었다.
 *
 * 무엇을 보는가: docs/regression-runs/ 의 기록을 모아
 *   1) 인벤토리의 모든 스펙이 어느 기계엔가 배정되었는가
 *   2) 배정되었지만 요구 환경이 없던 것은 무엇인가(실행 전 예측이다)
 *   3) 실패한 기계가 있는가
 * 를 판정한다. 건너뛴 것은 통과가 아니다.
 *
 * 기록이 어느 스펙 목록을 잰 것인지는 **지문** 으로 본다. 그 계산은
 * scripts/lib/inventory-digest.mjs 한 곳이 하고, 파일의 원문 바이트가 아니라
 * 내용을 잰다 — 원문 바이트로 잡았을 때 윈도우 체크아웃의 CRLF 가 같은 목록에
 * 다른 해시를 주어, 두 기계가 서로의 기록을 영원히 무효로 보았다. 규칙을 바꾸기
 * 전에 남은 기록을 살리려고 **이행 기간** 동안 옛 규칙의 지문도 받는다. 그
 * 예외와 만료 조건은 아래 `acceptedDigests` 에 적혀 있다.
 *
 * 쓰는 법: node scripts/check-regression-complete.mjs [--max-age-hours=24]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	inventoryDigestFromFile,
} from "./lib/inventory-digest.mjs";
import {
	machineInTargets,
	releaseTargets,
	specInTargets,
} from "./lib/release-target.mjs";
import { isRetestRecord } from "./lib/retest-selection.mjs";

const args = process.argv.slice(2);
const maxAgeHours = Number(
	args.find((a) => a.startsWith("--max-age-hours="))?.split("=")[1] ?? 24,
);

const INVENTORY = "docs/e2e-inventory.json";
const RUNS = "docs/regression-runs";

if (!existsSync(INVENTORY)) {
	console.error(`[regression-complete] ❌ ${INVENTORY} 이 없다`);
	process.exit(1);
}
const inventory = JSON.parse(readFileSync(INVENTORY, "utf8"));
/**
 * 이번 배포가 나가는 운영체제. 나가지 않는 운영체제에서만 도는 스펙과 그
 * 운영체제의 기계는 판정에 넣지 않는다 — `scripts/lib/release-target.mjs`.
 * 빠진 것은 아래에서 이름과 함께 출력한다. 조용히 사라지면 통과처럼 보인다.
 */
const { targets, source: targetSource } = releaseTargets();
const outOfTarget = inventory.specs.filter((s) => !specInTargets(s, targets)).map((s) => s.spec);
const all = new Set(
	inventory.specs.filter((s) => specInTargets(s, targets)).map((s) => s.spec),
);
if (targets) {
	console.log(
		`[regression-complete] 배포 대상 ${targets.join(", ")} (${targetSource}) — 스펙 ${inventory.specs.length} 중 ${all.size}개가 조건이다`,
	);
	if (outOfTarget.length) {
		console.log(`  대상 운영체제에서 돌지 않아 조건에서 뺀 스펙 ${outOfTarget.length}개: ${outOfTarget.join(", ")}`);
	}
}

if (!existsSync(RUNS)) {
	console.error(`[regression-complete] ❌ ${RUNS} 이 없다 — 아직 아무 기계도 회귀를 돌리지 않았다`);
	console.error(`   스펙 ${all.size}개가 전부 미실행이다. 돌지 않은 것은 통과가 아니다.`);
	process.exit(1);
}

const cutoff = Date.now() - maxAgeHours * 3600_000;
/**
 * 기록이 이 코드·이 스펙 목록에서 나왔는지 본다.
 *
 * 위조를 막지는 못한다 — 저장소에 커밋할 수 있는 사람이면 기록 파일도 쓸 수
 * 있고, 그것을 코드로 구별할 방법은 없다. 여기서 막는 것은 **실수**다.
 * 인벤토리가 바뀐 뒤의 낡은 기록, 다른 브랜치에서 돈 기록, 그리고 시계가
 * 어긋난 기록. 이것들은 악의 없이도 생기고, 생기면 "전부 덮였다" 는 거짓
 * 결론으로 이어진다.
 */
const inventoryDigest = inventoryDigestFromFile(INVENTORY);

/**
 * 지금 인벤토리를 잰 기록으로 인정하는 지문들.
 *
 * 정본은 첫 번째, `scripts/lib/inventory-digest.mjs` 의 정규화 지문이다. 나머지
 * 둘은 **이행 기간** 동안만 받는 옛 규칙(원문 바이트 sha256)의 LF·CRLF 판이다.
 *
 * 왜 받는가: 규칙을 바꾸기 전에 이미 두 기계가 오늘의 실측을 push 했고, 그
 * 기록들은 옛 규칙으로 지문을 적었다. 새 규칙만 받으면 고치자마자 그 기록들이
 * 전부 무효가 되어, 결함을 고치는 일이 이미 잰 것을 지우는 일이 된다.
 *
 * 언제 지우는가: **다음에 인벤토리가 바뀔 때** 다. 그때부터 옛 규칙의 지문은
 * 어차피 지금 목록을 가리키지 않으므로 받을 이유가 없고, 그 뒤의 기록은 전부
 * 새 규칙으로 남는다. `src/test/inventory-digest.contract.test.ts` 의 마지막
 * 계약이 그 시점에 붉어져 이 대목을 지우라고 말한다.
 */
const acceptedDigests = new Map([
	[inventoryDigest, "정규화 지문"],
]);
// 이행 기간(옛 규칙 LF·CRLF 원문 지문 인정)은 2026-09-07 인벤토리 변경(#567, 119→109)으로
// 끝났다. 그 전 기록은 다른 목록을 잰 것이므로 다시 돌린다.

/**
 * 지금 회귀를 나눠 맡는 기계들. 명단이 유일한 출처다.
 *
 * 게이트가 명단을 보지 않으면 러너와 판정 기준이 갈린다 — 러너는 명단에 없는
 * 기계를 거부하는데, 게이트는 그 기계의 기록을 커버리지로 세었다. 실제로
 * 명단에 한 번도 없던 이름의 기록 여섯이 판정에 섞여, 신선한 실패를 낡은
 * 통과가 덮고 있었다.
 */
const ROSTER = join(RUNS, "machines.json");
const roster = existsSync(ROSTER)
	? JSON.parse(readFileSync(ROSTER, "utf8"))
	: { machines: [] };
const activeMachines = new Set(
	(roster.machines ?? [])
		.filter((m) => m.active !== false && machineInTargets(m, targets))
		.map((m) => m.name),
);
/** 활성이지만 이번 배포 대상 운영체제가 아닌 기계. 그 기록은 판정에 넣지 않는다. */
const offTargetMachines = new Map(
	(roster.machines ?? [])
		.filter((m) => m.active !== false && !machineInTargets(m, targets))
		.map((m) => [m.name, m.os]),
);
if (offTargetMachines.size) {
	console.log(
		`  배포 대상이 아닌 운영체제의 기계 ${offTargetMachines.size}대는 이번 판정에서 뺀다: ${[...offTargetMachines].map(([name, os]) => `${name}(${os})`).join(", ")}`,
	);
}
/**
 * 기계가 예전에 쓰던 이름. 같은 기계인데 이름만 바뀐 기록을 "모르는 기계" 로
 * 말하면 사람이 헷갈린다 — 실제로 이 저장소의 첫 기록들이 호스트명을 따
 * 지은 이름으로 남아 있었고, 명단을 만들며 이름을 바꾸었다.
 */
const formerNames = new Map();
for (const machine of roster.machines ?? []) {
	for (const old of machine.formerNames ?? []) formerNames.set(old, machine.name);
}

const rejected = [];
/** 옛 규칙의 지문으로 들어온 기록. 이행 기간이 끝나면 비어야 한다. */
const legacyAccepted = [];
/**
 * 실패만 다시 돌린 기록. 판정에서 뺀다.
 *
 * 왜 빼는가: 재시험은 그 기계의 몫 **전체**가 아니라 지난 실행에서 실패했거나
 * 돌지 못한 것만 잰다. 그것을 전체 기록으로 세면, 실패 셋을 다시 돌려 통과시킨
 * 것만으로 "다 덮였다" 가 된다 — 실패 우선 고리가 곧 거짓 초록이 되는 길이다.
 * 재시험이 초록이면 그다음에 전체를 한 번 돌아 기록을 확정해야 한다.
 *
 * 지우지는 않는다. 몇 개가 있었는지는 화면에 남겨, 사람이 "확정 실행을 아직
 * 안 돌았다" 를 알 수 있게 한다.
 */
const retests = [];
const inWindow = readdirSync(RUNS)
	// 기계 명단은 기록이 아니다. 같은 디렉터리에 있어 확장자만 보면 기록으로
	// 읽히고, 기계 이름이 없어 판정이 어긋난다.
	.filter((f) => f.endsWith(".json") && f !== "machines.json")
	.map((f) => ({ file: f, record: JSON.parse(readFileSync(join(RUNS, f), "utf8")) }))
	.filter(({ file, record }) => {
		if (!record.machine) {
			rejected.push(`${file}: 기계 이름이 없다 — 회귀 기록이 아니다`);
			return false;
		}
		if (offTargetMachines.has(record.machine)) {
			rejected.push(`${file}: ${record.machine} 은 이번 배포 대상 운영체제(${targets.join(", ")})의 기계가 아니다`);
			return false;
		}
		if (activeMachines.size > 0 && !activeMachines.has(record.machine)) {
			const renamed = formerNames.get(record.machine);
			rejected.push(
				renamed
					? `${file}: ${record.machine} 은 ${renamed} 의 옛 이름이다 — 명단을 만들기 전의 기록이라 지금 판정에는 쓰지 않는다`
					: `${file}: ${record.machine} 은 명단에 없다 — 나눔에 참여하지 않는 기계의 기록이다`,
			);
			return false;
		}
		const when = Date.parse(record.finished ?? record.started ?? 0);
		if (Number.isNaN(when)) {
			rejected.push(`${file}: 시각을 읽을 수 없다`);
			return false;
		}
		// 미래 날짜는 창을 영원히 통과한다. 시계가 어긋났거나 손으로 적은
		// 것이고, 어느 쪽이든 실행 시각이 아니다.
		if (when > Date.now() + 5 * 60_000) {
			rejected.push(`${file}: 실행 시각이 미래다`);
			return false;
		}
		if (when < cutoff) return false;
		const stamp = record.ranOn;
		// 지문이 없는 기록은 어느 스펙 목록을 잰 것인지 알 수 없다. 한때는
		// 옛 형식을 살리려고 통과시켰는데, 그러면 그 면제를 받은 낡은 통과가
		// 신선한 실패를 덮는다 — 실제로 그 일이 있었다. 알 수 없는 것은 세지
		// 않는다.
		if (!stamp?.inventorySha256) {
			rejected.push(`${file}: 어느 스펙 목록을 잰 것인지 알 수 없다(지문 없음)`);
			return false;
		}
		if (isRetestRecord(record)) {
			retests.push(
				`${file}: 재시험(${record.retestOf ?? "원 기록 미상"}) — 몫 전체가 아니라 판정에서 뺀다`,
			);
			return false;
		}
		if (!acceptedDigests.has(stamp.inventorySha256)) {
			rejected.push(`${file}: 다른 스펙 목록에서 돌았다`);
			return false;
		}
		if (stamp.inventorySha256 !== inventoryDigest) {
			// 버리지는 않되 조용히 넘기지도 않는다. 이행 기간이 언제 끝나는지를
			// 사람이 보고 판단해야 한다.
			legacyAccepted.push(
				`${file}: ${acceptedDigests.get(stamp.inventorySha256)}`,
			);
		}
		return true;
	})
	.map(({ record }) => record);

/**
 * 기계마다 **가장 최근 실행 하나**만 본다.
 *
 * 왜: 예전에는 창 안의 기록을 전부 보았다. 그래서 오전에 실패하고, 원인을
 * 고치고, 오후에 다시 돌려 전부 통과시켜도 오전의 실패 기록이 창에 남아
 * 게이트가 계속 붉었다. CI 창이 72시간이므로 사흘간 그랬다. 고친 것이
 * 반영되지 않는 게이트는 사람이 곧 무시하게 된다.
 *
 * 옛 기록을 지우는 것으로 풀면 안 된다 — 그러면 실패를 지워서 초록을 만드는
 * 길이 열리고, 그것은 이 프로세스가 없애려는 바로 그 형태다. 기록은 남기되
 * 판정은 최신으로 한다.
 */
const latestByMachine = new Map();
for (const record of inWindow) {
	const when = Date.parse(record.finished ?? record.started ?? 0);
	// 기계마다가 아니라 **기계와 등급마다** 최신을 본다.
	//
	// 등급은 따로 돌리는 것이 자연스럽다 — 자격증명이 필요한 것과 장치가
	// 필요한 것은 준비가 다르고, 문서도 한 기계에서 여러 종류를 동시에
	// 돌리지 말라고 적는다. 그런데 기계 단위로만 최신을 고르면 나중 등급이
	// 앞 등급의 기록을 통째로 지운다. 실제로 두 기계가 세 등급을 나눠 돌아
	// 123개를 전부 통과시켜도 게이트는 105개가 미실행이라고 말했다.
	const key = `${record.machine}::${[...(record.tiers ?? [])].sort().join(",")}`;
	const previous = latestByMachine.get(key);
	if (!previous || when > previous.when) latestByMachine.set(key, { when, record });
}
const records = [...latestByMachine.values()].map((entry) => entry.record);
const superseded = inWindow.length - records.length;

if (retests.length > 0) {
	console.log(
		`  재시험 기록 ${retests.length}개 — 실패만 다시 돌린 것이라 "전체 덮임" 판정에는 넣지 않는다:`,
	);
	for (const line of retests) console.log(`    ${line}`);
	console.log(
		"    재시험이 초록이면 전체를 한 번 돌려 기록을 확정하라 — 그 기록만이 덮임을 말할 수 있다.",
	);
}

if (legacyAccepted.length > 0) {
	console.log(
		`  옛 규칙의 지문으로 받은 기록 ${legacyAccepted.length}개 (이행 기간 — 다음 인벤토리 변경 때 이 예외를 지운다):`,
	);
	for (const line of legacyAccepted) console.log(`    ${line}`);
}

if (rejected.length > 0) {
	console.log(`  판정에서 뺀 기록 ${rejected.length}개:`);
	for (const reason of rejected) console.log(`    ${reason}`);
	const staleList = rejected.filter((r) => r.includes("다른 스펙 목록"));
	if (staleList.length > 0) {
		console.log(
			`  ↳ 그중 ${staleList.length}개는 스펙 목록이 바뀐 뒤의 옛 기록이다.` +
				" 인벤토리가 바뀌면 그 전 기록은 다른 대상을 잰 것이므로 쓸 수 없다 —" +
				" 기계들이 다시 돌려야 한다.",
		);
	}
}

if (!records.length) {
	console.error(`[regression-complete] ❌ 최근 ${maxAgeHours}시간 안의 회귀 기록이 없다`);
	process.exit(1);
}

const covered = new Set();
const planned = new Set();
const skipped = new Map();
const failedMachines = [];
/** 다시 돌리면 통과하는 스펙. 보여만 주고 판정에는 넣지 않는다. */
const flakyByMachine = [];
const notRun = [];
/** 전제가 깨진 실행. 그 실패는 제품의 것이 아니므로 커버리지가 아니다. */
const premiseBroken = [];
/** 전제를 재지 않은 옛 기록. 세되, 무엇을 모르는지 밝힌다. */
const premiseUnmeasured = [];
for (const record of records) {
	// 이 실행에 뇌가 있었는가. 없으면 그 스펙들은 앱만 뜬 채 돌았고, 실패는
	// 저마다 다른 자리에서 난다 — 2026-09-06 naia-os-3090 의 자격증명 실행이
	// 서른여덟 개 중 서른일곱을 그렇게 돌렸다. 그 기록을 덮인 것으로 세면
	// 다음 사람이 없는 제품 결함을 찾는다.
	const premise = record.premise;
	if (premise === "invalid") {
		const reason = record.premiseSignals?.reason ?? "이유가 적히지 않았다";
		premiseBroken.push(`${record.machine}: ${reason}`);
	} else if (premise === undefined) {
		// 옛 기록에는 이 칸이 없다. 세되 무엇을 모르는지 말한다 — 알 수 없는
		// 것을 아는 것처럼 세면 그 숫자가 다시 사람을 속인다.
		premiseUnmeasured.push(record.machine);
	}

	// 덮였다고 셀 수 있는 것은 실제로 끝까지 돈 것뿐이다. planned 는 무엇을
	// 돌리려 했는지일 뿐이고, 그것을 커버로 세면 wdio 가 죽어도 전수 커버로
	// 보고된다. 옛 기록의 assigned 는 계획이었으므로 planned 로 읽는다.
	if (premise !== "invalid") {
		for (const spec of record.executed ?? []) covered.add(spec);
	}
	for (const spec of record.planned ?? record.assigned ?? []) planned.add(spec);
	for (const [spec, envs] of Object.entries(record.envMissingBeforeRun ?? record.skippedForMissingEnv ?? {})) {
		skipped.set(spec, envs);
	}
	// prerequisites-missing 은 "돌렸는데 깨졌다" 가 아니라 "돌리지 못했다" 다.
	// 둘 다 통과가 아니지만 사람이 볼 때 구별돼야 한다 — 하나는 코드를 고칠
	// 일이고 하나는 기계를 준비할 일이다.
	if (record.status === "prerequisites-missing") {
		notRun.push(`${record.machine}: ${(record.missingPrerequisites ?? []).join(", ")}`);
	} else if (record.status !== "passed") {
		failedMachines.push(`${record.machine}(${record.status})`);
	}
	// 다시 돌리면 통과하는 스펙은 통과가 아니다. 다만 매번 실패하는 것과
	// 구별돼야 사람이 진짜 회귀를 찾을 수 있다. 판정에는 넣지 않고 보여만
	// 준다 — 이 숫자로 초록을 만들 수는 없다.
	for (const spec of record.flakySpecs ?? []) {
		flakyByMachine.push(`${record.machine}: ${spec}`);
	}
}

const never = [...all].filter((s) => !covered.has(s));
if (flakyByMachine.length) {
	console.log(
		`  가끔 실패하는 스펙 ${flakyByMachine.length}개 — 다시 돌리면 통과하지만 통과로 세지 않는다:`,
	);
	for (const line of flakyByMachine) console.log(`     ${line}`);
}
const machines = [...new Set(records.map((r) => r.machine))];

console.log(
	`[regression-complete] 기계 ${machines.length}대(${machines.join(", ")}) / 최근 ${maxAgeHours}시간` +
		(superseded > 0 ? ` — 기계별 최신 실행만 본다(더 오래된 기록 ${superseded}개는 판정에서 뺐다)` : ""),
);
console.log(`  스펙 ${all.size} 중 실제로 돈 것 ${covered.size}, 돌리려 했던 것 ${planned.size}, 아무도 맡지 않은 것 ${never.length}`);
console.log(`  배정되었으나 요구 환경이 없던 것 ${skipped.size}`);

let failed = false;
if (premiseUnmeasured.length) {
	console.log(
		`  전제를 재지 않은 기록 ${premiseUnmeasured.length}개(${[...new Set(premiseUnmeasured)].join(", ")}) — 미측정. 그 실행에 뇌가 있었는지 알 수 없다.`,
	);
}
if (premiseBroken.length) {
	console.error(`  ❌ 전제 불성립 — 다시 돌려야 한다 (${premiseBroken.length}개):`);
	for (const line of premiseBroken) console.error(`     ${line}`);
	console.error(
		"     에이전트 없이 돈 세션의 실패는 제품의 것이 아니다. 이 기록은 덮인 것으로 세지 않는다.",
	);
	failed = true;
}
if (notRun.length) {
	console.error(`  ❌ 전제가 없어 돌리지 못한 기계 ${notRun.length}대:`);
	for (const line of notRun) console.error(`     ${line}`);
	console.error("     기계를 준비해야 한다. 돌리지 못한 것은 통과가 아니다.");
	failed = true;
}
if (failedMachines.length) {
	console.error(`  ❌ 실패한 기계: ${failedMachines.join(", ")}`);
	failed = true;
}
if (never.length) {
	console.error(`  ❌ 아무 기계도 맡지 않은 스펙 ${never.length}개:`);
	for (const spec of never.slice(0, 10)) console.error(`     ${spec}`);
	if (never.length > 10) console.error(`     … 그리고 ${never.length - 10}개 더`);
	console.error("     등급을 나눠 맡기거나, 왜 돌리지 않는지 적어라.");
	failed = true;
}
if (skipped.size) {
	console.error(`  ❌ 요구 환경이 없던 스펙 ${skipped.size}개 — 이것은 통과가 아니다:`);
	for (const [spec, envs] of [...skipped].slice(0, 10)) {
		console.error(`     ${spec} ← ${envs.join(", ")}`);
	}
	failed = true;
}
if (!failed) console.log("  ✓ 모든 스펙이 어느 기계엔가 배정되었고 건너뛴 것이 없다");

// 채널에 그대로 붙일 수 있는 한 줄. 형식은 docs/regression-runs/CHANNEL.md.
// 마스터가 각 기계의 DONE 을 모아 전체가 얼마나 덮였는지 알리는 자리다.
console.log(
	`\n[master] STATE ${all.size}개 중 덮인 것 ${covered.size}` +
		` · 아무도 맡지 않은 것 ${never.length}` +
		(failedMachines.length
			? ` · 실패한 기계 ${failedMachines.join(", ")}`
			: " · 실패한 기계 없음") +
		(notRun.length ? ` · 전제 미비 ${notRun.length}대` : "") +
		(premiseBroken.length ? ` · 전제 불성립 ${premiseBroken.length}개` : "") +
		`\n`,
);

process.exit(failed ? 1 : 0);
