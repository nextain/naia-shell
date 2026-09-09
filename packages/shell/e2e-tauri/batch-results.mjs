import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BATCH_RESULTS_SCHEMA = "naia-shell.e2e-batch-results.v1";
export const BATCH_RESULTS_DIRNAME = "e2e-batch-results";

const MAX_ERROR_MESSAGE = 2_000;
const MAX_ERROR_STACK = 8_000;

function invalid(message) {
	throw new Error(`[e2e-batch] ${message}`);
}

function pathValue(value) {
	if (value instanceof URL) return fileURLToPath(value);
	if (typeof value === "string" && value.startsWith("file:")) {
		return fileURLToPath(value);
	}
	return value;
}

function requireAbsolutePath(value, label) {
	const candidate = pathValue(value);
	if (typeof candidate !== "string" || candidate.trim() === "") {
		invalid(`${label} must be an absolute path`);
	}
	if (!isAbsolute(candidate)) invalid(`${label} must be an absolute path`);
	return resolve(candidate);
}

function safeRunPrefix(value) {
	if (value === undefined || value === null || String(value).trim() === "") {
		return "e2e-batch";
	}
	const prefix = String(value).trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(prefix) || prefix === "." || prefix === "..") {
		invalid("runId must contain only short filename-safe characters");
	}
	return prefix;
}

