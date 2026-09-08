#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const QA_ROUND_VERSION = 1;
export const QA_ROUND_SCHEMA = "naia-shell.qa-round.v1";
export const QA_STATUSES = Object.freeze(["PASS", "FAIL", "BLOCKED"]);
export const QA_PENDING_STATUS = "NOT_RUN";

class QaRoundError extends Error {
	constructor(message, code = "INVALID") {
		super(`[qa-round] ${message}`);
		this.name = "QaRoundError";
		this.code = code;
	}
}

function fail(message, code = "INVALID") {
	throw new QaRoundError(message, code);
}

function nonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim() === "") {
		fail(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(value, label) {
	if (value === undefined || value === null || value === "") return null;
	return nonEmptyString(value, label);
}

function requireAbsolutePath(value, label) {
	const candidate = nonEmptyString(value, label);
	if (!isAbsolute(candidate)) fail(`${label} must be an absolute path`);
	return resolve(candidate);
}

function safeRoundId(value) {
	const roundId = nonEmptyString(value, "roundId");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(roundId)) {
		fail("roundId must contain only short filename-safe characters");
	}
	return roundId;
}

function asArray(value, label) {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value;
}

function uniqueStrings(value, label, { allowEmpty = false } = {}) {
	const values = asArray(value, label).map((entry, index) => {
		if (typeof entry !== "string" || (!allowEmpty && entry.trim() === "")) {
			fail(`${label}[${index}] must be a non-empty string`);
		}
		return entry.trim();
	});
	if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
	return values;
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

export function hashJson(value) {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

export function hashCandidate(candidate) {
	return createHash("sha256").update(nonEmptyString(candidate, "candidate")).digest("hex");
}

function nowIso() {
	return new Date().toISOString();
}

function normalizeVerification(input) {
	const source = input?.verification && typeof input.verification === "object"
		? input.verification
		: {};
	const status = source.status ?? input?.verificationStatus ?? input?.catalogStatus ?? input?.status;
	const evidenceRef = source.evidenceRef ?? source.evidence ?? source.ref ?? input?.verificationRef;
	const method = source.method ?? source.basis ?? input?.verificationMethod;
	if (status !== "verified") {
		fail("manifest must carry verification.status=verified; draft catalogs cannot start a round", "DRAFT");
	}
	if (typeof evidenceRef !== "string" || evidenceRef.trim() === "") {
		fail("verified manifest requires a non-empty verification evidenceRef", "DRAFT");
	}
	return {
		status: "verified",
		evidenceRef: evidenceRef.trim(),
		...(typeof method === "string" && method.trim() ? { method: method.trim() } : {}),
	};
}

function normalizeScopeReview(input) {
	if (input === undefined || input === null) return undefined;
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		fail("manifest.scopeReview must be an object");
	}
	const rawCounts = input.dispositionCounts;
	if (!rawCounts || typeof rawCounts !== "object" || Array.isArray(rawCounts)) {
		fail("manifest.scopeReview.dispositionCounts must be an object");
	}
	const dispositionCounts = {};
	for (const [name, count] of Object.entries(rawCounts)) {
		const normalizedName = nonEmptyString(name, "manifest.scopeReview.dispositionCounts key");
		if (!Number.isSafeInteger(count) || count < 0) {
			fail(`manifest.scopeReview.dispositionCounts.${normalizedName} must be a non-negative integer`);
		}
		dispositionCounts[normalizedName] = count;
	}
	return { dispositionCounts };
}

/**
 * Validate the declared catalog. This checks IDs and coverage within the
 * supplied manifest; verification.evidenceRef records the external review
 * that established source existence. It does not pretend to parse every
 * referenced source file.
 */
export function validateManifest(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		fail("manifest root must be an object");
	}
	if (input.version !== QA_ROUND_VERSION) {
		fail(`manifest.version must be ${QA_ROUND_VERSION}`);
	}
	const verification = normalizeVerification(input);
	const scopeReview = normalizeScopeReview(input.scopeReview);
	const sourceInputs = asArray(input.sources, "manifest.sources");
	if (sourceInputs.length === 0) fail("manifest.sources must not be empty");
	const sourceById = new Map();
	const sources = sourceInputs.map((source, index) => {
		if (!source || typeof source !== "object" || Array.isArray(source)) {
			fail(`sources[${index}] must be an object`);
		}
		const id = nonEmptyString(source.id, `sources[${index}].id`);
		const kind = nonEmptyString(source.kind, `sources[${index}].kind`);
		if (kind !== "UC" && kind !== "FE") fail(`sources[${index}].kind must be UC or FE`);
		const ref = nonEmptyString(source.ref, `sources[${index}].ref`);
		if (sourceById.has(id)) fail(`duplicate source id: ${id}`);
		const normalized = { id, kind, ref };
		sourceById.set(id, normalized);
		return normalized;
	});

	const caseInputs = asArray(input.cases, "manifest.cases");
	if (caseInputs.length === 0) fail("manifest.cases must not be empty");
	const caseIds = new Set();
	const coveredSourceIds = new Set();
	const cases = caseInputs.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			fail(`cases[${index}] must be an object`);
		}
		const id = nonEmptyString(item.id, `cases[${index}].id`);
		if (caseIds.has(id)) fail(`duplicate case id: ${id}`);
		caseIds.add(id);
		const title = nonEmptyString(item.title, `cases[${index}].title`);
		const method = nonEmptyString(item.method, `cases[${index}].method`);
		const expectedResult = nonEmptyString(
			item.expectedResult,
			`cases[${index}].expectedResult`,
		);
		const ucIds = uniqueStrings(item.ucIds, `cases[${index}].ucIds`);
		const feIds = uniqueStrings(item.feIds, `cases[${index}].feIds`);
		if (ucIds.length === 0 || feIds.length === 0) {
			fail(`case ${id} is UNMAPPED: every QA case must reference at least one UC and one FE source`);
		}
		for (const sourceId of ucIds) {
			const source = sourceById.get(sourceId);
			if (!source) fail(`case ${id} references missing UC source: ${sourceId}`);
			if (source.kind !== "UC") fail(`case ${id} places non-UC source in ucIds: ${sourceId}`);
			coveredSourceIds.add(sourceId);
		}
		for (const sourceId of feIds) {
			const source = sourceById.get(sourceId);
			if (!source) fail(`case ${id} references missing FE source: ${sourceId}`);
			if (source.kind !== "FE") fail(`case ${id} places non-FE source in feIds: ${sourceId}`);
			coveredSourceIds.add(sourceId);
		}
		const sourceRef = nonEmptyString(item.sourceRef, `cases[${index}].sourceRef`);
		const deviceIds = uniqueStrings(item.deviceIds, `cases[${index}].deviceIds`);
		if (deviceIds.length === 0) fail(`case ${id} must declare at least one deviceId`);
		if (!item.execution || typeof item.execution !== "object" || Array.isArray(item.execution)) {
			fail(`cases[${index}].execution must be an object`);
		}
		const executionKind = nonEmptyString(item.execution.kind, `cases[${index}].execution.kind`);
		if (executionKind !== "batch" && executionKind !== "manual") {
			fail(`case ${id} execution.kind must be batch or manual`);
		}
		const executionRef = nonEmptyString(item.execution.ref, `cases[${index}].execution.ref`);
		return {
			id,
			title,
			method,
			expectedResult,
			ucIds,
			feIds,
			sourceRef,
			deviceIds,
			execution: { kind: executionKind, ref: executionRef },
		};
	});

	const exclusions = input.exclusions === undefined
		? []
		: asArray(input.exclusions, "manifest.exclusions").map((item, index) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) {
				fail(`exclusions[${index}] must be an object`);
			}
			const sourceId = nonEmptyString(item.sourceId, `exclusions[${index}].sourceId`);
			if (!sourceById.has(sourceId)) fail(`exclusion references missing source: ${sourceId}`);
			const reason = nonEmptyString(item.reason, `exclusions[${index}].reason`);
			return { sourceId, reason };
		});
	const excludedSourceIds = new Set();
	for (const exclusion of exclusions) {
		if (excludedSourceIds.has(exclusion.sourceId)) {
			fail(`duplicate exclusion for source: ${exclusion.sourceId}`);
		}
		if (coveredSourceIds.has(exclusion.sourceId)) {
			fail(`source cannot have both case coverage and exclusion: ${exclusion.sourceId}`);
		}
		excludedSourceIds.add(exclusion.sourceId);
	}
	for (const source of sources) {
		if (!coveredSourceIds.has(source.id) && !excludedSourceIds.has(source.id)) {
			fail(`source has no case coverage or exclusion: ${source.id}`);
		}
	}

	return {
		version: QA_ROUND_VERSION,
		verification,
		sources,
		cases,
		...(scopeReview ? { scopeReview } : {}),
		...(exclusions.length > 0 ? { exclusions } : {}),
	};
}

