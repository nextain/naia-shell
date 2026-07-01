// @vitest-environment jsdom
/**
 * Step 5 tests: process-name → agent auto-detection polling
 *
 * Tests that WorkspaceCenterPanel:
 *  1. Calls workspace_get_pty_agents (batch) every 5s with all open terminal PIDs
 *  2. Updates terminal.agent when the detected agent changes
 *  3. Clears terminal.agent when detection returns no entry for that pid
 *  4. Ignores unknown agent names (runtime validation via VALID_AGENTS set)
 *  5. Handles Rust command failure gracefully (no crash)
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { useEffect } from "react";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { NaiaContextBridge, AppContext, ToolHandler } from "../../lib/app-registry";
import type { SessionInfo } from "../workspace/SessionCard";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../lib/config", () => ({
	loadConfig: vi.fn().mockReturnValue({
		workspaceRoot: "/tmp/test",
		provider: "gemini",
		model: "gemini-2.5-flash",
		apiKey: "",
	}),
	saveConfig: vi.fn(),
}));

vi.mock("@codemirror/view", () => ({
	EditorView: class {
		destroy() {}
		state = { doc: { toString: () => "" } };
		dispatch() {}
		static lineWrapping = {};
		static updateListener = { of: () => ({}) };
	},
	keymap: { of: () => ({}) },
	lineNumbers: () => ({}),
}));

vi.mock("@codemirror/state", () => ({
	EditorState: {
		create: () => ({}),
		readOnly: { of: () => ({}) },
	},
	Transaction: { addToHistory: { of: () => ({}) } },
}));

vi.mock("@codemirror/commands", () => ({
	defaultKeymap: [],
	history: () => ({}),
	historyKeymap: [],
}));

vi.mock("@codemirror/lang-javascript", () => ({ javascript: () => ({}) }));
vi.mock("@codemirror/lang-markdown", () => ({ markdown: () => ({}) }));
vi.mock("@codemirror/theme-one-dark", () => ({ oneDark: {} }));

vi.mock("react-markdown", () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="md-preview">{children}</div>
	),
}));

// Mock Terminal — avoids xterm.js canvas + ResizeObserver which are unavailable in jsdom
vi.mock("../workspace/Terminal", () => ({
	Terminal: vi.fn(({ ptyId }: { ptyId: string }) => (
		<div data-testid={`terminal-${ptyId}`} />
	)),
}));

vi.mock("../workspace/IssuesPanel", () => ({
	IssuesPanel: vi.fn(
		({
			onSessionsUpdate,
		}: {
			onSessionsUpdate?: (sessions: SessionInfo[]) => void;
			onSessionClick: (session: SessionInfo) => void;
			highlightedDir?: string;
			onIssueClick?: (issue: unknown) => void;
		}) => {
			useEffect(() => {
				onSessionsUpdate?.([]);
			}, [onSessionsUpdate]);
			return null as unknown as React.ReactElement;
		},
	),
}));

// ─── MockBridge ───────────────────────────────────────────────────────────────

class MockBridge implements NaiaContextBridge {
	public contexts: AppContext[] = [];
	private handlers = new Map<string, ToolHandler>();

	pushContext(ctx: AppContext): void {
		this.contexts.push(ctx);
	}

	onToolCall(toolName: string, handler: ToolHandler): () => void {
		this.handlers.set(toolName, handler);
		return () => { this.handlers.delete(toolName); };
	}

	async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
		const handler = this.handlers.get(toolName);
		if (!handler) return `No handler: ${toolName}`;
		const result = await handler(args);
		return result ?? "ok";
	}

	hasHandler(toolName: string): boolean {
		return this.handlers.has(toolName);
	}

	logBehavior(_event: string, _data?: Record<string, unknown>): Promise<void> {
		return Promise.resolve();
	}
	queryBehavior(): Promise<import("../../lib/app-registry").BehaviorEntry[]> {
		return Promise.resolve([]);
	}
	getSecret(_key: string): Promise<string | null> {
		return Promise.resolve(null);
	}
	setSecret(_key: string, _value: string): Promise<void> {
		return Promise.resolve();
	}
	readFile(_path: string): Promise<string> {
		return Promise.resolve("");
	}
	runShell(
		_cmd: string,
		_args?: string[],
	): Promise<import("../../lib/app-registry").ShellResult> {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Default invoke responses.
 * workspace_get_pty_agents returns Record<pid, agentName> — empty means no agent.
 */
function setupDefaultInvoke({
	agentMap = {},
	ptcPid = 9999,
}: {
	agentMap?: Record<number, string>;
	ptcPid?: number;
} = {}) {
	mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === "workspace_set_root") return args?.root ?? "/tmp/test";
		if (cmd === "workspace_get_sessions") return [];
		if (cmd === "workspace_load_project_index") return null;
		if (cmd === "workspace_discover_skills") return [];
		if (cmd === "workspace_check_adk_server") return false;
		if (cmd === "workspace_discover_adk_server") return null;
		if (cmd === "pty_create") return { pty_id: "pty-test", pid: ptcPid };
		if (cmd === "workspace_get_git_info") return { branch: "issue-42" };
		if (cmd === "workspace_get_pty_agents") return agentMap;
		return [];
	});
}

