import { invoke } from "@tauri-apps/api/core";
import { LAB_GATEWAY_URL, loadConfig } from "../../lib/config";
import { selectOpenCodeNaiaModel } from "../../lib/llm/registry";
import { Logger } from "../../lib/logger";
import { effectiveMainRole } from "../../lib/slots/model";
import {
	ensureProjectAgentEventListeners,
	resetProjectAgentEventListenersForTests,
} from "./project-agent-events";
import {
	PROJECT_AGENT_APPS,
	type ProjectAgentAppId,
	type ProjectAgentState,
	availabilityByApp,
	cloneState,
	isProjectAgentAppId,
	parseAgentError,
	parseAvailability,
	parseSession,
	pathListeners,
	projectAgentDiagnosticCode,
	publish,
	setState,
	stateFor,
	statesByProject,
} from "./project-agent-runtime-state";
import { normalizeProjectPath } from "./project-session";
export { PROJECT_AGENT_APPS } from "./project-agent-runtime-state";
export type {
	ProjectAgentAppId,
	ProjectAgentAvailability,
	ProjectAgentError,
	ProjectAgentPtySession,
	ProjectAgentState,
	ProjectAgentStatus,
} from "./project-agent-runtime-state";

export function preselectProjectAgentIfUnset(
	projectPath: string,
	candidateAppId: unknown,
): void {
	if (candidateAppId === null || candidateAppId === undefined) return;
	if (!isProjectAgentAppId(candidateAppId)) {
		Logger.debug(
			"ProjectAgentRuntime",
			"ignoring invalid coding_app preselect",
		);
		return;
	}
	const state = stateFor(projectPath);
	if (state.selectedAppId !== null) return;
	Logger.debug("ProjectAgentRuntime", "preselecting configured coding_app", {
		appId: candidateAppId,
	});
	state.selectedAppId = candidateAppId;
}

let availabilityRequest: Promise<void> | null = null;

const MAX_PROJECT_AGENT_QUEUED_INPUT_BYTES = 64 * 1024;
// Fixed ownership/path/availability validation codes cannot change by polling.
const PERMANENT_PROJECT_AGENT_ATTACH_ERRORS = new Set([
	"repository_invalid",
	"checkout_unsafe",
	"project_unverified",
	"agent_unavailable",
	"agent_invalid",
	"session_mismatch",
]);

interface ProjectAgentInputChunk {
	data: string;
	bytes: number;
}

interface ProjectAgentInputQueue {
	projectPath: string;
	adapterRoot: string;
	appId: ProjectAgentAppId;
	chunks: ProjectAgentInputChunk[];
	bytes: number;
	draining: Promise<void> | null;
}

const inputQueues = new Map<string, ProjectAgentInputQueue>();
const adapterRootsByProject = new Map<string, string>();
const pendingOpenCodeOperations = new Set<Promise<void>>();
let opencodeCredentialEpoch = 0;

function trackOpenCodeOperation(appId: ProjectAgentAppId): (() => void) | null {
	if (appId !== "opencode") return null;
	let finish: (() => void) | null = null;
	const completion = new Promise<void>((resolve) => {
		finish = resolve;
	});
	pendingOpenCodeOperations.add(completion);
	return () => {
		pendingOpenCodeOperations.delete(completion);
		finish?.();
	};
}

function inputQueueKey(projectPath: string, appId: ProjectAgentAppId): string {
	return JSON.stringify([normalizeProjectPath(projectPath), appId]);
}

function getOrCreateInputQueue(
	projectPath: string,
	adapterRoot: string,
	appId: ProjectAgentAppId,
): ProjectAgentInputQueue {
	const key = inputQueueKey(projectPath, appId);
	let queue = inputQueues.get(key);
	if (!queue) {
		queue = {
			projectPath,
			adapterRoot,
			appId,
			chunks: [],
			bytes: 0,
			draining: null,
		};
		inputQueues.set(key, queue);
	} else if (queue.adapterRoot !== adapterRoot) {
		Logger.debug("ProjectAgentRuntime", "refreshing queued PTY adapter root", {
			appId,
		});
		queue.adapterRoot = adapterRoot;
	}
	return queue;
}

