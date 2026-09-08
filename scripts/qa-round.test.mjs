import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
	acquireLease,
	finalizeRound,
	getRoundStatus,
	initRound,
	recordResult,
	releaseLease,
	validateManifest,
} from "./qa-round.mjs";

const CLI_PATH = fileURLToPath(new URL("./qa-round.mjs", import.meta.url));

function manifest(overrides = {}) {
	return {
		version: 1,
		verification: {
			status: "verified",
			method: "qa-traceability-review",
			evidenceRef: "qa-traceability.json:1",
		},
		sources: [
			{ id: "UC-001", kind: "UC", ref: "docs/user-scenarios.md:1" },
			{ id: "SPEC-001", kind: "FE", ref: "docs/progress/04.features/INDEX.md:18" },
		],
		cases: [
			{
				id: "chat-1",
				title: "A chat turn completes",
				method: "Send one prompt and inspect the rendered response",
				expectedResult: "The response is rendered and the session remains usable",
				ucIds: ["UC-001"],
				feIds: ["SPEC-001"],
				sourceRef: "qa-catalog.md:10",
				deviceIds: ["linux-3090", "windows-4060"],
				execution: { kind: "manual", ref: "qa-runbook.md:20" },
			},
		],
		...overrides,
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "naia-qa-round-"));
	const adk = resolve(root, "adk");
	const manifestPath = resolve(root, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`);
	return { root, adk, manifestPath };
}

function cleanup(fixtureValue) {
	rmSync(fixtureValue.root, { recursive: true, force: true });
}

function executionAt(state) {
	return new Date(Math.max(Date.now(), Date.parse(state.createdAt) + 1)).toISOString();
}

test("validateManifest rejects draft, missing links, and missing execution definitions", () => {
	assert.throws(() => validateManifest(manifest({ verification: { status: "draft", evidenceRef: "x" } })), /draft catalogs/i);
	assert.throws(() => validateManifest(manifest({ sources: [{ id: "UC-001", kind: "UC", ref: "x:1" }] })), /FE source|source has no case coverage/i);
	assert.throws(() => validateManifest(manifest({ cases: [{ ...manifest().cases[0], ucIds: [] }] })), /UNMAPPED|UC/i);
	assert.throws(() => validateManifest(manifest({ cases: [{ ...manifest().cases[0], feIds: [] }] })), /UNMAPPED|FE/i);
	assert.throws(() => validateManifest(manifest({ cases: [{ ...manifest().cases[0], method: "" }] })), /method/i);
	assert.throws(() => validateManifest(manifest({ cases: [{ ...manifest().cases[0], expectedResult: "" }] })), /expectedResult/i);
});

test("init creates a full NOT_RUN matrix and never reuses a prior PASS", () => {
	const f = fixture();
	try {
		const first = initRound({ adkPath: f.adk, manifestPath: f.manifestPath, roundId: "r1", candidate: "candidate-a" });
		assert.equal(first.results.length, 2);
		assert.deepEqual(first.results.map((entry) => entry.result), ["NOT_RUN", "NOT_RUN"]);
		recordResult({
			adkPath: f.adk,
			roundId: "r1",
			candidate: "candidate-a",
			caseId: "chat-1",
			deviceId: "linux-3090",
			platform: "Linux",
			executedAt: executionAt(first),
			result: "PASS",
			evidence: "receipt://r1/linux",
		});
		const second = initRound({ adkPath: f.adk, manifestPath: f.manifestPath, roundId: "r2", candidate: "candidate-a" });
		assert.deepEqual(second.results.map((entry) => entry.result), ["NOT_RUN", "NOT_RUN"]);
		assert.equal(second.previousResultsReused, false);
		const sheet = readFileSync(join(f.adk, "qa", "rounds", "r2", "sheet.md"), "utf8");
		assert.match(sheet, /테스트 방법/);
		assert.match(sheet, /예상하는 테스트 결과/);
		assert.match(sheet, /관련 유저 시나리오\(UC\)/);
		assert.match(sheet, /관련 기능\(FE\)/);
	} finally {
		cleanup(f);
	}
});

test("round snapshot hash rejects catalog edits and the CLI reports the fixed scope", () => {
	const f = fixture();
	try {
		const init = spawnSync(process.execPath, [CLI_PATH, "init", "--adk", f.adk, "--manifest", f.manifestPath, "--round", "cli-r1", "--candidate", "candidate-a"], { encoding: "utf8" });
		assert.equal(init.status, 0, init.stderr);
		const status = spawnSync(process.execPath, [CLI_PATH, "status", "--adk", f.adk, "--round", "cli-r1"], { encoding: "utf8" });
		assert.equal(status.status, 0, status.stderr);
		assert.equal(JSON.parse(status.stdout).counts.NOT_RUN, 2);
		const roundManifestPath = join(f.adk, "qa", "rounds", "cli-r1", "manifest.json");
		const roundManifest = JSON.parse(readFileSync(roundManifestPath, "utf8"));
		roundManifest.cases[0].title = "tampered";
		writeFileSync(roundManifestPath, `${JSON.stringify(roundManifest)}\n`);
		assert.throws(() => getRoundStatus({ adkPath: f.adk, roundId: "cli-r1" }), /catalog hash|snapshot/i);
	} finally {
		cleanup(f);
	}
});

test("record requires execution provenance, evidence, failure reason, and fixed candidate", () => {
	const f = fixture();
	try {
		const opened = initRound({ adkPath: f.adk, manifestPath: f.manifestPath, roundId: "r1", candidate: "candidate-a" });
		const base = {
			adkPath: f.adk,
			roundId: "r1",
			caseId: "chat-1",
			deviceId: "linux-3090",
			platform: "Linux",
			executedAt: executionAt(opened),
			evidence: "receipt://r1/linux",
		};
		assert.throws(() => recordResult({ ...base, candidate: "candidate-b", result: "PASS" }), /candidate/i);
		assert.throws(() => recordResult({ ...base, candidate: "candidate-a", result: "PASS", evidence: "" }), /evidence/i);
		assert.throws(() => recordResult({ ...base, candidate: "candidate-a", result: "FAIL" }), /failureReason/i);
		assert.throws(() => recordResult({ ...base, candidate: "candidate-a", result: "BLOCKED", executedAt: "2026-09-08T00:00:00", failureReason: "not completed" }), /timezone|ISO/i);
		assert.throws(() => recordResult({ ...base, candidate: "candidate-a", result: "BLOCKED", executedAt: new Date(Date.parse(opened.createdAt) - 1).toISOString(), failureReason: "not completed" }), /earlier|createdAt/i);
		const state = recordResult({ ...base, candidate: "candidate-a", result: "FAIL", failureReason: "provider returned an error" });
		assert.equal(state.results[0].result, "FAIL");
		assert.equal(state.results[0].platform, "Linux");
		assert.equal(state.history.length, 1);
		assert.throws(() => recordResult({ ...base, candidate: "candidate-a", result: "PASS" }), /already has a terminal result/i);
	} finally {
		cleanup(f);
	}
});

test("finalize rejects omitted checks, then permits fixes with BLOCKED not launch-ready", () => {
	const f = fixture();
	try {
		const opened = initRound({ adkPath: f.adk, manifestPath: f.manifestPath, roundId: "r1", candidate: "candidate-a" });
		const common = {
			adkPath: f.adk,
			roundId: "r1",
			candidate: "candidate-a",
			platform: "Linux",
			executedAt: executionAt(opened),
			evidence: "receipt://r1",
		};
		recordResult({ ...common, caseId: "chat-1", deviceId: "linux-3090", result: "FAIL", failureReason: "first failure" });
		assert.throws(() => finalizeRound({ adkPath: f.adk, roundId: "r1", candidate: "candidate-a" }), /unrecorded/i);
		recordResult({ ...common, caseId: "chat-1", deviceId: "windows-4060", result: "BLOCKED", failureReason: "inspection incomplete" });
		const finalized = finalizeRound({ adkPath: f.adk, roundId: "r1", candidate: "candidate-a" });
		assert.equal(finalized.phase, "FIX_ALLOWED");
		assert.equal(finalized.finalized, true);
		assert.equal(finalized.launchReady, false);
		assert.deepEqual(getRoundStatus({ adkPath: f.adk, roundId: "r1" }).counts, {
			total: 2,
			NOT_RUN: 0,
			PASS: 0,
			FAIL: 1,
			BLOCKED: 1,
			overall: "BLOCKED",
		});
		assert.throws(() => recordResult({ ...common, caseId: "chat-1", deviceId: "linux-3090", result: "PASS" }), /finalized/i);
	} finally {
		cleanup(f);
	}
});

test("technical scope review keeps an otherwise full PASS round from launch readiness", () => {
	const f = fixture();
	try {
		const reviewedManifest = manifest({
			scopeReview: {
				present: true,
				valid: true,
				dispositionCounts: {
					"direct-case": 1,
					"technical-verification-pending": 1,
				},
			},
		});
		writeFileSync(f.manifestPath, `${JSON.stringify(reviewedManifest, null, 2)}\n`);
		const opened = initRound({
			adkPath: f.adk,
			manifestPath: f.manifestPath,
			roundId: "scope-r1",
			candidate: "candidate-a",
		});
		for (const deviceId of ["linux-3090", "windows-4060"]) {
			recordResult({
				adkPath: f.adk,
				roundId: "scope-r1",
				candidate: "candidate-a",
				caseId: "chat-1",
				deviceId,
				platform: deviceId.startsWith("linux") ? "Linux" : "Windows",
				executedAt: executionAt(opened),
				result: "PASS",
				evidence: `receipt://scope-r1/${deviceId}`,
			});
		}
		const finalized = finalizeRound({ adkPath: f.adk, roundId: "scope-r1", candidate: "candidate-a" });
		assert.equal(finalized.launchReady, false);
		assert.equal(getRoundStatus({ adkPath: f.adk, roundId: "scope-r1" }).launchReady, false);
		assert.deepEqual(finalized.scopeReview.dispositionCounts, {
			"direct-case": 1,
			"technical-verification-pending": 1,
		});
	} finally {
		cleanup(f);
	}
});

