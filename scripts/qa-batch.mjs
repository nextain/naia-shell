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
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BATCH_PLAN_VERSION, validateBatchPlan } from "../packages/shell/e2e-tauri/batch-plan.mjs";
import { BATCH_RESULTS_DIRNAME, BATCH_RESULTS_SCHEMA } from "../packages/shell/e2e-tauri/batch-results.mjs";
import { getRoundStatus, hashCandidate, hashJson, recordResult, withExclusiveLock } from "./qa-round.mjs";

export const QA_BATCH_VERSION = 1;
export const QA_BATCH_SCHEMA = "naia-shell.qa-batch.v1";
export const QA_BATCH_PLAN_DIRNAME = "batch";

const TERMINAL_STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "SKIP", "NOT_RUN"]);
const IGNORED_STATUSES = new Set(["RUNNING", "RETRY"]);
const ISO_DATETIME_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

class QaBatchError extends Error {
	constructor(message, code = "INVALID") {
		super(`[qa-batch] ${message}`);
		this.name = "QaBatchError";
		this.code = code;
	}
}

function fail(message, code = "INVALID") {
	throw new QaBatchError(message, code);
}

function nonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
	return value.trim();
}

function absolutePath(value, label) {
	let candidate = value;
	if (candidate instanceof URL) candidate = fileURLToPath(candidate);
	if (typeof candidate === "string" && candidate.startsWith("file:")) candidate = fileURLToPath(candidate);
	const text = nonEmptyString(candidate, label);
	if (!isAbsolute(text)) fail(`${label} must be an absolute path`);
	return resolve(text);
}

function safeId(value, label) {
	const text = nonEmptyString(value, label);
	if (!SAFE_ID.test(text) || text === "." || text === "..") fail(`${label} must contain only short filename-safe characters`);
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

function nowIso() {
	return new Date().toISOString();
}

function parseIso(value, label) {
	const raw = nonEmptyString(value, label);
	if (!ISO_DATETIME_WITH_TIMEZONE.test(raw)) fail(`${label} must be an ISO datetime with an explicit timezone`);
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) fail(`${label} must be a valid timestamp`);
	return { raw, date };
}

function normalizeFile(value, { baseDir, label, mustExist = true } = {}) {
	let raw = value;
	if (raw instanceof URL) raw = fileURLToPath(raw);
	if (typeof raw === "string" && raw.startsWith("file:")) raw = fileURLToPath(raw);
	const text = nonEmptyString(raw, label);
	const candidate = resolve(isAbsolute(text) ? text : join(baseDir, text));
	if (candidate.includes("\0")) fail(`${label} contains a NUL byte`);
	if (mustExist && (!existsSync(candidate) || !statSync(candidate).isFile())) fail(`${label} does not point to an existing file: ${candidate}`);
	return candidate;
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function stableScope(state) {
	return {
		roundId: state.roundId,
		candidate: state.candidate,
		candidateHash: state.candidateHash,
		catalogHash: state.catalogHash,
		createdAt: state.createdAt,
		cases: state.cases,
	};
}

function stateForRound({ adkPath, roundId, candidate } = {}) {
	const adk = absolutePath(adkPath, "adkPath");
	const id = safeId(roundId, "roundId");
	const status = getRoundStatus({ adkPath: adk, roundId: id });
	if (status.finalized || status.phase !== "OPEN") fail("batch plan/import requires an open round", "FINALIZED");
	const state = readJson(status.statePath, "round state");
	if (state.roundId !== id) fail("round state identity does not match roundId", "INTEGRITY");
	if (candidate !== undefined && nonEmptyString(candidate, "candidate") !== state.candidate) fail("candidate does not match the fixed round candidate", "CANDIDATE_MISMATCH");
	if (state.candidateHash !== hashCandidate(state.candidate)) fail("round candidate hash mismatch", "INTEGRITY");
	return { adkPath: adk, status, state };
}

function normalizeMapping(input, { specBaseDir }) {
	const entries = Array.isArray(input) ? input : input?.cases;
	if (!Array.isArray(entries) || entries.length === 0) fail("mapping.cases must be a non-empty array");
	const seenCases = new Set();
	const seenObservations = new Set();
	return entries.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`mapping.cases[${index}] must be an object`);
		const caseId = nonEmptyString(entry.caseId ?? entry.id, `mapping.cases[${index}].caseId`);
		if (seenCases.has(caseId)) fail(`mapping contains duplicate caseId: ${caseId}`);
		seenCases.add(caseId);
		const observations = entry.requiredObservations ?? entry.required ?? entry.observations;
		if (!Array.isArray(observations) || observations.length === 0) fail(`mapping case ${caseId} must declare requiredObservations`);
		const requiredObservations = observations.map((observation, observationIndex) => {
			if (!observation || typeof observation !== "object" || Array.isArray(observation)) fail(`mapping case ${caseId} observation ${observationIndex} must be an object`);
			const file = normalizeFile(observation.file ?? observation.path, { baseDir: specBaseDir, label: `mapping case ${caseId} observation file` });
			const testTitle = nonEmptyString(observation.testTitle ?? observation.title ?? observation.fullTitle, `mapping case ${caseId} observation testTitle`);
			const key = `${file}\u0000${testTitle}`;
			if (seenObservations.has(key)) fail(`mapping contains duplicate observation: ${file} / ${testTitle}`);
			seenObservations.add(key);
			return { file, testTitle };
		});
		return { caseId, requiredObservations };
	});
}