function bufferProjectAgentInput(
	projectPath: string,
	adapterRoot: string,
	appId: ProjectAgentAppId,
	data: string,
): ProjectAgentInputQueue | null {
	const key = inputQueueKey(projectPath, appId);
	const queue = getOrCreateInputQueue(projectPath, adapterRoot, appId);
	const bytes = new TextEncoder().encode(data).byteLength;
	if (queue.bytes + bytes > MAX_PROJECT_AGENT_QUEUED_INPUT_BYTES) {
		Logger.warn("ProjectAgentRuntime", "PTY input was not queued", {
			appId,
			reason: "startup_queue_limit",
			queuedBytes: queue.bytes,
			inputBytes: bytes,
			limitBytes: MAX_PROJECT_AGENT_QUEUED_INPUT_BYTES,
		});
		setState(projectPath, { inputError: { code: "input_failed" } });
		if (queue.chunks.length === 0) inputQueues.delete(key);
		return null;
	}
	queue.chunks.push({ data, bytes });
	queue.bytes += bytes;
	Logger.debug("ProjectAgentRuntime", "PTY input buffered in order", {
		appId,
		bufferedBytes: queue.bytes,
	});
	return queue;
}

function discardQueuedProjectAgentInput(
	projectPath: string,
	appId: ProjectAgentAppId,
	reason: string,
): boolean {
	const key = inputQueueKey(projectPath, appId);
	const queue = inputQueues.get(key);
	if (!queue || queue.chunks.length === 0) {
		inputQueues.delete(key);
		return false;
	}
	Logger.warn("ProjectAgentRuntime", "buffered PTY input could not be sent", {
		appId,
		reason,
		droppedChunks: queue.chunks.length,
		droppedBytes: queue.bytes,
	});
	inputQueues.delete(key);
	return true;
}

async function drainProjectAgentInput(
	queue: ProjectAgentInputQueue,
): Promise<void> {
	const key = inputQueueKey(queue.projectPath, queue.appId);
	if (queue.draining) return queue.draining;
	const draining = (async () => {
		while (queue.chunks.length > 0) {
			const chunk = queue.chunks[0];
			try {
				await invoke("project_agent_pty_write", {
					appId: queue.appId,
					projectPath: queue.projectPath,
					adapterRoot: queue.adapterRoot,
					data: chunk.data,
				});
			} catch (error) {
				const mapped = parseAgentError(error);
				const droppedChunks = queue.chunks.length;
				const droppedBytes = queue.bytes;
				Logger.error("ProjectAgentRuntime", "PTY input request failed", {
					appId: queue.appId,
					code: projectAgentDiagnosticCode(error),
					droppedChunks,
					droppedBytes,
				});
				queue.chunks = [];
				queue.bytes = 0;
				inputQueues.delete(key);
				setState(queue.projectPath, {
					status: "error",
					error: mapped,
					inputError: { code: "input_failed" },
					ptyId: null,
				});
				return;
			}
			queue.chunks.shift();
			queue.bytes -= chunk.bytes;
		}
		if (inputQueues.get(key) === queue) inputQueues.delete(key);
		setState(queue.projectPath, { inputError: null });
	})();
	queue.draining = draining;
	return draining;
}

function ensureEventListeners(): Promise<void> {
	Logger.debug("ProjectAgentRuntime", "requesting project PTY event listeners");
	return ensureProjectAgentEventListeners({
		isAppId: isProjectAgentAppId,
		getState: (projectKey) => statesByProject.get(projectKey),
		publish,
	});
}

export function getProjectAgentState(projectPath: string): ProjectAgentState {
	Logger.debug("ProjectAgentRuntime", "reading project agent state");
	return cloneState(stateFor(projectPath));
}

export function subscribeProjectAgent(
	projectPath: string,
	listener: (state: ProjectAgentState) => void,
): () => void {
	Logger.debug("ProjectAgentRuntime", "subscribing to one project session");
	const key = normalizeProjectPath(projectPath);
	const listeners = pathListeners.get(key) ?? new Set();
	listeners.add(listener);
	pathListeners.set(key, listeners);
	void ensureEventListeners().catch(() => {
		setState(projectPath, {
			status: "error",
			error: { code: "unknown" },
		});
	});
	listener(getProjectAgentState(projectPath));
	return () => {
		Logger.debug(
			"ProjectAgentRuntime",
			"unsubscribing from one project session",
		);
		listeners.delete(listener);
		if (listeners.size === 0) pathListeners.delete(key);
	};
}

