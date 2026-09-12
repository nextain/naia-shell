import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	exportDeviceResults,
	exportRoundSnapshot,
	importDeviceResults,
	importRoundSnapshot,
} from "./qa-round-transfer.mjs";
import {
	getRoundStatus,
	hashCandidate,
	hashJson,
	initRound,
	recordResult,
} from "./qa-round.mjs";

const ROUND_ID = "qa-transfer-r1";
const CANDIDATE = "shell-qa-candidate-20260908";
const LINUX_DEVICE = "linux-4060";
const WINDOWS_DEVICE = "windows-4060";
const LINUX_PLATFORM = "linux";
const WINDOWS_PLATFORM = "windows";
const transferScript = fileURLToPath(new URL("./qa-round-transfer.mjs", import.meta.url));

function runTransferCli(args) {
	return JSON.parse(execFileSync(process.execPath, [transferScript, ...args], { encoding: "utf8" }));
}

function manifestFixture() {
	return {
		version: 1,
		verification: { status: "verified", evidenceRef: "fixture:catalog-reviewed" },
		sources: [
			{ id: "UC-TRANSFER-001", kind: "UC", ref: "fixture/user-scenarios.md:1" },
			{ id: "FE-TRANSFER-001", kind: "FE", ref: "fixture/features.md:1" },
		],
		cases: [
			{
				id: "transfer-case-1",
				title: "Round snapshot survives an ADK move",
				method: "Import the central snapshot into each device ADK and inspect its scope.",
				expectedResult: "Both clones retain the fixed round, candidate, and catalog identity.",
				ucIds: ["UC-TRANSFER-001"],
				feIds: ["FE-TRANSFER-001"],
				sourceRef: "fixture:transfer-case-1",
				deviceIds: [LINUX_DEVICE, WINDOWS_DEVICE],
				execution: { kind: "manual", ref: "fixture:device-scope" },
			},
			{
				id: "transfer-case-2",
				title: "Device receipts merge without losing rows",
				method: "Export both device receipts, import them into the central round, and inspect every row.",
				expectedResult: "One terminal result remains for every case/device pair.",
				ucIds: ["UC-TRANSFER-001"],
				feIds: ["FE-TRANSFER-001"],
				sourceRef: "fixture:transfer-case-2",
				deviceIds: [LINUX_DEVICE, WINDOWS_DEVICE],
				execution: { kind: "manual", ref: "fixture:receipt-merge" },
			},
		],
	};
}

function setupCentral() {
	const root = mkdtempSync(join(tmpdir(), "naia-qa-round-transfer-"));
	const centralAdk = join(root, "central-adk");
	const manifestPath = join(root, "catalog.json");
	writeFileSync(manifestPath, `${JSON.stringify(manifestFixture(), null, 2)}\n`, "utf8");
	const state = initRound({
		adkPath: centralAdk,
		manifestPath,
		roundId: ROUND_ID,
		candidate: CANDIDATE,
	});
	return { root, centralAdk, manifestPath, state };
}

function executionAt(createdAt) {
	// Keep the synthetic execution after round creation while ensuring the
	// immediate recordResult call cannot observe recordedAt before it.
	const minimum = new Date(createdAt).getTime() + 1;
	let executionMs = Math.max(Date.now(), minimum);
	while (Date.now() < executionMs) {
		// The only possible wait is the round-creation millisecond boundary.
	}
	return new Date(executionMs).toISOString();
}

function recordDevice(adkPath, deviceId, platform, outcomes) {
	const state = JSON.parse(readFileSync(getRoundStatus({ adkPath, roundId: ROUND_ID }).statePath, "utf8"));
	const executedAt = executionAt(state.createdAt);
	for (const [caseId, result] of Object.entries(outcomes)) {
		recordResult({
			adkPath,
			roundId: ROUND_ID,
			candidate: CANDIDATE,
			caseId,
			deviceId,
			platform,
			executedAt,
			result,
			evidence: `fixture://${deviceId}/${caseId}`,
			failureReason: result === "PASS" ? undefined : `fixture ${result.toLowerCase()} result`,
		});
	}
}

function rehashReceipt(receipt, mutate) {
	const next = structuredClone(receipt);
	mutate(next);
	if (next.candidate !== receipt.candidate) next.candidateHash = hashCandidate(next.candidate);
	next.resultsHash = hashJson(next.results);
	const { receiptHash: ignored, ...unsigned } = next;
	void ignored;
	next.receiptHash = hashJson(unsigned);
	return next;
}