function qaRoot(adkPath) {
	return join(requireAbsolutePath(adkPath, "adkPath"), "qa");
}

function pathsFor(adkPath, roundId) {
	const root = qaRoot(adkPath);
	const safeId = safeRoundId(roundId);
	const roundRoot = join(root, "rounds", safeId);
	return {
		adkPath: dirname(root),
		root,
		roundRoot,
		manifestPath: join(root, "manifest.json"),
		roundManifestPath: join(roundRoot, "manifest.json"),
		statePath: join(roundRoot, "state.json"),
		sheetPath: join(roundRoot, "sheet.md"),
		lockPath: join(root, ".locks", `round-${safeId}.lock`),
		catalogLockPath: join(root, ".locks", "catalog.lock"),
	};
}

function leasePaths(adkPath, deviceId) {
	const root = qaRoot(adkPath);
	const digest = createHash("sha256").update(nonEmptyString(deviceId, "deviceId")).digest("hex");
	return {
		leasePath: join(root, "leases", `${digest}.json`),
		lockPath: join(root, ".locks", `lease-${digest}.lock`),
	};
}

function readJson(filePath, label) {
	if (!existsSync(filePath)) fail(`missing ${label}: ${filePath}`, "MISSING");
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		fail(`invalid ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function atomicWrite(filePath, contents) {
	mkdirSync(dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	let fd;
	try {
		fd = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(fd, contents, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporaryPath, filePath);
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The write may have failed before the temporary file was created.
		}
		throw error;
	}
}

function writeJsonAtomic(filePath, value) {
	atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(filePath, value) {
	atomicWrite(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

export function withExclusiveLock(lockPath, callback) {
	mkdirSync(dirname(lockPath), { recursive: true });
	let fd;
	try {
		fd = openSync(lockPath, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: nowIso() })}\n`, "utf8");
		fsyncSync(fd);
	} catch (error) {
		if (error?.code === "EEXIST") fail(`exclusive lock is held: ${lockPath}`, "LOCKED");
		throw error;
	}
	try {
		return callback();
	} finally {
		closeSync(fd);
		try {
			unlinkSync(lockPath);
		} catch {
			// Preserve the callback result; the lock owner has already closed its fd.
		}
	}
}