export function loadProjectAgentAvailability(): Promise<void> {
	Logger.debug("ProjectAgentRuntime", "loading fixed app availability");
	if (!availabilityRequest) {
		availabilityRequest = invoke<unknown>("project_agent_availability")
			.then(parseAvailability)
			.then((entries) => {
				Logger.debug("ProjectAgentRuntime", "app availability received", {
					entryCount: entries.length,
				});
				for (const appId of PROJECT_AGENT_APPS)
					availabilityByApp.set(appId, false);
				for (const entry of entries)
					availabilityByApp.set(entry.appId, entry.available);
				for (const state of statesByProject.values()) {
					for (const appId of PROJECT_AGENT_APPS) {
						state.availability[appId] = availabilityByApp.get(appId) ?? false;
					}
				}
				for (const key of pathListeners.keys()) {
					const state = statesByProject.get(key);
					if (state) publish(key);
				}
				availabilityRequest = null;
			})
			.catch((error) => {
				availabilityRequest = null;
				Logger.debug("ProjectAgentRuntime", "app availability request failed");
				throw error;
			});
	}
	return availabilityRequest;
}

export function selectProjectAgent(
	projectPath: string,
	appId: ProjectAgentAppId,
): void {
	Logger.debug("ProjectAgentRuntime", "selecting a fixed project agent", {
		appId,
	});
	if (!isProjectAgentAppId(appId)) {
		Logger.debug(
			"ProjectAgentRuntime",
			"selection rejected for unknown app ID",
		);
		return;
	}
	const state = stateFor(projectPath);
	if (state.status === "running" || state.status === "starting") {
		Logger.debug(
			"ProjectAgentRuntime",
			"selection ignored while a PTY is active",
		);
		return;
	}
	setState(projectPath, {
		selectedAppId: appId,
		status: "idle",
		error: null,
		inputError: null,
		naiaLoginRequired: false,
		exitCode: null,
	});
}

export async function startProjectAgent(
	projectPath: string,
	adapterRoot: string,
	appId: ProjectAgentAppId,
): Promise<void> {
	Logger.debug("ProjectAgentRuntime", "starting selected project agent", {
		appId,
	});
	if (!isProjectAgentAppId(appId)) {
		Logger.debug("ProjectAgentRuntime", "start rejected for unknown app ID");
		setState(projectPath, {
			status: "error",
			error: { code: "agent_invalid" },
		});
		return;
	}
	const current = stateFor(projectPath);
	if (current.availability[appId] !== true) {
		Logger.debug(
			"ProjectAgentRuntime",
			"start blocked because fixed executable is unavailable",
		);
		setState(projectPath, {
			status: "error",
			error: { code: "agent_unavailable" },
		});
		return;
	}
	if (
		current.selectedAppId !== appId ||
		current.status === "running" ||
		current.status === "starting"
	) {
		Logger.debug(
			"ProjectAgentRuntime",
			"start blocked by selection or lifecycle state",
		);
		return;
	}
	setState(projectPath, {
		status: "starting",
		error: null,
		inputError: null,
		naiaLoginRequired: false,
		output: "",
		ptyId: null,
		exitCode: null,
	});
	const projectKey = normalizeProjectPath(projectPath);
	adapterRootsByProject.set(projectKey, adapterRoot);
	const authEpochAtStart = opencodeCredentialEpoch;
	const finishOpenCodeStart = trackOpenCodeOperation(appId);
	try {
		await ensureEventListeners();
		const config = appId === "opencode" ? loadConfig() : null;
		const mainRole = config ? effectiveMainRole(config) : {};
		const value = await invoke<unknown>("project_agent_pty_start", {
			appId,
			projectPath,
			adapterRoot,
			...(appId === "opencode"
				? {
						naiaGatewayUrl: LAB_GATEWAY_URL,
						naiaModelProvider: mainRole.provider ?? "",
						naiaModel: selectOpenCodeNaiaModel(
							mainRole.provider,
							mainRole.model,
						),
					}
				: {}),
		});
		const session = parseSession(value, appId, projectPath);
		setState(projectPath, {
			status: "running",
			ptyId: session.ptyId,
			naiaLoginRequired: session.naiaLoginRequired,
			error: null,
			inputError: null,
		});
		Logger.debug("ProjectAgentRuntime", "project agent PTY started", { appId });
		if (appId === "opencode" && authEpochAtStart !== opencodeCredentialEpoch) {
			Logger.debug(
				"ProjectAgentRuntime",
				"stopping OpenCode started across a Naia credential change",
			);
			await stopProjectAgent(projectPath, adapterRoot, appId);
			return;
		}
		const queue = inputQueues.get(inputQueueKey(projectPath, appId));
		if (queue) await drainProjectAgentInput(queue);
	} catch (error) {
		const mapped = parseAgentError(error);
		const bufferedInputDropped = discardQueuedProjectAgentInput(
			projectPath,
			appId,
			"start_failed",
		);
		Logger.error("ProjectAgentRuntime", "project agent PTY start failed", {
			code: projectAgentDiagnosticCode(error),
		});
		setState(projectPath, {
			status: "error",
			error: mapped,
			inputError: bufferedInputDropped
				? { code: "input_failed" }
				: stateFor(projectPath).inputError,
			ptyId: null,
			naiaLoginRequired: false,
		});
	} finally {
		finishOpenCodeStart?.();
	}
}

