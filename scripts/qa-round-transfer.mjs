#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	getRoundStatus,
	hashCandidate,
	hashJson,
	recordResult,
	validateManifest,
	withExclusiveLock,
} from "./qa-round.mjs";

export const QA_TRANSFER_VERSION = 1;
export const QA_TRANSFER_SCHEMA = "naia-shell.qa-round-transfer.v1";

const RESULT_STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const ISO_DATETIME_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

class QaTransferError extends Error {
	constructor(message, code = "INVALID") {
		super(`[qa-round-transfer] ${message}`);
		this.name = "QaTransferError";
		this.code = code;
	}
}

function fail(message, code = "INVALID") {
	throw new QaTransferError(message, code);
}

function nonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
	return value.trim();
}

function absolutePath(value, label) {
	const text = nonEmptyString(value, label);
	if (!isAbsolute(text)) fail(`${label} must be an absolute path`);
	return resolve(text);
}

function safeRoundId(value) {
	const text = nonEmptyString(value, "roundId");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(text)) fail("roundId must contain only short filename-safe characters");
	return text;
}

function readJson(path, label = path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, path);
}

function writeTextAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(descriptor, value, "utf8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, path);
}

function parseIso(value, label) {
	const text = nonEmptyString(value, label);
	if (!ISO_DATETIME_WITH_TIMEZONE.test(text)) fail(`${label} must be an ISO datetime with an explicit timezone`);
	const date = new Date(text);
	if (Number.isNaN(date.getTime())) fail(`${label} must be a valid timestamp`);
	return date.toISOString();
}

function roundPaths(adkPath, roundId) {
	const adk = absolutePath(adkPath, "adkPath");
	const id = safeRoundId(roundId);
	const qa = join(adk, "qa");
	const roundRoot = join(qa, "rounds", id);
	return {
		adk,
		qa,
		id,
		roundRoot,
		manifestPath: join(qa, "manifest.json"),
		roundManifestPath: join(roundRoot, "manifest.json"),
		statePath: join(roundRoot, "state.json"),
		sheetPath: join(roundRoot, "sheet.md"),
		lockPath: join(qa, ".locks", `transfer-${id}.lock`),
	};
}

function loadRound(adkPath, roundId) {
	const status = getRoundStatus({ adkPath, roundId });
	const paths = roundPaths(adkPath, roundId);
	const state = readJson(status.statePath, "round state");
	const manifest = validateManifest(readJson(paths.roundManifestPath, "round manifest"));
	return { status, state, manifest, paths };
}

function portableScope(state) {
	return {
		roundId: state.roundId,
		candidate: state.candidate,
		candidateHash: state.candidateHash,
		catalogHash: state.catalogHash,
		createdAt: state.createdAt,
		cases: state.cases,
	};
}

function scopeHash(state) {
	return hashJson(portableScope(state));
}

