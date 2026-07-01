// @vitest-environment jsdom
/**
 * Phase 3 tests: Session Persistence
 *
 * Verifies that WorkspaceCenterPanel:
 *  1. Saves terminal dirs to localStorage when terminals change
 *  2. Restores terminals from localStorage after workspace is ready
 *  3. Restores the previously active terminal as activeTab
 *  4. Skips dirs that fail pty_create (graceful degradation)
 *  5. Does NOT overwrite saved session before restore runs
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	EditorState: { create: () => ({}), readOnly: { of: () => ({}) } },
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
vi.mock("../workspace/Terminal", () => ({
	Terminal: vi.fn(({ pty_id }: { pty_id: string }) => (
		<div data-testid={`terminal-${pty_id}`} />
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

	pushContext(ctx: AppContext): void { this.contexts.push(ctx); }
	onToolCall(toolName: string, handler: ToolHandler): () => void {
		this.handlers.set(toolName, handler);
		return () => { this.handlers.delete(toolName); };
	}
	async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
		const handler = this.handlers.get(toolName);
		if (!handler) return `No handler: ${toolName}`;
		return (await handler(args)) ?? "ok";
	}
	hasHandler(toolName: string): boolean { return this.handlers.has(toolName); }
	logBehavior(): Promise<void> { return Promise.resolve(); }
	queryBehavior(): Promise<import("../../lib/app-registry").BehaviorEntry[]> {
		return Promise.resolve([]);
	}
	getSecret(): Promise<string | null> { return Promise.resolve(null); }
	setSecret(): Promise<void> { return Promise.resolve(); }
	readFile(): Promise<string> { return Promise.resolve(""); }
	runShell(): Promise<import("../../lib/app-registry").ShellResult> {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TERMINAL_SESSION_KEY = "workspace-terminal-session-v1";

let ptyCounter = 0;

function setupInvoke(opts: {
	failDirs?: string[];
} = {}) {
	ptyCounter = 0;
	mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === "workspace_set_root") return args?.root ?? "/tmp/test";
		if (cmd === "workspace_get_sessions") return [];
		if (cmd === "workspace_load_project_index") return null;
		if (cmd === "workspace_discover_skills") return [];
		if (cmd === "workspace_check_adk_server") return false;
		if (cmd === "workspace_discover_adk_server") return null;
		if (cmd === "workspace_get_git_info") return { branch: null };
		if (cmd === "workspace_get_pty_agents") return {};
		if (cmd === "pty_kill") return null;
		if (cmd === "pty_create") {
			ptyCounter++;
			const dir = String((args as Record<string, unknown>)?.dir ?? "/tmp");
			if (opts.failDirs?.includes(dir)) throw new Error("dir not found");
			const name = dir.split(/[/\\]/).pop() ?? "term";
			return { pty_id: `pty-${name}-${ptyCounter}`, pid: 1000 + ptyCounter };
		}
		return [];
	});
}

async function openTerminal(bridge: MockBridge, dir: string): Promise<void> {
	await waitFor(() =>
		expect(bridge.hasHandler("skill_workspace_new_session")).toBe(true),
	);
	await bridge.callTool("skill_workspace_new_session", { dir });
}

function saveSession(dirs: string[], activeDir?: string): void {
	localStorage.setItem(
		TERMINAL_SESSION_KEY,
		JSON.stringify({ dirs, activeDir }),
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Session Persistence — Phase 3", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setupInvoke();
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
		vi.resetModules();
		localStorage.clear();
	});

	it("saves terminal dirs to localStorage when a terminal is opened", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-alpha-1")).toBeInTheDocument(),
		);

		// Session should now be saved
		await waitFor(() => {
			const raw = localStorage.getItem(TERMINAL_SESSION_KEY);
			expect(raw).not.toBeNull();
			const session = JSON.parse(raw!) as { dirs: string[] };
			expect(session.dirs).toContain("/tmp/alpha");
		});
	});

	it("saves activeDir when switching between terminals", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		await openTerminal(bridge, "/tmp/beta");

		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-beta-2")).toBeInTheDocument(),
		);

		// beta was opened last → it's the active terminal
		await waitFor(() => {
			const raw = localStorage.getItem(TERMINAL_SESSION_KEY);
			expect(raw).not.toBeNull();
			const session = JSON.parse(raw!) as { dirs: string[]; activeDir?: string };
			expect(session.dirs).toEqual(["/tmp/alpha", "/tmp/beta"]);
			expect(session.activeDir).toBe("/tmp/beta");
		});
	});

	it("restores terminals from localStorage after workspace is ready", async () => {
		saveSession(["/tmp/alpha", "/tmp/beta"]);

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		// Both terminals must appear without any manual tool call
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-alpha-1")).toBeInTheDocument(),
		);
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-beta-2")).toBeInTheDocument(),
		);
	});

	it("restores the previously active terminal as the focused tab", async () => {
		saveSession(["/tmp/alpha", "/tmp/beta"], "/tmp/beta");

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-beta-2")).toBeInTheDocument(),
		);

		// beta should be the active tab — its tab label visible (not in grid yet, single tab shown)
		await waitFor(() =>
			expect(screen.getAllByText("beta")[0]).toBeInTheDocument(),
		);
	});

	it("skips dirs that fail pty_create without crashing", async () => {
		saveSession(["/tmp/gone", "/tmp/alpha"]);
		setupInvoke({ failDirs: ["/tmp/gone"] });

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		// /tmp/alpha should still be restored despite /tmp/gone failing
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-alpha-2")).toBeInTheDocument(),
		);
		// /tmp/gone terminal must NOT appear
		expect(screen.queryByTestId("terminal-pty-gone-1")).toBeNull();
	});

	it("does not save an empty session before restore runs", async () => {
		saveSession(["/tmp/alpha"]);

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		// Immediately after mount (before restore completes), the saved session
		// must NOT have been overwritten with an empty dirs array
		const raw = localStorage.getItem(TERMINAL_SESSION_KEY);
		if (raw) {
			const session = JSON.parse(raw) as { dirs: string[] };
			// Either it's the original session or it was overwritten with the restored state
			// — it must never be an empty dirs array at this point
			expect(session.dirs.length).toBeGreaterThan(0);
		}

		// After restore completes, terminal should appear
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-alpha-1")).toBeInTheDocument(),
		);
	});

	it("removes a terminal dir from saved session when terminal is closed", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		await openTerminal(bridge, "/tmp/beta");
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-beta-2")).toBeInTheDocument(),
		);

		// Close beta via the close button in the tab bar
		await act(async () => {
			const closeBtn = document.querySelector<HTMLButtonElement>(
				`[aria-label="터미널 닫기: /tmp/beta"]`,
			);
			closeBtn?.click();
		});

		await waitFor(() => {
			const raw = localStorage.getItem(TERMINAL_SESSION_KEY);
			expect(raw).not.toBeNull();
			const session = JSON.parse(raw!) as { dirs: string[] };
			expect(session.dirs).not.toContain("/tmp/beta");
			expect(session.dirs).toContain("/tmp/alpha");
		});
	});
});
