import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../../lib/logger";
import {
	PROJECT_AGENT_APPS,
	attachProjectAgent,
	getProjectAgentState,
	loadProjectAgentAvailability,
	resetProjectAgentRuntimeForTests,
	selectProjectAgent,
	startProjectAgent,
	subscribeProjectAgent,
	stopProjectAgent,
	writeProjectAgent,
} from "../project-agent-runtime";

const eventHandlers = vi.hoisted(
	() => new Map<string, (event: { payload: unknown }) => void>(),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(
		async (name: string, handler: (event: { payload: unknown }) => void) => {
			eventHandlers.set(name, handler);
			return vi.fn();
		},
	),
}));

const adapterRoot = "/fixture/adapter-root";
const projectA = "/fixture/adapter-root/projects/alpha";
const projectB = "/fixture/adapter-root/projects/beta";

describe("project agent runtime ownership", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers.clear();
		resetProjectAgentRuntimeForTests();
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "project_agent_availability") {
				return PROJECT_AGENT_APPS.map((appId) => ({ appId, available: true }));
			}
			if (
				command === "project_agent_pty_start" ||
				command === "project_agent_pty_attach"
			) {
				const typedArgs = args as { appId: string; projectPath: string };
				return {
					appId: typedArgs.appId,
					projectPath: typedArgs.projectPath,
					ptyId: `pty-${typedArgs.projectPath.split("/").at(-1)}`,
					running: true,
				};
			}
			return null;
		});
	});

	it("keeps app choices, output, input, and PTY identity separate for each project", async () => {
		const seenA: string[] = [];
		const seenB: string[] = [];
		const unsubscribeA = subscribeProjectAgent(projectA, (state) =>
			seenA.push(state.output),
		);
		const unsubscribeB = subscribeProjectAgent(projectB, (state) =>
			seenB.push(state.output),
		);
		await loadProjectAgentAvailability();
		await Promise.resolve();
		selectProjectAgent(projectA, "claude");
		selectProjectAgent(projectB, "codex");
		await startProjectAgent(projectA, adapterRoot, "claude");
		await startProjectAgent(projectB, adapterRoot, "codex");

		const outputHandler = eventHandlers.get("project-agent-pty-output");
		expect(outputHandler).toBeTypeOf("function");
		outputHandler?.({
			payload: {
				appId: "claude",
				projectPath: projectA,
				ptyId: "pty-alpha",
				data: "alpha output",
			},
		});
		expect(getProjectAgentState(projectA).output).toBe("alpha output");
		expect(getProjectAgentState(projectB).output).toBe("");
		expect(seenA.at(-1)).toBe("alpha output");
		expect(seenB.at(-1)).toBe("");

		await writeProjectAgent(projectB, adapterRoot, "codex", "beta input");
		await writeProjectAgent(
			projectA,
			adapterRoot,
			"codex",
			"cross-project input",
		);
		expect(invoke).toHaveBeenCalledWith("project_agent_pty_write", {
			appId: "codex",
			projectPath: projectB,
			adapterRoot,
			data: "beta input",
		});
		expect(
			vi
				.mocked(invoke)
				.mock.calls.filter(
					([command, args]) =>
						command === "project_agent_pty_write" &&
						(args as { projectPath?: string }).projectPath === projectA,
				),
		).toHaveLength(0);

		await attachProjectAgent(projectA, adapterRoot, "claude");
		expect(invoke).toHaveBeenCalledWith("project_agent_pty_attach", {
			appId: "claude",
			projectPath: projectA,
			adapterRoot,
		});
		unsubscribeA();
		unsubscribeB();

		resetProjectAgentRuntimeForTests();
		expect(getProjectAgentState(projectA)).toMatchObject({
			status: "idle",
			ptyId: null,
			selectedAppId: null,
		});
	});

	it("logs why terminal input is discarded without an active owner", async () => {
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});

		await writeProjectAgent(projectA, adapterRoot, "claude", "input");

		expect(warn).toHaveBeenCalledWith(
			"ProjectAgentRuntime",
			"PTY input was not sent",
			{ appId: "claude", reason: "app_not_selected" },
		);
		warn.mockRestore();
	});

	it("buffers starting input and sends it in order after the session is ready", async () => {
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "claude");
		let releaseStart: ((value: unknown) => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "project_agent_pty_start") {
				return new Promise((resolve) => {
					releaseStart = resolve;
				});
			}
			if (command === "project_agent_availability") {
				return PROJECT_AGENT_APPS.map((appId) => ({
					appId,
					available: true,
				}));
			}
			if (command === "project_agent_pty_attach") {
				const typedArgs = args as { appId: string; projectPath: string };
				return {
					appId: typedArgs.appId,
					projectPath: typedArgs.projectPath,
					ptyId: "pty-alpha",
					running: true,
				};
			}
			return null;
		});

		const starting = startProjectAgent(projectA, adapterRoot, "claude");
		for (let attempt = 0; attempt < 10 && !releaseStart; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		await writeProjectAgent(projectA, adapterRoot, "claude", "first\n");
		await writeProjectAgent(projectA, adapterRoot, "claude", "second\n");
		expect(
			vi.mocked(invoke).mock.calls.filter(
				([command]) => command === "project_agent_pty_write",
			),
		).toHaveLength(0);

		if (!releaseStart) throw new Error("PTY start request did not begin");
		releaseStart({
			appId: "claude",
			projectPath: projectA,
			ptyId: "pty-alpha",
			running: true,
		});
		await starting;

		const written = vi
			.mocked(invoke)
			.mock.calls.filter(([command]) => command === "project_agent_pty_write")
			.map(([, args]) => (args as { data: string }).data);
		expect(written).toEqual(["first\n", "second\n"]);
		expect(getProjectAgentState(projectA).status).toBe("running");
	});

	it("caps starting input at 64 KiB and reports overflow", async () => {
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "claude");
		let releaseStart: ((value: unknown) => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_start") {
				return new Promise((resolve) => {
					releaseStart = resolve;
				});
			}
			return null;
		});
		const starting = startProjectAgent(projectA, adapterRoot, "claude");
		for (let attempt = 0; attempt < 10 && !releaseStart; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		if (!releaseStart) throw new Error("PTY start request did not begin");
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});

		await writeProjectAgent(
			projectA,
			adapterRoot,
			"claude",
			"x".repeat(64 * 1024 + 1),
		);

		expect(warn).toHaveBeenCalledWith(
			"ProjectAgentRuntime",
			"PTY input was not queued",
			expect.objectContaining({
				reason: "startup_queue_limit",
				limitBytes: 64 * 1024,
			}),
		);
		expect(getProjectAgentState(projectA).inputError).toEqual({
			code: "input_failed",
		});
		releaseStart({
			appId: "claude",
			projectPath: projectA,
			ptyId: "pty-alpha",
			running: true,
		});
		await starting;
		expect(
			vi.mocked(invoke).mock.calls.filter(
				([command]) => command === "project_agent_pty_write",
			),
		).toHaveLength(0);
		warn.mockRestore();
	});

	it("shows and logs a native write failure instead of swallowing it", async () => {
		const error = vi.spyOn(Logger, "error").mockImplementation(() => {});
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "claude");
		await startProjectAgent(projectA, adapterRoot, "claude");
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "project_agent_pty_write")
				throw "write_failed:BrokenPipe";
			if (command === "project_agent_pty_start") {
				const typedArgs = args as { appId: string; projectPath: string };
				return {
					appId: typedArgs.appId,
					projectPath: typedArgs.projectPath,
					ptyId: "pty-alpha",
					running: true,
				};
			}
			return null;
		});

		await writeProjectAgent(projectA, adapterRoot, "claude", "input");

		expect(getProjectAgentState(projectA)).toMatchObject({
			status: "error",
			ptyId: null,
			error: { code: "input_failed" },
			inputError: { code: "input_failed" },
		});
		expect(error).toHaveBeenCalledWith(
			"ProjectAgentRuntime",
			"PTY input request failed",
			expect.objectContaining({ code: "write_failed:BrokenPipe" }),
		);
		error.mockRestore();
	});

	it("stops only the selected project's owned PTY and waits for its exit event", async () => {
		await loadProjectAgentAvailability();
		await Promise.resolve();
		selectProjectAgent(projectA, "muse");
		await startProjectAgent(projectA, adapterRoot, "muse");
		await stopProjectAgent(projectA, adapterRoot, "muse");

		expect(invoke).toHaveBeenCalledWith("project_agent_pty_stop", {
			appId: "muse",
			projectPath: projectA,
			adapterRoot,
		});
		expect(getProjectAgentState(projectA).status).toBe("stopping");
		eventHandlers.get("project-agent-pty-exit")?.({
			payload: {
				appId: "muse",
				projectPath: projectA,
				ptyId: "pty-alpha",
				exitCode: 0,
			},
		});
		expect(getProjectAgentState(projectA).status).toBe("exited");
	});
});
