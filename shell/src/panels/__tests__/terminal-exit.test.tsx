// @vitest-environment jsdom
/**
 * Phase 5 tests: Terminal exit notification + restart
 *
 * Verifies WorkspaceCenterPanel:
 *  1. Shows restart button when terminal process exits (not removed from DOM)
 *  2. Dead overlay appears instead of Terminal component after exit
 *  3. Clicking restart creates a new PTY in the same dir
 *  4. Restarted terminal replaces the exited one in-place (position preserved)
 *  5. Close button still removes the exited terminal normally
 *  6. Exited terminal does NOT block re-opening the same dir via Naia (after close)
 *  7. Duplicate open is blocked while exited tab is still visible
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NaiaContextBridge, PanelContext, ToolHandler } from "../../lib/panel-registry";
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

// Terminal mock: exposes onExit so tests can fire it
let capturedOnExit: Map<string, (pty_id: string) => void> = new Map();

vi.mock("../workspace/Terminal", () => ({
	Terminal: vi.fn(
		({
			pty_id,
			onExit,
		}: {
			pty_id: string;
			active: boolean;
			workingDir: string;
			onExit: (id: string) => void;
			onFileSelect: () => void;
		}) => {
			capturedOnExit.set(pty_id, onExit);
			return <div data-testid={`terminal-${pty_id}`} />;
		},
	),
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
			useEffect(() => { onSessionsUpdate?.([]) }, [onSessionsUpdate]);
			return null as unknown as React.ReactElement;
		},
	),
}));

// ─── MockBridge ───────────────────────────────────────────────────────────────

class MockBridge implements NaiaContextBridge {
	public contexts: PanelContext[] = [];
	private handlers = new Map<string, ToolHandler>();

	pushContext(ctx: PanelContext): void { this.contexts.push(ctx); }
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
	queryBehavior(): Promise<import("../../lib/panel-registry").BehaviorEntry[]> { return Promise.resolve([]); }
	getSecret(): Promise<string | null> { return Promise.resolve(null); }
	setSecret(): Promise<void> { return Promise.resolve(); }
	readFile(): Promise<string> { return Promise.resolve(""); }
	runShell(): Promise<import("../../lib/panel-registry").ShellResult> { return Promise.resolve({ stdout: "", stderr: "", code: 0 }); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let ptyCounter = 0;

function setupInvoke() {
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
			const name = dir.split(/[/\\]/).pop() ?? "term";
			return { pty_id: `pty-${name}-${ptyCounter}`, pid: 1000 + ptyCounter };
		}
		return [];
	});
}

async function openTerminal(bridge: MockBridge, dir: string): Promise<string> {
	await waitFor(() => expect(bridge.hasHandler("skill_workspace_new_session")).toBe(true));
	await bridge.callTool("skill_workspace_new_session", { dir });
	const name = dir.split(/[/\\]/).pop() ?? "term";
	return `pty-${name}-${ptyCounter}`;
}

function fireExit(ptyId: string): void {
	const cb = capturedOnExit.get(ptyId);
	if (!cb) throw new Error(`No onExit captured for ${ptyId}`);
	act(() => { cb(ptyId); });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Terminal exit notification — Phase 5", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setupInvoke();
		localStorage.clear();
		capturedOnExit = new Map();
	});

	afterEach(() => {
		cleanup();
		vi.resetModules();
		localStorage.clear();
	});

	it("shows dead overlay (not Terminal) after process exits", async () => {
		const { WorkspaceCenterPanel } = await import("../workspace/WorkspaceCenterPanel");
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		const ptyId = await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() => expect(screen.getByTestId(`terminal-${ptyId}`)).toBeInTheDocument());

		fireExit(ptyId);

		// Terminal component replaced by dead overlay
		await waitFor(() => {
			expect(screen.queryByTestId(`terminal-${ptyId}`)).toBeNull();
			expect(document.querySelector(".workspace-panel__terminal-dead")).toBeTruthy();
		});
	});

	it("shows restart button in dead overlay", async () => {
		const { WorkspaceCenterPanel } = await import("../workspace/WorkspaceCenterPanel");
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		const ptyId = await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() => expect(screen.getByTestId(`terminal-${ptyId}`)).toBeInTheDocument());

		fireExit(ptyId);

		await waitFor(() =>
			expect(document.querySelector(".workspace-panel__terminal-dead-restart")).toBeTruthy(),
		);
	});

	it("tab stays visible after exit (not removed)", async () => {
		const { WorkspaceCenterPanel } = await import("../workspace/WorkspaceCenterPanel");
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		const ptyId = await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() => expect(screen.getByTestId(`terminal-${ptyId}`)).toBeInTheDocument());

		fireExit(ptyId);

		// Tab label "alpha" still visible
		await waitFor(() => expect(screen.getAllByText("alpha")[0]).toBeInTheDocument());
	});

	it("restart button creates new PTY in the same dir", async () => {
		const { WorkspaceCenterPanel } = await import("../workspace/WorkspaceCenterPanel");
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		const ptyId = await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() => expect(screen.getByTestId(`terminal-${ptyId}`)).toBeInTheDocument());

		fireExit(ptyId);
		await waitFor(() =>
			expect(document.querySelector(".workspace-panel__terminal-dead-restart")).toBeTruthy(),
		);

		// Click restart
		await act(async () => {
			(document.querySelector(".workspace-panel__terminal-dead-restart") as HTMLButtonElement)?.click();
		});

		// New terminal appears (counter incremented to 2)
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-alpha-2")).toBeInTheDocument(),
		);
	});

	it("restarted terminal replaces the exited one in-place", async () => {
		const { WorkspaceCenterPanel } = await import("../workspace/WorkspaceCenterPanel");
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		const ptyId = await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() => expect(screen.getByTestId(`terminal-${ptyId}`)).toBeInTheDocument());

		fireExit(ptyId);
		await waitFor(() =>
			expect(document.querySelector(".workspace-panel__terminal-dead-restart")).toBeTruthy(),
		);

		await act(async () => {
			(document.querySelector(".workspace-panel__terminal-dead-restart") as HTMLButtonElement)?.click();
		});

		await waitFor(() => {
			// Dead overlay gone
			expect(document.querySelector(".workspace-panel__terminal-dead")).toBeNull();
			// New terminal present
			expect(screen.getByTestId("terminal-pty-alpha-2")).toBeInTheDocument();
		});
	});

	it("close button removes the exited terminal", async () => {
		const { WorkspaceCenterPanel } = await import("../workspace/WorkspaceCenterPanel");
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		const ptyId = await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() => expect(screen.getByTestId(`terminal-${ptyId}`)).toBeInTheDocument());

		fireExit(ptyId);
		await waitFor(() =>
			expect(document.querySelector(".workspace-panel__terminal-dead")).toBeTruthy(),
		);

		// Close the exited tab
		await act(async () => {
			const btn = document.querySelector<HTMLButtonElement>(
				`[aria-label="터미널 닫기: /tmp/alpha"]`,
			);
			btn?.click();
		});

		// Tab and dead overlay both gone
		await waitFor(() => {
			expect(document.querySelector(".workspace-panel__terminal-dead")).toBeNull();
			expect(screen.queryAllByText("alpha")).toHaveLength(0);
		});
	});

	it("blocks duplicate open while exited tab is visible", async () => {
		const { WorkspaceCenterPanel } = await import("../workspace/WorkspaceCenterPanel");
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		const ptyId = await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() => expect(screen.getByTestId(`terminal-${ptyId}`)).toBeInTheDocument());

		fireExit(ptyId);
		await waitFor(() =>
			expect(document.querySelector(".workspace-panel__terminal-dead")).toBeTruthy(),
		);

		// Try to open the same dir via Naia
		const result = await bridge.callTool("skill_workspace_new_session", { dir: "/tmp/alpha" });
		expect(result).toMatch(/Already open|already in progress/i);
	});
});
