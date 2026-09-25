// 배포 전 회귀는 **나가는 운영체제**만 조건으로 삼는다.
//
// 왜 이 파일이 있는가: 게이트는 명단의 활성 기계 전부가 스펙 전부를 나눠 맡는
// 것으로 판정했다. 그래서 윈도우 설치본만 내보내는 0.2.3 도 리눅스 기계의 몫이
// 비면 붉어졌고, PipeWire 마이크처럼 리눅스에서만 도는 스펙까지 윈도우 배포의
// 조건이 되었다. 여기서 재는 것은 셋이다. 매니페스트의 `targets` 를 읽는가,
// 좁혔을 때 대상 운영체제의 기계와 스펙만 보는가, 좁히지 않은 배포는 예전처럼
// 전부를 보는가.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const GATE = resolve(ROOT, "scripts", "check-regression-complete.mjs");
const TARGET_URL = pathToFileURL(resolve(ROOT, "scripts", "lib", "release-target.mjs")).href;

interface Spec {
	spec: string;
	platforms?: string[];
}

/** 모듈 표면. `.mjs` 정적 import 는 루트 tsc 프로그램을 오염시킨다. */
interface TargetModule {
	parseTargets(text: string): string[] | null;
	specInTargets(spec: Spec, targets: string[] | null): boolean;
	specRunsOn(spec: Spec, os: string): boolean;
}

let target: TargetModule;
beforeAll(async () => {
	target = (await import(TARGET_URL)) as TargetModule;
});

const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const inventory = JSON.parse(
	readFileSync(resolve(ROOT, "docs", "e2e-inventory.json"), "utf8"),
) as { specs: Spec[] };

describe("매니페스트의 targets 를 읽는다", () => {
	it("한 줄 목록과 블록 목록을 같은 값으로 읽는다", () => {
		expect(target.parseTargets('version: "1"\ntargets: [windows]\n')).toEqual(["windows"]);
		expect(target.parseTargets("targets:\r\n  - windows\r\n  - linux\r\nsummary: x\r\n")).toEqual([
			"windows",
			"linux",
		]);
	});

	it("적혀 있지 않으면 좁히지 않는다", () => {
		expect(target.parseTargets('version: "1"\n')).toBeNull();
	});

	it("모르는 운영체제나 읽지 못하는 형태는 조용히 넘기지 않는다", () => {
		// 읽지 못한 것을 "대상 없음" 으로 넘기면 좁히지 않은 채 돈다고 착각한다.
		expect(() => target.parseTargets("targets: [win]\n")).toThrow(/win/);
		expect(() => target.parseTargets("targets: windows\n")).toThrow();
		expect(() => target.parseTargets("targets: []\n")).toThrow();
	});
});

describe("스펙의 운영체제", () => {
	it("리눅스 전용 스펙은 인벤토리에 platforms 로 남는다", () => {
		const linuxOnly = inventory.specs.filter((s) => s.platforms?.includes("linux"));
		expect(linuxOnly.map((s) => s.spec).sort()).toEqual([
			"95-voice-linux-shell.spec.ts",
			"96-voice-linux-app-start.spec.ts",
			"99-stt-mic-test.spec.ts",
		]);
		for (const spec of linuxOnly) expect(spec.platforms).toEqual(["linux"]);
	});

	it("선언이 없는 스펙은 어디서나 돈다", () => {
		expect(target.specRunsOn({ spec: "a" }, "windows")).toBe(true);
		expect(target.specRunsOn({ spec: "a", platforms: ["linux"] }, "windows")).toBe(false);
		expect(target.specInTargets({ spec: "a", platforms: ["linux"] }, null)).toBe(true);
		expect(target.specInTargets({ spec: "a", platforms: ["linux"] }, ["windows"])).toBe(false);
	});
});

/** 지금 인벤토리로 찍은 지문. 이것이 없으면 게이트가 기록을 버린다. */
function stamp(): Record<string, string> {
	const digest = execFileSync(
		process.execPath,
		[
			"-e",
			'import("./scripts/lib/inventory-digest.mjs").then((m) => process.stdout.write(m.inventoryDigestFromFile("docs/e2e-inventory.json")))',
		],
		{ cwd: ROOT, encoding: "utf8" },
	);
	return { inventorySha256: digest, commit: "probe", host: "probe", platform: "probe", node: process.version };
}