function assertHash(value, label) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a SHA-256 hex digest`);
}

function assertSnapshot(snapshot) {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("round snapshot must be an object");
	if (snapshot.schema !== QA_TRANSFER_SCHEMA || snapshot.version !== QA_TRANSFER_VERSION || snapshot.kind !== "round-snapshot") {
		fail("unsupported round snapshot schema/version");
	}
	const { snapshotHash, ...unsigned } = snapshot;
	assertHash(snapshotHash, "snapshotHash");
	if (snapshotHash !== hashJson(unsigned)) fail("round snapshot hash mismatch", "INTEGRITY");
	safeRoundId(snapshot.roundId);
	nonEmptyString(snapshot.candidate, "snapshot candidate");
	if (snapshot.candidateHash !== hashCandidate(snapshot.candidate)) fail("round snapshot candidate hash mismatch", "INTEGRITY");
	assertHash(snapshot.catalogHash, "snapshot catalogHash");
	assertHash(snapshot.roundScopeHash, "snapshot roundScopeHash");
	parseIso(snapshot.roundCreatedAt, "snapshot roundCreatedAt");
	parseIso(snapshot.exportedAt, "snapshot exportedAt");
	const manifest = validateManifest(snapshot.manifest);
	if (hashJson(manifest) !== snapshot.catalogHash) fail("round snapshot catalog hash mismatch", "INTEGRITY");
	if (!snapshot.state || typeof snapshot.state !== "object" || Array.isArray(snapshot.state)) fail("round snapshot state is missing");
	if (snapshot.state.manifestSnapshot !== null) fail("round snapshot contains an absolute manifest path", "PORTABILITY");
	if (snapshot.state.roundId !== snapshot.roundId || snapshot.state.candidate !== snapshot.candidate || snapshot.state.catalogHash !== snapshot.catalogHash) {
		fail("round snapshot state scope does not match its metadata", "INTEGRITY");
	}
	if (snapshot.state.createdAt !== snapshot.roundCreatedAt || scopeHash(snapshot.state) !== snapshot.roundScopeHash) {
		fail("round snapshot scope hash does not match its state", "INTEGRITY");
	}
	if (!Array.isArray(snapshot.state.cases) || !Array.isArray(snapshot.state.results) || !Array.isArray(snapshot.state.history)) {
		fail("round snapshot state arrays are missing", "INTEGRITY");
	}
	if (snapshot.state.candidateHash !== hashCandidate(snapshot.candidate)) {
		fail("round snapshot state candidate hash does not match its metadata", "INTEGRITY");
	}
	if (snapshot.state.finalized || snapshot.state.phase !== "OPEN" || snapshot.state.status !== "OPEN" || snapshot.state.history.length !== 0) {
		fail("only an open, unrecorded round can be transferred", "SCOPE");
	}
	if (!Array.isArray(snapshot.state.results) || snapshot.state.results.some((entry) => entry.result !== "NOT_RUN")) {
		fail("round snapshot cannot reuse prior results", "SCOPE");
	}
	if (hashJson(snapshot.state.cases) !== hashJson(manifest.cases)) fail("round snapshot case scope does not match its manifest", "INTEGRITY");
	return { manifest, state: snapshot.state };
}

function renderSheet(state) {
	const lines = [
		`# QA round ${state.roundId}`,
		"",
		`- Candidate: ${state.candidate}`,
		`- Candidate SHA-256: ${state.candidateHash}`,
		`- Catalog SHA-256: ${state.catalogHash}`,
		`- Phase: ${state.phase}`,
		`- Launch ready: ${state.launchReady ? "true" : "false"}`,
		"",
		"| Case ID | Device | Platform | Result | Executed at | Evidence | Failure reason |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const result of state.results) {
		const cell = (value) => value === null || value === undefined || value === "" ? "—" : String(value).replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
		lines.push(`| ${cell(result.caseId)} | ${cell(result.deviceId)} | ${cell(result.platform)} | ${cell(result.result)} | ${cell(result.executedAt)} | ${cell(result.evidence)} | ${cell(result.failureReason)} |`);
	}
	return `${lines.join("\n")}\n`;
}

function snapshotUnsigned({ manifest, state, exportedAt }) {
	const portableState = { ...state, manifestSnapshot: null };
	return {
		schema: QA_TRANSFER_SCHEMA,
		version: QA_TRANSFER_VERSION,
		kind: "round-snapshot",
		roundId: state.roundId,
		candidate: state.candidate,
		candidateHash: state.candidateHash,
		catalogHash: state.catalogHash,
		roundCreatedAt: state.createdAt,
		roundScopeHash: scopeHash(portableState),
		exportedAt,
		manifest,
		state: portableState,
	};
}

export function exportRoundSnapshot({ adkPath, roundId, candidate, outputPath } = {}) {
	const loaded = loadRound(adkPath, roundId);
	if (candidate !== undefined && nonEmptyString(candidate, "candidate") !== loaded.state.candidate) fail("candidate does not match the fixed round", "CANDIDATE_MISMATCH");
	if (loaded.state.finalized || loaded.state.phase !== "OPEN") fail("round snapshot requires an open round", "SCOPE");
	if (loaded.state.results.some((entry) => entry.result !== "NOT_RUN") || loaded.state.history.length > 0) {
		fail("round snapshot refuses to reuse prior results", "SCOPE");
	}
	const unsigned = snapshotUnsigned({ manifest: loaded.manifest, state: loaded.state, exportedAt: new Date().toISOString() });
	const snapshot = { ...unsigned, snapshotHash: hashJson(unsigned) };
	if (outputPath !== undefined) writeJsonAtomic(absolutePath(outputPath, "outputPath"), snapshot);
	return snapshot;
}