export async function attachProjectAgent(
	projectPath: string,
	adapterRoot: string,
	appId: ProjectAgentAppId,
): Promise<void> {
	Logger.debug("ProjectAgentRuntime", "reattaching to project PTY", { appId });
	if (!isProjectAgentAppId(appId)) {
		Logger.debug("ProjectAgentRuntime", "attach rejected for unknown app ID");
		return;
	}
	const state = stateFor(projectPath);
	if (!state.ptyId || state.selectedAppId !== appId) {
		Logger.debug(
			"ProjectAgentRuntime",
			"attach skipped without an in-memory session identity",
		);
		return;
	}
	setState(projectPath, {
		status: "connecting",
		error: null,
	});
	adapterRootsByProject.set(normalizeProjectPath(projectPath), adapterRoot);
	const authEpochAtAttach = opencodeCredentialEpoch;
	const finishOpenCodeAttach = trackOpenCodeOperation(appId);
	try {
		await ensureEventListeners();
		const value = await invoke<unknown>("project_agent_pty_attach", {
			appId,
			projectPath,
			adapterRoot,
		});
		const session = parseSession(value, appId, projectPath);
		if (state.ptyId !== session.ptyId) {
			Logger.debug(
				"ProjectAgentRuntime",
				"attach identity did not match memory session",
			);
			setState(projectPath, {
				status: "error",
				error: { code: "session_mismatch" },
				inputError: discardQueuedProjectAgentInput(
					projectPath,
					appId,
					"attach_session_mismatch",
				)
					? { code: "input_failed" }
					: stateFor(projectPath).inputError,
				ptyId: null,
			});
			return;
		}
		setState(projectPath, {
			status: "running",
			naiaLoginRequired: session.naiaLoginRequired,
			error: null,
			inputError: null,
		});
		Logger.debug("ProjectAgentRuntime", "project agent PTY reattached", {
			appId,
		});
		if (appId === "opencode" && authEpochAtAttach !== opencodeCredentialEpoch) {
			Logger.debug(
				"ProjectAgentRuntime",
				"stopping OpenCode reattached across a Naia credential change",
			);
			await stopProjectAgent(projectPath, adapterRoot, appId);
			return;
		}
		const queue = inputQueues.get(inputQueueKey(projectPath, appId));
		if (queue) await drainProjectAgentInput(queue);
	} catch (error) {
		const mapped = parseAgentError(error);
		const bufferedInputDropped = discardQueuedProjectAgentInput(
			projectPath,
			appId,
			"attach_failed",
		);
		Logger.debug("ProjectAgentRuntime", "project agent PTY reattach failed", {
			code: mapped.code,
		});
		setState(projectPath, {
			status: mapped.code === "session_missing" ? "idle" : "error",
			error: mapped.code === "session_missing" ? null : mapped,
			inputError: bufferedInputDropped
				? { code: "input_failed" }
				: stateFor(projectPath).inputError,
			ptyId: null,
		});
	} finally {
		finishOpenCodeAttach?.();
	}
}

