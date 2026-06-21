// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type React from "react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelRegistry } from "../../lib/panel-registry";
import type {
	NaiaContextBridge,
	PanelContext,
	ToolHandler,
} from "../../lib/panel-registry";
import type { SessionInfo } from "../workspace/SessionCard";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockImplementation(async (cmd: string, args?: any) => {
		if (cmd === "workspace_set_root")
			return args?.root ?? "/tmp/test-workspace";
		if (cmd === "workspace_get_sessions") return [];
		if (cmd === "read_file_text") return "";
		return [];
	}),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/logger", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../../lib/config", () => ({
	loadConfig: vi.fn().mockReturnValue({
		workspaceRoot: "/tmp/test-workspace",
		provider: "gemini",
		model: "gemini-2.5-flash",
		apiKey: "",
	}),
	saveConfig: vi.fn(),
}));

// ─── Mock CodeMirror (not available in jsdom) ─────────────────────────────────

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
	Transaction: {
		addToHistory: { of: () => ({}) },
	},
}));

vi.mock("@codemirror/commands", () => ({
	defaultKeymap: [],
	history: () => ({}),
	historyKeymap: [],
}));

vi.mock("@codemirror/lang-javascript", () => ({
	javascript: () => ({}),
}));

vi.mock("@codemirror/lang-markdown", () => ({
	markdown: () => ({}),
}));

vi.mock("@codemirror/theme-one-dark", () => ({
	oneDark: {},
}));

vi.mock("react-markdown", () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="md-preview">{children}</div>
	),
}));

// Terminal mock: avoids ResizeObserver / xterm dependency in jsdom
vi.mock("../workspace/Terminal", () => ({
	Terminal: vi.fn(({ pty_id }: { pty_id: string }) => (
		<div data-testid={`terminal-${pty_id}`} />
	)),
}));

// ─── Mock IssuesPanel — removes dependency on IssuesPanel/SessionDashboard internals ─

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

// ─── Mock NaiaContextBridge ──────────────────────────────────────────────────

class MockBridge implements NaiaContextBridge {
	public contexts: PanelContext[] = [];
	private handlers = new Map<string, ToolHandler>();

	pushContext(ctx: PanelContext): void {
		this.contexts.push(ctx);
	}

	onToolCall(toolName: string, handler: ToolHandler): () => void {
		this.handlers.set(toolName, handler);
		return () => {
			this.handlers.delete(toolName);
		};
	}

	async callTool(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<string> {
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
	queryBehavior(): Promise<import("../../lib/panel-registry").BehaviorEntry[]> {
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
	): Promise<import("../../lib/panel-registry").ShellResult> {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	}
}

// ─── Tests: WorkspaceCenterPanel ──────────────────────────────────────────────

describe("WorkspaceCenterPanel", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders left FileTree and right area", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);

		// Tree header should be visible
		expect(screen.getByText("탐색기")).toBeDefined();
	});