export function importRoundSnapshot({ adkPath, snapshotPath, snapshot: suppliedSnapshot } = {}) {
	const snapshot = suppliedSnapshot ?? readJson(absolutePath(snapshotPath, "snapshotPath"), "round snapshot");
	const { manifest, state: sourceState } = assertSnapshot(snapshot);
	const paths = roundPaths(adkPath, snapshot.roundId);
	withExclusiveLock(paths.lockPath, () => {
		if (existsSync(paths.roundRoot)) fail(`destination round already exists: ${snapshot.roundId}`, "CONFLICT");
		if (existsSync(paths.manifestPath)) {
			const existing = validateManifest(readJson(paths.manifestPath, "destination catalog"));
			if (hashJson(existing) !== snapshot.catalogHash) fail("destination catalog conflicts with round snapshot", "CONFLICT");
		} else {
			writeJsonAtomic(paths.manifestPath, manifest);
		}
		const state = { ...sourceState, manifestSnapshot: paths.roundManifestPath };
		mkdirSync(paths.roundRoot, { recursive: true });
		writeJsonAtomic(paths.roundManifestPath, manifest);
		writeJsonAtomic(paths.statePath, state);
		writeTextAtomic(paths.sheetPath, renderSheet(state));
	});
	return getRoundStatus({ adkPath, roundId: snapshot.roundId });
}

function assertTerminalResult(result, label) {
	if (!result || typeof result !== "object" || Array.isArray(result)) fail(`${label} must be an object`);
	const caseId = nonEmptyString(result.caseId, `${label}.caseId`);
	const deviceId = nonEmptyString(result.deviceId, `${label}.deviceId`);
	const platform = nonEmptyString(result.platform, `${label}.platform`);
	const executedAt = parseIso(result.executedAt, `${label}.executedAt`);
	const recordedAt = parseIso(result.recordedAt, `${label}.recordedAt`);
	const status = nonEmptyString(result.result, `${label}.result`).toUpperCase();
	if (!RESULT_STATUSES.has(status)) fail(`${label}.result must be PASS, FAIL, or BLOCKED`);
	const evidence = nonEmptyString(result.evidence, `${label}.evidence`);
	let failureReason = null;
	if (status === "PASS") {
		if (result.failureReason !== null) fail(`${label}.failureReason must be null for PASS`);
	} else {
		failureReason = nonEmptyString(result.failureReason, `${label}.failureReason`);
	}
	return { caseId, deviceId, platform, executedAt, result: status, evidence, failureReason, recordedAt };
}

function receiptUnsigned({ state, deviceId, results, exportedAt }) {
	return {
		schema: QA_TRANSFER_SCHEMA,
		version: QA_TRANSFER_VERSION,
		kind: "device-results",
		roundId: state.roundId,
		candidate: state.candidate,
		candidateHash: state.candidateHash,
		catalogHash: state.catalogHash,
		roundCreatedAt: state.createdAt,
		roundScopeHash: scopeHash(state),
		deviceId,
		exportedAt,
		results,
		resultsHash: hashJson(results),
	};
}

function assertReceipt(receipt) {
	if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail("device receipt must be an object");
	if (receipt.schema !== QA_TRANSFER_SCHEMA || receipt.version !== QA_TRANSFER_VERSION || receipt.kind !== "device-results") fail("unsupported device receipt schema/version");
	const { receiptHash, ...unsigned } = receipt;
	assertHash(receiptHash, "receiptHash");
	if (receiptHash !== hashJson(unsigned)) fail("device receipt hash mismatch", "INTEGRITY");
	safeRoundId(receipt.roundId);
	nonEmptyString(receipt.candidate, "receipt candidate");
	if (receipt.candidateHash !== hashCandidate(receipt.candidate)) fail("device receipt candidate hash mismatch", "INTEGRITY");
	assertHash(receipt.catalogHash, "receipt catalogHash");
	assertHash(receipt.roundScopeHash, "receipt roundScopeHash");
	nonEmptyString(receipt.deviceId, "receipt deviceId");
	parseIso(receipt.roundCreatedAt, "receipt roundCreatedAt");
	parseIso(receipt.exportedAt, "receipt exportedAt");
	if (!Array.isArray(receipt.results) || receipt.results.length === 0) fail("device receipt results must be non-empty");
	if (receipt.resultsHash !== hashJson(receipt.results)) fail("device receipt results hash mismatch", "INTEGRITY");
	const seen = new Set();
	const results = receipt.results.map((result, index) => {
		const normalized = assertTerminalResult(result, `receipt.results[${index}]`);
		if (normalized.deviceId !== receipt.deviceId) fail("device receipt contains a result for another device", "DEVICE_MISMATCH");
		if (seen.has(normalized.caseId)) fail(`device receipt contains duplicate case: ${normalized.caseId}`, "DUPLICATE");
		seen.add(normalized.caseId);
		return normalized;
	});
	return { ...receipt, results };
}

