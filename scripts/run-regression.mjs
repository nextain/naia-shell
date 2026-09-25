/**
 * 배포 전 회귀를 이 기계가 맡은 몫만큼 돌리고, 무엇을 돌렸는지 남긴다.
 *
 * 왜 이렇게 나누는가: 실기 스펙 123개는 한 기계에서 다 돌 수 없다. 자격증명이
 * 필요한 것, 그 기계의 장치(GPU·오디오·데스크톱 세션)가 필요한 것, 아무것도
 * 필요 없는 것이 섞여 있다. 나누려면 무엇이 무엇을 요구하는지 알아야 하고,
 * 그 목록은 build-e2e-inventory.mjs 가 만든다.
 *
 * 왜 결과를 파일로 남기는가: 기계마다 따로 돌면 전체가 통과했는지 아무도
 * 모른다. 각자 "내 몫은 됐다" 고 말하는 것으로는 배포 판단을 할 수 없다.
 * 남긴 기록을 check-regression-complete.mjs 가 모아 빈 곳을 찾는다.
 *
 * 쓰는 법:
 *   node scripts/run-regression.mjs --machine=<이름> --tier=deterministic_ci[,credentialed_live,native_local]
 *   node scripts/run-regression.mjs --machine=<이름> --tier=deterministic_ci --dry-run
 *   node scripts/run-regression.mjs --machine=<이름> --only-failed
 *
 * --only-failed 는 지난 기록에서 **실패했거나 아예 돌지 못한 것**만 다시 돌린다.
 * 실패 우선 고리([전체 → 실패만 재시험 → 고침 → 재시험 → 실패 0 → 전체 확정])의
 * 가운데 걸음이고, 그 기록에는 `kind: "retest"` 가 붙어 완결성 판정에서 빠진다.
 *
 * --dry-run 은 무엇을 돌릴지만 보여준다. 환경이 갖춰졌는지 먼저 볼 때 쓴다.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	rmSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { createServer } from "node:net";
import { basename } from "node:path";
import { delimiter, join, resolve } from "node:path";

/**
 * 선호 포트가 비어 있는지 확인하고, 이미 점유되어 있으면 OS가 할당하는
 * 빈 포트(listen on 0)에 바인드하여 실제 포트를 돌려준다.
 * 선호 포트가 비어 있을 때는 기본값으로 유지한다.
 */
function checkPortFree(port, host = "127.0.0.1") {
	return new Promise((resolve) => {
		const server = createServer();
		server.unref();
		server.once("error", () => resolve(false));
		server.listen(port, host, () => {
			server.close(() => resolve(true));
		});
	});
}