/** Open a terminal via the Naia bridge tool */
async function openTerminal(bridge: MockBridge, dir = "/tmp/test-dir"): Promise<void> {
	await waitFor(() =>
		expect(bridge.hasHandler("skill_workspace_new_session")).toBe(true),
	);
	await bridge.callTool("skill_workspace_new_session", { dir });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("agent polling — workspace_get_pty_agents (batch)", () => {
	beforeEach(() => {
		// shouldAdvanceTime: true keeps real clock ticking so waitFor retries still work
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		cleanup();
		vi.resetModules();
	});

	it("calls workspace_get_pty_agents with all open terminal PIDs every 5s", async () => {
		setupDefaultInvoke({ ptcPid: 1111 });

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge);

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("pty_create", expect.anything()),
		);

		mockInvoke.mockClear();

		await act(async () => { vi.advanceTimersByTime(5001); });

		expect(mockInvoke).toHaveBeenCalledWith(
			"workspace_get_pty_agents",
			{ pids: [1111] },
		);
	});

	it("updates terminal.agent when batch result contains the pid", async () => {
		setupDefaultInvoke({ agentMap: { 2222: "claude" }, ptcPid: 2222 });

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge);
		await waitFor(() => expect(screen.getAllByText("test-dir")[0]).toBeInTheDocument());

		await act(async () => { vi.advanceTimersByTime(5001); });

		await waitFor(() => expect(screen.getAllByText("claude")[0]).toBeInTheDocument());
	});

	it("clears terminal.agent when pid is absent from batch result", async () => {
		let callCount = 0;
		mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === "workspace_set_root") return args?.root ?? "/tmp/test";
			if (cmd === "workspace_get_sessions") return [];
			if (cmd === "workspace_load_project_index") return null;
			if (cmd === "workspace_discover_skills") return [];
			if (cmd === "workspace_check_adk_server") return false;
			if (cmd === "workspace_discover_adk_server") return null;
			if (cmd === "pty_create") return { pty_id: "pty-clear", pid: 3333 };
			if (cmd === "workspace_get_git_info") return { branch: null };
			if (cmd === "workspace_get_pty_agents") {
				callCount++;
				// First poll: found, second poll: not found (empty map)
				return callCount === 1 ? { 3333: "opencode" } : {};
			}
			return [];
		});

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge, "/tmp/test-dir");
		await waitFor(() => expect(screen.getAllByText("test-dir")[0]).toBeInTheDocument());

		// First poll: badge appears
		await act(async () => { vi.advanceTimersByTime(5001); });
		await waitFor(() => expect(screen.getAllByText("opencode")[0]).toBeInTheDocument());

		// Second poll: pid absent → badge cleared
		await act(async () => { vi.advanceTimersByTime(5001); });
		await waitFor(() => expect((screen.queryAllByText("opencode")[0] ?? null)).toBeNull());
	});

	it("ignores unknown agent names returned by Rust (runtime validation)", async () => {
		// Rust returns an unrecognized name — should NOT render as a badge
		setupDefaultInvoke({
			agentMap: { 4444: "unknown-future-agent" },
			ptcPid: 4444,
		});

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge);
		await waitFor(() => expect(screen.getAllByText("test-dir")[0]).toBeInTheDocument());

		await act(async () => { vi.advanceTimersByTime(5001); });

		// Unknown name must NOT appear as a badge
		await waitFor(() =>
			expect(screen.queryByText("unknown-future-agent")).toBeNull(),
		);
		// Tab still present
		expect(screen.getAllByText("test-dir")[0]).toBeInTheDocument();
	});

	it("all valid AgentType values are recognized and displayed as badge", async () => {
		const agents = ["claude", "opencode", "codex", "gemini"] as const;

		for (const agent of agents) {
			vi.resetModules();
			mockInvoke.mockClear();
			setupDefaultInvoke({ agentMap: { 5000: agent }, ptcPid: 5000 });

			const { WorkspaceCenterPanel } = await import(
				"../workspace/WorkspaceCenterPanel"
			);
			const bridge = new MockBridge();
			const { unmount } = render(<WorkspaceCenterPanel naia={bridge} />);

			await openTerminal(bridge);
			await waitFor(() => expect(screen.getAllByText("test-dir")[0]).toBeInTheDocument());

			await act(async () => { vi.advanceTimersByTime(5001); });
			await waitFor(() => expect(screen.getAllByText(agent)[0]).toBeInTheDocument());

			unmount();
			cleanup();
		}
	});

	it("handles workspace_get_pty_agents failure gracefully (no crash)", async () => {
		mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === "workspace_set_root") return args?.root ?? "/tmp/test";
			if (cmd === "workspace_get_sessions") return [];
			if (cmd === "workspace_load_project_index") return null;
			if (cmd === "workspace_discover_skills") return [];
			if (cmd === "workspace_check_adk_server") return false;
			if (cmd === "workspace_discover_adk_server") return null;
			if (cmd === "pty_create") return { pty_id: "pty-err", pid: 6666 };
			if (cmd === "workspace_get_git_info") return { branch: null };
			if (cmd === "workspace_get_pty_agents") throw new Error("sysinfo unavailable");
			return [];
		});

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge);
		await waitFor(() => expect(screen.getAllByText("test-dir")[0]).toBeInTheDocument());

		// Should NOT throw
		await act(async () => { vi.advanceTimersByTime(5001); });

		expect(screen.getAllByText("test-dir")[0]).toBeInTheDocument();
		expect(screen.queryByText(/claude|opencode|codex|gemini/)).toBeNull();
	});
});