test("loadState rejects finalized result mutations and missing terminal evidence fields", () => {
	const mutations = [
		{ name: "platform", mutate: (state) => { state.results[0].platform = null; }, pattern: /platform/i },
		{ name: "executedAt", mutate: (state) => { state.results[0].executedAt = null; }, pattern: /executedAt/i },
		{ name: "evidence", mutate: (state) => { state.results[0].evidence = null; }, pattern: /evidence/i },
		{ name: "failureReason", mutate: (state) => { state.results[0].result = "FAIL"; state.results[0].failureReason = null; }, pattern: /failureReason/i },
		{ name: "snapshot", mutate: (state) => { state.results[0].platform = "tampered"; state.history[0].platform = "tampered"; }, pattern: /snapshot hash/i },
	];
	for (const mutation of mutations) {
		const f = fixture();
		try {
			const opened = initRound({ adkPath: f.adk, manifestPath: f.manifestPath, roundId: "r1", candidate: "candidate-a" });
			const common = {
				adkPath: f.adk,
				roundId: "r1",
				candidate: "candidate-a",
				platform: "Linux",
				executedAt: executionAt(opened),
				evidence: `receipt://r1/${mutation.name}`,
			};
			recordResult({ ...common, caseId: "chat-1", deviceId: "linux-3090", result: "PASS" });
			recordResult({ ...common, caseId: "chat-1", deviceId: "windows-4060", result: "PASS" });
			finalizeRound({ adkPath: f.adk, roundId: "r1", candidate: "candidate-a" });
			const statePath = join(f.adk, "qa", "rounds", "r1", "state.json");
			const state = JSON.parse(readFileSync(statePath, "utf8"));
			mutation.mutate(state);
			writeFileSync(statePath, `${JSON.stringify(state)}\n`);
			assert.throws(() => getRoundStatus({ adkPath: f.adk, roundId: "r1" }), mutation.pattern, mutation.name);
		} finally {
			cleanup(f);
		}
	}
});

