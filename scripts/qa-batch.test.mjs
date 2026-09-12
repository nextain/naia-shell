import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import BatchResultsReporter, { BATCH_RESULTS_SCHEMA } from "../packages/shell/e2e-tauri/batch-results.mjs";
import { initRound, getRoundStatus } from "./qa-round.mjs";
import { importBatchResults, planBatch } from "./qa-batch.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deviceId = "linux-4060";
const platform = "Linux x86_64";
const candidate = "shell-4da9864deff40c879c960a30cb51a376e996fa17-agent-1c2561d";

function makeManifest() {
	return {
		version: 1,
		verification: { status: "verified", evidenceRef: "fixture:catalog-review" },
		sources: [
			{ id: "UC-001", kind: "UC", ref: "fixture:uc-001" },
			{ id: "FE-001", kind: "FE", ref: "fixture:fe-001" },
		],
		cases: [
			{
				id: "BATCH-001",
				title: "Two observations are required",
				method: "Run both native observations in one session",
				expectedResult: "Both observations report PASS",
				ucIds: ["UC-001"],
				feIds: ["FE-001"],
				sourceRef: "fixture:case-001",
				deviceIds: [deviceId],
				execution: { kind: "batch", ref: "fixture.spec.ts" },
			},
			{
				id: "BATCH-002",
				title: "Failure remains visible",
				method: "Run the native failure observation",
				expectedResult: "The failure is recorded with a reason",
				ucIds: ["UC-001"],
				feIds: ["FE-001"],
				sourceRef: "fixture:case-002",
				deviceIds: [deviceId],
				execution: { kind: "batch", ref: "fixture.spec.ts" },
			},
			{
				id: "BATCH-003",
				title: "Later cases still import",
				method: "Run the later native observation",
				expectedResult: "The later observation is imported after an earlier failure",
				ucIds: ["UC-001"],
				feIds: ["FE-001"],
				sourceRef: "fixture:case-003",
				deviceIds: [deviceId],
				execution: { kind: "batch", ref: "fixture.spec.ts" },
			},
			{
				id: "MANUAL-001",
				title: "Manual-only acceptance",
				method: "Inspect the installed application manually",
				expectedResult: "The operator records the manual result",
				ucIds: ["UC-001"],
				feIds: ["FE-001"],
				sourceRef: "fixture:manual",
				deviceIds: [deviceId],
				execution: { kind: "manual", ref: "operator" },
			},
		],
	};
}

function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "naia-qa-batch-"));
	const adkPath = join(root, "adk");
	const fixturePath = join(root, "fixture.spec.ts");
	const manifestPath = join(root, "manifest.json");
	mkdirSync(adkPath, { recursive: true });
	writeFileSync(fixturePath, "export const fixture = true;\n");
	writeFileSync(manifestPath, `${JSON.stringify(makeManifest(), null, 2)}\n`);
	initRound({ adkPath, manifestPath, roundId: "round-001", candidate });
	return { root, adkPath, fixturePath, manifestPath };
}

function makePlan(fixture) {
	return planBatch({
		adkPath: fixture.adkPath,
		roundId: "round-001",
		candidate,
		deviceId,
		platform,
		specBaseDir: fixture.root,
		workingDirectory: projectRoot,
		mapping: {
			cases: [
				{
					caseId: "BATCH-001",
					requiredObservations: [
						{ file: fixture.fixturePath, testTitle: "BATCH-001 / primary" },
						{ file: fixture.fixturePath, testTitle: "BATCH-001 / secondary" },
					],
				},
				{ caseId: "BATCH-002", requiredObservations: [{ file: fixture.fixturePath, testTitle: "BATCH-002 / failure" }] },
				{ caseId: "BATCH-003", requiredObservations: [{ file: fixture.fixturePath, testTitle: "BATCH-003 / later" }] },
			],
		},
	});
}

function writeResults(fixture, plan, events, suffix = "fixture-run") {
	const runId = `${plan.runPrefix}-${suffix}`;
	const resultDir = join(fixture.adkPath, "e2e-batch-results", runId);
	const jsonlPath = join(resultDir, "results.jsonl");
	mkdirSync(resultDir, { recursive: true });
	writeFileSync(jsonlPath, `${events.map((event) => JSON.stringify({ ...event, runId })).join("\n")}\n`);
	return jsonlPath;
}

