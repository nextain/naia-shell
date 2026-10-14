import { invoke } from "@tauri-apps/api/core";
import { Logger } from "../../lib/logger";
import { ensureProjectAgentEventListeners } from "./project-agent-events";
import { normalizeProjectPath } from "./project-session";

export const PROJECT_AGENT_APPS = [
	"claude",
	"codex",
	"muse",
	"opencode",
] as const;
export type ProjectAgentAppId = (typeof PROJECT_AGENT_APPS)[number];
export type ProjectAgentStatus =
	| "idle"
	| "starting"
	| "connecting"
	| "running"
	| "exited"
	| "error";

export interface ProjectAgentAvailability {
	appId: ProjectAgentAppId;
	available: boolean;
}

export interface ProjectAgentPtySession {
	appId: ProjectAgentAppId;
	projectPath: string;
	ptyId: string;
	running: true;
}

export interface ProjectAgentError {
	code:
		| "checkout_missing"
		| "repository_invalid"
		| "checkout_unsafe"
		| "project_unverified"
		| "agent_unavailable"
		| "agent_invalid"
		| "session_mismatch"
		| "session_missing"
		| "unknown";
	expectedPath?: string;
}

export interface ProjectAgentState {
	selectedAppId: ProjectAgentAppId | null;
	availability: Record<ProjectAgentAppId, boolean | null>;
	status: ProjectAgentStatus;
	output: string;
	error: ProjectAgentError | null;
	exitCode: number | null;
	/** Process identity is memory-only and is never written to browser storage. */
	ptyId: string | null;
}

const availabilityByApp = new Map<ProjectAgentAppId, boolean>();
const statesByProject = new Map<string, ProjectAgentState>();
const pathListeners = new Map<
	string,
	Set<(state: ProjectAgentState) => void>
>();
let availabilityRequest: Promise<void> | null = null;

function emptyAvailability(): Record<ProjectAgentAppId, boolean | null> {
	Logger.debug("ProjectAgentRuntime", "creating unknown availability map");
	return { claude: null, codex: null, muse: null, opencode: null };
}

function isProjectAgentAppId(value: unknown): value is ProjectAgentAppId {
	Logger.debug("ProjectAgentRuntime", "checking fixed app identifier");
	return (
		typeof value === "string" &&
		(PROJECT_AGENT_APPS as readonly string[]).includes(value)
	);
}

function cloneState(state: ProjectAgentState): ProjectAgentState {
	Logger.debug("ProjectAgentRuntime", "copying project agent state", {
		status: state.status,
	});
	return {
		...state,
		availability: { ...state.availability },
		error: state.error ? { ...state.error } : null,
	};
}

function defaultState(): ProjectAgentState {
	Logger.debug("ProjectAgentRuntime", "creating empty in-memory project state");
	return {
		selectedAppId: null,
		availability: emptyAvailability(),
		status: "idle",
		output: "",
		error: null,
		exitCode: null,
		ptyId: null,
	};
}

function stateFor(projectPath: string): ProjectAgentState {
	Logger.debug("ProjectAgentRuntime", "looking up in-memory project session");
	const key = normalizeProjectPath(projectPath);
	let state = statesByProject.get(key);
	if (!state) {
		state = defaultState();
		for (const appId of PROJECT_AGENT_APPS) {
			state.availability[appId] = availabilityByApp.get(appId) ?? null;
		}
		statesByProject.set(key, state);
	}
	return state;
}

function publish(projectPath: string): void {
	Logger.debug("ProjectAgentRuntime", "publishing project session state");
	const key = normalizeProjectPath(projectPath);
	const state = statesByProject.get(key);
	if (!state) {
		Logger.debug(
			"ProjectAgentRuntime",
			"publish skipped without a project state",
		);
		return;
	}
	for (const listener of pathListeners.get(key) ?? [])
		listener(cloneState(state));
}

function setState(
	projectPath: string,
	patch: Partial<ProjectAgentState>,
): ProjectAgentState {
	Logger.debug("ProjectAgentRuntime", "updating project session state", {
		status: patch.status,
	});
	const state = stateFor(projectPath);
	Object.assign(state, patch);
	publish(projectPath);
	return state;
}

function parseAvailability(value: unknown): ProjectAgentAvailability[] {
	Logger.debug("ProjectAgentRuntime", "validating app availability response");
	if (!Array.isArray(value)) throw new Error("agent_invalid");
	const result: ProjectAgentAvailability[] = [];
	for (const item of value) {
		if (
			typeof item !== "object" ||
			item === null ||
			!isProjectAgentAppId((item as { appId?: unknown }).appId) ||
			typeof (item as { available?: unknown }).available !== "boolean"
		) {
			Logger.debug(
				"ProjectAgentRuntime",
				"ignoring malformed availability entry",
			);
			continue;
		}
		result.push({
			appId: (item as ProjectAgentAvailability).appId,
			available: (item as ProjectAgentAvailability).available,
		});
	}
	return result;
}