function getOsFreePort(host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, host, () => {
			const address = server.address();
			const port =
				typeof address === "object" && address !== null ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

async function resolveFreePort(preferredPort, host = "127.0.0.1") {
	if (await checkPortFree(preferredPort, host)) {
		return preferredPort;
	}
	const freePort = await getOsFreePort(host);
	console.log(
		`[regression] 선호 포트 ${preferredPort} 이 이미 점유되어 있어 OS 빈 포트 ${freePort} 로 대체한다`,
	);
	return freePort;
}
import {
	describeReclaimed,
	reclaimStrandedSidecars,
	surveyStrandedSidecars,
} from "../packages/shell/e2e-tauri/bgm-sidecar-lease.mjs";
import { e2eBinaryPath } from "../packages/shell/scripts/agent-pairing.mjs";
import { inventoryDigestFromFile } from "./lib/inventory-digest.mjs";
import {
	addPremiseSignals,
	countPremiseSignals,
	judgePremise,
} from "./lib/run-premise.mjs";
import { planGroups, wdioSpecArgs } from "./lib/regression-selection.mjs";
import {
	machineInTargets,
	osOfPlatform,
	releaseTargets,
	specInTargets,
	specRunsOn,
} from "./lib/release-target.mjs";
import {
	isRetestRecord,
	pickLatestRecord,
	retestSourceName,
	retestTargets,
} from "./lib/retest-selection.mjs";
import { createProgressTracker } from "./lib/wdio-progress.mjs";

const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const machine = value("machine");
const tiers = (value("tier") ?? "deterministic_ci").split(",").map((t) => t.trim()).filter(Boolean);
const dryRun = args.includes("--dry-run");
/**
 * 실패한 것만 다시 돌린다 (`--only-failed[=<기록 경로>]`).
 *
 * 오너가 정한 고리는 [전체 → 실패 → **실패만 재시험** → 고침 → 재시험 실패 0 →
 * 전체 한 번 확정] 이다. 예전에는 실패 하나를 다시 보려면 그 기계의 몫 전부를
 * 돌려야 했다 — 자격증명 등급이면 쉰다섯 개, 한 시간이다.
 */
/** 실패를 한 번 더 돌려 가끔 실패를 가르는 단계. 기본은 끔 — 실패 우선 루프가 대신한다. */
const classifyFlaky = args.includes("--classify-flaky");
const onlyFailedArg = args.find((a) => a === "--only-failed" || a.startsWith("--only-failed="));
const onlyFailed = onlyFailedArg !== undefined;
const onlyFailedFrom = onlyFailedArg?.includes("=")
	? onlyFailedArg.slice(onlyFailedArg.indexOf("=") + 1)
	: undefined;
/** `--tier` 를 사람이 직접 준 경우에만 재시험 목록을 그 등급으로 좁힌다. */
const tierGiven = value("tier") !== undefined;

// 채널에 그대로 붙일 한 줄. 성공/실패(prereq-missing) 경로 양쪽 DONE·BLOCKED 가
// 이 함수를 부르므로 모듈 최상위에 둔다 — 블록 안에 두면 성공 경로 최종 DONE 에서 ReferenceError.
function channelLine(state, rest) {
	return `[${machine}] ${state} ${rest}`;
}

if (!machine) {
	console.error(
		"사용법: node scripts/run-regression.mjs --machine=<이름> --tier=deterministic_ci[,credentialed_live,native_local] [--dry-run] [--only-failed[=<기록 경로>]]",
	);
	process.exit(2);
}

const INVENTORY = "docs/e2e-inventory.json";
if (!existsSync(INVENTORY)) {
	console.error(`${INVENTORY} 이 없다 — node scripts/build-e2e-inventory.mjs 를 먼저 돌려라`);
	process.exit(2);
}
const inventory = JSON.parse(readFileSync(INVENTORY, "utf8"));

const known = new Set(["deterministic_ci", "credentialed_live", "native_local"]);
const unknown = tiers.filter((t) => !known.has(t));
if (unknown.length) {
	console.error(`알 수 없는 등급: ${unknown.join(", ")} (쓸 수 있는 것: deterministic_ci, credentialed_live, native_local)`);
	process.exit(2);
}

/**
 * 함께 도는 기계들의 명단. `docs/regression-runs/machines.json` 이 한 곳이다.
 *
 * 왜 파일에 두는가: 기계마다 `--peers` 를 손으로 적으면 목록이 어긋난다.
 * 어긋나면 몫이 겹치거나 비는데, 그것은 기록만 보고는 알 수 없다 — 각자
 * "나는 내 몫을 다 돌았다" 고 말하기 때문이다.
 */
const ROSTER = "docs/regression-runs/machines.json";
const rosterFile = existsSync(ROSTER)
	? JSON.parse(readFileSync(ROSTER, "utf8"))
	: { machines: [] };
// 합류하지 않은 기계는 몫을 받지 않는다. 받으면 그 몫이 영영 비고, 완결성
// 판정은 그것을 "아무도 맡지 않았다" 로 붉힌다 — 옳은 판정이지만 사람은
// 그것을 회귀로 읽는다.
//
// 이번 배포 대상 운영체제의 기계끼리만 나눈다(`scripts/lib/release-target.mjs`).
// 대상이 아닌 운영체제의 기계가 몫을 받으면 게이트가 그 기록을 세지 않으므로
// 그 몫이 영영 빈다.
const { targets, source: targetSource } = releaseTargets();
const roster = {
	...rosterFile,
	machines: (rosterFile.machines ?? []).filter(
		(m) => m.active !== false && machineInTargets(m, targets),
	),
};
if (targets) {
	console.log(`[regression] 배포 대상 ${targets.join(", ")} (${targetSource})`);
}

/**
 * 이 기계가 정말 그 이름의 기계인지 본다.
 *
 * 왜 필요한가: 이름은 사람이 준다. 그래서 같은 기계가 다른 이름으로 돌 수도
 * 있고, 다른 기계가 같은 이름으로 돌 수도 있다. 실제로 그 일이 있었다 —
 * 처음에는 호스트명으로 이름을 짓고 나중에 능력으로 다시 지었는데, 바뀌었다는
 * 사실이 어디에도 없어서 같은 기계의 기록이 "모르는 기계" 로 보였다. 사람도
 * 판정하는 쪽도 헷갈렸다.
 *
 * 이름이 어긋나면 그 자리에서 막는다. 기록을 남긴 뒤에 알면 늦다.
 */
function identityMismatch(profile) {
	const mismatches = [];
	if (profile.host && profile.host !== hostname()) {
		mismatches.push(`호스트명: 명단은 ${profile.host}, 이 기계는 ${hostname()}`);
	}
	const osByName = { linux: "linux", windows: "win32", darwin: "darwin" };
	const expected = osByName[profile.os];
	if (expected && expected !== process.platform) {
		mismatches.push(`운영체제: 명단은 ${profile.os}, 이 기계는 ${process.platform}`);
	}
	return mismatches;
}

const profile = roster.machines.find((m) => m.name === machine);
if (roster.machines.length > 0 && !profile) {
	const dormant = (rosterFile.machines ?? []).find((m) => m.name === machine);
	console.error(
		dormant && dormant.active !== false && !machineInTargets(dormant, targets)
			? `${machine}(${dormant.os}) 는 이번 배포 대상 운영체제(${targets.join(", ")})의 기계가 아니다.\n` +
					`${targetSource} 의 targets 를 확인하라.`
			: dormant
			? `${machine} 는 명단에 있지만 아직 합류하지 않았다(active: false).\n` +
					`${ROSTER} 에서 active 를 true 로 바꾸면 몫을 받는다.`
			: `${ROSTER} 에 이 기계(${machine})가 없다.\n` +
					`지금 도는 기계: ${roster.machines.map((m) => m.name).join(", ")}\n` +
			"먼저 명단에 이름과 능력을 적어라 — 명단에 없는 기계가 도는 것은 아무도 모르는 실행이다.",
	);
	process.exit(2);
}

// 명단이 있으면 그 기계가 맡기로 한 등급만 받는다. 능력에 없는 등급을
// 억지로 맡으면 실패가 쌓이는데, 그것은 회귀가 아니라 기계가 못 하는 일이다.
if (profile) {
	const mismatches = identityMismatch(profile);
	if (mismatches.length > 0) {
		console.error(
			`이 기계는 ${machine} 이 아닌 것 같다:\n` +
				mismatches.map((m) => `  ${m}`).join("\n") +
				"\n\n이름을 잘못 주었거나, 명단이 낡았다. 어느 쪽인지 확인하고 고쳐라 —" +
				" 이름이 기계를 가리키지 못하면 기록이 누구 것인지 알 수 없다.",
		);
		process.exit(2);
	}
	const notMine = tiers.filter((tier) => !profile.tiers.includes(tier));
	if (notMine.length > 0) {
		console.error(
			`${machine} 는 ${notMine.join(", ")} 을 맡지 않는다 (맡는 것: ${profile.tiers.join(", ")}).\n` +
				`이유: ${profile.note ?? "명단 참조"}`,
		);
		process.exit(2);
	}
}

/**
 * 등급마다 그 등급을 맡은 기계들끼리 나눈다.
 *
 * 등급을 합쳐서 나누면 균등하지 않다 — 다섯 대가 맡는 등급과 두 대가 맡는
 * 등급을 한 줄로 세우면, 두 대짜리 등급의 몫이 다섯 대에 흩어져 그중 셋은
 * 돌릴 수 없는 것을 받는다.
 */
function shareOf(tier) {
	// 대상 운영체제에서 돌지 않는 스펙은 나누기 전에 뺀다. 이 기계의 운영체제에서
	// 돌지 않는 스펙도 뺀다 — 맡으면 "환경 없음" 으로 붉어질 뿐 결함이 아니다.
	const myOs = profile?.os ?? osOfPlatform(process.platform);
	const inTier = inventory.specs
		.filter((s) => s.tier === tier && specInTargets(s, targets) && specRunsOn(s, myOs))
		.sort((a, b) => a.spec.localeCompare(b.spec));
	const owners = roster.machines
		.filter((m) => m.tiers.includes(tier))
		.map((m) => m.name)
		.sort();
	if (owners.length === 0) return inTier;
	const index = owners.indexOf(machine);
	if (index < 0) return [];
	return inTier.filter((_, i) => i % owners.length === index);
}

/**
 * 이 실행이 맡을 스펙.
 *
 * 보통은 등급별 몫이다. `--only-failed` 면 지난 기록에서 다시 볼 것만 고른다 —
 * 그 목록은 이미 이 기계의 몫이었으므로 다시 나누지 않는다. 등급을 사람이 직접
 * 주었으면 그 등급으로 좁힌다(`--tier=credentialed_live --only-failed`).
 */
function retestSelection() {
	const dir = "docs/regression-runs";
	let file = onlyFailedFrom;
	let record = null;
	if (file) {
		if (!existsSync(file)) {
			console.error(`${file} 이 없다 — --only-failed 가 가리킨 기록을 찾지 못했다`);
			process.exit(2);
		}
		record = JSON.parse(readFileSync(file, "utf8"));
	} else {
		const entries = (existsSync(dir) ? readdirSync(dir) : [])
			.filter((name) => name.endsWith(".json") && name !== "machines.json")
			.map((name) => {
				try {
					return { file: join(dir, name), record: JSON.parse(readFileSync(join(dir, name), "utf8")) };
				} catch {
					return null;
				}
			})
			.filter(Boolean);
		const picked = pickLatestRecord(entries, machine);
		if (!picked) {
			console.error(
				`${dir} 에 ${machine} 의 기록이 없다 — 먼저 전체를 한 번 돌려야 재시험할 것이 생긴다`,
			);
			process.exit(2);
		}
		file = picked.file;
		record = picked.record;
	}
	const targets = retestTargets(record);
	const byName = new Map(inventory.specs.map((spec) => [spec.spec, spec]));
	const unknown = targets.specs.filter((name) => !byName.has(name));
	let chosen = targets.specs.map((name) => byName.get(name)).filter(Boolean);
	if (tierGiven) chosen = chosen.filter((spec) => tiers.includes(spec.tier));
	return { file, record, targets, chosen, unknown };
}

const retest = onlyFailed ? retestSelection() : null;
const mine = retest ? retest.chosen : tiers.flatMap((tier) => shareOf(tier));
if (retest) {
	console.log(
		`[regression] --only-failed — ${retestSourceName(retest.file)} 에서 다시 볼 스펙 ${retest.chosen.length}개` +
			(retest.targets.envMissing.length
				? ` (요구 환경이 없어 빼는 것 ${retest.targets.envMissing.length}개)`
				: ""),
	);
	for (const name of retest.targets.envMissing) {
		console.log(`      제외(환경 없음): ${name}`);
	}
	if (retest.unknown.length > 0) {
		console.log(
			`  ⚠ 지금 인벤토리에 없는 스펙 ${retest.unknown.length}개는 뺀다: ${retest.unknown.join(", ")}`,
		);
	}
	if (retest.targets.legacy) {
		console.log(
			"  ⚠ 이 기록에는 passedSpecs 칸이 없다(옛 형식). 돌지 못한 것만 골랐고, 돌았다가 실패한 것은 알 수 없다 — 전체를 한 번 돌려 기록을 새로 만드는 편이 낫다.",
		);
	}
	if (isRetestRecord(retest.record)) {
		console.log(`  (앞 재시험 ${retestSourceName(retest.file)} 을 이어받는다)`);
	}
	if (retest.chosen.length === 0) {
		console.log(
			"\n[regression] 실패 0 — 이제 전체를 한 번 돌려 기록을 확정하라.\n",
		);
		process.exit(0);
	}
}
const ownersByTier = new Map(
	tiers.map((tier) => [
		tier,
		roster.machines.filter((m) => m.tiers.includes(tier)).length,
	]),
);

console.log(
	`[regression] ${machine} 이 맡은 몫: ${mine.length} / 전체 ${inventory.total}` +
		(roster.machines.length > 0 ? ` (명단 ${roster.machines.length}대)` : ""),
);
for (const tier of tiers) {
	const owners = ownersByTier.get(tier) ?? 1;
	const total = inventory.specs.filter((s) => s.tier === tier).length;
	console.log(
		`  ${tier.padEnd(18)} ${String(mine.filter((s) => s.tier === tier).length).padStart(3)} / ${total} (${owners}대가 나눔)`,
	);
}

// 죽은 실행이 남긴 BGM 사이드카를 걷어 낸다 (#577).
//
// 왜 러너가 하는가: 자리가 사라진 사이드카는 그 자리의 `bgm-server.pid` 도 함께
// 잃어서, 다음 실행의 `onPrepare` 가 짚어 갈 단서가 없다. 그것을 아는 유일한
// 자리는 그 프로세스 자신의 환경(`NAIA_E2E_RUNTIME_DIR`)이다. 2026-09-06
// naia-os-3090 에서 그렇게 남은 사이드카가 여덟이었고, 그 포트를 물고 있어서
// 다음 실행의 사이드카가 뜨지 못했다.
//
// 이름으로 훑지 않는다(`pkill -f` 금지). 표식과 환경이 둘 다 맞고, 그 환경이
// 가리키는 자리가 이미 없는 것만 손댄다. 자리가 살아 있으면 그 실행이 아직 돌고
// 있을 수 있고, 환경에 그 변수가 없으면 애초에 우리 것이 아니다.
{
	const survey = surveyStrandedSidecars();
	const stranded = survey.filter((s) => s.verdict === "stranded");
	const kept = survey.length - stranded.length;
	if (survey.length > 0) {
		console.log(
			`\n[regression] BGM 사이드카 ${survey.length}개 — 자리 없는 것 ${stranded.length}, 두는 것 ${kept}`,
		);
		for (const candidate of survey) {
			const where = candidate.runtimeDir ?? "(실행 자리 변수 없음)";
			console.log(`      pid ${candidate.pid} ${candidate.verdict} ${where}`);
		}
	}
	if (dryRun) {
		if (stranded.length > 0)
			console.log("      [--dry-run] 걷어 내지 않는다 — 마른 실행은 아무것도 죽이지 않는다.");
	} else if (stranded.length > 0) {
		for (const line of describeReclaimed(reclaimStrandedSidecars()))
			console.log(`      ${line}`);
	}
}

// 산출물 자리와 비용 원장은 이 실행의 것이므로 러너가 만든다.
//
// 스펙과 헬퍼는 두 변수를 읽어 화면 흔적과 판정 호출 수를 남긴다. 사람이
// 넣어야 하는 값으로 두었더니 선별이 그것을 "요구 환경 없음" 으로 읽어,
// 두 변수만 빠진 스펙들까지 통째로 빠졌다(2026-09-25 win-rtx4060 마른 실행에서
// 일흔네 개 중 다수). 비용 원장은 아래에서 기록에 옮겨 적는 자리인데, 아무도
// 채우지 않아 그 칸이 늘 비어 있었다. 밖에서 준 값은 그대로 존중한다.
{
	const runDir = join(
		tmpdir(),
		`naia-regression-${machine}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
	);
	process.env.NAIA_E2E_ARTIFACTS_DIR ||= join(runDir, "artifacts");
	process.env.NAIA_E2E_COST_LEDGER ||= join(runDir, "cost-ledger.json");
	if (!dryRun) mkdirSync(process.env.NAIA_E2E_ARTIFACTS_DIR, { recursive: true });
}

// 등급이 요구하는 환경 변수가 실제로 있는지 먼저 본다. 없으면 그 스펙은
// **wdio 에 넘기지 않는다.**
//
// 오래 반대로 돌았다. 여기서 "건너뛸 스펙" 이라고 찍어 놓고 목록은 그대로
// 넘겼고, 스펙들은 그 안에서 키가 없다며 `before all` 훅에서 죽어 결함처럼
// 기록됐다(2026-09-05 naia-os-3090 기록의 96-voice-linux-app-start). 반대로
// 스스로 통과해 버린 것은 재지 않은 채 `executed` 에 올랐다(88-stt-tts-combo).
// 말한 것과 한 것이 다르면 기록은 두 갈래로 거짓이 된다.
//
// 빼도 판정에서 사라지지 않는다. `envMissingBeforeRun` 에 그대로 남고
// check-regression-complete 가 그것을 "통과가 아니다" 로 센다.
const {
	groups,
	envMissing: missingEnv,
	harnessProvided,
	capabilityBlocked,
	skippedGroups,
} = planGroups(mine, process.env);
// 아직 이어지지 않은 능력 때문에 뺀 스펙. 통과가 아니고 결함도 아니다 —
// 추적처와 함께 남겨 두어야 배선되는 날 누가 되살릴지 알 수 있다.
if (capabilityBlocked.size) {
	console.log(
		`  ⚠ 능력이 아직 이어지지 않아 돌리지 않을 스펙 ${capabilityBlocked.size}개 — 이것은 통과가 아니다`,
	);
	for (const [spec, requires] of capabilityBlocked) {
		const why = requires
			.map((r) => `${r.capability} (${r.tracker})`)
			.join(", ");
		console.log(`      ${spec}: 능력 미배선 — ${why}`);
	}
}
// 하네스가 채우는 변수는 부재가 아니다. 다만 조용히 넘어가면 다음 사람이
// "이 변수는 왜 안 물어보지" 를 소스에서 되짚어야 하므로 수를 남긴다.
const harnessProvidedNames = [
	...new Set([...harnessProvided.values()].flat()),
].sort();
if (harnessProvided.size) {
	console.log(
		`  하네스가 채우는 변수 ${harnessProvidedNames.length}개(시딩) — 스펙 ${harnessProvided.size}개: ${harnessProvidedNames.join(", ")}`,
	);
}
if (missingEnv.size) {
	console.log(`  ⚠ 환경이 없어 돌리지 않을 스펙 ${missingEnv.size}개 — 이것은 통과가 아니다`);
	for (const [spec, absent] of [...missingEnv].slice(0, 5)) {
		console.log(`      ${spec}: ${absent.join(", ")}`);
	}
	if (missingEnv.size > 5) console.log(`      … 그리고 ${missingEnv.size - 5}개 더`);
}
for (const group of skippedGroups) {
	console.log(
		`  ⚠ ${group.conf} 는 아예 띄우지 않는다 — ${group.reason} (스펙 ${group.specs.length}개)`,
	);
}

// 실기 스펙은 환경 변수 말고도 공통 전제를 요구한다 — 브라우저 드라이버,
// tauri-driver, 빌드된 디버그 바이너리, 그리고 살아 있는 게이트웨이다.
// 전제가 없으면 스펙은 ECONNREFUSED 같은 모양으로 죽는데, 그것은 결함이
// 아니라 준비 부족이다. 둘을 같은 칸에 넣으면 기록이 "서른한 개가 깨졌다" 고
// 말하게 되고, 다음 사람이 없는 버그를 찾는다.
// 게이트웨이를 실제로 쓰는 스펙. 소스에서 포트를 직접 적은 것들이다.

function missingPrerequisites() {
	const missing = [];
	// PATH 를 직접 뒤진다. `sh -c "command -v"` 는 윈도우에 sh 가 없으면
	// 언제나 실패해, 있는 도구를 없다고 말한다. 이 프로세스는 여러 기계가
	// 나눠 도는 것이 목적이므로 한 플랫폼에서만 도는 검사를 두면 안 된다.
	const has = (command) => {
		const exts =
			process.platform === "win32"
				? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
				: [""];
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			if (!dir) continue;
			for (const ext of exts) {
				if (existsSync(join(dir, command + ext))) return true;
			}
		}
		return false;
	};
	// 짝 naia-agent 체크아웃은 **모든** 스펙의 전제다. 전용 설정만 요구한다고
	// 오래 믿었는데, 기본 설정(wdio.conf.ts)이 모듈 최상위에서 그것을 부르고
	// 전용 설정들은 전부 그것을 상속한다. 그래서 짝이 없으면 스펙 전부가
	// 설정을 읽는 단계에서 죽는다 — 그 죽음을 "회귀가 깨졌다" 로 적으면
	// 다음 사람이 없는 버그를 찾는다.
	if (!pairedAgentAvailable())
		missing.push(
			"짝 naia-agent 체크아웃 (핀 커밋과 같고 작업 트리가 깨끗한 것). NAIA_AGENT_WORKTREES_DIR 로 자리를 알려 주어라",
		);
	if (!has("WebKitWebDriver") && process.platform === "linux")
		missing.push("WebKitWebDriver (리눅스 웹뷰 드라이버)");
	// Windows 는 앱에 들어 있는 WebDriver(tauri_plugin_wdio_webdriver)에 바로
	// 붙는다(#539, wdio.conf.ts). tauri-driver 는 리눅스 경로의 전제다 — Windows
	// 에서 이것을 요구하면 쓰지도 않는 도구 때문에 전체가 "전제 없음" 이 된다.
	if (process.platform !== "win32" && !has("tauri-driver"))
		missing.push("tauri-driver");
	// 자리 계산은 agent-pairing 이 하나로 갖는다. 여기에 다시 적으면 빌드가
	// 두는 자리와 갈라진다 — 실제로 그랬다. Windows 빌드는 MSVC 경로 길이
	// 때문에 `C:/tmp/...` 에 짓는데 러너는 리눅스 자리만 보고 있었고, 그래서
	// 그 기계는 빌드에 성공하고도 "바이너리 없음" 으로 거부당했다.
	const binary = e2eBinaryPath(resolve("packages/shell"));
	if (!existsSync(binary))
		missing.push(
			`빌드된 e2e 바이너리 — ${binary} (pnpm -C packages/shell run build:e2e:tauri)`,
		);
	// 게이트웨이(:18789)는 그것을 쓰는 스펙이 배정됐을 때만 전제다. 실측에서
	// 전체 전제로 두었다가 진단을 그르쳤다 — 서른한 개 실패의 실제 사유는
	// 게이트웨이가 아니라 WebDriver 세션이 중간에 끊긴 것이었다
	// (invalid session id + ECONNREFUSED to the driver socket).
	// 자격증명 등급의 진짜 전제는 **모델에 닿는가** 다.
	//
	// 첫 수행에서 45개 중 38개가 실패했는데 대부분 한 뿌리였다 —
	// `provider error: fetch failed` 로 모델에 못 닿아 그 뒤 단정이 줄줄이
	// 무너진다. 그것은 제품 결함이 아니라 준비 부족인데, 러너가 그 전제를
	// 검사하지 않아 서른여덟 개의 결함처럼 기록됐다. 준비 부족과 결함을
	// 가르겠다는 이 함수가 정작 가장 중요한 하나를 안 보고 있었다.
	//
	// 그래서 등급이 모델을 쓰면 그 제공자가 실제로 응답하는지 먼저 본다.
	//
	// 기본 제공자는 더 이상 codex 앱서버가 아니다 (#547). 자격증명 등급이 돌 때
	// 기본 설정(wdio.conf.ts)이 실행 자리 아래에 격리 워크스페이스를 하나 만들고,
	// 그 안 `naia-settings/config.json` 에 나이아 게이트웨이 공급자를 심는다.
	// 그 시딩은 `NAIA_API_KEY` 가 있을 때에만 돈다 — 그래서 이 등급의 진짜 전제는
	// 그 키다. 사람이 쓰는 실제 ADK 의 설정은 이 등급에 영향을 주지 않는다.
	const needsModel = tiers.includes("credentialed_live");
	if (needsModel) {
		// 판정 모델도 같은 게이트웨이로 부르므로(helpers/semantic.ts) 이 키 하나가
		// 대화와 판정의 전제다. 예전에는 판정용 GEMINI_API_KEY 를 따로 요구했다.
		if (!(process.env.NAIA_API_KEY ?? "").length) {
			missing.push(
				"NAIA_API_KEY (자격증명 등급의 대화·판정에 필요하다 — 이 키가 없으면 격리 워크스페이스에 살아 있는 공급자를 심지 못해 대화 스펙이 fetch failed 로 죽는다)",
			);
		}
		// codex 는 이제 그것을 실제로 쓰는 스펙의 전제일 뿐이다. 전체 전제로 두면
		// 자격증명 등급 마흔다섯 개가 codex 로그인 하나에 통째로 묶인다.
		const usesCodex = mine.some(
			(spec) =>
				/codex/i.test(spec.spec) ||
				(spec.conf ?? []).some((conf) => /codex/i.test(conf)),
		);
		if (usesCodex) {
			if (!has("codex")) {
				missing.push(
					"codex 실행 파일 (codex 앱서버를 쓰는 스펙이 배정됐다 — PATH 에 없으면 그 스펙들이 fetch failed 로 죽는다)",
				);
			} else {
				const login = spawnSync("codex", ["login", "status"], {
					encoding: "utf8",
					timeout: 20_000,
					// 윈도우의 codex 는 .cmd/.ps1 이라 shell 없이는 스폰 자체가
					// 실패해, 로그인돼 있어도 "안 됐다" 로 읽는다(win-rtx4060 실측,
					// pnpm.cmd EINVAL 과 같은 부류). 아래 wdio 스폰 둘과 같은 규칙.
					shell: process.platform === "win32",
				});
				// codex 는 이 문장을 **표준 오류**로 낸다. 표준 출력만 보면
				// 로그인돼 있는데도 안 됐다고 말한다(실측).
				const said = `${login.stdout ?? ""}${login.stderr ?? ""}`;
				if (login.status !== 0 || !/logged in/i.test(said)) {
					missing.push(
						"codex 로그인 (codex login status 가 로그인을 보고하지 않는다 — codex 스펙이 모델에 닿지 못한다)",
					);
				}
			}
		}
	}

	// 게이트웨이(:18789) 전제는 지웠다.
	//
	// 제품이 그것을 없앴다 — `spawn_gateway` 는 "Gateway removed: naia-agent
	// handles all tools directly" 를 돌려주는 껍데기다(lib.rs:2010). 그런데
	// 러너만 그 포트를 전제로 요구해서, 자격증명 등급 45개가 통째로 막혔다.
	// 세 스펙이 설정에 게이트웨이 주소를 적어 넣기는 하지만 그것은 설정
	// 문자열일 뿐이고, 정말 필요하면 그 스펙이 그 자리에서 실패하면 된다.
	// 준비 부족과 결함을 가르려던 장치가, 없어진 것을 요구해 45개를 못 돌게
	// 만드는 쪽으로 뒤집혔다.
	return missing;
}

const absentPrereqs = missingPrerequisites();
if (absentPrereqs.length) {
	console.log(`  ⚠ 공통 전제 ${absentPrereqs.length}개가 없다:`);
	for (const item of absentPrereqs) console.log(`      ${item}`);
	console.log("     이 상태로 돌리면 스펙이 결함처럼 죽는다 — 준비 부족과 결함은 다르다.");
}

if (dryRun) {
	// 무엇을 넘기고 무엇을 빼는지 **인자 그대로** 보인다. 요약만 찍으면 고른
	// 것과 실제로 넘어가는 것이 갈라져도 드러나지 않는다 — 이 러너가 바로 그
	// 방식으로 어긋나 있었다("건너뛴다" 고 찍고 전부 넘겼다).
	console.log("\n  [--dry-run] wdio 에 넘길 것:");
	if (groups.size === 0) console.log("      (없다)");
	for (const [conf, specs] of groups) {
		console.log(
			`      pnpm -C packages/shell exec wdio run e2e-tauri/${conf} ${wdioSpecArgs(specs).join(" ")}`,
		);
	}
	console.log("  [--dry-run] 넘기지 않을 것(요구 환경 없음 — 기록에는 남는다):");
	if (missingEnv.size === 0) console.log("      (없다)");
	for (const [spec, absent] of missingEnv) {
		console.log(`      ${spec} ← ${absent.join(", ")}`);
	}
	// 두 목록이 겹치면 선별이 깨진 것이다. 사람이 눈으로 대조하지 않아도
	// 되도록 여기서 센다.
	const passedToWdio = new Set([...groups.values()].flat());
	const overlap = [...missingEnv.keys()].filter((spec) => passedToWdio.has(spec));
	console.log(
		overlap.length === 0
			? `  [--dry-run] 두 목록이 겹치지 않는다 (넘길 것 ${passedToWdio.size} · 뺄 것 ${missingEnv.size})`
			: `  [--dry-run] ❌ 두 목록이 겹친다: ${overlap.join(", ")}`,
	);
	console.log("  (--dry-run: 실행하지 않는다)");
	process.exit(overlap.length === 0 ? 0 : 1);
}

if (absentPrereqs.length) {
	// 준비가 안 된 것을 "돌렸는데 실패했다" 로 기록하지 않는다. 기록은 남기되
	// 상태를 따로 둔다 — 완결성 게이트가 이것을 통과로 세지 않는다.

const started = new Date().toISOString();
console.log(
	`\n${channelLine(
		"START",
		`${tiers.join(",")} ${mine.length}개` +
			(missingEnv.size ? ` · 환경 없어 건너뛸 것 ${missingEnv.size}` : ""),
	)}\n`,
);
	const dir = "docs/regression-runs";
	mkdirSync(dir, { recursive: true });
	const out = join(dir, `${machine}-${started.replace(/[:.]/g, "-")}.json`);
	writeFileSync(
		out,
		`${JSON.stringify(
			{
				machine,
				tiers,
				// 전제가 없어 못 돌린 기록에도 지문을 남긴다. 없으면 게이트가
				// 그 기록을 "어느 스펙 목록을 잰 것인지 알 수 없다" 로 통째로
				// 버려, **돌리지 못한 기계 자체가 판정에서 사라진다** —
				// 준비가 안 된 기계가 조용히 없는 것이 되면 사람은 그 몫이
				// 덮였는지 아닌지를 알 수 없다(win-rtx4060 의 2026-09-05
				// 18-06-58 기록이 실제로 그렇게 빠졌다).
				ranOn: fingerprint(),
				started,
				finished: new Date().toISOString(),
				status: "prerequisites-missing",
				assigned: [],
				// 요구 환경이 없어 **wdio 에 넘기지 않은** 스펙. 실행에서 뺀 것이지
	// 판정에서 뺀 것이 아니다 — check-regression-complete 가 이 칸을 읽어
	// "요구 환경이 없던 스펙, 이것은 통과가 아니다" 로 센다.
	envMissingBeforeRun: Object.fromEntries(missingEnv),
				// 환경에는 없지만 그 스펙의 wdio 설정이 자기 손으로 채워 주는 변수.
				// 부재가 아니므로 위 칸에 없다 — 왜 없는지가 기록에서 보이게 남긴다.
				harnessProvidedEnv: Object.fromEntries(harnessProvided),
				// 아직 이어지지 않은 능력 때문에 넘기지 않은 스펙과 그 추적처.
				capabilityBlockedBeforeRun: Object.fromEntries(capabilityBlocked),
				// 스펙이 전부 환경 부재라 아예 띄우지 않은 wdio 설정.
				envMissingGroups: skippedGroups,
				missingPrerequisites: absentPrereqs,
				detail: "공통 전제가 없어 실행하지 않았다",
			},
			null,
			"\t",
		)}\n`,
	);
	console.log(`[regression] 실행하지 않았다 — 기록: ${out}`);
	console.log(
		`\n[${machine}] BLOCKED ${absentPrereqs.map((p) => p.split("(")[0].trim()).join(", ")}\n`,
	);
	process.exit(2);
}

const started = new Date().toISOString();
let status = "passed";
let detail = "";
// 무엇을 돌리려 했는지(planned)와 실제로 끝까지 돈 것(executed)은 다르다.
// 예전에는 계획을 그대로 "배정" 으로 적었고, 완결성 게이트가 그것을 덮인
// 것으로 셌다. 그러면 wdio 가 시작하자마자 죽어도 기록에는 전부 덮였다고
// 남는다.
const executed = [];
// 돈 것 중 **통과한** 것. `executed` 와 나누어 두어야 채널 한 줄의 "통과" 와
// 게이트의 "덮인 것" 이 서로 다른 사실을 말할 수 있다.
const passedSpecs = [];
// 이 실행의 **전제** 지표. 스펙 하나가 세션 하나이고 세션마다 에이전트가 한 번
// 떠야 하는데, 앞 세션의 고아가 리스를 쥐면 앱만 뜨고 뇌 없이 돈다. 그 사실이
// 기록에 없으면 남는 것은 제품 결함처럼 보이는 실패 숫자뿐이다.
let premiseSignals = { agentStarts: 0, leaseBlocked: 0 };
const groupResults = [];

/**
 * 전용 설정 중 짝 naia-agent 체크아웃을 요구하는 것들. 그 체크아웃이 없으면
 * 설정 파일을 읽는 단계에서 죽는데, 그것은 회귀가 깨진 것이 아니라 환경이
 * 없는 것이다. 둘을 섞으면 배포 판단이 흐려진다.
 */
function pairedAgentAvailable() {
	const root =
		process.env.NAIA_AGENT_WORKTREES_DIR ?? resolve("..", "naia-agent-worktrees");
	if (!existsSync(root)) return false;

	// 디렉터리가 있다고 되는 것이 아니다. 설정은 **검증된 커밋과 같고 작업
	// 트리가 깨끗한** 체크아웃만 받는다. 짝이 조금이라도 다르면 결과를
	// 믿을 수 없기 때문이다. 여기서 같은 판정을 하지 않으면, 있는데 못 쓰는
	// 상태를 "있다" 로 보고 그룹을 돌렸다가 설정 로딩에서 죽는다.
	// Rust 선언은 `const REQUIRED_AGENT_COMMIT: &str = "..."` 이다. 타입
	// 표기를 빼먹으면 매치되지 않고, 그러면 이 검사가 조용히 "짝이 없다" 로
	// 답한다 — 있는데 없다고 말하는 쪽도 판단을 망친다.
	const required = /REQUIRED_AGENT_COMMIT\s*(?::\s*&str\s*)?=\s*"([0-9a-f]{40})"/.exec(
		readFileSync("packages/shell/src-tauri/build.rs", "utf8"),
	)?.[1];
	if (!required) return false;

	let entries = [];
	try {
		entries = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name));
	} catch {
		return false;
	}

	for (const candidate of entries) {
		if (!existsSync(join(candidate, "scripts/builds/agent-stdio-entry.mjs")))
			continue;
		try {
			const head = execFileSync("git", ["-C", candidate, "rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim();
			if (head !== required) continue;
			const dirty = execFileSync(
				"git",
				["-C", candidate, "status", "--porcelain"],
				{ encoding: "utf8" },
			)
				.split("\n")
				.filter((line) => line.trim() !== "")
				// 크래시 복구 lease 는 실행 중에 생기는 것이라 소스가 아니다.
				.filter((line) => !/\.agents[\\/]session-contracts[\\/]\.recovery[\\/]/.test(line));
			if (dirty.length === 0) return true;
		} catch {
			// 후보가 아니다. 계속 찾는다.
		}
	}
	return false;
}

// 묶음은 이미 위에서 정했다(planGroups). 여기서 다시 묶으면 환경이 없어 뺀
// 스펙이 되살아난다 — 고른 것과 넘기는 것이 갈라지는 그 형태다.
console.log(
	`[regression] wdio 설정 ${groups.size}개로 나눠 돈다` +
		(skippedGroups.length
			? ` (환경이 없어 띄우지 않는 설정 ${skippedGroups.length}개)`
			: ""),
);

/**
 * wdio 의 spec 리포터 출력에서 스펙별 결과를 읽는다.
 *
 * 왜 필요한가: 묶음 하나가 실패해도 그 안에서 실제로 통과한 스펙이 있다.
 * 실측에서 스물두 개 묶음이 9 통과 13 실패로 끝났는데, 묶음 단위로만 세면
 * 그 아홉 개가 "돌지 않았다" 로 기록된다. 돌았는데 안 돌았다고 적는 것도
 * 안 돌았는데 돌았다고 적는 것만큼 판단을 망친다.
 *
 * 리포터는 `» e2e-tauri/specs/<이름>` 뒤에 그 스펙의 `N passing` / `N failing`
 * 을 낸다. 그 사이를 읽는다.
 */
function parseSpecOutcomes(output) {
	// 한 스펙 블록은 `» ...spec.ts` 로 시작해 다음 `»` 까지다. mocha 는 그
	// 안에서 `N passing` 을 먼저 내고 실패가 있으면 그 **뒤에** `N failing`
	// 을 낸다. 줄 단위로 먼저 만난 것을 판정으로 삼으면 실패한 스펙을 통과로
	// 읽는다 — 실제로 그 버그가 있었다.
	const blocks = [];
	let current = null;
	for (const raw of output.split("\n")) {
		const line = raw.replace(/^\[[^\]]*\]\s*/, "");
		const started = /»\s+(?:e2e-tauri\/specs\/)?([\w.-]+\.spec\.ts)/.exec(line);
		if (started) {
			current = { spec: started[1], passing: 0, failing: 0 };
			blocks.push(current);
			continue;
		}
		if (!current) continue;
		const failing = /^(\d+)\s+failing/.exec(line);
		if (failing) current.failing += Number(failing[1]);
		const passing = /^(\d+)\s+passing/.exec(line);
		if (passing) current.passing += Number(passing[1]);
	}

	// wdio 9.x 스펙 리포터는 `» ... N passing` 대신 워커별로 한 줄로
	// `[0-3] PASSED in tauri - file:///.../specs/<이름>.spec.ts` 를 낸다. 이
	// 형식을 못 읽어 통과한 스펙을 안 돌았다로 세던 것이 win-rtx4060 첫
	// 실행의 과소계상이었다(6/9 통과가 executed 0 으로 남았다).
	for (const raw of output.split("\n")) {
		const line = raw.replace(/^\[[^\]]*\]\s*/, "");
		const m = /\b(PASSED|FAILED) in [\w-]+ - .*?([\w.-]+\.spec\.ts)/.exec(line);
		if (!m) continue;
		blocks.push({ spec: m[2], passing: m[1] === "PASSED" ? 1 : 0, failing: m[1] === "FAILED" ? 1 : 0 });
	}
	const failed = new Set();
	const passed = new Set();
	for (const block of blocks) {
		if (block.failing > 0) failed.add(block.spec);
		else if (block.passing > 0) passed.add(block.spec);
	}
	// 같은 스펙이 여러 번 돌았고 한 번이라도 실패했으면 실패로 본다.
	for (const spec of failed) passed.delete(spec);
	return { passed: [...passed], failed: [...failed] };
}

/**
 * 앞 묶음이 남긴 상태가 뒤 묶음을 막지 못하게 쉰다.
 *
 * 셸은 에이전트를 너무 자주 다시 띄우지 못하도록 5초를 막는다(재시작 폭풍
 * 방지). 묶음을 연달아 돌리면 앞 묶음이 끝나며 남긴 그 억제가 뒤 묶음의
 * 시작을 거절한다 — 실제로 전용 설정 셋이 "restart debounced" 로 한 줄도
 * 못 돌았다. 그 실패는 회귀가 아니라 앞 실행의 잔여다.
 */
const COOLDOWN_MS = 6_000;

/**
 * 한 묶음의 wdio 를 돌리면서 **진행을 즉시 흘린다.**
 *
 * 예전에는 `spawnSync` 로 붙들어 두었다가 끝난 뒤에 출력을 한꺼번에 냈다. 한
 * 묶음이 마흔한 개, 한 시간이라 그동안 화면에는 아무것도 없었고, 사람은 앱이
 * 남긴 흔적 파일의 수정 시각을 뒤져 몇 번째인지 추정했다. 이제 줄 단위로 읽어
 * 그대로 흘리고, 스펙 하나가 끝날 때마다 `[regression] 12/41 ✓ …` 한 줄을 끼워
 * 넣는다.
 *
 * 바뀌지 않는 것: 종료 코드 판정, 윈도우의 `shell` 처리(`pnpm.cmd` 를 shell
 * 없이 spawn 하면 EINVAL 로 죽어 wdio 가 한 번도 뜨지 않는다), 그리고 출력
 * 전체를 모아 나중에 다시 파싱하는 것 — 진행 줄은 표시일 뿐 판정이 아니다.
 */
function runWdioGroup(conf, specArgs, groupPort, total) {
	return new Promise((resolve) => {
		const chunks = [];
		const tracker = createProgressTracker(total);
		const child = spawn(
			process.platform === "win32" ? "pnpm.cmd" : "pnpm",
			[
				"-C",
				"packages/shell",
				"exec",
				"wdio",
				"run",
				`e2e-tauri/${conf}`,
				...specArgs,
			],
			{
				stdio: ["inherit", "pipe", "pipe"],
				env: { ...process.env, NAIA_E2E_WEBDRIVER_PORT: String(groupPort) },
				shell: process.platform === "win32",
			},
		);

		/** 스트림은 줄 경계로 오지 않는다. 남은 조각을 이어 붙인다. */
		const attach = (stream, sink) => {
			let rest = "";
			stream.setEncoding("utf8");
			stream.on("data", (piece) => {
				chunks.push(piece);
				sink.write(piece);
				rest += piece;
				const lines = rest.split("\n");
				rest = lines.pop() ?? "";
				for (const line of lines) {
					const note = tracker.feed(line);
					if (note) console.log(note);
				}
			});
			stream.on("end", () => {
				if (!rest) return;
				const note = tracker.feed(rest);
				if (note) console.log(note);
			});
		};
		attach(child.stdout, process.stdout);
		attach(child.stderr, process.stderr);

		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve({ ...result, output: chunks.join("") });
		};
		child.on("error", (error) => finish({ error, status: null }));
		child.on("close", (code) => finish({ error: null, status: code }));
	});
}

let first = true;
let groupIndex = 0;
for (const [conf, specs] of groups) {
	if (!first) {
		console.log(`[regression] 앞 묶음의 재시작 억제가 풀리기를 기다린다 (${COOLDOWN_MS}ms)`);
		Atomics.wait(
			new Int32Array(new SharedArrayBuffer(4)),
			0,
			0,
			COOLDOWN_MS,
		);
	}
	first = false;
	groupIndex += 1;

	const specArgs = wdioSpecArgs(specs);
	// 묶음마다 다른 드라이버 포트를 준다. 전용 설정 여럿이 같은 포트(4450)를
	// 기본값으로 쓰기 때문에, 연달아 돌리면 앞 실행의 드라이버가 아직 그
	// 포트를 잡고 있어 세션 생성이 실패한다 — 실제로 전용 설정 셋이
	// `UND_ERR_INVALID_ARG` 로 죽었다. 그 실패는 회귀가 아니라 자리 다툼이다.
	const preferredPort = 4450 + groupIndex * 4;
	const groupPort = await resolveFreePort(preferredPort);
	console.log(`[regression] ${conf} — 스펙 ${specs.length}개 (포트 ${groupPort})`);
	// 출력을 화면에 그대로 내면서 동시에 모은다. 십몇 분 도는 동안 아무
	// 소리가 없으면 사람이 멈춘 줄 알고 취소한다. 예전에는 `sh -c "... | tee"`
	// 로 했는데 윈도우에는 sh 가 없어 그 기계에서는 아예 돌지 않았다.
	let ok = true;
	const child = await runWdioGroup(conf, specArgs, groupPort, specs.length);
	if (child.error || child.status !== 0) {
		ok = false;
		status = "failed";
		const message = String(
			child.error?.message ?? `종료 코드 ${child.status}`,
		).slice(0, 200);
		detail = detail ? `${detail}; ${conf}: ${message}` : `${conf}: ${message}`;
	}
	const output = child.output;

	// 전제는 묶음마다 센다. 묶음마다 wdio 를 따로 부르므로 출력도 따로다.
	// 다시 돌리는 대목(retryFailedOnce)은 세지 않는다 — 그쪽 기동까지 더하면
	// 기동 수가 돈 스펙 수를 넘어 전제가 거짓으로 깨진다.
	premiseSignals = addPremiseSignals(
		premiseSignals,
		countPremiseSignals(output),
	);

	const outcome = parseSpecOutcomes(output);
	// **돈 것** 과 **통과한 것** 은 다른 사실이다. 오래 한 칸에 넣었다 —
	// 묶음이 실패하면 `executed` 에 통과한 스펙만 담았고, 게이트는 그 칸을
	// "덮인 것" 으로 센다. 그래서 실제로 돌아 실패한 스펙이 판정에서는
	// "아무 기계도 맡지 않았다" 로 보였다(win-rtx4060 의 2026-09-05 기록은
	// 쉰아홉 개를 맡아 열아홉만 `executed` 에 남겼다). 재서 실패한 것을
	// 재지 않은 것으로 말하면, 사람이 찾아야 할 결함이 빈칸으로 보인다.
	//
	// 이제 `executed` 는 **리포터가 판정을 읽은** 스펙이다. 통과든 실패든
	// 그 스펙은 돌았다. 한 줄도 못 읽은 스펙(예: wdio 가 시작하자마자 죽어
	// 차례가 오지 않은 것)은 여전히 빠진다 — 그것은 정말로 돌지 않았다.
	const judged = new Set([...outcome.passed, ...outcome.failed]);
	const ran = ok ? specs : specs.filter((spec) => judged.has(spec));
	const passedHere = ok
		? specs
		: outcome.passed.filter((spec) => specs.includes(spec));
	executed.push(...ran);
	passedSpecs.push(...passedHere);
	groupResults.push({
		conf,
		specs: specs.length,
		status: ok ? "passed" : "failed",
		passed: passedHere.length,
		failedSpecs: outcome.failed.filter((spec) => specs.includes(spec)),
	});
}

/**
 * 이 실행이 어느 코드·어느 목록에서 나왔는지 남긴다.
 *
 * 기록은 저장소에 커밋되는 JSON 일 뿐이라, 손으로 써도 게이트가 받아들인다.
 * 그것을 완전히 막을 수는 없다 — 같은 저장소에 커밋할 수 있는 사람이면
 * 파일도 쓸 수 있다. 다만 **실수로 낡거나 어긋난 기록이 통과하는 것**은 막을
 * 수 있다. 인벤토리가 다르면 다른 스펙 목록으로 돈 것이고, 커밋이 다르면
 * 다른 코드에서 돈 것이다. 그 사실을 게이트가 보게 한다.
 */
function fingerprint() {
	// 지문은 바이트가 아니라 내용을 잰다. 원문 바이트로 잡았을 때 윈도우
	// 체크아웃의 CRLF 가 같은 목록에 다른 해시를 주어, 두 기계가 서로의
	// 기록을 영원히 "다른 스펙 목록" 으로 버렸다. 계산은
	// scripts/lib/inventory-digest.mjs 한 곳이 한다 — 러너와 게이트가 같은
	// 함수를 써야 규칙이 갈라지지 않는다.
	const digest = inventoryDigestFromFile(INVENTORY);
	let commit = "unknown";
	try {
		commit = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
	} catch {
		// git 이 없는 자리에서도 기록은 남긴다. 다만 추적이 약해진다.
	}
	return {
		inventorySha256: digest,
		commit,
		host: hostname(),
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
	};
}

/**
 * 이 실행에 뇌가 있었는가. 스펙 하나가 세션 하나이고 세션마다 에이전트가 한 번
 * 떠야 하므로, 기동 수가 돈 스펙 수와 같고 리스에 막힌 세션이 없어야 성립한다.
 */
const premiseVerdict = judgePremise({
	agentStarts: premiseSignals.agentStarts,
	leaseBlocked: premiseSignals.leaseBlocked,
	executed: executed.length,
});
if (premiseVerdict.premise !== "ok") {
	console.log(
		`[regression] ⚠ 전제 불성립 — ${premiseVerdict.reason}. 이 실행의 실패는 제품의 것이라고 말할 수 없다.`,
	);
}

const record = {
	machine,
	tiers,
	// 이 기록이 무엇인가. 재시험은 그 기계의 몫 **전체**를 잰 것이 아니므로
	// 완결성 게이트가 판정에서 뺀다 — 실패 셋만 다시 돌려 통과시키고 "다
	// 덮였다" 가 되는 길을 막는다.
	...(retest
		? { kind: "retest", retestOf: retestSourceName(retest.file) }
		: {}),
	ranOn: fingerprint(),
	started,
	finished: new Date().toISOString(),
	status,
	planned: mine.map((s) => s.spec),
	// 리포터가 판정을 읽은 스펙 — 통과든 실패든 **돈 것**이다. 완결성 게이트는
	// 이 칸을 "덮인 것" 으로 센다.
	executed,
	// 그중 통과한 것. 돈 것과 통과한 것을 한 칸에 넣었더니, 실제로 돌아 실패한
	// 스펙이 판정에서 "아무 기계도 맡지 않았다" 로 보였다.
	passedSpecs,
	// 이 실행에 뇌가 있었는가 — `"ok"` 또는 `"invalid"`. 전제가 깨진 실행의
	// 실패는 제품의 것이 아니므로 완결성 게이트가 커버리지로 세지 않는다.
	// 2026-09-06 이 기계의 자격증명 실행이 정확히 그 모양이었다: 서른여덟 개
	// 중 서른일곱이 뇌 없이 돌았는데 기록에는 그 사실이 한 글자도 없었다.
	premise: premiseVerdict.premise,
	// 그 판정의 근거 숫자. 로그는 다음 실행이 덮어쓰므로 여기 남긴다.
	premiseSignals: {
		agentStarts: premiseSignals.agentStarts,
		leaseBlocked: premiseSignals.leaseBlocked,
		executed: executed.length,
		reason: premiseVerdict.reason,
	},
	// 어느 wdio 설정이 어디까지 갔는지. 한 설정이 실패해도 다른 설정의
	// 결과는 남는다.
	groups: groupResults,
	// 요구 환경이 없어 **wdio 에 넘기지 않은** 스펙. 그래서 이 이름들은
	// executed·stableFailures·flakySpecs 어디에도 오르지 않는다 — 재지 않은
	// 것이 통과로도, 결함으로도 세어지지 않게 하는 것이 이 칸의 목적이다.
	// 판정에서 빠지는 것은 아니다: check-regression-complete 가 이것을 읽어
	// "이것은 통과가 아니다" 로 게이트를 붉힌다.
	envMissingBeforeRun: Object.fromEntries(missingEnv),
	// 환경에는 없지만 그 스펙의 wdio 설정이 자기 손으로 채워 주는 변수(자격증명
	// 시딩). 부재가 아니므로 위 칸에 없다 — 밖에서 채우면 화면과 네이티브가
	// 다른 워크스페이스를 보므로, 비어 있는 것이 정상인 값들이다.
	harnessProvidedEnv: Object.fromEntries(harnessProvided),
	// 아직 이어지지 않은 능력 때문에 넘기지 않은 스펙과 그 추적처.
	// 실행에서 뺀 것이지 판정에서 뺀 것이 아니다.
	capabilityBlockedBeforeRun: Object.fromEntries(capabilityBlocked),
	// 스펙이 전부 환경 부재라 아예 띄우지 않은 wdio 설정. 전용 설정은
	// onPrepare 에서 사이드카를 띄우므로, 돌릴 것이 없는데 부르면 준비 비용만
	// 쓰고 죽는다 — 그 죽음이 다시 결함처럼 기록된다.
	envMissingGroups: skippedGroups,
	detail,
};

const dir = "docs/regression-runs";
mkdirSync(dir, { recursive: true });
const out = join(dir, `${machine}-${started.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, `${JSON.stringify(record, null, "\t")}\n`);
// 기계·등급마다 최신 하나만 남긴다. 판정이 어차피 최신만 보므로 옛것은
// 쌓이기만 하고, 쌓이면 어느 것이 지금 상태인지 사람이 알 수 없다. 실제로
// 이 디렉터리에 한 기계의 기록 여섯이 남아 무엇이 현재인지 흐려졌다.
for (const old of readdirSync(dir)) {
	if (!old.endsWith(".json") || old === "machines.json") continue;
	if (old === basename(out)) continue;
	try {
		const previous = JSON.parse(readFileSync(join(dir, old), "utf8"));
		const sameMachine = previous.machine === machine;
		const sameTiers =
			[...(previous.tiers ?? [])].sort().join(",") === [...tiers].sort().join(",");
		// 같은 종류끼리만 갈아 끼운다. 재시험 기록이 전체 기록을 지우면 완결성
		// 판정은 재시험을 무시하므로 "기록 없음" 이 되고, 다음 --only-failed 는
		// 실패 목록의 출처를 잃는다 — 실제로 첫 재시험이 전체 기록을 지웠다.
		const sameKind = (previous.kind ?? "full") === (record.kind ?? "full");
		if (sameMachine && sameTiers && sameKind) rmSync(join(dir, old));
	} catch {
		// 읽을 수 없는 파일은 건드리지 않는다. 판정이 이유와 함께 뺀다.
	}
}

console.log(`[regression] 기록: ${out} (${status})`);

/**
 * 실패한 스펙을 한 번만 다시 돌려, **매번 실패하는 것**과 **가끔 실패하는
 * 것**을 가른다.
 *
 * 두 기계로 나눠 돌면서 실행마다 번갈아 실패하는 스펙이 보였다. 그것을
 * 그냥 실패로 적으면 사람은 매번 원인을 다시 쫓고, 진짜 회귀가 그 소음에
 * 묻힌다.
 *
 * ⚠️ 다시 돌아 통과했다고 **통과로 바꾸지 않는다.** 그것은 이 프로그램이
 * 여덟 번 잡아 온 거짓 통과 그대로다. 실패로 남기되 `flaky` 로 표시해
 * 판단할 재료를 준다.
 */
async function retryFailedOnce(failed) {
	const flaky = [];
	const stable = [];
	for (const { conf, spec } of failed) {
		console.log(`[regression] 다시 한 번: ${spec} (${conf})`);
		const retryPort = await resolveFreePort(4490);
		const child = spawnSync(
			process.platform === "win32" ? "pnpm.cmd" : "pnpm",
			[
				"-C",
				"packages/shell",
				"exec",
				"wdio",
				"run",
				`e2e-tauri/${conf}`,
				"--spec",
				`e2e-tauri/specs/${spec}`,
			],
			{
				encoding: "utf8",
				stdio: ["inherit", "pipe", "pipe"],
				maxBuffer: 512 * 1024 * 1024,
				env: { ...process.env, NAIA_E2E_WEBDRIVER_PORT: String(retryPort) },
				shell: process.platform === "win32",
			},
		);
		const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
		const outcome = parseSpecOutcomes(output);
		if (child.status === 0 || outcome.passed.includes(spec)) flaky.push(spec);
		else stable.push(spec);
	}
	return { flaky, stable };
}

const failedSpecs = [
	...new Set(groupResults.flatMap((g) => g.failedSpecs ?? [])),
];

// 실패한 것만 한 번 더 돌려 매번 실패와 가끔 실패를 가른다.
// 이 단계는 `--classify-flaky` 를 줄 때만 돈다. 실패 우선 루프(--only-failed)가
// 같은 일을 사람이 보는 앞에서 하므로, 기록을 쓴 뒤 몰래 이어 도는 재실행은
// 다음 실행과 포트를 다투는 사고만 낳았다(2026-09-06, 세 실행 겹침).
const retryTargets = classifyFlaky
	? groupResults.flatMap((g) =>
			(g.failedSpecs ?? []).map((spec) => ({ conf: g.conf, spec })),
		)
	: [];
const { flaky, stable } = retryTargets.length
	? await retryFailedOnce(retryTargets)
	: { flaky: [], stable: [] };
if (flaky.length) {
	console.log(
		`[regression] 다시 돌리니 통과한 것 ${flaky.length}개 — 통과로 바꾸지 않는다. 가끔 실패한다는 사실 자체가 문제다:`,
	);
	for (const spec of flaky) console.log(`  ${spec}`);
}
if (stable.length) {
	console.log(`[regression] 다시 돌려도 실패 ${stable.length}개:`);
	for (const spec of stable) console.log(`  ${spec}`);
}
// 이 실행이 어느 청구처를 몇 번 두드렸는지 기록에 남긴다. 금액은 콘솔의
// 청구서와 대조한다 — 추정 금액을 적으면 아무도 믿지 않는다.
if (process.env.NAIA_E2E_COST_LEDGER) {
	try {
		record.billableCalls = JSON.parse(
			readFileSync(process.env.NAIA_E2E_COST_LEDGER, "utf8"),
		);
	} catch {
		record.billableCalls = {};
	}
	// 셸이 쓰는 모델은 나이아 게이트웨이를 지난다. 그 호출은 이 프로세스
	// 밖(앱 안)에서 나므로 여기서 셀 수 없다. 어느 자격증명이 있었는지를
	// 남겨 청구서를 그 실행에 붙일 수 있게 한다.
	record.credentialsPresent = [
		"NAIA_API_KEY",
		"GEMINI_API_KEY",
		"CAFE_E2E_API_KEY",
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"XAI_API_KEY",
	].filter((name) => (process.env[name] ?? "").length > 0);
}

record.flakySpecs = flaky;
record.stableFailures = stable;
writeFileSync(out, `${JSON.stringify(record, null, "\t")}\n`);

// 실패 우선 고리의 다음 걸음을 러너가 말한다. 사람이 기록을 열어 빼기를 하지
// 않도록, 무엇이 남았는지 또는 이제 전체를 돌 차례인지 여기서 찍는다.
if (retest) {
	const left = retestTargets(record);
	if (left.specs.length === 0) {
		console.log(
			"\n[regression] 실패 0 — 이제 전체를 한 번 돌려 기록을 확정하라.\n",
		);
	} else {
		console.log(`\n[regression] 아직 실패하는 스펙 ${left.specs.length}개:`);
		for (const name of left.specs) console.log(`      ${name}`);
		console.log("      고친 뒤 같은 명령을 다시 돌려라 (--only-failed).\n");
	}
}

console.log(
	`\n${channelLine(
		"DONE",
		`${passedSpecs.length}/${mine.length} 통과 · 돈 것 ${executed.length}` +
			` · 전제 ${premiseVerdict.premise}` +
			(failedSpecs.length
				? ` · 실패 ${failedSpecs.slice(0, 4).join(", ")}${failedSpecs.length > 4 ? ` 외 ${failedSpecs.length - 4}` : ""}`
				: ""),
	)}\n`,
);
process.exit(status === "passed" ? 0 : 1);