test("portable snapshot clones a fixed round and merges Linux and Windows receipts", () => {
	const fixture = setupCentral();
	try {
		const snapshotPath = join(fixture.root, "round-snapshot.json");
		const snapshot = exportRoundSnapshot({
			adkPath: fixture.centralAdk,
			roundId: ROUND_ID,
			candidate: CANDIDATE,
			outputPath: snapshotPath,
		});
		assert.equal(snapshot.state.manifestSnapshot, null);
		assert.equal(snapshot.roundId, ROUND_ID);
		assert.equal(snapshot.candidate, CANDIDATE);
		assert.equal(snapshot.roundCreatedAt, fixture.state.createdAt);

		const linuxAdk = join(fixture.root, "linux-adk");
		const windowsAdk = join(fixture.root, "windows-adk");
		const linuxStatus = importRoundSnapshot({ adkPath: linuxAdk, snapshotPath });
		const windowsStatus = importRoundSnapshot({ adkPath: windowsAdk, snapshotPath });
		for (const [adkPath, status] of [[linuxAdk, linuxStatus], [windowsAdk, windowsStatus]]) {
			assert.equal(status.roundId, ROUND_ID);
			assert.equal(status.candidate, CANDIDATE);
			assert.equal(status.catalogHash, snapshot.catalogHash);
			const state = JSON.parse(readFileSync(status.statePath, "utf8"));
			assert.equal(state.createdAt, snapshot.roundCreatedAt);
			assert.equal(state.manifestSnapshot, join(adkPath, "qa", "rounds", ROUND_ID, "manifest.json"));
			assert.notEqual(state.manifestSnapshot, fixture.centralAdk);
			assert.equal(JSON.stringify(state).includes(fixture.centralAdk), false);
		}

		recordDevice(linuxAdk, LINUX_DEVICE, LINUX_PLATFORM, {
			"transfer-case-1": "PASS",
			"transfer-case-2": "FAIL",
		});
		recordDevice(windowsAdk, WINDOWS_DEVICE, WINDOWS_PLATFORM, {
			"transfer-case-1": "BLOCKED",
			"transfer-case-2": "PASS",
		});
		const linuxReceipt = exportDeviceResults({
			adkPath: linuxAdk,
			roundId: ROUND_ID,
			deviceId: LINUX_DEVICE,
			candidate: CANDIDATE,
			outputPath: join(fixture.root, "linux-results.json"),
		});
		const windowsReceipt = exportDeviceResults({
			adkPath: windowsAdk,
			roundId: ROUND_ID,
			deviceId: WINDOWS_DEVICE,
			candidate: CANDIDATE,
			outputPath: join(fixture.root, "windows-results.json"),
		});
		const linuxMerged = importDeviceResults({
			adkPath: fixture.centralAdk,
			roundId: ROUND_ID,
			receipt: linuxReceipt,
			candidate: CANDIDATE,
		});
		assert.equal(linuxMerged.counts.NOT_RUN, 2);
		const merged = importDeviceResults({
			adkPath: fixture.centralAdk,
			roundId: ROUND_ID,
			receipt: windowsReceipt,
			candidate: CANDIDATE,
		});
		assert.deepEqual(merged.counts, {
			total: 4,
			NOT_RUN: 0,
			PASS: 2,
			FAIL: 1,
			BLOCKED: 1,
			overall: "BLOCKED",
		});
		assert.equal(merged.launchReady, false);
		assert.throws(
			() => importDeviceResults({ adkPath: fixture.centralAdk, roundId: ROUND_ID, receipt: linuxReceipt }),
			/terminal result|central round already/,
		);
		const centralState = JSON.parse(readFileSync(merged.statePath, "utf8"));
		assert.equal(centralState.results.length, 4);
		assert.deepEqual(
			centralState.results.map(({ caseId, deviceId, result }) => ({ caseId, deviceId, result })),
			[
				{ caseId: "transfer-case-1", deviceId: LINUX_DEVICE, result: "PASS" },
				{ caseId: "transfer-case-1", deviceId: WINDOWS_DEVICE, result: "BLOCKED" },
				{ caseId: "transfer-case-2", deviceId: LINUX_DEVICE, result: "FAIL" },
				{ caseId: "transfer-case-2", deviceId: WINDOWS_DEVICE, result: "PASS" },
			],
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("transfer rejects wrong scope, hashes, device, duplicate rows, and conflicts without mutation", () => {
	const fixture = setupCentral();
	try {
		const snapshot = exportRoundSnapshot({ adkPath: fixture.centralAdk, roundId: ROUND_ID, candidate: CANDIDATE });
		const linuxAdk = join(fixture.root, "linux-adk");
		importRoundSnapshot({ adkPath: linuxAdk, snapshot });
		recordDevice(linuxAdk, LINUX_DEVICE, LINUX_PLATFORM, {
			"transfer-case-1": "PASS",
			"transfer-case-2": "PASS",
		});
		const receipt = exportDeviceResults({ adkPath: linuxAdk, roundId: ROUND_ID, deviceId: LINUX_DEVICE, candidate: CANDIDATE });
		const expectRejected = (candidateReceipt, pattern, options = {}) => {
			assert.throws(
				() => importDeviceResults({ adkPath: fixture.centralAdk, roundId: ROUND_ID, receipt: candidateReceipt, ...options }),
				pattern,
			);
		};
		expectRejected(
			rehashReceipt(receipt, (next) => { next.roundId = "other-round"; }),
			/roundId does not match|roundId|ROUND_MISMATCH/,
		);
		expectRejected(
			rehashReceipt(receipt, (next) => { next.candidate = "different-candidate"; }),
			/candidate hash mismatch|candidate does not match|CANDIDATE_MISMATCH/,
		);
		expectRejected(
			rehashReceipt(receipt, (next) => { next.catalogHash = "0".repeat(64); }),
			/catalog hash does not match|CATALOG_MISMATCH/,
		);
		expectRejected(
			rehashReceipt(receipt, (next) => {
				next.deviceId = "macos-intel";
				for (const result of next.results) result.deviceId = next.deviceId;
			}),
			/device|DEVICE_MISMATCH|outside the central round/,
		);
		expectRejected(
			rehashReceipt(receipt, (next) => { next.results.push(structuredClone(next.results[0])); }),
			/duplicate case|DUPLICATE/,
		);
		const before = getRoundStatus({ adkPath: fixture.centralAdk, roundId: ROUND_ID });
		assert.equal(before.counts.NOT_RUN, 4);
		assert.equal(before.counts.PASS, 0);
		importDeviceResults({ adkPath: fixture.centralAdk, roundId: ROUND_ID, receipt });
		const afterFirst = getRoundStatus({ adkPath: fixture.centralAdk, roundId: ROUND_ID });
		assert.equal(afterFirst.counts.NOT_RUN, 2);
		assert.throws(
			() => importDeviceResults({ adkPath: fixture.centralAdk, roundId: ROUND_ID, receipt }),
			/terminal result|central round already|CONFLICT/,
		);
		assert.equal(getRoundStatus({ adkPath: fixture.centralAdk, roundId: ROUND_ID }).counts.NOT_RUN, 2);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("transfer CLI round-trip preserves markdown and binds imported results", () => {
	const fixture = setupCentral();
	try {
		const snapshotPath = join(fixture.root, "cli-round-snapshot.json");
		const snapshotExport = runTransferCli([
			"snapshot-export",
			"--adk", fixture.centralAdk,
			"--round", ROUND_ID,
			"--candidate", CANDIDATE,
			"--output", snapshotPath,
		]);
		assert.equal(snapshotExport.roundId, ROUND_ID);
		assert.equal(readFileSync(snapshotPath, "utf8").startsWith("{\n"), true);

		const linuxAdk = join(fixture.root, "cli-linux-adk");
		const imported = runTransferCli(["snapshot-import", "--adk", linuxAdk, "--snapshot", snapshotPath]);
		assert.equal(imported.roundId, ROUND_ID);
		const sheetPath = join(linuxAdk, "qa", "rounds", ROUND_ID, "sheet.md");
		const sheet = readFileSync(sheetPath, "utf8");
		assert.match(sheet, /^# QA round /);
		assert.equal(sheet.startsWith("\"#"), false);

		recordDevice(linuxAdk, LINUX_DEVICE, LINUX_PLATFORM, {
			"transfer-case-1": "PASS",
			"transfer-case-2": "PASS",
		});
		const receiptPath = join(fixture.root, "cli-linux-results.json");
		const resultExport = runTransferCli([
			"results-export",
			"--adk", linuxAdk,
			"--round", ROUND_ID,
			"--device", LINUX_DEVICE,
			"--candidate", CANDIDATE,
			"--output", receiptPath,
		]);
		assert.equal(resultExport.deviceId, LINUX_DEVICE);
		const resultImport = runTransferCli([
			"results-import",
			"--adk", fixture.centralAdk,
			"--round", ROUND_ID,
			"--candidate", CANDIDATE,
			"--receipt", receiptPath,
		]);
		assert.deepEqual(resultImport.counts, {
			total: 4,
			NOT_RUN: 2,
			PASS: 2,
			FAIL: 0,
			BLOCKED: 0,
			overall: "NOT_RUN",
		});
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("transfer validates every receipt row before writing any central result", () => {
	const fixture = setupCentral();
	try {
		const snapshot = exportRoundSnapshot({ adkPath: fixture.centralAdk, roundId: ROUND_ID, candidate: CANDIDATE });
		const linuxAdk = join(fixture.root, "linux-adk");
		importRoundSnapshot({ adkPath: linuxAdk, snapshot });
		recordDevice(linuxAdk, LINUX_DEVICE, LINUX_PLATFORM, {
			"transfer-case-1": "PASS",
			"transfer-case-2": "PASS",
		});
		const receipt = exportDeviceResults({
			adkPath: linuxAdk,
			roundId: ROUND_ID,
			deviceId: LINUX_DEVICE,
			candidate: CANDIDATE,
		});
		const invalidReceipt = rehashReceipt(receipt, (next) => {
			next.results[1].executedAt = "2000-01-01T00:00:00Z";
		});
		const before = getRoundStatus({ adkPath: fixture.centralAdk, roundId: ROUND_ID });
		assert.throws(
			() => importDeviceResults({ adkPath: fixture.centralAdk, roundId: ROUND_ID, receipt: invalidReceipt, candidate: CANDIDATE }),
			/executedAt cannot be earlier than the central round createdAt/,
		);
		const after = getRoundStatus({ adkPath: fixture.centralAdk, roundId: ROUND_ID });
		assert.deepEqual(after.counts, before.counts);
		assert.equal(JSON.parse(readFileSync(after.statePath, "utf8")).history.length, 0);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
