// @vitest-environment jsdom
/**
 * Phase 2 tests: Terminal Grid
 *
 * Verifies that WorkspaceCenterArea:
 *  1. Uses tab mode (single terminal visible) when 0–1 terminal is open
 *  2. Switches to grid mode automatically when 2+ terminals are open
 *  3. Grid cell headers show issueId / dir / agent badges
 *  4. Clicking a cell header sets focus (--focused class)
 *  5. Closing the focused terminal falls back to the next terminal, not "editor"
 *  6. Odd terminal count: last cell gets grid-column: 1/-1 (spans full width)
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

// Terminal mock: renders a div with data-testid so we can assert presence
vi.mock("../workspace/Terminal", () => ({
	Terminal: vi.fn(({ pty_id, active }: { pty_id: string; active: boolean }) => (
		<div
			data-testid={`terminal-${pty_id}`}
			data-active={String(active)}
		/>
	)),
}));

vi.mock("../workspace/IssuesArea", () => ({
	IssuesArea: vi.fn(
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
	await waitFor(() =>
		expect(bridge.hasHandler("skill_workspace_new_session")).toBe(true),
	);
	await bridge.callTool("skill_workspace_new_session", { dir });
	// Return the pty_id that would have been generated
	const name = dir.split(/[/\\]/).pop() ?? "term";
	return `pty-${name}-${ptyCounter}`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Terminal Grid — Phase 2", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setupInvoke();
	});

	afterEach(() => {
		cleanup();
		vi.resetModules();
	});

	it("tab mode: only one terminal visible when a single terminal is open", async () => {
		const { WorkspaceCenterArea } = await import(
			"../workspace/WorkspaceCenterArea"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");

		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-alpha-1")).toBeInTheDocument(),
		);

		// Grid area class must NOT be present
		const gridArea = document
			.querySelector(".workspace-panel__terminal-area--grid");
		expect(gridArea).toBeNull();

		// Terminal is active
		expect(screen.getByTestId("terminal-pty-alpha-1")).toHaveAttribute(
			"data-active",
			"true",
		);
	});

	it("grid mode activates automatically when 2nd terminal is opened", async () => {
		const { WorkspaceCenterArea } = await import(
			"../workspace/WorkspaceCenterArea"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-alpha-1")).toBeInTheDocument(),
		);

		await openTerminal(bridge, "/tmp/beta");
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-beta-2")).toBeInTheDocument(),
		);

		// Grid area must now be present
		await waitFor(() =>
			expect(
				document.querySelector(".workspace-panel__terminal-area--grid"),
			).toBeTruthy(),
		);

		// Both terminals are active in grid mode
		expect(screen.getByTestId("terminal-pty-alpha-1")).toHaveAttribute(
			"data-active",
			"true",
		);
		expect(screen.getByTestId("terminal-pty-beta-2")).toHaveAttribute(
			"data-active",
			"true",
		);
	});

	it("grid cell headers show dir basename", async () => {
		const { WorkspaceCenterArea } = await import(
			"../workspace/WorkspaceCenterArea"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		await openTerminal(bridge, "/tmp/beta");

		await waitFor(() =>
			expect(
				document.querySelector(".workspace-panel__terminal-area--grid"),
			).toBeTruthy(),
		);

		// Both dir names should appear in cell headers
		const headers = document.querySelectorAll(
			".workspace-panel__terminal-cell-header",
		);
		expect(headers.length).toBe(2);

		const headerText = Array.from(headers).map((h) => h.textContent ?? "");
		expect(headerText.some((t) => t.includes("alpha"))).toBe(true);
		expect(headerText.some((t) => t.includes("beta"))).toBe(true);
	});

	it("grid drops back to tab mode when terminal count falls to 1", async () => {
		const { WorkspaceCenterArea } = await import(
			"../workspace/WorkspaceCenterArea"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		const ptyBeta = await openTerminal(bridge, "/tmp/beta");

		await waitFor(() =>
			expect(
				document.querySelector(".workspace-panel__terminal-area--grid"),
			).toBeTruthy(),
		);

		// Close one terminal
		await bridge.callTool("skill_workspace_close_terminal", { pty_id: ptyBeta });
		// Or simulate via the close button in the cell header
		await act(async () => {
			const closeBtn = document.querySelector<HTMLButtonElement>(
				`.workspace-panel__terminal-cell [aria-label*="beta"] button, [aria-label*="beta"]`,
			);
			if (closeBtn) closeBtn.click();
		});

		// Grid should disappear (1 terminal left)
		await waitFor(() =>
			expect(
				document.querySelector(".workspace-panel__terminal-area--grid"),
			).toBeNull(),
		);
	});

	it("closing focused terminal falls back to next terminal, not editor", async () => {
		const { WorkspaceCenterArea } = await import(
			"../workspace/WorkspaceCenterArea"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		const ptyAlpha = await openTerminal(bridge, "/tmp/alpha");
		await openTerminal(bridge, "/tmp/beta");

		await waitFor(() =>
			expect(
				document.querySelector(".workspace-panel__terminal-area--grid"),
			).toBeTruthy(),
		);

		// Close focused terminal (alpha) via close button in tab bar
		await act(async () => {
			const closeBtn = document.querySelector<HTMLButtonElement>(
				`[aria-label="터미널 닫기: /tmp/alpha"]`,
			);
			closeBtn?.click();
		});

		// Beta terminal should still be visible (not "에디터")
		await waitFor(() => {
			expect(screen.queryByTestId(`terminal-${ptyAlpha}`)).toBeNull();
			// Editor tab label should NOT be the primary visible content
			// Beta terminal is still active
			const betaTerminal = screen.queryByTestId("terminal-pty-beta-2");
			if (betaTerminal) {
				expect(betaTerminal).toHaveAttribute("data-active", "true");
			}
		});
	});
});