test("record rejects additional case/device scope and leases collide only within the selected ADK", () => {
	const f = fixture();
	const other = fixture();
	try {
		initRound({ adkPath: f.adk, manifestPath: f.manifestPath, roundId: "r1", candidate: "candidate-a" });
		const common = {
			adkPath: f.adk,
			roundId: "r1",
			candidate: "candidate-a",
			platform: "Linux",
			executedAt: "2026-09-08T00:00:00Z",
			result: "PASS",
			evidence: "receipt://r1",
		};
		assert.throws(() => recordResult({ ...common, caseId: "other", deviceId: "linux-3090" }), /outside this round/i);
		assert.throws(() => recordResult({ ...common, caseId: "chat-1", deviceId: "macos" }), /outside this round/i);
		const first = acquireLease({ adkPath: f.adk, deviceId: "linux-3090", owner: "agent-a" });
		assert.throws(() => acquireLease({ adkPath: f.adk, deviceId: "linux-3090", owner: "agent-b" }), /already held/i);
		const independent = acquireLease({ adkPath: other.adk, deviceId: "linux-3090", owner: "agent-b" });
		assert.notEqual(first.leaseId, independent.leaseId);
		assert.throws(() => releaseLease({ adkPath: f.adk, deviceId: "linux-3090", owner: "agent-b" }), /owner mismatch/i);
		releaseLease({ adkPath: f.adk, deviceId: "linux-3090", owner: "agent-a" });
		releaseLease({ adkPath: other.adk, deviceId: "linux-3090", owner: "agent-b" });
	} finally {
		cleanup(f);
		cleanup(other);
	}
});
