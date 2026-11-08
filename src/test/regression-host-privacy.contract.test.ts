/**
 * 회귀 기록과 기계 명단은 공개 저장소에 있다. 실제 호스트명이 다시 들어오지
 * 않게 막는다 — 명단은 호스트명의 sha256 만, 기록은 기계 id 만 둔다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RUNS = join(process.cwd(), "docs", "regression-runs");
const roster = JSON.parse(readFileSync(join(RUNS, "machines.json"), "utf8"));
const machineIds = new Set<string>(roster.machines.map((m: { name: string }) => m.name));

describe("regression host privacy", () => {
	it("roster keeps only a sha256 of each host name", () => {
		for (const m of roster.machines) {
			expect(m, m.name).not.toHaveProperty("host");
			if (m.hostSha256 !== undefined) expect(m.hostSha256).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("run records name the machine, not the host", () => {
		const records = readdirSync(RUNS).filter((f) => f.endsWith(".json") && f !== "machines.json");
		expect(records.length).toBeGreaterThan(0);
		for (const f of records) {
			const r = JSON.parse(readFileSync(join(RUNS, f), "utf8"));
			const host = r.ranOn?.host;
			if (host === undefined) continue;
			expect(machineIds.has(host) || host === "unknown", `${f}: ranOn.host`).toBe(true);
		}
	});

	it("the runner records the machine id instead of hostname()", () => {
		const runner = readFileSync(join(process.cwd(), "scripts", "run-regression.mjs"), "utf8");
		expect(runner).not.toMatch(/host:\s*hostname\(\)/);
		expect(runner).toMatch(/host:\s*machine\b/);
	});
});