	it("registers skill_workspace_get_sessions handler on mount", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_workspace_get_sessions")).toBe(true);
		});
	});

	it("registers skill_workspace_open_file handler on mount", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_workspace_open_file")).toBe(true);
		});
	});

	it("registers skill_workspace_classify_dirs handler on mount", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_workspace_classify_dirs")).toBe(true);
		});
	});

	it("skill_workspace_get_sessions returns JSON session list", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_get_sessions")).toBe(true),
		);

		const result = await bridge.callTool("skill_workspace_get_sessions", {});
		// Returns { sessions: SessionInfo[], summary: { total, active, idle, stopped, error, description } }
		const parsed = JSON.parse(result);
		expect(parsed).toHaveProperty("sessions");
		expect(Array.isArray(parsed.sessions)).toBe(true);
		expect(parsed).toHaveProperty("summary");
		// Numeric fields must be present and zero (no sessions)
		expect(parsed.summary.total).toBe(0);
		expect(parsed.summary.active).toBe(0);
		expect(parsed.summary.idle).toBe(0);
		expect(parsed.summary.stopped).toBe(0);
		expect(parsed.summary.error).toBe(0);
		// No sessions → description must be "세션 없음"
		expect(parsed.summary.description).toBe("세션 없음");
	});

	it("skill_workspace_get_sessions counts sessions by status correctly", async () => {
		// Override IssuesPanel mock to inject known session data directly,
		// eliminating any dependency on IssuesPanel/SessionDashboard internals or invoke timing.
		// Safety: WorkspaceCenterPanel renders IssuesPanel unconditionally (no
		// conditional rendering), so it is never unmounted/remounted during this test.
		// handleSessionsUpdate = useCallback([naia]) provides a stable onSessionsUpdate
		// reference — the default mock's effect cannot re-fire and overwrite sessionsRef.
		const { IssuesPanel } = await import("../workspace/IssuesPanel");
		const testSessions: SessionInfo[] = [
			{
				dir: "naia-os",
				path: "/dev/naia-os",
				status: "active",
				branch: "main",
				progress: { issue: "#79", phase: "build" },
			},
			{ dir: "vllm", path: "/dev/vllm", status: "idle" },
			{ dir: "test", path: "/dev/test", status: "stopped" },
			{ dir: "broken", path: "/dev/broken", status: "error" },
		];
		vi.mocked(IssuesPanel).mockImplementationOnce(
			({ onSessionsUpdate }) => {
				useEffect(() => {
					onSessionsUpdate?.(testSessions);
				}, [onSessionsUpdate]);
				return null as unknown as React.ReactElement;
			},
		);

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_get_sessions")).toBe(true),
		);

		// callTool reads sessionsRef (no state mutation) so retries in waitFor are safe.
		// waitFor retries until onSessionsUpdate has been called with testSessions.
		await waitFor(async () => {
			const r = await bridge.callTool("skill_workspace_get_sessions", {});
			const p = JSON.parse(r);
			expect(p.summary.total).toBe(4);
			expect(p.summary.active).toBe(1);
			expect(p.summary.idle).toBe(1);
			expect(p.summary.stopped).toBe(1);
			expect(p.summary.error).toBe(1);
			// Counts must always add up to total
			expect(
				p.summary.active + p.summary.idle + p.summary.stopped + p.summary.error,
			).toBe(p.summary.total);
			// Description should mention each status group and active session details
			expect(p.summary.description).toContain("active 1개");
			expect(p.summary.description).toContain("idle 1개");
			expect(p.summary.description).toContain("stopped 1개");
			expect(p.summary.description).toContain("error 1개");
			expect(p.summary.description).toContain("naia-os");
			expect(p.summary.description).toContain("[main]");
			expect(p.summary.description).toContain("(#79)");
		});
	});

	it("skill_workspace_execute resolves a session basename dir to its absolute path", async () => {
		// Regression: get_sessions/focus_session expose sessions[].dir as a basename
		// ("naia-os"), but pty_execute_sync requires an absolute path. The agent reused
		// that basename as execute's `dir`, so the backend rejected it with
		// "Invalid working directory". The handler must resolve it to the session path.
		const { invoke } = await import("@tauri-apps/api/core");
		const testSessions: SessionInfo[] = [
			{ dir: "naia-os", path: "/home/user/dev/naia-os", status: "active" },
		];
		const { IssuesPanel } = await import("../workspace/IssuesPanel");
		vi.mocked(IssuesPanel).mockImplementationOnce(({ onSessionsUpdate }) => {
			useEffect(() => {
				onSessionsUpdate?.(testSessions);
			}, [onSessionsUpdate]);
			return null as unknown as React.ReactElement;
		});

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_execute")).toBe(true),
		);
		// Wait until the injected session is visible to the handler (sessionsRef).
		await waitFor(async () => {
			const r = await bridge.callTool("skill_workspace_get_sessions", {});
			expect(JSON.parse(r).summary.total).toBe(1);
		});

		vi.mocked(invoke).mockClear();
		await bridge.callTool("skill_workspace_execute", {
			command: "ls -F",
			dir: "naia-os",
		});
		const ptyCall = vi
			.mocked(invoke)
			.mock.calls.find((c) => c[0] === "pty_execute_sync");
		expect(ptyCall).toBeDefined();
		expect(ptyCall?.[1]).toMatchObject({
			dir: "/home/user/dev/naia-os",
			command: "ls -F",
		});
	});

	it("Panel API: getApi returns WorkspacePanelApi after mount, undefined after unmount", async () => {
		// Ensure workspace panel is registered in the registry (normally done by index.tsx)
		await import("../workspace/index");
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		const { unmount } = render(<WorkspaceCenterPanel naia={bridge} />);

		// After mount the API should be registered
		await waitFor(() =>
			expect(panelRegistry.getApi("workspace")).toBeDefined(),
		);
		const api = panelRegistry.getApi("workspace");
		expect(typeof api?.openFile).toBe("function");
		expect(typeof api?.focusSession).toBe("function");
		expect(typeof api?.getActiveSessions).toBe("function");
		expect(typeof api?.activatePanel).toBe("function");

		// After unmount the API should be cleared
		unmount();
		expect(panelRegistry.getApi("workspace")).toBeUndefined();
	});

	it("registers skill_workspace_focus_session handler on mount", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_workspace_focus_session")).toBe(true);
		});
	});

	it("skill_workspace_focus_session returns error when dir is missing", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);
		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_focus_session")).toBe(true),
		);

		const result = await bridge.callTool("skill_workspace_focus_session", {});
		expect(result).toContain("Error");
		expect(result).toContain("dir");
	});

	it("skill_workspace_focus_session returns error when session not found", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);
		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_focus_session")).toBe(true),
		);

		const result = await bridge.callTool("skill_workspace_focus_session", {
			dir: "nonexistent",
		});
		expect(result).toContain("Error");
		expect(result).toContain("nonexistent");
	});

	it("skill_workspace_focus_session returns Focused and passes highlightedDir to IssuesPanel", async () => {
		const { IssuesPanel } = await import("../workspace/IssuesPanel");
		const testSessions: SessionInfo[] = [
			{ dir: "naia-os", path: "/dev/naia-os", status: "active" },
		];
		vi.mocked(IssuesPanel).mockImplementationOnce(
			({ onSessionsUpdate }) => {
				useEffect(() => {
					onSessionsUpdate?.(testSessions);
				}, [onSessionsUpdate]);
				return null as unknown as React.ReactElement;
			},
		);

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);
		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_focus_session")).toBe(true),
		);

		await waitFor(async () => {
			const result = await bridge.callTool("skill_workspace_focus_session", {
				dir: "naia-os",
			});
			expect(result).toBe("Focused: naia-os");
		});

		// Verify highlightedDir was propagated to IssuesPanel
		await waitFor(() => {
			const calls = vi.mocked(IssuesPanel).mock.calls;
			const lastProps = calls[calls.length - 1]?.[0];
			expect(lastProps?.highlightedDir).toBe("naia-os");
		});
	});

	it("skill_workspace_focus_session with open_recent_file opens the correct path", async () => {
		const { IssuesPanel } = await import("../workspace/IssuesPanel");
		const testSessions: SessionInfo[] = [
			{
				dir: "naia-os",
				path: "/dev/naia-os",
				status: "active",
				recent_file: "shell/src/App.tsx",
				progress: { issue: "#117", phase: "build" },
			},
		];
		vi.mocked(IssuesPanel).mockImplementationOnce(
			({ onSessionsUpdate }) => {
				useEffect(() => {
					onSessionsUpdate?.(testSessions);
				}, [onSessionsUpdate]);
				return null as unknown as React.ReactElement;
			},
		);

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);
		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_focus_session")).toBe(true),
		);

		// Return value includes the opened path — verifies path combination (session.path + "/" + recent_file)
		await waitFor(async () => {
			const result = await bridge.callTool("skill_workspace_focus_session", {
				dir: "naia-os",
				open_recent_file: true,
			});
			expect(result).toBe(
				"Focused: naia-os, opened: /dev/naia-os/shell/src/App.tsx",
			);
		});
	});

	it("skill_workspace_focus_session ignores non-boolean open_recent_file (trust boundary)", async () => {
		const { IssuesPanel } = await import("../workspace/IssuesPanel");
		const testSessions: SessionInfo[] = [
			{
				dir: "naia-os",
				path: "/dev/naia-os",
				status: "active",
				recent_file: "shell/src/App.tsx",
			},
		];
		vi.mocked(IssuesPanel).mockImplementationOnce(
			({ onSessionsUpdate }) => {
				useEffect(() => {
					onSessionsUpdate?.(testSessions);
				}, [onSessionsUpdate]);
				return null as unknown as React.ReactElement;
			},
		);

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);
		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_focus_session")).toBe(true),
		);

		// Truthy string "yes" must NOT trigger file open (LLM trust boundary)
		// waitFor ensures sessions are injected into sessionsRef before callTool
		await waitFor(async () => {
			const result = await bridge.callTool("skill_workspace_focus_session", {
				dir: "naia-os",
				open_recent_file: "yes",
			});
			// File not opened: return value must not contain "opened:"
			expect(result).toBe("Focused: naia-os");
		});
	});

	it("skill_workspace_focus_session clears badge when open_recent_file=true but no recent_file", async () => {
		const { IssuesPanel } = await import("../workspace/IssuesPanel");
		// Session with NO recent_file
		const testSessions: SessionInfo[] = [
			{
				dir: "naia-os",
				path: "/dev/naia-os",
				status: "active",
			},
		];
		vi.mocked(IssuesPanel).mockImplementationOnce(
			({ onSessionsUpdate }) => {
				useEffect(() => {
					onSessionsUpdate?.(testSessions);
				}, [onSessionsUpdate]);
				return null as unknown as React.ReactElement;
			},
		);

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);
		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_focus_session")).toBe(true),
		);

		// open_recent_file=true but session has no recent_file → "Focused: {dir}" (no "opened:")
		await waitFor(async () => {
			const result = await bridge.callTool("skill_workspace_focus_session", {
				dir: "naia-os",
				open_recent_file: true,
			});
			expect(result).toBe("Focused: naia-os");
		});
	});

	it("skill_workspace_open_file updates editor filepath", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_open_file")).toBe(true),
		);

		// Open a file via tool
		const result = await bridge.callTool("skill_workspace_open_file", {
			path: "/home/user/dev/naia-os/AGENTS.md",
		});
		expect(result).toContain("Opened");
		expect(result).toContain("AGENTS.md");
	});

	it("pushes errorAlert context when a session has status=error (once per session)", async () => {
		const { IssuesPanel } = await import("../workspace/IssuesPanel");
		const errorSession: SessionInfo = {
			dir: "broken",
			path: "/dev/broken",
			status: "error",
		};
		vi.mocked(IssuesPanel).mockImplementationOnce(
			({ onSessionsUpdate }) => {
				useEffect(() => {
					// Fire twice with same data — should push errorAlert only once
					onSessionsUpdate?.([errorSession]);
					onSessionsUpdate?.([errorSession]);
				}, [onSessionsUpdate]);
				return null as unknown as React.ReactElement;
			},
		);

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => {
			const errorAlerts = bridge.contexts.filter(
				(c) =>
					c.type === "workspace" &&
					(c.data as Record<string, unknown>)?.errorAlert != null,
			);
			// Exactly one errorAlert despite two identical updates
			expect(errorAlerts).toHaveLength(1);
			const alert = (errorAlerts[0].data as Record<string, unknown>)
				.errorAlert as Record<string, unknown>;
			expect(alert.dir).toBe("broken");
			expect(typeof alert.message).toBe("string");
		});
	});

	// ── skill_workspace_send_to_session ──────────────────────────────────────

	it("registers skill_workspace_send_to_session handler on mount", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_workspace_send_to_session")).toBe(true);
		});
	});

	it("skill_workspace_send_to_session returns error when dir or text is missing", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);
		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_send_to_session")).toBe(true),
		);

		// Missing both
		const r1 = await bridge.callTool("skill_workspace_send_to_session", {});
		expect(r1).toContain("Error");

		// Missing text
		const r2 = await bridge.callTool("skill_workspace_send_to_session", {
			dir: "/dev/naia-os",
		});
		expect(r2).toContain("Error");

		// Missing dir
		const r3 = await bridge.callTool("skill_workspace_send_to_session", {
			text: "hello\n",
		});
		expect(r3).toContain("Error");
	});

	it("skill_workspace_send_to_session returns error when no PTY session found", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);
		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_send_to_session")).toBe(true),
		);

		// terminalsRef is empty — no PTY session exists for this dir
		const result = await bridge.callTool("skill_workspace_send_to_session", {
			dir: "/dev/nonexistent",
			text: "hello",
		});
		expect(result).toContain("Error");
		expect(result).toContain("nonexistent");
	});

	it("skill_workspace_send_to_session calls pty_write and returns 'Sent to: {dir}'", async () => {
		const { invoke } = await import("@tauri-apps/api/core");

		// Arrange: pty_create succeeds, git info returns null branch, pty_write succeeds
		vi.mocked(invoke).mockImplementation(async (cmd, args) => {
			if (cmd === "pty_create") return { pty_id: "pty-test-1", pid: 42 };
			if (cmd === "workspace_get_git_info") return { branch: null };
			if (cmd === "pty_write") return undefined;
			if (cmd === "workspace_set_root")
				return (args as Record<string, unknown>)?.root ?? "/tmp/test-workspace";
			if (cmd === "workspace_get_sessions") return [];
			return [];
		});

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();

		render(<WorkspaceCenterPanel naia={bridge} />);
		await waitFor(() =>
			expect(bridge.hasHandler("skill_workspace_new_session")).toBe(true),
		);

		// Open a terminal so terminalsRef gets the tab
		const newResult = await bridge.callTool("skill_workspace_new_session", {
			dir: "/dev/naia-os",
		});
		expect(newResult).toContain("Started");

		// Now send_to_session should find the tab and invoke pty_write
		await waitFor(async () => {
			const result = await bridge.callTool("skill_workspace_send_to_session", {
				dir: "/dev/naia-os",
				text: "echo hello\n",
			});
			expect(result).toBe("Sent to: /dev/naia-os");
		});

		// Verify pty_write was called with correct args
		const ptyWriteCalls = vi
			.mocked(invoke)
			.mock.calls.filter(([cmd]) => cmd === "pty_write");
		expect(ptyWriteCalls.length).toBeGreaterThanOrEqual(1);
		const lastPtyWrite = ptyWriteCalls[ptyWriteCalls.length - 1]!;
		expect((lastPtyWrite[1] as Record<string, unknown>).pty_id).toBe(
			"pty-test-1",
		);
		expect((lastPtyWrite[1] as Record<string, unknown>).data).toBe(
			"echo hello\n",
		);
	});

	it("skill_workspace_send_to_session is registered in index.tsx tool descriptor list", async () => {
		// index.tsx exports WORKSPACE_TOOLS — verify the descriptor exists with correct fields
		const { WORKSPACE_TOOLS } = await import("../workspace/index");
		const descriptor = WORKSPACE_TOOLS.find(
			(t) => t.name === "skill_workspace_send_to_session",
		);
		expect(descriptor).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		const params = descriptor!.parameters!;
		expect(params.properties).toHaveProperty("dir");
		expect(params.properties).toHaveProperty("text");
		expect(params.required).toContain("dir");
		expect(params.required).toContain("text");
	});

	it("re-arms errorAlert after session recovers to idle/active", async () => {
		const { IssuesPanel } = await import("../workspace/IssuesPanel");
		let emit: ((sessions: SessionInfo[]) => void) | undefined;
		vi.mocked(IssuesPanel).mockImplementationOnce(
			({ onSessionsUpdate }) => {
				useEffect(() => {
					emit = onSessionsUpdate ?? undefined;
				}, [onSessionsUpdate]);
				return null as unknown as React.ReactElement;
			},
		);

		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => emit !== undefined);

		const session = {
			dir: "broken",
			path: "/dev/broken",
			status: "error",
		} satisfies SessionInfo;

		// First error
		emit?.([session]);
		await waitFor(() => {
			const alerts = bridge.contexts.filter(
				(c) =>
					c.type === "workspace" &&
					(c.data as Record<string, unknown>)?.errorAlert != null,
			);
			expect(alerts).toHaveLength(1);
		});

		// Recovery → idle
		emit?.([{ ...session, status: "idle" }]);
		// Second error — should fire again
		emit?.([session]);
		await waitFor(() => {
			const alerts = bridge.contexts.filter(
				(c) =>
					c.type === "workspace" &&
					(c.data as Record<string, unknown>)?.errorAlert != null,
			);
			expect(alerts).toHaveLength(2);
		});
	});
});

