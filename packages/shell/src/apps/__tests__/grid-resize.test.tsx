// @vitest-environment jsdom
/**
 * Phase 6 tests: Grid cell resize (2-terminal split)
 *
 * Verifies WorkspaceCenterArea:
 *  1. Resize handle NOT present with 0 or 1 terminal
 *  2. Resize handle appears when exactly 2 terminals are open
 *  3. Resize handle NOT present with 3+ terminals (normal auto-grid)
 *  4. Terminal area gets --resizable class with 2 terminals
 *  5. --resizable class absent with 1 or 3 terminals
 *  6. Dragging the handle updates gridTemplateColumns inline style
 *  7. body.resizing-col is added on pointerdown, removed on pointerup
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
			useEffect(() => { onSessionsUpdate?.([]) }, [onSessionsUpdate]);
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
	queryBehavior(): Promise<import("../../lib/app-registry").BehaviorEntry[]> { return Promise.resolve([]); }
	getSecret(): Promise<string | null> { return Promise.resolve(null); }
	setSecret(): Promise<void> { return Promise.resolve(); }
	readFile(): Promise<string> { return Promise.resolve(""); }
	runShell(): Promise<import("../../lib/app-registry").ShellResult> { return Promise.resolve({ stdout: "", stderr: "", code: 0 }); }
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

function getTerminalArea(): HTMLElement | null {
	return document.querySelector(".workspace-panel__terminal-area");
}

function getResizeHandle(): Element | null {
	return document.querySelector(".workspace-panel__grid-resize-handle");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Grid cell resize — Phase 6", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setupInvoke();
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
		vi.resetModules();
		localStorage.clear();
		document.body.classList.remove("resizing-col");
	});

	it("no resize handle with 0 terminals", async () => {
		const { WorkspaceCenterArea } = await import("../workspace/WorkspaceCenterArea");
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await waitFor(() => expect(bridge.hasHandler("skill_workspace_new_session")).toBe(true));
		expect(getResizeHandle()).toBeNull();
	});

	it("no resize handle with 1 terminal (tab mode)", async () => {
		const { WorkspaceCenterArea } = await import("../workspace/WorkspaceCenterArea");
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		const ptyId = await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() => expect(screen.getByTestId(`terminal-${ptyId}`)).toBeInTheDocument());

		expect(getResizeHandle()).toBeNull();
	});

	it("resize handle appears with exactly 2 terminals", async () => {
		const { WorkspaceCenterArea } = await import("../workspace/WorkspaceCenterArea");
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		const pty2 = await openTerminal(bridge, "/tmp/beta");
		await waitFor(() => expect(screen.getByTestId(`terminal-${pty2}`)).toBeInTheDocument());

		await waitFor(() => expect(getResizeHandle()).toBeTruthy());
	});

	it("terminal area gets --resizable class with 2 terminals", async () => {
		const { WorkspaceCenterArea } = await import("../workspace/WorkspaceCenterArea");
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		const pty2 = await openTerminal(bridge, "/tmp/beta");
		await waitFor(() => expect(screen.getByTestId(`terminal-${pty2}`)).toBeInTheDocument());

		await waitFor(() =>
			expect(getTerminalArea()?.classList.contains("workspace-panel__terminal-area--resizable")).toBe(true),
		);
	});

	it("no resize handle with 3 terminals (auto-grid, no drag)", async () => {
		const { WorkspaceCenterArea } = await import("../workspace/WorkspaceCenterArea");
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		await openTerminal(bridge, "/tmp/beta");
		const pty3 = await openTerminal(bridge, "/tmp/gamma");
		await waitFor(() => expect(screen.getByTestId(`terminal-${pty3}`)).toBeInTheDocument());

		// grid mode but canGridResize is false (3 terminals)
		expect(getResizeHandle()).toBeNull();
		expect(getTerminalArea()?.classList.contains("workspace-panel__terminal-area--resizable")).toBe(false);
	});

	it("terminal area has inline gridTemplateColumns with 2 terminals", async () => {
		const { WorkspaceCenterArea } = await import("../workspace/WorkspaceCenterArea");
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		const pty2 = await openTerminal(bridge, "/tmp/beta");
		await waitFor(() => expect(screen.getByTestId(`terminal-${pty2}`)).toBeInTheDocument());

		await waitFor(() => {
			const area = getTerminalArea() as HTMLElement;
			expect(area.style.gridTemplateColumns).toMatch(/fr\s+6px\s+.*fr/);
		});
	});

	it("removes body.resizing-col on pointercancel (no stuck cursor)", async () => {
		const { WorkspaceCenterArea } = await import("../workspace/WorkspaceCenterArea");
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		const pty2 = await openTerminal(bridge, "/tmp/beta");
		await waitFor(() => expect(screen.getByTestId(`terminal-${pty2}`)).toBeInTheDocument());
		await waitFor(() => expect(getResizeHandle()).toBeTruthy());

		const handle = getResizeHandle() as HTMLElement;

		act(() => {
			handle.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, clientX: 400 }),
			);
		});
		expect(document.body.classList.contains("resizing-col")).toBe(true);

		// Cancel instead of up (touch interrupted, focus lost, etc.)
		act(() => {
			window.dispatchEvent(new PointerEvent("pointercancel"));
		});
		expect(document.body.classList.contains("resizing-col")).toBe(false);
	});

	it("adds body.resizing-col on pointerdown and removes it on pointerup", async () => {
		const { WorkspaceCenterArea } = await import("../workspace/WorkspaceCenterArea");
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		const pty2 = await openTerminal(bridge, "/tmp/beta");
		await waitFor(() => expect(screen.getByTestId(`terminal-${pty2}`)).toBeInTheDocument());
		await waitFor(() => expect(getResizeHandle()).toBeTruthy());

		const handle = getResizeHandle() as HTMLElement;

		// Simulate pointerdown
		act(() => {
			handle.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, clientX: 400 }),
			);
		});
		expect(document.body.classList.contains("resizing-col")).toBe(true);

		// Simulate pointerup on window
		act(() => {
			window.dispatchEvent(new PointerEvent("pointerup"));
		});
		expect(document.body.classList.contains("resizing-col")).toBe(false);
	});

	it("gridSplit updates (style changes) after drag", async () => {
		const { WorkspaceCenterArea } = await import("../workspace/WorkspaceCenterArea");
		const bridge = new MockBridge();
		render(<WorkspaceCenterArea naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		const pty2 = await openTerminal(bridge, "/tmp/beta");
		await waitFor(() => expect(screen.getByTestId(`terminal-${pty2}`)).toBeInTheDocument());
		await waitFor(() => expect(getResizeHandle()).toBeTruthy());

		const handle = getResizeHandle() as HTMLElement;
		const area = getTerminalArea() as HTMLElement;

		// Mock container width
		Object.defineProperty(area, "offsetWidth", { value: 800, configurable: true });

		const initialStyle = area.style.gridTemplateColumns;

		act(() => {
			handle.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, clientX: 400 }),
			);
		});

		// Move 80px right → split should shift ~0.1 (80/800)
		act(() => {
			window.dispatchEvent(
				new PointerEvent("pointermove", { clientX: 480 }),
			);
		});

		await waitFor(() => {
			const newStyle = area.style.gridTemplateColumns;
			expect(newStyle).not.toBe(initialStyle);
		});

		act(() => { window.dispatchEvent(new PointerEvent("pointerup")); });
	});
});
