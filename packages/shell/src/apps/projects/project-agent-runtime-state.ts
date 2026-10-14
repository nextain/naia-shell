import { Logger } from "../../lib/logger";
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

export const availabilityByApp = new Map<ProjectAgentAppId, boolean>();
export const statesByProject = new Map<string, ProjectAgentState>();
export const pathListeners = new Map<
	string,
	Set<(state: ProjectAgentState) => void>
>();

function emptyAvailability(): Record<ProjectAgentAppId, boolean | null> {
	Logger.debug("ProjectAgentRuntime", "creating unknown availability map");
	return { claude: null, codex: null, muse: null, opencode: null };
}

export function isProjectAgentAppId(
	value: unknown,
): value is ProjectAgentAppId {
	Logger.debug("ProjectAgentRuntime", "checking fixed app identifier");
	return (
		typeof value === "string" &&
		(PROJECT_AGENT_APPS as readonly string[]).includes(value)
	);
}

export function cloneState(state: ProjectAgentState): ProjectAgentState {
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

export function stateFor(projectPath: string): ProjectAgentState {
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

export function publish(projectPath: string): void {
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

export function setState(
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

export function parseAvailability(value: unknown): ProjectAgentAvailability[] {
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

export function parseSession(
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

export function parseAgentError(error: unknown): ProjectAgentError {
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