function writeReporterResults(fixture, planPath, plan, observations) {
	const reporter = new BatchResultsReporter({ adkPath: fixture.adkPath, planPath, runId: plan.runPrefix });
	const cid = "wdio-0";
	reporter.emit("runner:start", { cid, specs: [fixture.fixturePath] });
	for (const observation of observations) {
		const startedAt = new Date().toISOString();
		const testEvent = {
			cid,
			uid: `fixture-${observation.title}`,
			file: fixture.fixturePath,
			fullTitle: observation.title,
			title: observation.title,
			start: startedAt,
			end: startedAt,
		};
		reporter.emit("test:start", testEvent);
		if (observation.status === "PASS") {
			reporter.emit("test:pass", testEvent);
		} else if (observation.status === "FAIL") {
			reporter.emit("test:fail", { ...testEvent, error: { message: observation.reason ?? "fixture assertion failed" } });
		} else if (observation.status === "SKIP") {
			reporter.emit("test:skip", { ...testEvent, reason: observation.reason ?? "fixture skipped" });
		} else {
			throw new Error(`unsupported reporter fixture status: ${observation.status}`);
		}
	}
	reporter.emit("runner:end", { cid, failures: observations.filter((observation) => observation.status === "FAIL").length });
	return { jsonlPath: reporter.flush(), runId: reporter.runId };
}