function parseSession(
	value: unknown,
	appId: ProjectAgentAppId,
	projectPath: string,
): ProjectAgentPtySession {
	Logger.debug("ProjectAgentRuntime", "validating PTY session response");
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		Logger.debug(
			"ProjectAgentRuntime",
			"PTY response was not a session object",
		);
		throw new Error("session_mismatch");
	}
	const candidate = value as Record<string, unknown>;
	if (
		candidate.appId !== appId ||
		typeof candidate.projectPath !== "string" ||
		normalizeProjectPath(candidate.projectPath) !==
			normalizeProjectPath(projectPath) ||
		typeof candidate.ptyId !== "string" ||
		!candidate.ptyId ||
		candidate.running !== true
	) {
		Logger.debug(
			"ProjectAgentRuntime",
			"PTY session response failed ownership checks",
		);
		throw new Error("session_mismatch");
	}
	return candidate as unknown as ProjectAgentPtySession;
}

function parseAgentError(error: unknown): ProjectAgentError {
	Logger.debug("ProjectAgentRuntime", "mapping native agent error code");
	const message =
		typeof error === "string"
			? error
			: error instanceof Error
				? error.message
				: "";
	const checkoutMissing = message.match(/^checkout_missing:([^\r\n]+)$/);
	if (checkoutMissing) {
		const expectedPath = checkoutMissing[1];
		const safeRelativePath =
			!expectedPath.startsWith("/") &&
			!expectedPath.includes("\\") &&
			!expectedPath.includes(":") &&
			expectedPath
				.split("/")
				.every((part) => part && part !== "." && part !== "..");
		if (safeRelativePath) return { code: "checkout_missing", expectedPath };
		return { code: "checkout_missing" };
	}
	const knownCodes: ProjectAgentError["code"][] = [
		"repository_invalid",
		"checkout_unsafe",
		"project_unverified",
		"agent_unavailable",
		"agent_invalid",
		"session_mismatch",
		"session_missing",
	];
	const code = knownCodes.find((known) => message === known) ?? "unknown";
	return { code };
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
		output: "",
		ptyId: null,
		exitCode: null,
	});
	try {
		await ensureEventListeners();
		const value = await invoke<unknown>("project_agent_pty_start", {
			appId,
			projectPath,
			adapterRoot,
		});
		const session = parseSession(value, appId, projectPath);
		setState(projectPath, {
			status: "running",
			ptyId: session.ptyId,
			error: null,
		});
		Logger.debug("ProjectAgentRuntime", "project agent PTY started", { appId });
	} catch (error) {
		const mapped = parseAgentError(error);
		Logger.debug("ProjectAgentRuntime", "project agent PTY start failed", {
			code: mapped.code,
		});
		setState(projectPath, { status: "error", error: mapped, ptyId: null });
	}
}

export async function attachProjectAgent(
	projectPath: string,
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
	setState(projectPath, { status: "connecting", error: null });
	try {
		await ensureEventListeners();
		const value = await invoke<unknown>("project_agent_pty_attach", {
			appId,
			projectPath,
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
				ptyId: null,
			});
			return;
		}
		setState(projectPath, { status: "running", error: null });
		Logger.debug("ProjectAgentRuntime", "project agent PTY reattached", {
			appId,
		});
	} catch (error) {
		const mapped = parseAgentError(error);
		Logger.debug("ProjectAgentRuntime", "project agent PTY reattach failed", {
			code: mapped.code,
		});
		setState(projectPath, {
			status: mapped.code === "session_missing" ? "idle" : "error",
			error: mapped.code === "session_missing" ? null : mapped,
			ptyId: null,
		});
	}
}

export async function writeProjectAgent(
	projectPath: string,
	appId: ProjectAgentAppId,
	data: string,
): Promise<void> {
	Logger.debug(
		"ProjectAgentRuntime",
		"writing terminal input to selected project PTY",
	);
	const state = stateFor(projectPath);
	if (
		!isProjectAgentAppId(appId) ||
		state.selectedAppId !== appId ||
		state.status !== "running" ||
		!state.ptyId
	) {
		Logger.debug(
			"ProjectAgentRuntime",
			"PTY input dropped because session ownership is not active",
		);
		return;
	}
	try {
		await invoke("project_agent_pty_write", { appId, projectPath, data });
	} catch (error) {
		const mapped = parseAgentError(error);
		Logger.debug("ProjectAgentRuntime", "PTY input request failed", {
			code: mapped.code,
		});
		setState(projectPath, { status: "error", error: mapped, ptyId: null });
	}
}

export async function resizeProjectAgent(
	projectPath: string,
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

export function resetProjectAgentRuntimeForTests(): void {
	Logger.debug("ProjectAgentRuntime", "resetting in-memory test state");
	statesByProject.clear();
	pathListeners.clear();
	availabilityByApp.clear();
	availabilityRequest = null;
	Logger.debug(
		"ProjectAgentRuntime",
		"native event listener lifecycle remains in the event module",
	);
}