function readManifest(manifestPath) {
	return validateManifest(readJson(requireAbsolutePath(manifestPath, "manifestPath"), "manifest"));
}

function candidateForState(candidate) {
	return nonEmptyString(candidate, "candidate");
}

function matrixForManifest(manifest) {
	return manifest.cases.flatMap((item) => item.deviceIds.map((deviceId) => ({
		caseId: item.id,
		deviceId,
		result: QA_PENDING_STATUS,
		platform: null,
		executedAt: null,
		evidence: null,
		failureReason: null,
		recordedAt: null,
	})));
}

function initialState({ roundId, candidate, catalogHash, manifest, paths }) {
	const createdAt = nowIso();
	return {
		schema: QA_ROUND_SCHEMA,
		version: QA_ROUND_VERSION,
		roundId,
		candidate,
		candidateHash: hashCandidate(candidate),
		catalogHash,
		manifestSnapshot: paths.roundManifestPath,
		createdAt,
		updatedAt: createdAt,
		phase: "OPEN",
		status: "OPEN",
		finalized: false,
		finalizedResultsHash: null,
		launchReady: false,
		executionPolicy: "full_scope_no_previous_pass_reuse",
		previousResultsReused: false,
		verification: manifest.verification,
		...(manifest.scopeReview ? { scopeReview: manifest.scopeReview } : {}),
		cases: manifest.cases,
		results: matrixForManifest(manifest),
		history: [],
	};
}