function uniqueRunId(value) {
	return `${safeRunPrefix(value)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function selectedAdkPath({ adkPath, planPath } = {}) {
	if (adkPath !== undefined) return requireAbsolutePath(adkPath, "adkPath");
	if (planPath !== undefined) {
		const absolutePlan = requireAbsolutePath(planPath, "planPath");
		return dirname(absolutePlan);
	}
	if (process.env.NAIA_E2E_ADK_PATH) {
		return requireAbsolutePath(process.env.NAIA_E2E_ADK_PATH, "NAIA_E2E_ADK_PATH");
	}
	invalid("adkPath or planPath is required");
}

/**
 * Build reporter options for the selected ADK. Output is deliberately rooted
 * in a unique run directory beneath the selected ADK.
 */
export function createBatchResultsReporterOptions(options = {}) {
	const adkPath = selectedAdkPath(options);
	const planPath = options.planPath === undefined
		? undefined
		: requireAbsolutePath(options.planPath, "planPath");
	const runId = uniqueRunId(options.runId);
	const resultsDir = join(adkPath, BATCH_RESULTS_DIRNAME, runId);
	return {
		...options,
		adkPath,
		...(planPath ? { planPath } : {}),
		runId,
		resultsDir,
		resultsPath: join(resultsDir, "results.jsonl"),
	};
}

function asIso(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

function boundedText(value, limit) {
	if (value === undefined || value === null) return undefined;
	const text = String(value);
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Redact common credential forms before anything reaches the JSONL artifact. */
export function redactText(value, limit = MAX_ERROR_STACK) {
	if (value === undefined || value === null) return undefined;
	let text = String(value);
	text = text.replace(/(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]");
	text = text.replace(/\b(?:sk|rk|xai|AIza)[-_A-Za-z0-9]{8,}\b/gi, "[REDACTED]");
	text = text.replace(
		/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*)(["']?)[^"'\s,;}]+/gi,
		"$1$2[REDACTED]",
	);
	text = text.replace(/((?:token|key|secret|password)\s*=\s*)[^\s&]+/gi, "$1[REDACTED]");
	return boundedText(text, limit);
}

export function serializeError(error) {
	if (error === undefined || error === null) return undefined;
	if (typeof error === "string") {
		return { name: "Error", message: redactText(error, MAX_ERROR_MESSAGE) };
	}
	const name = redactText(error.name ?? "Error", 200) ?? "Error";
	const message = redactText(error.message ?? String(error), MAX_ERROR_MESSAGE);
	const stack = redactText(error.stack, MAX_ERROR_STACK);
	return {
		name,
		...(message ? { message } : {}),
		...(stack ? { stack } : {}),
		...(error.code !== undefined ? { code: redactText(error.code, 200) } : {}),
	};
}

function normalizeFile(value) {
	if (value === undefined || value === null || value === "") return null;
	try {
		return String(pathValue(value));
	} catch {
		return boundedText(value, 2_000) ?? null;
	}
}

function finiteDuration(value) {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function errorFrom(event) {
	if (event?.error !== undefined) return event.error;
	if (Array.isArray(event?.errors) && event.errors.length > 0) return event.errors[0];
	return undefined;
}

function hasHookError(event) {
	return event?.state === "failed" || event?.error !== undefined ||
		(Array.isArray(event?.errors) && event.errors.length > 0);
}

function eventIdentity(event, fallback = {}) {
	return {
		cid: event?.cid ?? fallback.cid ?? null,
		uid: event?.uid ?? fallback.uid ?? null,
		file: event?.file ?? fallback.file ?? null,
	};
}

export class BatchResultsReporter extends EventEmitter {
	constructor(options = {}) {
		super();
		const normalized = createBatchResultsReporterOptions(options);
		this.adkPath = normalized.adkPath;
		this.planPath = normalized.planPath ?? null;
		this.runId = normalized.runId;
		this.resultsDir = normalized.resultsDir;
		this.resultsPath = normalized.resultsPath;
		this.writeError = null;
		this.sessionId = null;
		this.cid = null;
		this.specs = [];
		this.tests = new Map();
		this.hookFailure = false;
		this.finished = false;
		this.started = false;
		mkdirSync(this.resultsDir, { recursive: true });

		this.on("runner:start", (event) => this.onRunnerStart(event));
		this.on("test:start", (event) => this.onTestStart(event));
		this.on("test:pass", (event) => this.onTestPass(event));
		this.on("test:fail", (event) => this.onTestFail(event));
		this.on("test:skip", (event) => this.onTestSkip(event));
		this.on("test:pending", (event) => this.onTestPending(event));
		this.on("test:retry", (event) => this.onTestRetry(event));
		this.on("test:end", (event) => this.onTestEnd(event));
		this.on("hook:end", (event) => this.onHookEnd(event));
		this.on("runner:end", (event) => this.onRunnerEnd(event));
	}

	// WDIO waits for this property on custom reporters. Records use a synchronous
	// append, so a successful return means the line is immediately readable.
	get isSynchronised() {
		return true;
	}

	flush() {
		if (this.writeError) throw this.writeError;
		return this.resultsPath;
	}

	close() {
		return this.flush();
	}

	_setRunnerIdentity(event = {}) {
		if (event.sessionId !== undefined && event.sessionId !== null) {
			this.sessionId = String(event.sessionId);
		}
		if (event.cid !== undefined && event.cid !== null) this.cid = String(event.cid);
		if (Array.isArray(event.specs)) this.specs = event.specs.map(normalizeFile).filter(Boolean);
	}

	_record({ kind, event, status, payload = {}, state, reason, error, duration, scope, unvisitedStatus }) {
		const identity = eventIdentity(payload, state);
		const startedAt = state?.startedAt ?? asIso(payload.start);
		const finishedAt = asIso(payload.end) ?? (status === "RUNNING" ? undefined : new Date().toISOString());
		const effectiveDuration = finiteDuration(duration) ?? finiteDuration(payload.duration) ??
			(startedAt && finishedAt ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()) : undefined);
		const timestamps = { recordedAt: new Date().toISOString() };
		if (startedAt) timestamps.startedAt = startedAt;
		if (finishedAt) timestamps.finishedAt = finishedAt;
		return {
			schema: BATCH_RESULTS_SCHEMA,
			runId: this.runId,
			kind,
			event,
			status,
			sessionId: payload.sessionId ?? this.sessionId ?? null,
			cid: identity.cid === null || identity.cid === undefined ? null : String(identity.cid),
			uid: identity.uid === null || identity.uid === undefined ? null : String(identity.uid),
			file: normalizeFile(identity.file),
			...(state?.title || payload.fullTitle || payload.title
				? { title: state?.title ?? payload.fullTitle ?? payload.title }
				: {}),
			duration: effectiveDuration ?? null,
			timestamps,
			...(scope ? { scope } : {}),
			...(unvisitedStatus ? { unvisitedStatus } : {}),
			...(reason ? { reason: redactText(reason, MAX_ERROR_MESSAGE) } : {}),
			...(error !== undefined ? { error: serializeError(error) } : {}),
		};
	}

	_write(record) {
		if (this.writeError) throw this.writeError;
		try {
			appendFileSync(this.resultsPath, `${JSON.stringify(record)}\n`, {
				encoding: "utf8",
				flag: "a",
			});
		} catch (error) {
			this.writeError ??= error;
			throw error;
		}
	}

	_testKey(event) {
		const identity = eventIdentity(event, { cid: this.cid });
		const uid = identity.uid ?? `${normalizeFile(identity.file) ?? ""}:${event.fullTitle ?? event.title ?? "anonymous"}`;
		return `${identity.cid ?? ""}\u0000${normalizeFile(identity.file) ?? ""}\u0000${uid}`;
	}

	_newTestState(event) {
		const identity = eventIdentity(event, { cid: this.cid });
		const key = this._testKey(event);
		const previous = this.tests.get(key);
		const state = {
			key,
			cid: identity.cid,
			uid: identity.uid ?? `${normalizeFile(identity.file) ?? ""}:${event.fullTitle ?? event.title ?? "anonymous"}`,
			file: normalizeFile(identity.file),
			title: event.fullTitle ?? event.title ?? null,
			startedAt: asIso(event.start) ?? new Date().toISOString(),
			terminal: false,
			status: "RUNNING",
			attempt: (previous?.attempt ?? 0) + 1,
		};
		this.tests.set(key, state);
		return state;
	}

	_ensureTest(event) {
		const key = this._testKey(event);
		return this.tests.get(key) ?? this._newTestState(event);
	}

	onRunnerStart(event = {}) {
		if (this.started) return;
		this.started = true;
		this._setRunnerIdentity(event);
		this._write(this._record({ kind: "run", event: "run_started", status: "RUNNING", payload: event }));
	}

	onTestStart(event = {}) {
		const state = this._newTestState(event);
		this._write(this._record({
			kind: "test",
			event: "test_started",
			status: "RUNNING",
			payload: event,
			state,
			duration: 0,
		}));
	}

	_writeTerminal(event, status, eventName, reason) {
		const state = this._ensureTest(event);
		if (state.terminal) return;
		state.terminal = true;
		state.status = status;
		this._write(this._record({
			kind: "test",
			event: eventName,
			status,
			payload: event,
			state,
			reason,
			error: status === "FAIL" ? errorFrom(event) : undefined,
		}));
	}

	onTestPass(event = {}) {
		this._writeTerminal(event, "PASS", "test_passed");
	}

	onTestFail(event = {}) {
		this._writeTerminal(event, "FAIL", "test_failed");
	}

	onTestSkip(event = {}) {
		this._writeTerminal(event, "SKIP", "test_skipped", event.reason ?? event.pendingReason);
	}

	onTestPending(event = {}) {
		this._writeTerminal(event, "NOT_RUN", "test_pending", event.reason ?? event.pendingReason ?? "pending");
	}

	onTestRetry(event = {}) {
		const state = this._ensureTest(event);
		this._write(this._record({
			kind: "test",
			event: "test_retry",
			status: "RETRY",
			payload: event,
			state,
			error: errorFrom(event),
		}));
	}

	onTestEnd() {
		// Terminal records are emitted by pass/fail/skip/pending. A test:end event
		// without one remains unresolved and is classified at runner:end.
	}

	onHookEnd(event = {}) {
		if (!hasHookError(event)) return;
		this.hookFailure = true;
		const identity = eventIdentity(event, { cid: this.cid });
		this._write(this._record({
			kind: "hook",
			event: "hook_failed",
			status: "BLOCKED",
			payload: {
				...event,
				cid: identity.cid,
				file: identity.file,
			},
			reason: event.title ?? "hook failure",
			error: errorFrom(event),
		}));
	}

	onRunnerEnd(event = {}) {
		if (this.finished) return;
		this.finished = true;
		this._setRunnerIdentity(event);
		let unresolved = 0;
		for (const state of this.tests.values()) {
			if (state.terminal) continue;
			unresolved += 1;
			state.terminal = true;
			state.status = this.hookFailure ? "BLOCKED" : "NOT_RUN";
			this._write(this._record({
				kind: "test",
				event: this.hookFailure ? "test_blocked" : "test_not_run",
				status: state.status,
				payload: { cid: state.cid, uid: state.uid, file: state.file },
				state,
				reason: this.hookFailure ? "hook failure" : "runner ended before a terminal test event",
			}));
		}

		const states = [...this.tests.values()];
		const runnerFailure = states.some((state) => state.status === "FAIL") ||
			Number(event.failures) > 0 || event.error !== undefined;
		const hasUnvisited = this.hookFailure || unresolved > 0;
		const hasNotRun = states.some((state) => state.status === "NOT_RUN");
		const hasSkip = states.some((state) => state.status === "SKIP");
		const status = hasUnvisited
			? "BLOCKED"
			: runnerFailure
				? "FAIL"
				: states.length === 0
					? "NOT_RUN"
					: hasNotRun
						? "NOT_RUN"
						: hasSkip
							? "SKIP"
							: "PASS";
		this._write(this._record({
			kind: "run",
			event: "run_finished",
			status,
			payload: event,
			duration: event.duration,
			scope: {
				plannedSpecs: this.specs.length,
				startedTests: states.length,
				terminalTests: states.filter((state) => state.status !== "RUNNING").length,
				unresolvedTests: unresolved,
			},
			unvisitedStatus: hasUnvisited ? "NOT_RUN" : undefined,
		}));
	}
}

export default BatchResultsReporter;