function normalizeSpecs({ specs, nativePlanPath, specBaseDir, requiredFiles }) {
	let values = specs;
	if (nativePlanPath !== undefined) {
		const sourcePath = absolutePath(nativePlanPath, "nativePlanPath");
		const native = readJson(sourcePath, "native batch plan");
		values = validateBatchPlan(native, { adkPath: dirname(sourcePath) }).specs[0];
	}
	if (values === undefined) values = [...requiredFiles];
	if (!Array.isArray(values) || values.length === 0) fail("specs must be a non-empty array of explicit files");
	const normalized = values.map((value, index) => {
		const text = nonEmptyString(value, `specs[${index}]`);
		if (/[?*\[\]{}]/.test(text)) fail(`specs[${index}] must be explicit; globs are not allowed`);
		return normalizeFile(text, { baseDir: specBaseDir, label: `specs[${index}]` });
	});
	const unique = [...new Set(normalized)];
	for (const file of requiredFiles) if (!unique.includes(file)) fail(`native plan omits required observation file: ${file}`);
	return unique;
}

function batchCasesForDevice(state, deviceId) {
	return state.cases.filter((item) => item.execution?.kind === "batch" && item.deviceIds.includes(deviceId));
}

function makeRunPrefix(roundId, deviceId) {
	const deviceHash = createHash("sha256").update(deviceId).digest("hex").slice(0, 10);
	const roundPart = roundId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 18);
	return `qa-${roundPart}-${deviceHash}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.slice(0, 64);
}

function assertMappingMatchesCases(state, mapping, deviceId) {
	const scopedCases = batchCasesForDevice(state, deviceId);
	if (scopedCases.length === 0) fail(`round has no batch cases for device ${deviceId}`, "SCOPE");
	const expected = new Map(scopedCases.map((item) => [item.id, item]));
	const mappingById = new Map(mapping.map((item) => [item.caseId, item]));
	for (const item of mapping) {
		const source = expected.get(item.caseId);
		if (!source) {
			const manifestCase = state.cases.find((candidate) => candidate.id === item.caseId);
			if (manifestCase?.execution?.kind === "manual") fail(`manual case cannot be imported through the batch adapter: ${item.caseId}`, "SCOPE");
			fail(`mapping case is outside the selected batch/device scope: ${item.caseId}`, "SCOPE");
		}
	}
	for (const source of scopedCases) if (!mappingById.has(source.id)) fail(`batch case has no required observation mapping: ${source.id}`, "SCOPE");
	return scopedCases;
}

function planPathFor({ adkPath, roundId, deviceId, runPrefix }) {
	const deviceHash = createHash("sha256").update(deviceId).digest("hex").slice(0, 16);
	return join(adkPath, "qa", "rounds", roundId, QA_BATCH_PLAN_DIRNAME, `${deviceHash}-${runPrefix}.json`);
}

function planLockPath({ adkPath, deviceId }) {
	const deviceHash = createHash("sha256").update(deviceId).digest("hex").slice(0, 16);
	return join(adkPath, "qa", ".locks", `batch-plan-${deviceHash}.lock`);
}

function normalizeNativePlan(specFiles) {
	return { version: BATCH_PLAN_VERSION, contract: "single-session-ui", restartInstallExcluded: true, specs: [specFiles] };
}

/** Create an immutable plan binding a QA round/device to an explicit WDIO batch. */
export function planBatch({
	adkPath,
	roundId,
	candidate,
	deviceId,
	platform,
	mapping,
	mappingPath,
	specs,
	nativePlanPath,
	specBaseDir,
	workingDirectory,
	wdioConfig = "e2e-tauri/wdio.conf.batch.ts",
} = {}) {
	const normalizedDeviceId = safeId(deviceId, "deviceId");
	const normalizedPlatform = nonEmptyString(platform, "platform");
	const normalizedRoundId = safeId(roundId, "roundId");
	const normalizedCandidate = nonEmptyString(candidate, "candidate");
	const context = stateForRound({ adkPath, roundId: normalizedRoundId, candidate: normalizedCandidate });
	const baseDir = absolutePath(specBaseDir ?? dirname(fileURLToPath(import.meta.url)), "specBaseDir");
	const loadedMapping = mappingPath === undefined ? mapping : readJson(absolutePath(mappingPath, "mappingPath"), "batch mapping");
	const normalizedMapping = normalizeMapping(loadedMapping, { specBaseDir: baseDir });
	const scopedCases = assertMappingMatchesCases(context.state, normalizedMapping, normalizedDeviceId);
	const requiredFiles = [...new Set(normalizedMapping.flatMap((item) => item.requiredObservations.map((observation) => observation.file)))];
	const specFiles = normalizeSpecs({ specs, nativePlanPath, specBaseDir: baseDir, requiredFiles });
	const runPrefix = makeRunPrefix(normalizedRoundId, normalizedDeviceId);
	const createdAt = nowIso();
	const shellDirectory = absolutePath(workingDirectory ?? join(dirname(dirname(fileURLToPath(import.meta.url))), "packages", "shell"), "workingDirectory");
	if (!existsSync(shellDirectory) || !statSync(shellDirectory).isDirectory()) fail(`workingDirectory does not exist: ${shellDirectory}`);
	const configText = nonEmptyString(wdioConfig, "wdioConfig");
	const nativePlan = normalizeNativePlan(specFiles);
	const materializedNativePlanPath = join(context.adkPath, "e2e-batch-plan.json");
	const posixCommand = `cd ${shellQuote(shellDirectory)} && NAIA_E2E_ADK_PATH=${shellQuote(context.adkPath)} NAIA_E2E_RUN_ID=${shellQuote(runPrefix)} pnpm exec wdio run ${shellQuote(configText)}`;
	const powershellCommand = `Set-Location -LiteralPath ${powershellQuote(shellDirectory)}; $env:NAIA_E2E_ADK_PATH=${powershellQuote(context.adkPath)}; $env:NAIA_E2E_RUN_ID=${powershellQuote(runPrefix)}; pnpm exec wdio run ${powershellQuote(configText)}`;
	const plan = {
		schema: QA_BATCH_SCHEMA,
		version: QA_BATCH_VERSION,
		roundId: normalizedRoundId,
		candidate: normalizedCandidate,
		candidateHash: hashCandidate(normalizedCandidate),
		catalogHash: context.state.catalogHash,
		roundCreatedAt: context.state.createdAt,
		roundScopeHash: hashJson(stableScope(context.state)),
		deviceId: normalizedDeviceId,
		platform: normalizedPlatform,
		createdAt,
		runPrefix,
		cases: scopedCases.map((source) => ({
			caseId: source.id,
			title: source.title,
			execution: source.execution,
			requiredObservations: normalizedMapping.find((item) => item.caseId === source.id).requiredObservations,
		})),
		wdioPlan: {
			nativePlan,
			specs: nativePlan.specs,
			nativePlanPath: materializedNativePlanPath,
			nativePlanHash: hashJson(nativePlan),
			config: configText,
			workingDirectory: shellDirectory,
			maxInstances: 1,
			bail: 0,
			env: { NAIA_E2E_ADK_PATH: context.adkPath, NAIA_E2E_RUN_ID: runPrefix },
			materializeNativePlan: `already written as the exact native plan at ${materializedNativePlanPath}`,
			command: posixCommand,
			commands: { posix: posixCommand, powershell: powershellCommand },
		},
	};
	plan.planHash = hashJson(plan);
	const path = planPathFor({ adkPath: context.adkPath, roundId: normalizedRoundId, deviceId: normalizedDeviceId, runPrefix });
	withExclusiveLock(planLockPath({ adkPath: context.adkPath, deviceId: normalizedDeviceId }), () => {
		if (existsSync(materializedNativePlanPath)) {
			const existingNativePlan = readJson(materializedNativePlanPath, "selected ADK native batch plan");
			if (hashJson(existingNativePlan) !== plan.wdioPlan.nativePlanHash) {
				fail(`selected ADK native plan already exists with different specs: ${materializedNativePlanPath}`, "NATIVE_PLAN_CONFLICT");
			}
		} else {
			writeJsonAtomic(materializedNativePlanPath, nativePlan);
		}
		writeJsonAtomic(path, plan);
	});
	return { path, plan };
}

function assertPlanShape(plan, planPath) {
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("batch plan must be an object");
	if (plan.schema !== QA_BATCH_SCHEMA || plan.version !== QA_BATCH_VERSION) fail("unsupported batch plan schema/version");
	for (const field of ["roundId", "candidate", "candidateHash", "catalogHash", "roundCreatedAt", "roundScopeHash", "deviceId", "platform", "createdAt", "runPrefix", "planHash"]) nonEmptyString(plan[field], `batch plan ${field}`);
	safeId(plan.roundId, "batch plan roundId");
	safeId(plan.deviceId, "batch plan deviceId");
	if (!SAFE_ID.test(plan.runPrefix) || !plan.runPrefix.startsWith("qa-")) fail("batch plan runPrefix is invalid");
	const { planHash, ...unsignedPlan } = plan;
	if (planHash !== hashJson(unsignedPlan)) fail("batch plan hash mismatch", "INTEGRITY");
	parseIso(plan.roundCreatedAt, "batch plan roundCreatedAt");
	parseIso(plan.createdAt, "batch plan createdAt");
	if (new Date(plan.createdAt).getTime() < new Date(plan.roundCreatedAt).getTime()) fail("batch plan createdAt predates roundCreatedAt");
	if (!Array.isArray(plan.cases) || plan.cases.length === 0) fail("batch plan cases must be non-empty");
	if (!plan.wdioPlan || typeof plan.wdioPlan !== "object") fail("batch plan wdioPlan is missing");
	if (!isAbsolute(plan.wdioPlan.nativePlanPath) || plan.wdioPlan.nativePlanHash !== hashJson(plan.wdioPlan.nativePlan)) fail("batch plan native plan provenance is invalid", "INTEGRITY");
	if (!plan.wdioPlan.commands || plan.wdioPlan.commands.posix !== plan.wdioPlan.command || typeof plan.wdioPlan.commands.powershell !== "string") fail("batch plan platform commands are missing", "INTEGRITY");
	if (!Array.isArray(plan.wdioPlan.specs) || plan.wdioPlan.specs.length !== 1 || !Array.isArray(plan.wdioPlan.specs[0]) || plan.wdioPlan.specs[0].length === 0) fail("batch plan wdioPlan.specs must contain one non-empty nested group");
	const pairs = new Set();
	for (const [index, item] of plan.cases.entries()) {
		if (!item || typeof item !== "object") fail(`batch plan cases[${index}] is invalid`);
		const caseId = nonEmptyString(item.caseId, `batch plan cases[${index}].caseId`);
		if (!Array.isArray(item.requiredObservations) || item.requiredObservations.length === 0) fail(`batch plan case ${caseId} has no required observations`);
		for (const observation of item.requiredObservations) {
			const file = absolutePath(observation.file, `batch plan ${caseId} observation file`);
			const testTitle = nonEmptyString(observation.testTitle, `batch plan ${caseId} observation testTitle`);
			const key = `${file}\u0000${testTitle}`;
			if (pairs.has(key)) fail(`batch plan has duplicate observation: ${file} / ${testTitle}`);
			pairs.add(key);
		}
	}
	if (planPath !== undefined && !existsSync(planPath)) fail(`batch plan does not exist: ${planPath}`);
}

function loadPlan(planPath, { adkPath, candidate, deviceId, platform } = {}) {
	const path = absolutePath(planPath, "planPath");
	const plan = readJson(path, "batch plan");
	assertPlanShape(plan, path);
	const context = stateForRound({ adkPath, roundId: plan.roundId, candidate: plan.candidate });
	const planRoot = resolve(context.adkPath, "qa", "rounds", plan.roundId, QA_BATCH_PLAN_DIRNAME);
	const planRelative = relative(planRoot, path);
	if (planRelative === "" || planRelative === ".." || planRelative.startsWith(".." + "/") || planRelative.startsWith("..\\") || isAbsolute(planRelative)) fail("batch plan is outside the selected ADK round", "SCOPE");
	if (plan.wdioPlan.nativePlanPath !== join(context.adkPath, "e2e-batch-plan.json")) fail("batch plan native plan path is outside the selected ADK", "SCOPE");
	if (!existsSync(plan.wdioPlan.nativePlanPath) || hashJson(readJson(plan.wdioPlan.nativePlanPath, "selected ADK native batch plan")) !== plan.wdioPlan.nativePlanHash) fail("selected ADK native plan does not match batch plan", "STALE_PLAN");
	if (candidate !== undefined && nonEmptyString(candidate, "candidate") !== plan.candidate) fail("candidate does not match batch plan", "CANDIDATE_MISMATCH");
	if (deviceId !== undefined && nonEmptyString(deviceId, "deviceId") !== plan.deviceId) fail("deviceId does not match batch plan", "DEVICE_MISMATCH");
	if (platform !== undefined && nonEmptyString(platform, "platform") !== plan.platform) fail("platform does not match batch plan", "PLATFORM_MISMATCH");
	if (plan.candidateHash !== hashCandidate(plan.candidate) || plan.catalogHash !== context.state.catalogHash) fail("batch plan candidate/catalog hash mismatch", "INTEGRITY");
	if (plan.roundCreatedAt !== context.state.createdAt || plan.roundScopeHash !== hashJson(stableScope(context.state))) fail("batch plan is stale for the current round", "STALE_PLAN");
	for (const file of plan.wdioPlan.specs[0]) {
		const spec = absolutePath(file, "batch plan spec");
		if (!existsSync(spec) || !statSync(spec).isFile()) fail(`batch plan spec is missing: ${spec}`, "STALE_PLAN");
	}
	const scoped = batchCasesForDevice(context.state, plan.deviceId);
	const byId = new Map(scoped.map((item) => [item.id, item]));
	if (plan.cases.length !== scoped.length) fail("batch plan case scope no longer matches round", "STALE_PLAN");
	for (const item of plan.cases) if (!byId.has(item.caseId)) fail(`batch plan case is no longer in batch scope: ${item.caseId}`, "STALE_PLAN");
	return { path, plan, context };
}

function resultPathParts(jsonlPath, adkPath) {
	const root = resolve(adkPath, BATCH_RESULTS_DIRNAME);
	const relativePath = relative(root, jsonlPath);
	const parts = relativePath.split(/[\\/]/);
	if (parts.length !== 2 || parts[1] !== "results.jsonl" || parts[0] === "" || parts[0].startsWith(".")) fail("jsonlPath must be <selected ADK>/e2e-batch-results/<runId>/results.jsonl", "SCOPE");
	const runId = parts[0];
	if (!SAFE_ID.test(runId)) fail("result runId is not filename-safe");
	return { runId };
}

function metadata(event, names) {
	for (const name of names) if (event[name] !== undefined && event[name] !== null && event[name] !== "") return event[name];
	return undefined;
}

function validateOptionalBinding(event, plan) {
	const bindings = [
		[["roundId", "round"], plan.roundId, "roundId"],
		[["candidate", "candidateId"], plan.candidate, "candidate"],
		[["deviceId", "device"], plan.deviceId, "deviceId"],
		[["platform", "os", "platformName"], plan.platform, "platform"],
	];
	for (const [names, expected, label] of bindings) {
		const actual = metadata(event, names);
		if (actual !== undefined && String(actual) !== expected) fail(`result event ${label} does not match batch plan`, `${label.toUpperCase()}_MISMATCH`);
	}
}

function eventTimestamp(event, lineNumber, minimumDate) {
	const timestamps = event.timestamps && typeof event.timestamps === "object" ? event.timestamps : {};
	const value = metadata({ finishedAt: timestamps.finishedAt, recordedAt: timestamps.recordedAt, executedAt: event.executedAt, startedAt: timestamps.startedAt }, ["finishedAt", "recordedAt", "executedAt", "startedAt"]);
	if (value === undefined) fail(`terminal test event on line ${lineNumber} has no timestamp`, "MALFORMED");
	const parsed = parseIso(value, `result line ${lineNumber} timestamp`);
	if (parsed.date.getTime() < minimumDate.getTime()) fail(`result line ${lineNumber} predates the planned round`, "STALE_EXECUTION");
	return parsed;
}

function failureReason(event) {
	const direct = metadata(event, ["failureReason", "reason"]);
	if (direct !== undefined) return String(direct);
	if (typeof event.error === "string") return event.error;
	if (event.error && typeof event.error === "object") return metadata(event.error, ["message", "name"]);
	return undefined;
}

function eventEvidencePath(event, jsonlPath, lineNumber) {
	const raw = metadata(event, ["evidencePath", "resultPath", "artifactPath"]);
	if (raw === undefined) return `${jsonlPath}#line-${lineNumber}`;
	const path = normalizeFile(raw, { baseDir: dirname(jsonlPath), label: `result line ${lineNumber} evidencePath` });
	return `${path}#line-${lineNumber}`;
}