function finalizedSnapshotHash(state) {
	return hashJson({
		finalized: state.finalized,
		phase: state.phase,
		status: state.status,
		launchReady: state.launchReady,
		results: state.results,
		history: state.history,
	});
}

function hasTechnicalVerificationPending(state) {
	return (state.scopeReview?.dispositionCounts?.["technical-verification-pending"] ?? 0) > 0;
}

function launchReadyFor(state, counts) {
	return counts.PASS === counts.total
		&& counts.FAIL === 0
		&& counts.BLOCKED === 0
		&& !hasTechnicalVerificationPending(state);
}

function validateRecordedEntry(entry, { createdAt, label }) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		fail(`${label} must be an object`, "INTEGRITY");
	}
	if (![QA_PENDING_STATUS, ...QA_STATUSES].includes(entry.result)) {
		fail(`${label}.result is invalid`, "INTEGRITY");
	}
	if (entry.result === QA_PENDING_STATUS) {
		for (const field of ["platform", "executedAt", "evidence", "failureReason", "recordedAt"]) {
			if (entry[field] !== null) fail(`${label}.${field} must be null while NOT_RUN`, "INTEGRITY");
		}
		return null;
	}
	const platform = nonEmptyString(entry.platform, `${label}.platform`);
	const executedAt = parseIsoDateTime(entry.executedAt, `${label}.executedAt`);
	const created = parseIsoDateTime(createdAt, "state.createdAt");
	if (executedAt.date.getTime() < created.date.getTime()) {
		fail(`${label}.executedAt cannot be earlier than the round createdAt`, "INTEGRITY");
	}
	const evidence = nonEmptyString(entry.evidence, `${label}.evidence`);
	const recordedAt = parseIsoDateTime(entry.recordedAt, `${label}.recordedAt`);
	let failureReason = null;
	if (entry.result === "PASS") {
		if (entry.failureReason !== null) {
			fail(`${label}.failureReason must be null for PASS`, "INTEGRITY");
		}
	} else {
		failureReason = nonEmptyString(entry.failureReason, `${label}.failureReason`);
	}
	return {
		caseId: nonEmptyString(entry.caseId, `${label}.caseId`),
		deviceId: nonEmptyString(entry.deviceId, `${label}.deviceId`),
		platform,
		executedAt: executedAt.date.toISOString(),
		result: entry.result,
		evidence,
		failureReason,
		recordedAt: recordedAt.date.toISOString(),
	};
}

