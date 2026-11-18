/**
 * 회귀 기록과 기계 명단은 공개 저장소에 있다. 실제 호스트명이 다시 들어오지
 * 않게 막는다 — 명단은 호스트명의 sha256 만, 기록은 기계 id 만 둔다.
 */
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
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
			for (const alias of m.formerNames ?? []) expect(alias).toMatch(/^legacy-machine-[a-z0-9-]+$/);
			if (m.active !== false || m.hostSha256 !== undefined) expect(m.hostSha256).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("run records name the machine, not the host", () => {
		const records = readdirSync(RUNS).filter((f) => f.endsWith(".json") && f !== "machines.json");
		expect(records.length).toBeGreaterThan(0);
		for (const f of records) {
			const r = JSON.parse(readFileSync(join(RUNS, f), "utf8"));
			const host = r.ranOn?.host;
			if (host === undefined) continue;
			expect(machineIds.has(host), `${f}: ranOn.host`).toBe(true);
			expect(host, `${f}: machine binding`).toBe(r.machine);
		}
	});

	it("the runner fingerprints the selected machine with a virtual host", () => {
		const source = readFileSync(join(process.cwd(), "scripts", "run-regression.mjs"), "utf8");
		const start = source.indexOf("function fingerprint()");
		const end = source.indexOf("\n}", start);
		const fingerprint = runInNewContext(`${source.slice(start, end + 2)}; fingerprint`, {
			inventoryDigestFromFile: () => "virtual-inventory", INVENTORY: "virtual.json",
			execFileSync: () => "virtual-commit", machine: "virtual-machine",
			hostname: () => "virtual-private-host",
			process: { platform: "linux", arch: "x64", version: "virtual-node" },
		});
		expect(fingerprint().host).toBe("virtual-machine");
	});
});

// Execute the runner's actual functions with a virtual local host; no real host names.
const runner = readFileSync(join(process.cwd(), "scripts", "run-regression.mjs"), "utf8");
const identitySource = runner.slice(runner.indexOf("function hostSha256()"), runner.indexOf("const profile = roster.machines.find"));
const identity = runInNewContext(`${identitySource}; identityMismatch`, {
 createHash, hostname: () => "virtual-private-host", process: { platform: "linux" },
});
const binding = createHash("sha256").update("virtual-private-host").digest("hex");
describe("virtual host identity contract", () => {
 it.each([undefined, "", " ", "abcd", "0".repeat(63), "A".repeat(64)])("rejects missing or malformed binding %s", (hostSha256) => {
  expect(identity({ os: "linux", active: true, hostSha256 }).join(" ")).toMatch(/hostSha256/);
 });
 it.each(["virtual-old-host", ""]) ("rejects legacy host even with matching binding", (host) => {
  expect(identity({ os: "linux", host, hostSha256: binding }).join(" ")).toMatch(/이관/);
 });
 it("rejects a different host without disclosing the local name", () => {
  const errors = identity({ os: "linux", hostSha256: "0".repeat(64) });
  expect(errors).toHaveLength(1);
  expect(errors.join(" ")).not.toContain("virtual-private-host");
 });
 it("accepts matching binding", () => { expect(identity({ os: "linux", hostSha256: binding })).toEqual([]); });
 it("still rejects OS mismatch", () => { expect(identity({ os: "windows", hostSha256: binding })).toHaveLength(1); });
});