function terminalStatus(event, lineNumber) {
	const status = nonEmptyString(event.status ?? "", `result line ${lineNumber}.status`).toUpperCase();
	if (IGNORED_STATUSES.has(status)) return null;
	if (!TERMINAL_STATUSES.has(status)) fail(`result line ${lineNumber} has unsupported status ${status}`, "MALFORMED");
	return status;
}

function aggregateCase(casePlan, observations) {
	const records = casePlan.requiredObservations.map((observation) => observations.get(`${observation.file}\u0000${observation.testTitle}`));
	const missing = records.filter((record) => !record || record.status === "SKIP" || record.status === "NOT_RUN");
	const available = records.filter((record) => record && record.status !== "SKIP" && record.status !== "NOT_RUN");
	if (available.length === 0) return { record: null, reason: "all required observations are missing, skipped, or not run" };
	const failed = available.filter((record) => record.status === "FAIL");
	const blocked = available.filter((record) => record.status === "BLOCKED");
	const result = failed.length > 0 ? "FAIL" : blocked.length > 0 ? "BLOCKED" : missing.length > 0 ? null : "PASS";
	if (result === null) return { record: null, reason: "required observation is missing, skipped, or not run" };
	const timestamps = available.map((record) => record.timestamp.date.getTime());
	const reasons = available.map((record) => record.reason).filter(Boolean);
	const missingReason = missing.length > 0 ? `${missing.length} required observation(s) missing, skipped, or not run` : undefined;
	return {
		record: {
			result,
			executedAt: new Date(Math.max(...timestamps)).toISOString(),
			evidence: available.map((record) => record.evidence).join(", "),
			failureReason: result === "PASS" ? undefined : [...reasons, missingReason].filter(Boolean).join("; ") || `required observation reported ${result}`,
		},
		reason: null,
	};
}