// ─── Tests: SessionCard ──────────────────────────────────────────────────────

describe("SessionCard", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders active session with green emoji and dir name", async () => {
		const { SessionCard } = await import("../workspace/SessionCard");

		render(
			<SessionCard
				session={{
					dir: "naia-os-issue-79",
					path: "/home/user/dev/naia-os-issue-79",
					status: "active",
					branch: "issue-79-qwen3-asr",
					progress: { issue: "#79", phase: "build" },
					recent_file: "shell/src/lib/stt/registry.ts",
					last_change: Math.floor(Date.now() / 1000) - 5,
				}}
				onClick={() => {}}
			/>,
		);

		expect(screen.getByText("🟢")).toBeDefined();
		expect(screen.getByText("naia-os-issue-79")).toBeDefined();
	});

	it("renders idle session with yellow emoji", async () => {
		const { SessionCard } = await import("../workspace/SessionCard");

		render(
			<SessionCard
				session={{
					dir: "naia.nextain.io",
					path: "/home/user/dev/naia.nextain.io",
					status: "idle",
					branch: "main",
					progress: { issue: "#8", phase: "e2e" },
					last_change: Math.floor(Date.now() / 1000) - 120,
				}}
				onClick={() => {}}
			/>,
		);

		expect(screen.getByText("🟡")).toBeDefined();
		expect(screen.getByText("naia.nextain.io")).toBeDefined();
	});

	it("renders stopped session with black emoji", async () => {
		const { SessionCard } = await import("../workspace/SessionCard");

		render(
			<SessionCard
				session={{
					dir: "vllm",
					path: "/home/user/dev/vllm",
					status: "stopped",
				}}
				onClick={() => {}}
			/>,
		);

		expect(screen.getByText("⚫")).toBeDefined();
		expect(screen.getByText("vllm")).toBeDefined();
	});

	it("shows progress issue and phase in badge", async () => {
		const { SessionCard } = await import("../workspace/SessionCard");

		render(
			<SessionCard
				session={{
					dir: "naia-os-issue-79",
					path: "/home/user/dev/naia-os-issue-79",
					status: "active",
					progress: { issue: "#79", phase: "build" },
				}}
				onClick={() => {}}
			/>,
		);

		// "#79 · build" should appear (phase from progress.json is lowercase)
		expect(screen.getByText("#79 · build")).toBeDefined();
	});

	it("calls onClick when card is clicked", async () => {
		const { SessionCard } = await import("../workspace/SessionCard");
		const onClick = vi.fn();

		render(
			<SessionCard
				session={{
					dir: "naia-os",
					path: "/home/user/dev/naia-os",
					status: "active",
				}}
				onClick={onClick}
			/>,
		);

		const card = screen.getByRole("button", { name: /naia-os/ });
		fireEvent.click(card);
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

// ─── Tests: Editor ───────────────────────────────────────────────────────────

describe("Editor", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders empty hint when no file is selected", async () => {
		const { Editor } = await import("../workspace/Editor");

		render(<Editor filePath="" />);

		expect(screen.getByText(/파일 탐색기에서 파일을 선택/)).toBeDefined();
	});

	it("shows filename in header when file is opened", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		vi.mocked(invoke).mockResolvedValueOnce("file content here");

		const { Editor } = await import("../workspace/Editor");

		render(<Editor filePath="/home/user/dev/naia-os/AGENTS.md" />);

		expect(screen.getByText("AGENTS.md")).toBeDefined();
	});

	it("shows badge when provided", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		vi.mocked(invoke).mockResolvedValueOnce("content");

		const { Editor } = await import("../workspace/Editor");

		render(
			<Editor
				filePath="/home/user/dev/naia-os/AGENTS.md"
				badge="#79 · Build"
			/>,
		);

		expect(screen.getByText("#79 · Build")).toBeDefined();
	});

	it("shows edit toggle button for markdown files (default preview mode)", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		vi.mocked(invoke).mockResolvedValueOnce("# Heading\n\nContent");

		const { Editor } = await import("../workspace/Editor");

		render(
			<Editor filePath="/home/user/dev/naia-os/docs/design/workspace-panel.ko.md" />,
		);

		// Markdown files start in preview mode → "편집" button is shown to switch back
		expect(screen.getByText("편집")).toBeDefined();
	});

	it("shows read-only label for ref- directories", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		vi.mocked(invoke).mockResolvedValueOnce("readonly content");

		const { Editor } = await import("../workspace/Editor");

		render(
			<Editor
				filePath="/home/user/dev/ref-cline/README.md"
				readOnly={true}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("읽기 전용")).toBeDefined();
		});
	});
});