function readReporterRows(jsonlPath) {
	return readFileSync(jsonlPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function writeReporterRows(jsonlPath, rows) {
	writeFileSync(jsonlPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function event(plan, fixture, title, status, timestamp, extra = {}) {
	return {
		schema: BATCH_RESULTS_SCHEMA,
		kind: "test",
		event: status === "PASS" ? "test_passed" : status === "FAIL" ? "test_failed" : "test_blocked",
		status,
		file: fixture.fixturePath,
		title,
		timestamps: { finishedAt: timestamp },
		...extra,
	};
}

function freshTimestamp() {
	return new Date(Date.now() + 2_000).toISOString();
}

test("plan binds every batch case to device/platform and explicit native observations", () => {
	const fixture = makeFixture();
	try {
		const { path, plan } = makePlan(fixture);
		assert.equal(plan.deviceId, deviceId);
		assert.equal(plan.platform, platform);
		assert.equal(plan.cases.length, 3);
		assert.deepEqual(plan.wdioPlan.specs, [[fixture.fixturePath]]);
		assert.equal(JSON.parse(readFileSync(plan.wdioPlan.nativePlanPath, "utf8")).specs[0][0], fixture.fixturePath);
		assert.equal(plan.wdioPlan.commands.posix, plan.wdioPlan.command);
		assert.match(plan.wdioPlan.commands.powershell, /\$env:NAIA_E2E_ADK_PATH/);
		assert.equal(plan.planHash.length, 64);
		assert.match(plan.runPrefix, /^qa-round-001-/);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).candidate, candidate);
		const tamperedPlan = JSON.parse(readFileSync(path, "utf8"));
		tamperedPlan.platform = "Windows 4060";
		writeFileSync(path, `${JSON.stringify(tamperedPlan)}\n`);
		assert.throws(
			() => importBatchResults({
				adkPath: fixture.adkPath,
				planPath: path,
				candidate,
				deviceId,
				platform,
				jsonlPath: join(fixture.root, "missing-results.jsonl"),
			}),
			/batch plan hash mismatch/,
		);
		assert.throws(
			() => planBatch({
				adkPath: fixture.adkPath,
				roundId: "round-001",
				candidate,
				deviceId,
				platform,
				specBaseDir: fixture.root,
				mapping: { cases: [{ caseId: "BATCH-001", requiredObservations: [{ file: fixture.fixturePath, testTitle: "only one" }] }] },
			}),
			/batch case has no required observation mapping: BATCH-002/,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("import records complete cases, preserves a failure, and continues to later cases", () => {
	const fixture = makeFixture();
	try {
		const { plan, path: planPath } = makePlan(fixture);
		const { jsonlPath } = writeReporterResults(fixture, planPath, plan, [
			{ title: "BATCH-001 / primary", status: "PASS" },
			{ title: "BATCH-001 / secondary", status: "PASS" },
			{ title: "BATCH-002 / failure", status: "FAIL", reason: "fixture assertion failed" },
			{ title: "BATCH-003 / later", status: "PASS" },
			{ title: "auxiliary test", status: "PASS" },
		]);
		const imported = importBatchResults({ adkPath: fixture.adkPath, planPath, candidate, deviceId, platform, jsonlPath });
		assert.deepEqual(imported.imported.map((item) => [item.caseId, item.result]), [
			["BATCH-001", "PASS"],
			["BATCH-002", "FAIL"],
			["BATCH-003", "PASS"],
		]);
		assert.equal(imported.skipped.length, 0);
		assert.deepEqual(imported.status.counts, { total: 4, NOT_RUN: 1, PASS: 2, FAIL: 1, BLOCKED: 0, overall: "NOT_RUN" });
		assert.equal(imported.status.launchReady, false);
		assert.throws(
			() => importBatchResults({ adkPath: fixture.adkPath, planPath, candidate, deviceId, platform, jsonlPath }),
			/case\/device is already terminal or outside round/,
		);
		assert.deepEqual(getRoundStatus({ adkPath: fixture.adkPath, roundId: "round-001" }).counts, imported.status.counts);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("partial observations remain NOT_RUN and malformed bindings cannot mutate the round", () => {
	const fixture = makeFixture();
	try {
		const { plan, path: planPath } = makePlan(fixture);
		const timestamp = freshTimestamp();
		const partialPath = writeReporterResults(fixture, planPath, plan, [
			{ title: "BATCH-001 / primary", status: "FAIL", reason: "known fixture failure" },
		]).jsonlPath;
		const partial = importBatchResults({ adkPath: fixture.adkPath, planPath, candidate, deviceId, platform, jsonlPath: partialPath });
		assert.deepEqual(partial.imported.map((item) => [item.caseId, item.result]), [["BATCH-001", "FAIL"]]);
		assert.match(partial.imported[0].failureReason, /missing/);
		assert.equal(partial.skipped.length, 2);
		assert.deepEqual(getRoundStatus({ adkPath: fixture.adkPath, roundId: "round-001" }).counts, { total: 4, NOT_RUN: 3, PASS: 0, FAIL: 1, BLOCKED: 0, overall: "NOT_RUN" });
		assert.equal(partial.status.launchReady, false);
		assert.throws(
			() => importBatchResults({ adkPath: fixture.adkPath, planPath, candidate, deviceId, platform: "Windows 4060", jsonlPath: partialPath }),
			/platform does not match batch plan/,
		);
		assert.throws(
			() => importBatchResults({ adkPath: fixture.adkPath, planPath, candidate: "other-candidate", deviceId, platform, jsonlPath: partialPath }),
			/candidate does not match batch plan/,
		);
		assert.throws(
			() => importBatchResults({ adkPath: fixture.adkPath, planPath, candidate, deviceId: "windows-4060", platform, jsonlPath: partialPath }),
			/deviceId does not match batch plan/,
		);
		const stalePath = writeResults(fixture, plan, [event(plan, fixture, "BATCH-001 / primary", "PASS", "2020-01-01T00:00:00Z")], "stale");
		assert.throws(
			() => importBatchResults({ adkPath: fixture.adkPath, planPath, candidate, deviceId, platform, jsonlPath: stalePath }),
			/predates the planned round/,
		);
		assert.equal(getRoundStatus({ adkPath: fixture.adkPath, roundId: "round-001" }).counts.FAIL, 1);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("duplicate terminal observations are rejected before any write", () => {
	const fixture = makeFixture();
	try {
		const { plan, path: planPath } = makePlan(fixture);
		const jsonlPath = writeReporterResults(fixture, planPath, plan, [
			{ title: "BATCH-001 / primary", status: "PASS" },
		]).jsonlPath;
		const rows = readReporterRows(jsonlPath);
		const terminal = rows.find((row) => row.kind === "test" && row.status === "PASS");
		assert.ok(terminal);
		writeReporterRows(jsonlPath, [...rows, structuredClone(terminal)]);
		assert.throws(
			() => importBatchResults({ adkPath: fixture.adkPath, planPath, candidate, deviceId, platform, jsonlPath }),
			/duplicate terminal result/,
		);
		assert.equal(getRoundStatus({ adkPath: fixture.adkPath, roundId: "round-001" }).counts.PASS, 0);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("actual reporter artifacts reject schema, binding, stale time, and duplicate mutations before writing", () => {
	const mutations = [
		{
			name: "schema",
			pattern: /unsupported schema/,
			mutate: (rows) => { rows[0].schema = "invalid-schema"; },
		},
		{
			name: "binding",
			pattern: /platform does not match batch plan/,
			mutate: (rows) => {
				const terminal = rows.find((row) => row.kind === "test" && row.status === "PASS");
				terminal.platform = "Windows 4060";
			},
		},
		{
			name: "timestamp",
			pattern: /predates the planned round/,
			mutate: (rows) => {
				const terminal = rows.find((row) => row.kind === "test" && row.status === "PASS");
				terminal.timestamps.finishedAt = "2020-01-01T00:00:00Z";
				terminal.timestamps.recordedAt = "2020-01-01T00:00:00Z";
			},
		},
		{
			name: "duplicate",
			pattern: /duplicate terminal result/,
			mutate: (rows) => {
				const terminal = rows.find((row) => row.kind === "test" && row.status === "PASS");
				rows.push(structuredClone(terminal));
			},
		},
	];
	for (const mutation of mutations) {
		const fixture = makeFixture();
		try {
			const { plan, path: planPath } = makePlan(fixture);
			const jsonlPath = writeReporterResults(fixture, planPath, plan, [
				{ title: "BATCH-001 / primary", status: "PASS" },
			]).jsonlPath;
			const rows = structuredClone(readReporterRows(jsonlPath));
			mutation.mutate(rows);
			writeReporterRows(jsonlPath, rows);
			assert.throws(
				() => importBatchResults({ adkPath: fixture.adkPath, planPath, candidate, deviceId, platform, jsonlPath }),
				mutation.pattern,
				mutation.name,
			);
			assert.deepEqual(getRoundStatus({ adkPath: fixture.adkPath, roundId: "round-001" }).counts, {
				total: 4,
				NOT_RUN: 4,
				PASS: 0,
				FAIL: 0,
				BLOCKED: 0,
				overall: "NOT_RUN",
			});
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	}
});