export function exportDeviceResults({ adkPath, roundId, deviceId, candidate, outputPath } = {}) {
	const normalizedDeviceId = nonEmptyString(deviceId, "deviceId");
	const loaded = loadRound(adkPath, roundId);
	if (candidate !== undefined && nonEmptyString(candidate, "candidate") !== loaded.state.candidate) fail("candidate does not match the fixed round", "CANDIDATE_MISMATCH");
	const results = loaded.state.results.filter((entry) => entry.deviceId === normalizedDeviceId);
	if (results.length === 0) fail(`device is outside the round: ${normalizedDeviceId}`, "DEVICE_MISMATCH");
	if (results.some((entry) => entry.result === "NOT_RUN")) fail("device results are incomplete; NOT_RUN rows cannot be exported", "INCOMPLETE");
	const normalizedResults = results.map((result, index) => assertTerminalResult(result, `round result ${index}`));
	const unsigned = receiptUnsigned({ state: loaded.state, deviceId: normalizedDeviceId, results: normalizedResults, exportedAt: new Date().toISOString() });
	const receipt = { ...unsigned, receiptHash: hashJson(unsigned) };
	if (outputPath !== undefined) writeJsonAtomic(absolutePath(outputPath, "outputPath"), receipt);
	return receipt;
}

export function importDeviceResults({ adkPath, roundId: selectedRoundId, receiptPath, receipt: suppliedReceipt, candidate } = {}) {
	const receipt = assertReceipt(suppliedReceipt ?? readJson(absolutePath(receiptPath, "receiptPath"), "device receipt"));
	if (selectedRoundId !== undefined && safeRoundId(selectedRoundId) !== receipt.roundId) {
		fail("device receipt roundId does not match the selected central round", "ROUND_MISMATCH");
	}
	const roundId = selectedRoundId === undefined ? receipt.roundId : safeRoundId(selectedRoundId);
	const paths = roundPaths(adkPath, roundId);
	return withExclusiveLock(paths.lockPath, () => {
		const loaded = loadRound(adkPath, roundId);
		if (loaded.state.finalized) fail("finalized rounds cannot receive device results", "FINALIZED");
		if (candidate !== undefined && nonEmptyString(candidate, "candidate") !== loaded.state.candidate) fail("candidate does not match the fixed round", "CANDIDATE_MISMATCH");
		if (receipt.candidate !== loaded.state.candidate || receipt.candidateHash !== loaded.state.candidateHash) fail("device receipt candidate does not match the central round", "CANDIDATE_MISMATCH");
		if (receipt.catalogHash !== loaded.state.catalogHash) fail("device receipt catalog hash does not match the central round", "CATALOG_MISMATCH");
		if (receipt.roundCreatedAt !== loaded.state.createdAt) fail("device receipt round createdAt does not match the central round", "ROUND_MISMATCH");
		if (receipt.roundScopeHash !== scopeHash(loaded.state)) fail("device receipt round scope hash does not match the central round", "SCOPE_MISMATCH");
		const expected = new Map(loaded.state.results.filter((entry) => entry.deviceId === receipt.deviceId).map((entry) => [entry.caseId, entry]));
		if (expected.size === 0) fail(`device is outside the central round: ${receipt.deviceId}`, "DEVICE_MISMATCH");
		if (receipt.results.length !== expected.size) fail("device receipt does not contain every case for the device", "INCOMPLETE");
		const roundCreatedAt = Date.parse(loaded.state.createdAt);
		const receiptExportedAt = Date.parse(receipt.exportedAt);
		if (Number.isNaN(roundCreatedAt) || Number.isNaN(receiptExportedAt)) fail("central round timestamps are invalid", "INTEGRITY");
		if (receiptExportedAt < roundCreatedAt) fail("device receipt exportedAt cannot be earlier than the central round createdAt", "STALE_RECEIPT");
		let receiptPlatform = null;
		for (const result of receipt.results) {
			const entry = expected.get(result.caseId);
			if (!entry) fail(`device receipt case is outside the central round: ${result.caseId}`, "SCOPE");
			if (entry.result !== "NOT_RUN") fail(`central round already has a terminal result for ${result.caseId}/${receipt.deviceId}`, "CONFLICT");
			const executedAt = Date.parse(result.executedAt);
			const recordedAt = Date.parse(result.recordedAt);
			if (Number.isNaN(executedAt) || Number.isNaN(recordedAt)) fail(`device receipt has invalid timestamps for ${result.caseId}`, "INTEGRITY");
			if (executedAt < roundCreatedAt) fail(`device receipt executedAt cannot be earlier than the central round createdAt: ${result.caseId}`, "STALE_EXECUTION");
			if (recordedAt < executedAt) fail(`device receipt recordedAt cannot be earlier than executedAt: ${result.caseId}`, "STALE_RECORD");
			if (recordedAt > receiptExportedAt) fail(`device receipt recordedAt cannot be later than exportedAt: ${result.caseId}`, "STALE_RECEIPT");
			if (receiptPlatform === null) receiptPlatform = result.platform;
			else if (receiptPlatform !== result.platform) fail("device receipt platform must be consistent across all results", "PLATFORM_MISMATCH");
		}
		for (const result of receipt.results) {
			recordResult({
				adkPath,
				roundId,
				candidate: loaded.state.candidate,
				caseId: result.caseId,
				deviceId: result.deviceId,
				platform: result.platform,
				executedAt: result.executedAt,
				result: result.result,
				evidence: result.evidence,
				failureReason: result.failureReason,
			});
		}
		return getRoundStatus({ adkPath, roundId });
	});
}