// ─── Tests: Panel Registry ─────────────────────────────────────────────────

describe("Workspace panel registry", () => {
	beforeEach(async () => {
		// Import index to trigger registration
		await import("../workspace/index");
	});

	it("registers workspace panel as builtIn", async () => {
		const { panelRegistry } = await import("../../lib/panel-registry");
		const panel = panelRegistry.get("workspace");

		expect(panel).toBeDefined();
		expect(panel?.builtIn).toBe(true);
		expect(panel?.id).toBe("workspace");
	});

	it("workspace panel has skill_workspace_get_sessions tool", async () => {
		const { panelRegistry } = await import("../../lib/panel-registry");
		const panel = panelRegistry.get("workspace");

		const tool = panel?.tools?.find(
			(t) => t.name === "skill_workspace_get_sessions",
		);
		expect(tool).toBeDefined();
		expect(tool?.tier).toBe(0);
	});

	it("workspace panel has skill_workspace_open_file tool", async () => {
		const { panelRegistry } = await import("../../lib/panel-registry");
		const panel = panelRegistry.get("workspace");

		const tool = panel?.tools?.find(
			(t) => t.name === "skill_workspace_open_file",
		);
		expect(tool).toBeDefined();
		expect(tool?.tier).toBe(1);
	});

	it("workspace panel has skill_workspace_focus_session tool", async () => {
		const { panelRegistry } = await import("../../lib/panel-registry");
		const panel = panelRegistry.get("workspace");

		const tool = panel?.tools?.find(
			(t) => t.name === "skill_workspace_focus_session",
		);
		expect(tool).toBeDefined();
		expect(tool?.tier).toBe(1);
	});

	it("workspace panel has onActivate and onDeactivate hooks", async () => {
		const { panelRegistry } = await import("../../lib/panel-registry");
		const panel = panelRegistry.get("workspace");

		expect(typeof panel?.onActivate).toBe("function");
		expect(typeof panel?.onDeactivate).toBe("function");
	});
});