/** Import one native reporter JSONL; all lines are validated before any round write. */
export function importBatchResults({ adkPath, planPath, candidate, deviceId, platform, jsonlPath } = {}) {
	const loaded = loadPlan(planPath, { adkPath, candidate, deviceId, platform });
	const jsonl = absolutePath(jsonlPath, "jsonlPath");
	if (!existsSync(jsonl) || !statSync(jsonl).isFile()) fail(`jsonlPath does not exist: ${jsonl}`);
	const { runId } = resultPathParts(jsonl, loaded.context.adkPath);
	if (!runId.startsWith(`${loaded.plan.runPrefix}-`)) fail("result runId is not a child of the planned run prefix", "STALE_RUN");
	const lines = readFileSync(jsonl, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
	if (lines.length === 0) fail("result JSONL is empty", "MALFORMED");
	const specFiles = new Set(loaded.plan.wdioPlan.specs[0].map((file) => absolutePath(file, "batch plan spec")));
	const observationIndex = new Map();
	for (const casePlan of loaded.plan.cases) for (const observation of casePlan.requiredObservations) observationIndex.set(`${observation.file}\u0000${observation.testTitle}`, casePlan.caseId);
	const observationsByCase = new Map(loaded.plan.cases.map((item) => [item.caseId, new Map()]));
	const seenTerminal = new Set();
	const minimumDate = new Date(Math.max(new Date(loaded.plan.roundCreatedAt).getTime(), new Date(loaded.plan.createdAt).getTime()));
	let eventCount = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		let event;
		try {
			event = JSON.parse(lines[index]);
		} catch (error) {
			fail(`result line ${lineNumber} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, "MALFORMED");
		}
		if (!event || typeof event !== "object" || Array.isArray(event)) fail(`result line ${lineNumber} must be an object`, "MALFORMED");
		if (event.schema !== undefined && event.schema !== BATCH_RESULTS_SCHEMA) fail(`result line ${lineNumber} has an unsupported schema`, "MALFORMED");
		if (event.runId !== runId) fail(`result line ${lineNumber} runId does not match result directory`, "STALE_RUN");
		validateOptionalBinding(event, loaded.plan);
		const kind = event.kind ?? "test";
		if (!["run", "test", "hook"].includes(kind)) fail(`result line ${lineNumber} has unsupported kind ${kind}`, "MALFORMED");
		if (kind !== "test") continue;
		const status = terminalStatus(event, lineNumber);
		if (status === null) continue;
		const fileValue = event.file ?? event.specFile;
		const title = nonEmptyString(event.title ?? event.fullTitle ?? event.testTitle, `result line ${lineNumber}.title`);
	const file = normalizeFile(fileValue, { baseDir: loaded.plan.wdioPlan.workingDirectory, label: `result line ${lineNumber}.file`, mustExist: false });
		if (!specFiles.has(file)) fail(`result line ${lineNumber} file is outside the planned specs: ${file}`, "SCOPE");
		const key = `${file}\u0000${title}`;
		const caseId = observationIndex.get(key);
		// Auxiliary tests in a selected spec are ignored; they cannot complete a QA case.
		if (!caseId) continue;
		if (seenTerminal.has(key)) fail(`duplicate terminal result for ${file} / ${title}`, "DUPLICATE");
		seenTerminal.add(key);
		const timestamp = eventTimestamp(event, lineNumber, minimumDate);
		const evidence = eventEvidencePath(event, jsonl, lineNumber);
		const reason = failureReason(event);
		observationsByCase.get(caseId).set(key, { status, timestamp, evidence, reason });
		eventCount += 1;
	}
	if (eventCount === 0) fail("result JSONL contains no declared batch observations", "SCOPE");
	const writes = [];
	const skipped = [];
	for (const casePlan of loaded.plan.cases) {
		const aggregate = aggregateCase(casePlan, observationsByCase.get(casePlan.caseId));
		if (!aggregate.record) {
			skipped.push({ caseId: casePlan.caseId, reason: aggregate.reason });
			continue;
		}
		const existing = loaded.context.state.results.find((entry) => entry.caseId === casePlan.caseId && entry.deviceId === loaded.plan.deviceId);
		if (!existing || existing.result !== "NOT_RUN") fail(`case/device is already terminal or outside round: ${casePlan.caseId}/${loaded.plan.deviceId}`, "RECORDED");
		writes.push({ caseId: casePlan.caseId, ...aggregate.record });
	}
	for (const item of writes) {
		recordResult({ adkPath: loaded.context.adkPath, roundId: loaded.plan.roundId, candidate: loaded.plan.candidate, caseId: item.caseId, deviceId: loaded.plan.deviceId, platform: loaded.plan.platform, executedAt: item.executedAt, result: item.result, evidence: item.evidence, failureReason: item.failureReason });
	}
	return {
		planPath: loaded.path,
		jsonlPath: jsonl,
		runId,
		imported: writes.map(({ caseId, result, executedAt, evidence, failureReason }) => ({ caseId, result, executedAt, evidence, ...(failureReason ? { failureReason } : {}) })),
		skipped,
		status: getRoundStatus({ adkPath: loaded.context.adkPath, roundId: loaded.plan.roundId }),
	};
}

export const createBatchPlan = planBatch;
export const importBatchJsonl = importBatchResults;

function parseCli(argv) {
	const [command, ...rest] = argv;
	const options = {};
	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];
		if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
		const [key, inline] = token.slice(2).split("=", 2);
		const value = inline ?? rest[++index];
		if (value === undefined || value.startsWith("--")) fail(`missing value for --${key}`);
		options[key.replaceAll("-", "_")] = value;
	}
	return { command, options };
}

function cli() {
	const { command, options } = parseCli(process.argv.slice(2));
	if (command === "plan") {
		const result = planBatch({ adkPath: options.adk, roundId: options.round, candidate: options.candidate, deviceId: options.device, platform: options.platform, mappingPath: options.mapping, nativePlanPath: options.native_plan, specBaseDir: options.spec_base_dir, workingDirectory: options.working_directory, wdioConfig: options.wdio_config });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	if (command === "import") {
		const result = importBatchResults({ adkPath: options.adk, planPath: options.plan, candidate: options.candidate, deviceId: options.device, platform: options.platform, jsonlPath: options.jsonl });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	process.stdout.write("Usage: qa-batch.mjs plan|import ...\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		cli();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
