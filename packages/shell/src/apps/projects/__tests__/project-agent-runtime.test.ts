import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../../lib/logger";
import {
	PROJECT_AGENT_APPS,
	attachProjectAgent,
	getProjectAgentState,
	loadProjectAgentAvailability,
	resetProjectAgentRuntimeForTests,
	selectProjectAgent,
	startProjectAgent,
	stopOpenCodeProjectAgentSessions,
	stopProjectAgent,
	subscribeProjectAgent,
	waitForProjectAgentStopped,
	writeProjectAgent,
} from "../project-agent-runtime";

const eventHandlers = vi.hoisted(
	() => new Map<string, (event: { payload: unknown }) => void>(),
);

const opencodeConfigMocks = vi.hoisted(() => ({
	loadConfig: vi.fn(() => ({})),
	effectiveMainRole: vi.fn(() => ({
		provider: "nextain",
		model: "solar-pro4",
	})),
	selectOpenCodeNaiaModel: vi.fn(() => "solar-pro4"),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../../../lib/config", () => ({
	LAB_GATEWAY_URL: "https://api.nextain.io",
	loadConfig: opencodeConfigMocks.loadConfig,
}));
vi.mock("../../../lib/slots/model", () => ({
	effectiveMainRole: opencodeConfigMocks.effectiveMainRole,
}));
vi.mock("../../../lib/llm/registry", () => ({
	selectOpenCodeNaiaModel: opencodeConfigMocks.selectOpenCodeNaiaModel,
}));
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
		opencodeConfigMocks.loadConfig.mockReturnValue({});
		opencodeConfigMocks.effectiveMainRole.mockReturnValue({
			provider: "nextain",
			model: "solar-pro4",
		});
		opencodeConfigMocks.selectOpenCodeNaiaModel.mockReturnValue("solar-pro4");
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
	afterEach(() => {
		vi.useRealTimers();
	});

	it("passes cached Naia selection context only to OpenCode and stops only OpenCode on credential changes", async () => {
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "opencode");
		selectProjectAgent(projectB, "codex");
		await startProjectAgent(projectA, adapterRoot, "opencode");
		await startProjectAgent(projectB, adapterRoot, "codex");

		expect(invoke).toHaveBeenCalledWith("project_agent_pty_start", {
			appId: "opencode",
			projectPath: projectA,
			adapterRoot,
			naiaGatewayUrl: "https://api.nextain.io",
			naiaModelProvider: "nextain",
			naiaModel: "solar-pro4",
		});
		expect(invoke).toHaveBeenCalledWith("project_agent_pty_start", {
			appId: "codex",
			projectPath: projectB,
			adapterRoot,
		});

		await stopOpenCodeProjectAgentSessions();
		expect(invoke).toHaveBeenCalledWith("project_agent_pty_stop", {
			appId: "opencode",
			projectPath: projectA,
			adapterRoot,
		});
		expect(
			vi
				.mocked(invoke)
				.mock.calls.filter(
					([command, args]) =>
						command === "project_agent_pty_stop" &&
						(args as { appId?: string }).appId === "codex",
				),
		).toHaveLength(0);
	});

	it("retries transient PTY attach errors until the status deadline", async () => {
		vi.useFakeTimers();
		let attachAttempts = 0;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_attach") {
				attachAttempts += 1;
				if (attachAttempts === 1) throw new Error("ipc_unavailable");
				return { running: false };
			}
			return null;
		});

		const stopped = waitForProjectAgentStopped(
			projectA,
			adapterRoot,
			"opencode",
			{
				timeoutMs: 100,
				intervalMs: 10,
			},
		);
		await vi.advanceTimersByTimeAsync(10);
		await expect(stopped).resolves.toBe(true);
		expect(attachAttempts).toBe(2);
	});

	it("restores running when repeated PTY attach errors make status unknown", async () => {
		vi.useFakeTimers();
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "opencode");
		await startProjectAgent(projectA, adapterRoot, "opencode");
		await stopProjectAgent(projectA, adapterRoot, "opencode");
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_attach") {
				throw new Error("ipc_unavailable");
			}
			return null;
		});

		const status = waitForProjectAgentStopped(
			projectA,
			adapterRoot,
			"opencode",
			{
				timeoutMs: 25,
				intervalMs: 10,
			},
		);
		await vi.advanceTimersByTimeAsync(30);
		await expect(status).resolves.toBe("unknown");
		expect(getProjectAgentState(projectA).status).toBe("running");
	});

	it("reports unknown only after the PTY status deadline", async () => {
		vi.useFakeTimers();
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_attach") {
				throw new Error("ipc_unavailable");
			}
			return null;
		});

		const status = waitForProjectAgentStopped(
			projectA,
			adapterRoot,
			"opencode",
			{
				timeoutMs: 20,
				intervalMs: 5,
			},
		);
		await vi.advanceTimersByTimeAsync(21);
		await expect(status).resolves.toBe("unknown");
		expect(
			vi
				.mocked(invoke)
				.mock.calls.filter(
					([command]) => command === "project_agent_pty_attach",
				),
		).toHaveLength(5);
		expect(invoke).toHaveBeenCalledWith("project_agent_pty_attach", {
			appId: "opencode",
			projectPath: projectA,
			adapterRoot,
		});
	});

	it("waits for an OpenCode start in flight before a Naia credential change completes", async () => {
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "opencode");
		let releaseStart: ((value: unknown) => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_start") {
				return new Promise((resolve) => {
					releaseStart = resolve;
				});
			}
			if (command === "project_agent_availability") {
				return PROJECT_AGENT_APPS.map((appId) => ({ appId, available: true }));
			}
			return null;
		});

		const starting = startProjectAgent(projectA, adapterRoot, "opencode");
		for (let attempt = 0; attempt < 10 && !releaseStart; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		if (!releaseStart) throw new Error("OpenCode start request did not begin");
		let credentialChangeFinished = false;
		const changingCredential = stopOpenCodeProjectAgentSessions().then(() => {
			credentialChangeFinished = true;
		});
		await Promise.resolve();
		expect(credentialChangeFinished).toBe(false);

		releaseStart({
			appId: "opencode",
			projectPath: projectA,
			ptyId: "pty-alpha",
			running: true,
			naiaLoginRequired: false,
		});
		await Promise.all([starting, changingCredential]);
		expect(credentialChangeFinished).toBe(true);
		expect(invoke).toHaveBeenCalledWith("project_agent_pty_stop", {
			appId: "opencode",
			projectPath: projectA,
			adapterRoot,
		});
	});

	it("waits for an OpenCode attach in flight before a Naia credential change completes", async () => {
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "opencode");
		await startProjectAgent(projectA, adapterRoot, "opencode");
		const ptyId = getProjectAgentState(projectA).ptyId;
		if (!ptyId) throw new Error("OpenCode start did not return a PTY identity");

		let releaseAttach: ((value: unknown) => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_attach") {
				return new Promise((resolve) => {
					releaseAttach = resolve;
				});
			}
			return null;
		});

		const attaching = attachProjectAgent(projectA, adapterRoot, "opencode");
		for (let attempt = 0; attempt < 10 && !releaseAttach; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		if (!releaseAttach)
			throw new Error("OpenCode attach request did not begin");
		let credentialChangeFinished = false;
		const changingCredential = stopOpenCodeProjectAgentSessions().then(() => {
			credentialChangeFinished = true;
		});
		await Promise.resolve();
		expect(credentialChangeFinished).toBe(false);

		releaseAttach({
			appId: "opencode",
			projectPath: projectA,
			ptyId,
			running: true,
			naiaLoginRequired: false,
		});
		await Promise.all([attaching, changingCredential]);
		expect(credentialChangeFinished).toBe(true);
		expect(invoke).toHaveBeenCalledWith("project_agent_pty_stop", {
			appId: "opencode",
			projectPath: projectA,
			adapterRoot,
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
			vi
				.mocked(invoke)
				.mock.calls.filter(
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
			vi
				.mocked(invoke)
				.mock.calls.filter(
					([command]) => command === "project_agent_pty_write",
				),
		).toHaveLength(0);
		expect(getProjectAgentState(projectA).inputError).toBeNull();
		warn.mockRestore();
	});

	it("uses the latest adapter root when reusing a queued input drain", async () => {
		const nextAdapterRoot = "/fixture/next-adapter-root";
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "claude");
		await startProjectAgent(projectA, adapterRoot, "claude");
		let releaseFirstWrite: (() => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "project_agent_pty_write") {
				const data = (args as { data: string }).data;
				if (data === "first\n") {
					return new Promise((resolve) => {
						releaseFirstWrite = () => resolve(null);
					});
				}
			}
			return null;
		});

		const firstWrite = writeProjectAgent(
			projectA,
			adapterRoot,
			"claude",
			"first\n",
		);
		for (let attempt = 0; attempt < 10 && !releaseFirstWrite; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const secondWrite = writeProjectAgent(
			projectA,
			nextAdapterRoot,
			"claude",
			"second\n",
		);
		if (!releaseFirstWrite) throw new Error("PTY write did not begin");
		releaseFirstWrite();
		await Promise.all([firstWrite, secondWrite]);

		const writes = vi
			.mocked(invoke)
			.mock.calls.filter(([command]) => command === "project_agent_pty_write")
			.map(([, args]) => (args as { adapterRoot: string }).adapterRoot);
		expect(writes).toEqual([adapterRoot, nextAdapterRoot]);
	});

	it("buffers input while attaching and drains it after reconnect", async () => {
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "claude");
		await startProjectAgent(projectA, adapterRoot, "claude");
		let releaseAttach: ((value: unknown) => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_attach") {
				return new Promise((resolve) => {
					releaseAttach = resolve;
				});
			}
			return null;
		});

		const attaching = attachProjectAgent(projectA, adapterRoot, "claude");
		for (let attempt = 0; attempt < 10 && !releaseAttach; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		await writeProjectAgent(
			projectA,
			adapterRoot,
			"claude",
			"during reconnect\n",
		);
		expect(
			vi
				.mocked(invoke)
				.mock.calls.filter(
					([command]) => command === "project_agent_pty_write",
				),
		).toHaveLength(0);

		if (!releaseAttach) throw new Error("PTY attach request did not begin");
		releaseAttach({
			appId: "claude",
			projectPath: projectA,
			ptyId: "pty-alpha",
			running: true,
		});
		await attaching;

		expect(invoke).toHaveBeenCalledWith("project_agent_pty_write", {
			appId: "claude",
			projectPath: projectA,
			adapterRoot,
			data: "during reconnect\n",
		});
		expect(getProjectAgentState(projectA).status).toBe("running");
	});

	it("applies the 64 KiB queue limit while reconnecting", async () => {
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "claude");
		await startProjectAgent(projectA, adapterRoot, "claude");
		let releaseAttach: ((value: unknown) => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_attach") {
				return new Promise((resolve) => {
					releaseAttach = resolve;
				});
			}
			return null;
		});
		const attaching = attachProjectAgent(projectA, adapterRoot, "claude");
		for (let attempt = 0; attempt < 10 && !releaseAttach; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		if (!releaseAttach) throw new Error("PTY attach request did not begin");
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
		releaseAttach({
			appId: "claude",
			projectPath: projectA,
			ptyId: "pty-alpha",
			running: true,
		});
		await attaching;
		expect(getProjectAgentState(projectA).inputError).toBeNull();
		warn.mockRestore();
	});

	it("clears an overflow banner after a pending input drain succeeds", async () => {
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "claude");
		await startProjectAgent(projectA, adapterRoot, "claude");
		let releaseWrite: (() => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_write") {
				return new Promise((resolve) => {
					releaseWrite = () => resolve(null);
				});
			}
			return null;
		});
		const firstWrite = writeProjectAgent(
			projectA,
			adapterRoot,
			"claude",
			"queued\n",
		);
		for (let attempt = 0; attempt < 10 && !releaseWrite; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		if (!releaseWrite) throw new Error("PTY write did not begin");
		await writeProjectAgent(
			projectA,
			adapterRoot,
			"claude",
			"x".repeat(64 * 1024),
		);
		expect(getProjectAgentState(projectA).inputError).toEqual({
			code: "input_failed",
		});

		releaseWrite();
		await firstWrite;
		expect(getProjectAgentState(projectA).inputError).toBeNull();
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

	it("clears a failed input banner when selecting a different agent", async () => {
		await loadProjectAgentAvailability();
		selectProjectAgent(projectA, "claude");
		await startProjectAgent(projectA, adapterRoot, "claude");
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_agent_pty_write")
				throw "write_failed:BrokenPipe";
			return null;
		});

		await writeProjectAgent(projectA, adapterRoot, "claude", "input");
		expect(getProjectAgentState(projectA).inputError).toEqual({
			code: "input_failed",
		});

		selectProjectAgent(projectA, "codex");

		expect(getProjectAgentState(projectA)).toMatchObject({
			selectedAppId: "codex",
			status: "idle",
			inputError: null,
		});
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