// ── #294: WorkspaceCenterPanel left sidebar divider (FileTree ↕ SkillLauncher) ──

describe("#294 — WorkspaceCenterPanel left sidebar divider (FileTree ↕ SkillLauncher)", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders workspace-panel__row-resize-handle in the left sidebar", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => screen.getByText("탐색기"));

		const handle = document.querySelector(".workspace-panel__row-resize-handle");
		expect(handle).toBeTruthy();
	});

	it("pointerdown on left sidebar divider adds resizing-row class to body", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => screen.getByText("탐색기"));

		const handle = document.querySelector(
			".workspace-panel__row-resize-handle",
		) as Element;
		expect(handle).toBeTruthy();

		fireEvent.pointerDown(handle, { clientY: 300 });
		expect(document.body.classList.contains("resizing-row")).toBe(true);

		// Cleanup
		fireEvent.pointerUp(window);
		expect(document.body.classList.contains("resizing-row")).toBe(false);
	});

	it("pointermove after pointerdown on left sidebar divider changes skillsHeight", async () => {
		const { WorkspaceCenterPanel } = await import(
			"../workspace/WorkspaceCenterPanel"
		);
		const bridge = new MockBridge();
		render(<WorkspaceCenterPanel naia={bridge} />);

		await waitFor(() => screen.getByText("탐색기"));

		const handle = document.querySelector(
			".workspace-panel__row-resize-handle",
		) as Element;

		// Start drag at y=300
		fireEvent.pointerDown(handle, { clientY: 300 });
		// Move up 50px → height increases (handle is on top edge; dragging up increases height)
		fireEvent.pointerMove(window, { clientY: 250 });

		// The skills container should now reflect updated height (> 160 initial default)
		// Look for the inline style height set on the skills container div
		const allDivs = document.querySelectorAll("div[style]");
		const heightDivs = Array.from(allDivs).filter((el) => {
			const h = (el as HTMLElement).style.height;
			return h.endsWith("px") && Number.parseInt(h) > 160;
		});
		expect(heightDivs.length).toBeGreaterThan(0);

		// Cleanup
		fireEvent.pointerUp(window);
	});
});