function passedRecord(machine: string, specs: string[]) {
	const now = new Date().toISOString();
	return {
		machine,
		tiers: ["deterministic_ci", "credentialed_live", "native_local"],
		ranOn: stamp(),
		started: now,
		finished: now,
		status: "passed",
		planned: specs,
		executed: specs,
		passedSpecs: specs,
		premise: "ok",
		envMissingBeforeRun: {},
		groups: [],
		flakySpecs: [],
		stableFailures: [],
	};
}

/**
 * 임시 저장소에서 게이트를 부른다. 실제 인벤토리와 명단을 복사하고, `targets`
 * 를 주면 그 값을 담은 매니페스트를 셸 버전과 함께 세운다.
 */
function runGate(targets: string | null, records: ReturnType<typeof passedRecord>[]) {
	const dir = mkdtempSync(resolve(tmpdir(), "naia-release-target-"));
	scratch.push(dir);
	mkdirSync(resolve(dir, "docs", "regression-runs"), { recursive: true });
	cpSync(resolve(ROOT, "docs", "e2e-inventory.json"), resolve(dir, "docs", "e2e-inventory.json"));
	cpSync(
		resolve(ROOT, "docs", "regression-runs", "machines.json"),
		resolve(dir, "docs", "regression-runs", "machines.json"),
	);
	if (targets !== null) {
		mkdirSync(resolve(dir, "packages", "shell"), { recursive: true });
		mkdirSync(resolve(dir, "releases"), { recursive: true });
		writeFileSync(resolve(dir, "packages", "shell", "package.json"), '{"version":"9.9.9"}');
		writeFileSync(resolve(dir, "releases", "v9.9.9.yaml"), `version: "9.9.9"\ntargets: ${targets}\n`);
	}
	records.forEach((value, index) => {
		writeFileSync(
			resolve(dir, "docs", "regression-runs", `${value.machine}-probe-${index}.json`),
			JSON.stringify(value, null, "\t"),
		);
	});
	const result = spawnSync(process.execPath, [GATE, "--max-age-hours=24"], { cwd: dir, encoding: "utf8" });
	return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

const windowsSpecs = inventory.specs.filter((s) => !s.platforms || s.platforms.includes("windows")).map((s) => s.spec);
const allSpecs = inventory.specs.map((s) => s.spec);

describe("윈도우 배포의 게이트", () => {
	it("윈도우 기계가 윈도우에서 도는 스펙을 전부 통과시키면 초록이다", () => {
		const { code, out } = runGate("[windows]", [passedRecord("win-rtx4060", windowsSpecs)]);
		expect(out).toContain("배포 대상 windows");
		expect(out).toContain("99-stt-mic-test.spec.ts");
		expect(code).toBe(0);
	});

	it("리눅스 기계의 기록은 윈도우 배포를 덮지 못한다", () => {
		// 리눅스 기계가 스펙 전부를 통과시켜도, 윈도우로 나가는 것은 윈도우에서
		// 잰 것이어야 한다.
		const { code, out } = runGate("[windows]", [passedRecord("naia-os-3090", allSpecs)]);
		expect(out).toContain("naia-os-3090 은 이번 배포 대상 운영체제(windows)의 기계가 아니다");
		expect(code).not.toBe(0);
	});

	it("윈도우에서 도는 스펙 하나가 빠지면 붉다", () => {
		const { code, out } = runGate("[windows]", [passedRecord("win-rtx4060", windowsSpecs.slice(1))]);
		expect(out).toContain(windowsSpecs[0]);
		expect(code).not.toBe(0);
	});
});

describe("좁히지 않은 배포는 예전처럼 전부를 본다", () => {
	it("targets 가 없으면 리눅스 기계의 몫이 비어 붉다", () => {
		const { code } = runGate(null, [passedRecord("win-rtx4060", windowsSpecs)]);
		expect(code).not.toBe(0);
	});
});