function validateState(state) {
	if (!state || typeof state !== "object" || Array.isArray(state)) fail("state must be an object");
	if (state.schema !== QA_ROUND_SCHEMA || state.version !== QA_ROUND_VERSION) {
		fail("state schema/version is unsupported");
	}
	safeRoundId(state.roundId);
	const candidate = candidateForState(state.candidate);
	if (state.candidateHash !== hashCandidate(candidate)) fail("state candidate hash mismatch", "INTEGRITY");
	if (state.scopeReview !== undefined) {
		const normalizedScopeReview = normalizeScopeReview(state.scopeReview);
		if (hashJson(normalizedScopeReview) !== hashJson(state.scopeReview)) {
			fail("state scope review snapshot is not normalized", "INTEGRITY");
		}
	}
	if (typeof state.finalized !== "boolean") fail("state.finalized must be boolean", "INTEGRITY");
	const createdAt = parseIsoDateTime(state.createdAt, "state.createdAt");
	const updatedAt = parseIsoDateTime(state.updatedAt, "state.updatedAt");
	if (updatedAt.date.getTime() < createdAt.date.getTime()) {
		fail("state.updatedAt cannot be earlier than createdAt", "INTEGRITY");
	}
	if (!Array.isArray(state.cases) || !Array.isArray(state.results)) fail("state case/result arrays are missing");
	const expected = new Set();
	for (const item of state.cases) {
		if (!item || typeof item.id !== "string" || !Array.isArray(item.deviceIds)) {
			fail("state contains an invalid case snapshot");
		}
		for (const deviceId of item.deviceIds) {
			const key = `${item.id}\u0000${deviceId}`;
			if (expected.has(key)) fail(`state contains duplicate matrix entry: ${item.id}/${deviceId}`);
			expected.add(key);
		}
	}
	if (state.results.length !== expected.size) fail("state result matrix size does not match case/device scope");
	for (const result of state.results) {
		const key = `${result?.caseId}\u0000${result?.deviceId}`;
		if (!expected.has(key)) fail(`state contains an out-of-scope result: ${result?.caseId}/${result?.deviceId}`);
		expected.delete(key);
		validateRecordedEntry(result, { createdAt: state.createdAt, label: `result ${key}` });
	}
	if (expected.size > 0) fail("state is missing matrix entries", "INTEGRITY");
	if (!Array.isArray(state.history)) fail("state history is missing");
	const terminalResults = state.results.filter((result) => result.result !== QA_PENDING_STATUS);
	if (state.history.length !== terminalResults.length) {
		fail("state history does not match recorded results", "INTEGRITY");
	}
	const historyByKey = new Map();
	for (const historyEntry of state.history) {
		const normalizedHistory = validateRecordedEntry(historyEntry, {
			createdAt: state.createdAt,
			label: "history entry",
		});
		const key = `${normalizedHistory.caseId}\u0000${normalizedHistory.deviceId}`;
		if (historyByKey.has(key)) fail(`state history contains duplicate entry: ${key}`, "INTEGRITY");
		historyByKey.set(key, normalizedHistory);
	}
	for (const result of terminalResults) {
		const key = `${result.caseId}\u0000${result.deviceId}`;
		const historyEntry = historyByKey.get(key);
		if (!historyEntry) fail(`state history is missing entry: ${key}`, "INTEGRITY");
		for (const field of ["caseId", "deviceId", "platform", "executedAt", "result", "evidence", "failureReason", "recordedAt"]) {
			const current = field === "executedAt" || field === "recordedAt"
				? parseIsoDateTime(result[field], `result ${key}.${field}`).date.toISOString()
				: result[field];
			if (historyEntry[field] !== current) fail(`state result/history mismatch: ${key}.${field}`, "INTEGRITY");
		}
	}
	if (!["OPEN", "FIX_ALLOWED"].includes(state.phase) || state.status !== state.phase) {
		fail("state phase/status is invalid", "INTEGRITY");
	}
	if (state.finalized && state.phase !== "FIX_ALLOWED") fail("finalized state must be FIX_ALLOWED");
	if (!state.finalized && state.phase !== "OPEN") fail("open state must have OPEN phase", "INTEGRITY");
	const counts = summarize(state);
	if (state.finalized) {
		if (counts.NOT_RUN > 0) fail("finalized state cannot contain NOT_RUN results", "INTEGRITY");
		const expectedLaunchReady = launchReadyFor(state, counts);
		if (state.launchReady !== expectedLaunchReady) fail("finalized launchReady does not match results", "INTEGRITY");
		if (typeof state.finalizedResultsHash !== "string" || state.finalizedResultsHash !== finalizedSnapshotHash(state)) {
			fail("finalized result snapshot hash mismatch", "INTEGRITY");
		}
	} else {
		if (state.finalizedResultsHash !== null) fail("open state has a finalized result snapshot", "INTEGRITY");
		if (state.launchReady !== false) fail("open state must not be launch ready", "INTEGRITY");
	}
	return state;
}

function loadState(paths) {
	const state = validateState(readJson(paths.statePath, "round state"));
	if (state.manifestSnapshot !== paths.roundManifestPath) {
		fail("state manifest snapshot path does not match this round", "INTEGRITY");
	}
	const manifest = validateManifest(readJson(paths.roundManifestPath, "round manifest"));
	if (hashJson(manifest) !== state.catalogHash) {
		fail("round catalog hash does not match its manifest snapshot", "INTEGRITY");
	}
	if (hashJson(state.cases) !== hashJson(manifest.cases)) {
		fail("state case snapshot does not match its manifest snapshot", "INTEGRITY");
	}
	if (hashJson(state.scopeReview ?? null) !== hashJson(manifest.scopeReview ?? null)) {
		fail("state scope review snapshot does not match its manifest snapshot", "INTEGRITY");
	}
	return state;
}

function findResult(state, caseId, deviceId) {
	return state.results.find((entry) => entry.caseId === caseId && entry.deviceId === deviceId);
}