function parseCli(argv) {
	const [command, ...rest] = argv;
	if (!command) fail("command is required. Usage: qa-round-transfer.mjs snapshot-export|snapshot-import|results-export|results-import ...");
	const options = {};
	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];
		if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
		const equals = token.indexOf("=");
		const key = (equals === -1 ? token.slice(2) : token.slice(2, equals)).replaceAll("-", "_");
		if (!key) fail("option name cannot be empty");
		const value = equals === -1 ? rest[++index] : token.slice(equals + 1);
		if (value === undefined || value === "" || value.startsWith("--")) fail(`missing value for --${key.replaceAll("_", "-")}`);
		options[key] = value;
	}
	return { command, options };
}

function requiredOption(options, key) {
	return nonEmptyString(options[key], `--${key.replaceAll("_", "-")}`);
}

function runCli(argv) {
	const { command, options } = parseCli(argv);
	if (command === "snapshot-export") {
		return exportRoundSnapshot({
			adkPath: requiredOption(options, "adk"),
			roundId: requiredOption(options, "round"),
			candidate: options.candidate,
			outputPath: options.output,
		});
	}
	if (command === "snapshot-import") {
		return importRoundSnapshot({
			adkPath: requiredOption(options, "adk"),
			snapshotPath: requiredOption(options, "snapshot"),
		});
	}
	if (command === "results-export") {
		return exportDeviceResults({
			adkPath: requiredOption(options, "adk"),
			roundId: requiredOption(options, "round"),
			deviceId: requiredOption(options, "device"),
			candidate: options.candidate,
			outputPath: options.output,
		});
	}
	if (command === "results-import") {
		return importDeviceResults({
			adkPath: requiredOption(options, "adk"),
			roundId: options.round,
			receiptPath: requiredOption(options, "receipt"),
			candidate: options.candidate,
		});
	}
	fail(`unsupported command: ${command}. Usage: qa-round-transfer.mjs snapshot-export|snapshot-import|results-export|results-import ...`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	try {
		process.stdout.write(`${JSON.stringify(runCli(process.argv.slice(2)), null, 2)}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