export async function writeProjectAgent(
	projectPath: string,
	adapterRoot: string,
	appId: ProjectAgentAppId,
	data: string,
): Promise<void> {
	Logger.debug(
		"ProjectAgentRuntime",
		"writing terminal input to selected project PTY",
	);
	const state = stateFor(projectPath);
	if (!isProjectAgentAppId(appId)) {
		Logger.warn("ProjectAgentRuntime", "PTY input was not sent", {
			reason: "invalid_app_id",
		});
		return;
	}
	if (state.selectedAppId !== appId) {
		Logger.warn("ProjectAgentRuntime", "PTY input was not sent", {
			appId,
			reason: "app_not_selected",
		});
		return;
	}
	if (state.status === "starting" || state.status === "connecting") {
		bufferProjectAgentInput(projectPath, adapterRoot, appId, data);
		return;
	}
	if (state.status !== "running") {
		Logger.warn("ProjectAgentRuntime", "PTY input was not sent", {
			appId,
			reason: `session_${state.status}`,
		});
		return;
	}
	if (!state.ptyId) {
		Logger.warn("ProjectAgentRuntime", "PTY input was not sent", {
			appId,
			reason: "missing_pty_id",
		});
		return;
	}
	const queue = bufferProjectAgentInput(projectPath, adapterRoot, appId, data);
	if (queue) await drainProjectAgentInput(queue);
}

export async function resizeProjectAgent(
	projectPath: string,
	adapterRoot: string,
	appId: ProjectAgentAppId,
	rows: number,
	cols: number,
): Promise<void> {
	Logger.debug("ProjectAgentRuntime", "resizing project PTY", { rows, cols });
	const state = stateFor(projectPath);
	if (
		!isProjectAgentAppId(appId) ||
		state.selectedAppId !== appId ||
		state.status !== "running" ||
		!state.ptyId
	) {
		Logger.debug(
			"ProjectAgentRuntime",
			"PTY resize skipped without owned active session",
		);
		return;
	}
	try {
		await invoke("project_agent_pty_resize", {
			appId,
			projectPath,
			adapterRoot,
			rows,
			cols,
		});
	} catch (error) {
		const mapped = parseAgentError(error);
		Logger.debug("ProjectAgentRuntime", "PTY resize request failed", {
			code: mapped.code,
		});
		setState(projectPath, { status: "error", error: mapped, ptyId: null });
	}
}

export async function stopProjectAgent(
	projectPath: string,
	adapterRoot: string,
	appId: ProjectAgentAppId,
): Promise<void> {
	Logger.debug("ProjectAgentRuntime", "requesting owned project PTY stop", {
		appId,
	});
	if (!isProjectAgentAppId(appId)) {
		Logger.debug("ProjectAgentRuntime", "stop rejected for unknown app ID");
		return;
	}
	const state = stateFor(projectPath);
	if (
		state.selectedAppId !== appId ||
		(state.status !== "running" && state.status !== "connecting") ||
		!state.ptyId
	) {
		Logger.debug(
			"ProjectAgentRuntime",
			"stop skipped without an owned active session",
		);
		return;
	}
	setState(projectPath, {
		status: "stopping",
		naiaLoginRequired: false,
		error: null,
	});
	try {
		await ensureEventListeners();
		await invoke("project_agent_pty_stop", {
			appId,
			projectPath,
			adapterRoot,
		});
		Logger.debug("ProjectAgentRuntime", "project PTY stop requested", {
			appId,
		});
	} catch (error) {
		const mapped = parseAgentError(error);
		Logger.debug("ProjectAgentRuntime", "project PTY stop request failed", {
			code: mapped.code,
		});
		if (getProjectAgentState(projectPath).status === "stopping") {
			setState(projectPath, { status: "running", error: mapped });
		}
	}
}

