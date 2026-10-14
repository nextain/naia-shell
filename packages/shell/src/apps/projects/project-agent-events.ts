import { listen } from "@tauri-apps/api/event";
import { Logger } from "../../lib/logger";
import type {
	ProjectAgentAppId,
	ProjectAgentState,
} from "./project-agent-runtime";
import { normalizeProjectPath } from "./project-session";

const MAX_OUTPUT_CHARS = 100_000;
let eventSetup: Promise<void> | null = null;

export interface ProjectAgentEventTarget {
	isAppId(value: unknown): value is ProjectAgentAppId;
	getState(projectKey: string): ProjectAgentState | undefined;
	publish(projectPath: string): void;
}

function isPayload(value: unknown): value is Record<string, unknown> {
	Logger.debug("ProjectAgentEvents", "checking PTY event payload shape");
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Register project-owned PTY listeners once and route events by normalized project path. */
export function ensureProjectAgentEventListeners(
	target: ProjectAgentEventTarget,
): Promise<void> {
	Logger.debug("ProjectAgentEvents", "ensuring project PTY event listeners");
	if (eventSetup) return eventSetup;
	eventSetup = Promise.all([
		listen<unknown>("project-agent-pty-output", (event) => {
			Logger.debug("ProjectAgentEvents", "received project PTY output event");
			const payload = event.payload;
			if (
				!isPayload(payload) ||
				!target.isAppId(payload.appId) ||
				typeof payload.projectPath !== "string" ||
				typeof payload.ptyId !== "string" ||
				typeof payload.data !== "string"
			) {
				Logger.debug(
					"ProjectAgentEvents",
					"ignoring malformed PTY output event",
				);
				return;
			}
			const projectKey = normalizeProjectPath(payload.projectPath);
			const state = target.getState(projectKey);
			if (!state || state.selectedAppId !== payload.appId) {
				Logger.debug(
					"ProjectAgentEvents",
					"ignoring output for an inactive project session",
				);
				return;
			}
			if (
				(state.ptyId && state.ptyId !== payload.ptyId) ||
				(!state.ptyId &&
					state.status !== "starting" &&
					state.status !== "connecting")
			) {
				Logger.debug(
					"ProjectAgentEvents",
					"ignoring output from a different PTY identity",
				);
				return;
			}
			state.ptyId = payload.ptyId;
			if (state.status !== "stopping") state.status = "running";
			state.error = null;
			state.output = `${state.output}${payload.data}`.slice(-MAX_OUTPUT_CHARS);
			target.publish(payload.projectPath);
		}),
		listen<unknown>("project-agent-pty-exit", (event) => {
			Logger.debug("ProjectAgentEvents", "received project PTY exit event");
			const payload = event.payload;
			if (
				!isPayload(payload) ||
				!target.isAppId(payload.appId) ||
				typeof payload.projectPath !== "string" ||
				typeof payload.ptyId !== "string" ||
				(payload.exitCode !== null && typeof payload.exitCode !== "number")
			) {
				Logger.debug("ProjectAgentEvents", "ignoring malformed PTY exit event");
				return;
			}
			const projectKey = normalizeProjectPath(payload.projectPath);
			const state = target.getState(projectKey);
			if (
				!state ||
				state.selectedAppId !== payload.appId ||
				state.ptyId !== payload.ptyId
			) {
				Logger.debug(
					"ProjectAgentEvents",
					"ignoring exit for an unrelated PTY session",
				);
				return;
			}
			state.status = "exited";
			state.exitCode = payload.exitCode;
			state.ptyId = null;
			target.publish(payload.projectPath);
		}),
	])
		.then(() => {
			Logger.debug(
				"ProjectAgentEvents",
				"registered project PTY event listeners",
			);
		})
		.catch((error) => {
			eventSetup = null;
			Logger.debug(
				"ProjectAgentEvents",
				"project PTY listeners could not be registered",
			);
			throw error;
		});
	return eventSetup;
}

export function resetProjectAgentEventListenersForTests(): void {
	Logger.debug("ProjectAgentEvents", "resetting cached test listener setup");
	eventSetup = null;
}
