// @vitest-environment jsdom
/**
 * Phase 4 tests: Issue → Terminal link
 *
 * Verifies that WorkspaceCenterPanel:
 *  1. Focuses the matching terminal when an issue with a known issueId is clicked
 *  2. Still pushes Naia context when clicking an issue (with or without a terminal)
 *  3. Does NOT change the active tab when the clicked issue has no matching terminal
 *  4. Focuses the correct terminal when multiple terminals are open (correct pid match)
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../workspace/Terminal", () => ({
	Terminal: vi.fn(({ pty_id }: { pty_id: string }) => (
		<div data-testid={`terminal-${pty_id}`} />
	)),
}));

// IssuesPanel mock — exposes onIssueClick so tests can fire it directly
let capturedOnIssueClick: ((issue: unknown) => void) | undefined;

vi.mock("../workspace/IssuesPanel", () => ({
	IssuesPanel: vi.fn(
		({
			onSessionsUpdate,
			onIssueClick,
		}: {
			onSessionsUpdate?: (sessions: SessionInfo[]) => void;
			onSessionClick: (session: SessionInfo) => void;
			highlightedDir?: string;
			onIssueClick?: (issue: unknown) => void;
		}) => {
			capturedOnIssueClick = onIssueClick;
			useEffect(() => {
				onSessionsUpdate?.([]);
			}, [onSessionsUpdate]);
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
	queryBehavior(): Promise<import("../../lib/panel-registry").BehaviorEntry[]> {
		return Promise.resolve([]);
	}
	getSecret(): Promise<string | null> { return Promise.resolve(null); }
	setSecret(): Promise<void> { return Promise.resolve(); }
	readFile(): Promise<string> { return Promise.resolve(""); }
	runShell(): Promise<import("../../lib/panel-registry").ShellResult> {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let ptyCounter = 0;

/**
 * Sets up invoke mock. branchMap: dir → branch name (used to derive issueId).
 * e.g. { "/tmp/alpha": "issue-42" } → terminal for /tmp/alpha gets issueId=42
 */
function setupInvoke(branchMap: Record<string, string> = {}) {
	ptyCounter = 0;
	mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		if (cmd === "workspace_set_root") return args?.root ?? "/tmp/test";
		if (cmd === "workspace_get_sessions") return [];
		if (cmd === "workspace_load_project_index") return null;
		if (cmd === "workspace_discover_skills") return [];
		if (cmd === "workspace_check_adk_server") return false;
		if (cmd === "workspace_discover_adk_server") return null;
		if (cmd === "workspace_get_pty_agents") return {};
		if (cmd === "pty_kill") return null;
		if (cmd === "workspace_get_git_info") {
			const dir = String((args as Record<string, unknown>)?.path ?? "");
			return { branch: branchMap[dir] ?? null };
		}
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
	const name = dir.split(/[/\\]/).pop() ?? "term";
	return `pty-${name}-${ptyCounter}`;
}

function makeIssue(number: number) {
	return { number, title: `Issue ${number}`, state: "OPEN" as const, labels: [], updatedAt: new Date().toISOString() };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Issue → Terminal link — Phase 4", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		capturedOnIssueClick = undefined;
	});

	afterEach(() => {
		cleanup();
		vi.resetModules();
		localStorage.clear();
	});

	it("focuses the matching terminal when issue is clicked", async () => {
		// Terminal for /tmp/alpha is on branch issue-42 → issueId=42
		setupInvoke({ "/tmp/alpha": "issue-42", "/tmp/beta": "issue-99" });

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		const betaPtyId = await openTerminal(bridge, "/tmp/beta");

		// Wait for both terminals and their issueIds to be set
		await waitFor(() =>
			expect(screen.getByTestId(`terminal-${betaPtyId}`)).toBeInTheDocument(),
		);

		// beta is the active tab now (opened last) — tab label visible
		await waitFor(() =>
			expect(screen.getAllByText("beta")[0]).toBeInTheDocument(),
		);

		// Click issue #42 → should focus alpha terminal
		await waitFor(() => expect(capturedOnIssueClick).toBeDefined());
		capturedOnIssueClick!(makeIssue(42));

		// 2 terminals = grid mode: focused cell gets --focused class
		await waitFor(() => {
			const focused = document.querySelectorAll(
				".workspace-panel__terminal-cell--focused",
			);
			expect(focused.length).toBe(1);
			expect(focused[0].textContent).toContain("alpha");
		});
	});

	it("always pushes Naia context when an issue is clicked", async () => {
		setupInvoke({ "/tmp/alpha": "issue-42" });

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-alpha-1")).toBeInTheDocument(),
		);

		await waitFor(() => expect(capturedOnIssueClick).toBeDefined());
		bridge.contexts = [];

		capturedOnIssueClick!(makeIssue(42));

		expect(bridge.contexts.length).toBeGreaterThan(0);
		const ctx = bridge.contexts[0];
		expect((ctx.data as Record<string, unknown>).selectedIssue).toBeDefined();
	});

	it("does NOT switch tabs when clicked issue has no matching terminal", async () => {
		setupInvoke({ "/tmp/alpha": "issue-42" });

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge, "/tmp/alpha");
		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-alpha-1")).toBeInTheDocument(),
		);

		// alpha is active. Click issue #99 (no terminal for it)
		await waitFor(() => expect(capturedOnIssueClick).toBeDefined());
		capturedOnIssueClick!(makeIssue(99));

		// 1 terminal = tab mode: alpha tab must stay aria-selected (no switch)
		await waitFor(() => {
			const alphaTab = screen
				.getAllByRole("tab")
				.find((el) => el.textContent?.includes("alpha"));
			expect(alphaTab).toBeDefined();
			expect(alphaTab).toHaveAttribute("aria-selected", "true");
		});
	});

	it("focuses the correct terminal among multiple with different issueIds", async () => {
		setupInvoke({
			"/tmp/feat-10": "issue-10",
			"/tmp/feat-20": "issue-20",
			"/tmp/feat-30": "issue-30",
		});

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await openTerminal(bridge, "/tmp/feat-10");
		await openTerminal(bridge, "/tmp/feat-20");
		await openTerminal(bridge, "/tmp/feat-30");

		await waitFor(() =>
			expect(screen.getByTestId("terminal-pty-feat-30-3")).toBeInTheDocument(),
		);

		// Click issue #10 → feat-10 terminal should be focused
		await waitFor(() => expect(capturedOnIssueClick).toBeDefined());
		capturedOnIssueClick!(makeIssue(10));

		// 3 terminals = grid mode: feat-10 cell gets --focused class
		await waitFor(() => {
			const focused = document.querySelectorAll(
				".workspace-panel__terminal-cell--focused",
			);
			expect(focused.length).toBe(1);
			expect(focused[0].textContent).toContain("feat-10");
		});
	});

	it("still pushes context even when no matching terminal exists", async () => {
		setupInvoke();

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		// No terminals open at all
		await waitFor(() => expect(capturedOnIssueClick).toBeDefined());
		bridge.contexts = [];

		capturedOnIssueClick!(makeIssue(77));

		expect(bridge.contexts.length).toBeGreaterThan(0);
		const ctx = bridge.contexts[0];
		const issue = (ctx.data as Record<string, unknown>).selectedIssue as Record<string, unknown>;
		expect(issue.number).toBe(77);
	});
});