export async function waitForProjectAgentStopped(
	projectPath: string,
	adapterRoot: string,
	appId: ProjectAgentAppId,
	options?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean | "unknown"> {
	const timeoutMs = options?.timeoutMs ?? 5000;
	const intervalMs = Math.max(50, options?.intervalMs ?? 200);
	const deadline = Date.now() + timeoutMs;
	Logger.debug(
		"ProjectAgentRuntime",
		"waiting for project PTY session to stop",
		{
			appId,
			timeoutMs,
			intervalMs,
		},
	);
	if (!isProjectAgentAppId(appId)) {
		return true;
	}
	while (true) {
		const state = stateFor(projectPath);
		if (state.status === "exited") {
			return true;
		}
		try {
			const response = await invoke<unknown>("project_agent_pty_attach", {
				appId,
				projectPath,
				adapterRoot,
			});
			const stillRunning =
				typeof response === "object" &&
				response !== null &&
				(response as { running?: unknown }).running === true;
			if (!stillRunning) {
				setState(projectPath, { status: "idle", ptyId: null, error: null });
				return true;
			}
		} catch (error) {
			const mapped = parseAgentError(error);
			if (mapped.code === "session_missing") {
				setState(projectPath, { status: "idle", ptyId: null, error: null });
				return true;
			}
			if (PERMANENT_PROJECT_AGENT_ATTACH_ERRORS.has(mapped.code)) {
				if (stateFor(projectPath).status === "stopping") {
					setState(projectPath, { status: "running" });
				}
				Logger.warn(
					"ProjectAgentRuntime",
					"project PTY stop status could not be checked",
					{ appId, code: mapped.code },
				);
				return "unknown";
			}
			if (Date.now() >= deadline) {
				if (stateFor(projectPath).status === "stopping") {
					setState(projectPath, { status: "running" });
				}
				Logger.warn(
					"ProjectAgentRuntime",
					"project PTY stop status is unknown",
					{
						appId,
					},
				);
				return "unknown";
			}
		}
		if (Date.now() >= deadline) {
			if (stateFor(projectPath).status === "stopping") {
				setState(projectPath, { status: "running" });
			}
			Logger.warn(
				"ProjectAgentRuntime",
				"project PTY session remained running after stop timeout",
				{ appId },
			);
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** Stop only OpenCode sessions because their inherited Naia key changed. */
export async function stopOpenCodeProjectAgentSessions(): Promise<void> {
	Logger.debug(
		"ProjectAgentRuntime",
		"stopping OpenCode sessions after Naia credential change",
	);
	opencodeCredentialEpoch += 1;
	await Promise.all([...pendingOpenCodeOperations]);
	const sessions = [...statesByProject.entries()].filter(
		([, state]) =>
			state.selectedAppId === "opencode" &&
			state.ptyId !== null &&
			(state.status === "running" || state.status === "connecting"),
	);
	await Promise.all(
		sessions.map(async ([projectPath]) => {
			const adapterRoot = adapterRootsByProject.get(projectPath);
			if (!adapterRoot) {
				Logger.warn(
					"ProjectAgentRuntime",
					"OpenCode session could not be stopped after Naia credential change",
					{ reason: "adapter_root_unavailable" },
				);
				throw new Error("OpenCode session adapter path is unavailable.");
			}
			await stopProjectAgent(projectPath, adapterRoot, "opencode");
			if (getProjectAgentState(projectPath).status === "running") {
				throw new Error("OpenCode session could not be stopped.");
			}
		}),
	);
}

export function resetProjectAgentRuntimeForTests(): void {
	Logger.debug("ProjectAgentRuntime", "resetting in-memory test state");
	inputQueues.clear();
	adapterRootsByProject.clear();
	pendingOpenCodeOperations.clear();
	opencodeCredentialEpoch = 0;
	resetProjectAgentEventListenersForTests();
	statesByProject.clear();
	pathListeners.clear();
	availabilityByApp.clear();
	availabilityRequest = null;
	Logger.debug(
		"ProjectAgentRuntime",
		"native event listener lifecycle remains in the event module",
	);
}