function summarize(state) {
	const counts = Object.fromEntries([QA_PENDING_STATUS, ...QA_STATUSES].map((status) => [status, 0]));
	for (const result of state.results) counts[result.result] = (counts[result.result] ?? 0) + 1;
	const total = state.results.length;
	const overall = counts[QA_PENDING_STATUS] > 0
		? QA_PENDING_STATUS
		: counts.BLOCKED > 0
			? "BLOCKED"
			: counts.FAIL > 0
				? "FAIL"
				: "PASS";
	return { total, ...counts, overall };
}

function markdownCell(value) {
	if (value === null || value === undefined || value === "") return "—";
	return String(value).replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}

function renderSheet(state) {
	const byId = new Map(state.cases.map((item) => [item.id, item]));
	const counts = summarize(state);
	const lines = [
		`# QA round ${state.roundId}`,
		"",
		`- Candidate: ${markdownCell(state.candidate)}`,
		`- Candidate SHA-256: ${state.candidateHash}`,
		`- Catalog SHA-256: ${state.catalogHash}`,
		`- Execution policy: ${state.executionPolicy}`,
		`- Phase: ${state.phase}`,
		`- Launch ready: ${state.launchReady ? "true" : "false"}`,
		`- Counts: total ${counts.total}, PASS ${counts.PASS}, FAIL ${counts.FAIL}, BLOCKED ${counts.BLOCKED}, NOT_RUN ${counts.NOT_RUN}`,
		"",
		"| Case ID | 테스트 방법 | 예상하는 테스트 결과 | 관련 유저 시나리오(UC) | 관련 기능(FE) | Platform | Device | 실행 결과 | 실행 일시 | Evidence | 실패 이유 |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const result of state.results) {
		const item = byId.get(result.caseId);
		lines.push(
			`| ${markdownCell(result.caseId)} | ${markdownCell(item.method)} | ${markdownCell(item.expectedResult)} | ${markdownCell(item.ucIds.join(", "))} | ${markdownCell(item.feIds.join(", "))} | ${markdownCell(result.platform)} | ${markdownCell(result.deviceId)} | ${markdownCell(result.result)} | ${markdownCell(result.executedAt)} | ${markdownCell(result.evidence)} | ${markdownCell(result.failureReason)} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function persistRound(paths, state) {
	writeJsonAtomic(paths.statePath, state);
	writeTextAtomic(paths.sheetPath, renderSheet(state));
}

function assertCandidate(state, candidate) {
	const supplied = candidateForState(candidate);
	if (supplied !== state.candidate || hashCandidate(supplied) !== state.candidateHash) {
		fail("candidate does not match the fixed round candidate", "CANDIDATE_MISMATCH");
	}
}

export function initRound({ adkPath, manifestPath, roundId, candidate }) {
	const paths = pathsFor(adkPath, roundId);
	const manifest = readManifest(manifestPath);
	const fixedCandidate = candidateForState(candidate);
	const catalogHash = hashJson(manifest);
	return withExclusiveLock(paths.catalogLockPath, () => {
		if (existsSync(paths.statePath)) fail(`round already exists: ${roundId}`, "EXISTS");
		const state = initialState({
			roundId: safeRoundId(roundId),
			candidate: fixedCandidate,
			catalogHash,
			manifest,
			paths,
		});
		mkdirSync(paths.roundRoot, { recursive: true });
		writeJsonAtomic(paths.manifestPath, manifest);
		writeJsonAtomic(paths.roundManifestPath, manifest);
		persistRound(paths, state);
		return state;
	});
}

function normalizeResult(value) {
	const result = nonEmptyString(value, "result").toUpperCase();
	if (!QA_STATUSES.includes(result)) fail(`result must be PASS, FAIL, or BLOCKED`);
	return result;
}

const ISO_DATETIME_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIsoDateTime(value, label) {
	const raw = nonEmptyString(value, label);
	if (!ISO_DATETIME_WITH_TIMEZONE.test(raw)) {
		fail(`${label} must be an ISO datetime with an explicit timezone`);
	}
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) fail(`${label} must be a valid timestamp`);
	return { raw, date };
}

function normalizeExecutedAt(value, roundCreatedAt) {
	const parsed = parseIsoDateTime(value, "executedAt");
	const created = parseIsoDateTime(roundCreatedAt, "state.createdAt");
	if (parsed.date.getTime() < created.date.getTime()) {
		fail("executedAt cannot be earlier than the round createdAt", "STALE_EXECUTION");
	}
	return parsed.date.toISOString();
}

export function recordResult({
	adkPath,
	roundId,
	candidate,
	caseId,
	deviceId,
	platform,
	executedAt,
	result,
	status,
	evidence,
	failureReason,
	reason,
}) {
	const paths = pathsFor(adkPath, roundId);
	const normalizedCaseId = nonEmptyString(caseId, "caseId");
	const normalizedDeviceId = nonEmptyString(deviceId, "deviceId");
	const normalizedPlatform = nonEmptyString(platform, "platform");
	const normalizedResult = normalizeResult(result ?? status);
	const normalizedEvidence = nonEmptyString(evidence, "evidence");
	const normalizedReason = optionalString(failureReason ?? reason, "failureReason");
	if ((normalizedResult === "FAIL" || normalizedResult === "BLOCKED") && !normalizedReason) {
		fail(`${normalizedResult} result requires failureReason`);
	}
	return withExclusiveLock(paths.lockPath, () => {
		const state = loadState(paths);
		if (state.finalized) fail("finalized rounds cannot be changed", "FINALIZED");
		assertCandidate(state, candidate);
		const entry = findResult(state, normalizedCaseId, normalizedDeviceId);
		if (!entry) fail(`case/device is outside this round: ${normalizedCaseId}/${normalizedDeviceId}`, "SCOPE");
		if (entry.result !== QA_PENDING_STATUS) {
			fail(`case/device already has a terminal result: ${normalizedCaseId}/${normalizedDeviceId}`, "RECORDED");
		}
		const normalizedExecutedAt = normalizeExecutedAt(executedAt, state.createdAt);
		const recordedAt = nowIso();
		const record = {
			caseId: normalizedCaseId,
			deviceId: normalizedDeviceId,
			platform: normalizedPlatform,
			executedAt: normalizedExecutedAt,
			result: normalizedResult,
			evidence: normalizedEvidence,
			failureReason: normalizedReason,
			recordedAt,
		};
		Object.assign(entry, record);
		state.history.push(record);
		state.updatedAt = recordedAt;
		persistRound(paths, state);
		return state;
	});
}

export function finalizeRound({ adkPath, roundId, candidate } = {}) {
	const paths = pathsFor(adkPath, roundId);
	return withExclusiveLock(paths.lockPath, () => {
		const state = loadState(paths);
		if (state.finalized) fail("round is already finalized", "FINALIZED");
		if (candidate !== undefined) assertCandidate(state, candidate);
		const counts = summarize(state);
		if (counts.NOT_RUN > 0) {
			fail(`cannot finalize with ${counts.NOT_RUN} unrecorded case/device result(s)`, "INCOMPLETE");
		}
		state.finalized = true;
		state.phase = "FIX_ALLOWED";
		state.status = "FIX_ALLOWED";
		state.launchReady = launchReadyFor(state, counts);
		state.finalizedResultsHash = finalizedSnapshotHash(state);
		state.updatedAt = nowIso();
		persistRound(paths, state);
		return state;
	});
}

export function getRoundStatus({ adkPath, roundId }) {
	const paths = pathsFor(adkPath, roundId);
	const state = loadState(paths);
	return {
		roundId: state.roundId,
		candidate: state.candidate,
		candidateHash: state.candidateHash,
		catalogHash: state.catalogHash,
		phase: state.phase,
		status: state.status,
		finalized: state.finalized,
		launchReady: state.launchReady,
		counts: summarize(state),
		statePath: paths.statePath,
		sheetPath: paths.sheetPath,
	};
}

export function acquireLease({ adkPath, deviceId, owner }) {
	const normalizedDeviceId = nonEmptyString(deviceId, "deviceId");
	const normalizedOwner = nonEmptyString(owner, "owner");
	const paths = leasePaths(adkPath, normalizedDeviceId);
	return withExclusiveLock(paths.lockPath, () => {
		if (existsSync(paths.leasePath)) {
			const current = readJson(paths.leasePath, "GUI lease");
			fail(`GUI lease already held for this ADK/device by ${current.owner ?? "unknown owner"}`, "LEASE_HELD");
		}
		const lease = {
			schema: "naia-shell.qa-gui-lease.v1",
			scope: "selected-adk-device",
			deviceId: normalizedDeviceId,
			owner: normalizedOwner,
			leaseId: randomUUID(),
			pid: process.pid,
			acquiredAt: nowIso(),
		};
		writeJsonAtomic(paths.leasePath, lease);
		return lease;
	});
}

export function releaseLease({ adkPath, deviceId, owner }) {
	const normalizedDeviceId = nonEmptyString(deviceId, "deviceId");
	const normalizedOwner = nonEmptyString(owner, "owner");
	const paths = leasePaths(adkPath, normalizedDeviceId);
	return withExclusiveLock(paths.lockPath, () => {
		if (!existsSync(paths.leasePath)) fail(`no GUI lease exists for device: ${normalizedDeviceId}`, "LEASE_MISSING");
		const lease = readJson(paths.leasePath, "GUI lease");
		if (lease.owner !== normalizedOwner) fail("GUI lease owner mismatch", "LEASE_OWNER");
		unlinkSync(paths.leasePath);
		return { released: true, deviceId: normalizedDeviceId, owner: normalizedOwner, leaseId: lease.leaseId };
	});
}

function parseArgs(argv) {
	const positionals = [];
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith("--")) {
			positionals.push(argument);
			continue;
		}
		const separator = argument.indexOf("=");
		if (separator !== -1) {
			options[argument.slice(2, separator)] = argument.slice(separator + 1);
			continue;
		}
		const key = argument.slice(2);
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) {
			options[key] = true;
		} else {
			options[key] = value;
			index += 1;
		}
	}
	return { positionals, options };
}

function usage() {
	return [
		"Usage:",
		"  qa-round.mjs init --adk /abs/adk --manifest /abs/manifest.json --round ID --candidate VALUE",
		"  qa-round.mjs record --adk /abs/adk --round ID --candidate VALUE --case ID --device ID --platform NAME --executed-at ISO --result PASS|FAIL|BLOCKED --evidence REF [--failure-reason TEXT]",
		"  qa-round.mjs finalize --adk /abs/adk --round ID [--candidate VALUE]",
		"  qa-round.mjs status --adk /abs/adk --round ID",
		"  qa-round.mjs lease acquire|release --adk /abs/adk --device ID --owner NAME",
	].join("\n");
}

function runCli(argv) {
	const { positionals, options } = parseArgs(argv);
	const command = positionals[0];
	if (!command || options.help) {
		console.log(usage());
		return;
	}
	let output;
	if (command === "init") {
		output = initRound({
			adkPath: options.adk,
			manifestPath: options.manifest,
			roundId: options.round,
			candidate: options.candidate,
		});
	} else if (command === "record") {
		output = recordResult({
			adkPath: options.adk,
			roundId: options.round,
			candidate: options.candidate,
			caseId: options.case,
			deviceId: options.device,
			platform: options.platform,
			executedAt: options["executed-at"] ?? options.executedAt,
			result: options.result ?? options.status,
			evidence: options.evidence,
			failureReason: options["failure-reason"] ?? options.failureReason ?? options.reason,
		});
	} else if (command === "finalize") {
		output = finalizeRound({ adkPath: options.adk, roundId: options.round, candidate: options.candidate });
	} else if (command === "status") {
		output = getRoundStatus({ adkPath: options.adk, roundId: options.round });
	} else if (command === "lease" || command === "lease-acquire" || command === "lease-release") {
		const action = command === "lease" ? positionals[1] : command.slice("lease-".length);
		if (action === "acquire") {
			output = acquireLease({ adkPath: options.adk, deviceId: options.device, owner: options.owner });
		} else if (action === "release") {
			output = releaseLease({ adkPath: options.adk, deviceId: options.device, owner: options.owner });
		} else {
			fail("lease action must be acquire or release");
		}
	} else {
		fail(`unknown command: ${command}\n${usage()}`);
	}
	console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	try {
		runCli(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
