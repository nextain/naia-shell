// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ActiveAppBridge,
	type NaiaContextBridge,
	type ToolHandler,
} from "../../../lib/app-registry";
import type { FileLocation, TerminalHandle } from "../Terminal";

const mockInvoke = vi.fn();
const terminalFocus = vi.fn();
const editorRevealLocation = vi.fn();
const editorReloadFile = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../../../lib/adk-store", () => ({
	getAdkPath: () => "/work/naia",
}));

vi.mock("../../../stores/app", () => ({
	useAppStore: {
		getState: () => ({
			activeApp: "workspace",
			setActiveApp: vi.fn(),
			setActiveAppContext: vi.fn(),
		}),
	},
}));

vi.mock("../Terminal", () => ({
	Terminal: forwardRef<
		TerminalHandle,
		{
			pty_id: string;
			onExit: (ptyId: string) => void;
			onFileLocation?: (value: FileLocation) => void;
			onReady?: () => void;
		}
	>(function MockTerminal({ pty_id, onExit, onFileLocation, onReady }, ref) {
		useImperativeHandle(ref, () => ({ focus: terminalFocus }));
		useEffect(() => onReady?.(), [pty_id]);
		return (
			<div data-testid="embedded-herdr-terminal" data-pty-id={pty_id}>
				<button
					type="button"
					onClick={() =>
						onFileLocation?.({ path: "src/App.tsx", line: 12, column: 4 })
					}
				>
					Open terminal path
				</button>
				<button type="button" onClick={() => onExit(pty_id)}>
					Exit Herdr PTY
				</button>
			</div>
		);
	}),
}));

vi.mock("../FileTree", () => ({
	FileTree: ({
		openFilePath,
		onFileSelect,
		onSendToChat,
	}: {
		openFilePath: string;
		onFileSelect: (path: string) => void;
		onSendToChat: (path: string) => void;
	}) => (
		<div>
			<div data-testid="file-tree-selection">{openFilePath}</div>
			<button
				type="button"
				onClick={() => onFileSelect("/work/naia/README.md")}
			>
				Open tree file
			</button>
			<button type="button" onClick={() => onSendToChat("README.md")}>
				Send tree file
			</button>
		</div>
	),
}));

vi.mock("../QuickOpen", () => ({
	QuickOpen: ({ onClose }: { onClose: () => void }) => (
		<button type="button" onClick={onClose}>
			Quick Open visible
		</button>
	),
}));

vi.mock("../Editor", () => ({
	Editor: forwardRef(function MockEditor(
		{ filePath }: { filePath: string },
		ref,
	) {
		useImperativeHandle(ref, () => ({
			reloadFile: editorReloadFile,
			revealLocation: editorRevealLocation,
		}));
		return <div data-testid="file-viewer">{filePath}</div>;
	}),
}));

vi.mock("../DocTabBar", () => ({
	DocTabBar: () => <div data-testid="doc-tabs" />,
}));

const snapshot = {
	protocol: 19,
	version: "0.8.0",
	focused_workspace_id: "w1",
	focused_pane_id: "w1:p1",
	workspaces: [
		{
			workspace_id: "w1",
			label: "Naia",
			focused: true,
			pane_count: 1,
			tab_count: 1,
			worktree: { checkout_path: "/work/naia" },
		},
	],
	agents: [
		{
			workspace_id: "w1",
			tab_id: "w1:t1",
			pane_id: "w1:p1",
			agent: "codex",
			agent_status: "working",
			cwd: "/work/naia",
			focused: true,
		},
	],
};

const toolHandlers = new Map<string, ToolHandler>();

const bridge: NaiaContextBridge = {
	pushContext: vi.fn(),
	onToolCall: vi.fn((name, handler) => {
		toolHandlers.set(name, handler);
		return () => toolHandlers.delete(name);
	}),
	logBehavior: vi.fn(async () => {}),
	queryBehavior: vi.fn(async () => []),
	getSecret: vi.fn(async () => null),
	setSecret: vi.fn(async () => {}),
	readFile: vi.fn(async () => ""),
	runShell: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
};

describe("HerdrWorkspaceCenterArea", () => {
	afterEach(() => {
		cleanup();
		mockInvoke.mockReset();
		terminalFocus.mockReset();
		editorRevealLocation.mockReset();
		editorReloadFile.mockReset();
		toolHandlers.clear();
	});

	it("places File Tree above Spaces and keeps Herdr mounted behind the viewer", async () => {
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "herdr_pty_create") return { pty_id: "pty-7", pid: 7 };
			if (command === "herdr_snapshot") return snapshot;
			if (command === "workspace_set_root") return "/work/naia";
			if (command === "workspace_resolve_file_location") {
				return "/work/naia/src/App.tsx";
			}
			return null;
		});
		const { HerdrWorkspaceCenterArea } = await import(
			"../HerdrWorkspaceCenterArea"
		);
		render(<HerdrWorkspaceCenterArea naia={bridge} />);

		const fileTree = await screen.findByLabelText("File Tree");
		const workspaceRoot = await screen.findByTestId("herdr-workspace-root");
		expect(workspaceRoot).toHaveTextContent("naia");
		expect(workspaceRoot).toHaveAttribute("title", "/work/naia");
		const spaces = screen.getByRole("tab", { name: "Spaces" });
		const agents = screen.getByRole("tab", { name: "Agents" });
		expect(
			fileTree.compareDocumentPosition(spaces) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			spaces.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		const terminal = await screen.findByTestId("embedded-herdr-terminal");

		fireEvent.click(screen.getByRole("button", { name: "Open terminal path" }));
		await screen.findByTestId("workspace-viewer");
		expect(mockInvoke).toHaveBeenCalledWith("workspace_resolve_file_location", {
			path: "src/App.tsx",
			expectedWorkspaceId: "w1",
			expectedPaneId: "w1:p1",
		});
		await waitFor(() =>
			expect(editorRevealLocation).toHaveBeenCalledWith(
				12,
				4,
				"/work/naia/src/App.tsx",
			),
		);
		expect(screen.getByTestId("file-tree-selection")).toHaveTextContent(
			"/work/naia/src/App.tsx",
		);
		expect(terminal).toBeInTheDocument();
		expect(
			mockInvoke.mock.calls.filter(
				([command]) => command === "herdr_pty_create",
			),
		).toHaveLength(1);

		fireEvent.click(screen.getByRole("button", { name: "Back to Herdr" }));
		await waitFor(() => expect(terminalFocus).toHaveBeenCalled());
		expect(screen.getByTestId("embedded-herdr-terminal")).toBe(terminal);
		expect(
			mockInvoke.mock.calls.filter(
				([command]) => command === "herdr_pty_create",
			),
		).toHaveLength(1);
	});

	it("preserves Quick Open and the FileTree Naia action", async () => {
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "herdr_pty_create") return { pty_id: "pty-7", pid: 7 };
			if (command === "herdr_snapshot") return snapshot;
			if (command === "workspace_set_root") return "/work/naia";
			return null;
		});
		const ask = vi.fn();
		window.addEventListener("naia:ask-ai", ask);
		const { HerdrWorkspaceCenterArea } = await import(
			"../HerdrWorkspaceCenterArea"
		);
		render(<HerdrWorkspaceCenterArea naia={bridge} />);

		fireEvent.keyDown(window, { key: "p", ctrlKey: true });
		expect(await screen.findByText("Quick Open visible")).toBeVisible();
		fireEvent.click(await screen.findByText("Send tree file"));
		expect(ask).toHaveBeenCalledTimes(1);
		window.removeEventListener("naia:ask-ai", ask);
	});

	it("focuses the owning Herdr pane from Agents", async () => {
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "herdr_pty_create") return { pty_id: "pty-7", pid: 7 };
			if (command === "herdr_snapshot") return snapshot;
			return null;
		});
		const { HerdrWorkspaceCenterArea } = await import(
			"../HerdrWorkspaceCenterArea"
		);
		render(<HerdrWorkspaceCenterArea naia={bridge} />);
		fireEvent.click(await screen.findByRole("tab", { name: "Agents" }));
		fireEvent.click(await screen.findByRole("button", { name: /codex/i }));
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("herdr_focus_agent", {
				paneId: "w1:p1",
			}),
		);
	});

	it("routes Naia workspace tools through the active Herdr space and agent", async () => {
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "herdr_pty_create") return { pty_id: "pty-7", pid: 7 };
			if (command === "herdr_snapshot") return snapshot;
			if (command === "workspace_set_root") return "/work/naia";
			if (command === "workspace_resolve_file_location") {
				return "/work/naia/src/App.tsx";
			}
			return null;
		});
		const { HerdrWorkspaceCenterArea } = await import(
			"../HerdrWorkspaceCenterArea"
		);
		render(<HerdrWorkspaceCenterArea naia={bridge} />);

		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_open_file")).toBe(true),
		);
		const openResult = await toolHandlers.get("skill_workspace_open_file")?.({
			path: "src/App.tsx",
		});
		expect(openResult).toBe("Opened: /work/naia/src/App.tsx");
		await waitFor(() =>
			expect(screen.getByLabelText("File Tree")).toHaveFocus(),
		);
		expect(screen.getByTestId("file-tree-selection")).toHaveTextContent(
			"/work/naia/src/App.tsx",
		);

		const focusResult = await toolHandlers.get(
			"skill_workspace_focus_session",
		)?.({
			dir: "/work/naia",
		});
		expect(focusResult).toBe("Focused: Naia");
		expect(mockInvoke).toHaveBeenCalledWith("herdr_focus_workspace", {
			workspaceId: "w1",
		});

		const sendResult = await toolHandlers.get(
			"skill_workspace_send_to_session",
		)?.({
			dir: "/work/naia",
			text: "inspect the failing test",
		});
		expect(sendResult).toBe("Prompted: /work/naia");
		expect(mockInvoke).toHaveBeenCalledWith("herdr_prompt_agent", {
			paneId: "w1:p1",
			text: "inspect the failing test",
		});
	});

	it("recovers from launch failure and PTY exit without duplicating a live client", async () => {
		let launches = 0;
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "herdr_pty_create") {
				launches++;
				if (launches === 1) throw new Error("launch failed");
				return { pty_id: `pty-${launches}`, pid: launches };
			}
			if (command === "herdr_snapshot") return snapshot;
			return null;
		});
		const { HerdrWorkspaceCenterArea } = await import(
			"../HerdrWorkspaceCenterArea"
		);
		render(<HerdrWorkspaceCenterArea naia={bridge} />);

		expect(await screen.findByText(/launch failed/)).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: /Retry|다시 시도/ }));
		expect(
			await screen.findByTestId("embedded-herdr-terminal"),
		).toHaveAttribute("data-pty-id", "pty-2");
		fireEvent.click(screen.getByRole("button", { name: "Exit Herdr PTY" }));
		await waitFor(() =>
			expect(screen.queryByTestId("embedded-herdr-terminal")).toBeNull(),
		);
		fireEvent.click(screen.getByRole("button", { name: /Retry|다시 시도/ }));
		expect(
			await screen.findByTestId("embedded-herdr-terminal"),
		).toHaveAttribute("data-pty-id", "pty-3");
		expect(launches).toBe(3);
	});

	it("covers all Naia bridge controls, errors, and unmount cleanup", async () => {
		mockInvoke.mockImplementation(
			async (command: string, args?: Record<string, unknown>) => {
				if (command === "herdr_pty_create") return { pty_id: "pty-7", pid: 7 };
				if (command === "herdr_snapshot") return snapshot;
				if (command === "workspace_set_root") return "/work/naia";
				if (command === "workspace_resolve_file_location")
					return "/work/naia/src/App.tsx";
				if (command === "workspace_read_file") return "before before";
				if (command === "pty_execute_sync")
					return { success: true, output: "ok", exit_code: 0 };
				if (
					command === "workspace_write_file" ||
					command === "herdr_create_workspace"
				)
					return null;
				return args ?? null;
			},
		);
		const { HerdrWorkspaceCenterArea } = await import(
			"../HerdrWorkspaceCenterArea"
		);
		const view = render(<HerdrWorkspaceCenterArea naia={bridge} />);
		await waitFor(() => expect(toolHandlers.size).toBeGreaterThanOrEqual(8));

		const sessions = JSON.parse(
			String(await toolHandlers.get("skill_workspace_get_sessions")?.({})),
		);
		expect(sessions.sessions).toHaveLength(1);
		expect(await toolHandlers.get("skill_workspace_get_open_file")?.({})).toBe(
			JSON.stringify({ open: false }),
		);
		await toolHandlers.get("skill_workspace_open_file")?.({
			path: "src/App.tsx",
		});
		await waitFor(async () =>
			expect(
				JSON.parse(
					String(await toolHandlers.get("skill_workspace_get_open_file")?.({})),
				),
			).toMatchObject({ open: true, path: "/work/naia/src/App.tsx" }),
		);
		expect(
			await toolHandlers.get("skill_workspace_edit_open_file")?.({
				search: "before",
				replace: "after",
			}),
		).toBe("Edited: /work/naia/src/App.tsx");
		expect(mockInvoke).toHaveBeenCalledWith("workspace_write_file", {
			path: "/work/naia/src/App.tsx",
			content: "after after",
		});
		expect(editorReloadFile).toHaveBeenCalled();
		expect(
			await toolHandlers.get("skill_workspace_new_session")?.({
				dir: "/work/new",
			}),
		).toBe("Started Herdr space: /work/new");
		expect(mockInvoke).toHaveBeenCalledWith("herdr_create_workspace", {
			cwd: "/work/new",
			label: null,
		});
		const execute = JSON.parse(
			String(
				await toolHandlers.get("skill_workspace_execute")?.({
					dir: "Naia",
					command: "pnpm test",
				}),
			),
		);
		expect(execute).toEqual({ success: true, output: "ok", exit_code: 0 });
		expect(mockInvoke).toHaveBeenCalledWith("pty_execute_sync", {
			dir: "/work/naia",
			command: "pnpm test",
			timeout_secs: undefined,
		});
		expect(await toolHandlers.get("skill_workspace_open_file")?.({})).toBe(
			"Error: path is required",
		);
		expect(
			await toolHandlers.get("skill_workspace_focus_session")?.({
				dir: "/missing",
			}),
		).toBe("Error: Herdr space not found: /missing");
		await expect(
			toolHandlers.get("skill_workspace_execute")?.({ command: " " }),
		).rejects.toThrow("Error: command is required");

		view.unmount();
		expect(toolHandlers.size).toBe(0);
	});
});

// ─── Naia 워크스페이스 도구 계약 ─────────────────────────────────────────────
//
// 이 블록의 케이스는 2026-09-05 에 `apps/__tests__/workspace-area.test.tsx`
// 에서 옮겨 왔다. 그 파일은 지운 `WorkspaceCenterArea` 를 그려서 도구 계약을
// 쟀는데, 도구 자체는 `useHerdrWorkspaceBridge` 와 `useHerdrDocuments` 에
// 살아 있다. 화면이 없어졌다고 계약 검사까지 지우면 살아 있는 기능이
// 검사에서 빠진다 — 그래서 이름과 단정을 남기고 대상만 Herdr 로 바꿨다.
// 반환 문구가 달라진 자리(세션 없음 → no Herdr spaces, Sent to → Prompted)
// 는 Herdr 가 실제로 내는 값으로 맞췄다.

const emptySnapshot = {
	protocol: 19,
	version: "0.8.0",
	workspaces: [],
	agents: [],
};

const statusSnapshot = {
	protocol: 19,
	version: "0.8.0",
	focused_workspace_id: "w1",
	focused_pane_id: "w1:p1",
	workspaces: [
		{
			workspace_id: "w1",
			label: "naia-os",
			focused: true,
			pane_count: 1,
			tab_count: 1,
			worktree: { checkout_path: "/dev/naia-os" },
		},
		{
			workspace_id: "w2",
			label: "vllm",
			focused: false,
			pane_count: 1,
			tab_count: 1,
			worktree: { checkout_path: "/dev/vllm" },
		},
		{
			workspace_id: "w3",
			label: "test",
			focused: false,
			pane_count: 0,
			tab_count: 0,
			worktree: { checkout_path: "/dev/test" },
		},
		{
			workspace_id: "w4",
			label: "broken",
			focused: false,
			pane_count: 1,
			tab_count: 1,
			worktree: { checkout_path: "/dev/broken" },
		},
	],
	agents: [
		{
			workspace_id: "w1",
			tab_id: "w1:t1",
			pane_id: "w1:p1",
			agent: "codex",
			agent_status: "working",
			cwd: "/dev/naia-os",
			focused: true,
		},
		{
			workspace_id: "w2",
			tab_id: "w2:t1",
			pane_id: "w2:p1",
			agent: "codex",
			agent_status: "idle",
			cwd: "/dev/vllm",
			focused: false,
		},
		{
			workspace_id: "w4",
			tab_id: "w4:t1",
			pane_id: "w4:p1",
			agent: "codex",
			agent_status: "blocked",
			cwd: "/dev/broken",
			focused: false,
		},
	],
};

function respondWith(current: unknown) {
	mockInvoke.mockImplementation(async (command: string) => {
		if (command === "herdr_pty_create") return { pty_id: "pty-7", pid: 7 };
		if (command === "herdr_snapshot") return current;
		if (command === "workspace_set_root") return "/work/naia";
		if (command === "workspace_resolve_file_location")
			return "/work/naia/src/App.tsx";
		if (command === "workspace_classify_dirs")
			return [{ name: "naia", path: "/work/naia", category: "project" }];
		if (command === "pty_execute_sync")
			return { success: true, output: "ok", exit_code: 0 };
		return null;
	});
}

async function renderHerdr(naia: NaiaContextBridge = bridge) {
	const { HerdrWorkspaceCenterArea } = await import(
		"../HerdrWorkspaceCenterArea"
	);
	return render(<HerdrWorkspaceCenterArea naia={naia} />);
}

describe("Naia workspace tool contract — Herdr bridge", () => {
	afterEach(() => {
		cleanup();
		mockInvoke.mockReset();
		terminalFocus.mockReset();
		editorRevealLocation.mockReset();
		editorReloadFile.mockReset();
		toolHandlers.clear();
	});

	it("registers skill_workspace_get_sessions handler on mount", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_get_sessions")).toBe(true),
		);
	});

	it("registers skill_workspace_open_file handler on mount", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_open_file")).toBe(true),
		);
	});

	it("registers skill_workspace_classify_dirs handler on mount", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_classify_dirs")).toBe(true),
		);
		expect(
			JSON.parse(
				String(await toolHandlers.get("skill_workspace_classify_dirs")?.({})),
			),
		).toEqual([{ name: "naia", path: "/work/naia", category: "project" }]);
	});

	it("skill_workspace_get_sessions returns JSON session list", async () => {
		respondWith(emptySnapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_get_sessions")).toBe(true),
		);

		const parsed = JSON.parse(
			String(await toolHandlers.get("skill_workspace_get_sessions")?.({})),
		);
		expect(parsed).toHaveProperty("sessions");
		expect(Array.isArray(parsed.sessions)).toBe(true);
		expect(parsed).toHaveProperty("summary");
		expect(parsed.summary.total).toBe(0);
		expect(parsed.summary.active).toBe(0);
		expect(parsed.summary.idle).toBe(0);
		expect(parsed.summary.stopped).toBe(0);
		expect(parsed.summary.error).toBe(0);
		// 세션이 없을 때의 문구. Herdr 로 옮기면서 "세션 없음" 이 아니라
		// "no Herdr spaces" 를 낸다.
		expect(parsed.summary.description).toBe("no Herdr spaces");
	});

	it("skill_workspace_get_sessions counts sessions by status correctly", async () => {
		respondWith(statusSnapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_get_sessions")).toBe(true),
		);

		await waitFor(async () => {
			const p = JSON.parse(
				String(await toolHandlers.get("skill_workspace_get_sessions")?.({})),
			);
			expect(p.summary.total).toBe(4);
			expect(p.summary.active).toBe(1);
			expect(p.summary.idle).toBe(1);
			expect(p.summary.stopped).toBe(1);
			expect(p.summary.error).toBe(1);
			expect(
				p.summary.active + p.summary.idle + p.summary.stopped + p.summary.error,
			).toBe(p.summary.total);
			expect(p.summary.description).toContain("naia-os: active");
			expect(p.summary.description).toContain("vllm: idle");
			expect(p.summary.description).toContain("test: stopped");
			expect(p.summary.description).toContain("broken: error");
		});
	});

	it("skill_workspace_execute resolves a session basename dir to its absolute path", async () => {
		// 회귀: get_sessions 는 sessions[].dir 을 이름으로 준다("naia-os"). 실행은
		// 절대 경로를 요구하므로, 그 이름을 그대로 넘기면 백엔드가 거절했다.
		respondWith(statusSnapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_execute")).toBe(true),
		);

		await waitFor(async () => {
			await toolHandlers.get("skill_workspace_execute")?.({
				command: "ls -F",
				dir: "naia-os",
			});
			expect(mockInvoke).toHaveBeenCalledWith("pty_execute_sync", {
				dir: "/dev/naia-os",
				command: "ls -F",
				timeout_secs: undefined,
			});
		});
	});

	it("rejects failed PTY execution with output and exit code preserved", async () => {
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "herdr_pty_create") return { pty_id: "pty-7", pid: 7 };
			if (command === "herdr_snapshot") return snapshot;
			if (command === "workspace_set_root") return "/work/naia";
			if (command === "pty_execute_sync") {
				return {
					success: false,
					output: "rg: no matches\n",
					exit_code: 1,
				};
			}
			return null;
		});
		const appBridge = new ActiveAppBridge("workspace");
		await renderHerdr(appBridge);
		await expect(
			appBridge.callTool("skill_workspace_execute", {
				command: 'rg -l "missing" .',
				dir: "/work/naia",
			}),
		).rejects.toThrow(
			JSON.stringify({
				success: false,
				output: "rg: no matches\n",
				exit_code: 1,
			}),
		);
	});

	it("propagates PTY invoke rejection through the app bridge", async () => {
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "herdr_pty_create") return { pty_id: "pty-8", pid: 8 };
			if (command === "herdr_snapshot") return snapshot;
			if (command === "workspace_set_root") return "/work/naia";
			if (command === "pty_execute_sync") {
				throw new Error("PTY unavailable");
			}
			return null;
		});
		const appBridge = new ActiveAppBridge("workspace");
		await renderHerdr(appBridge);
		await expect(
			appBridge.callTool("skill_workspace_execute", {
				command: "pwd",
				dir: "/work/naia",
			}),
		).rejects.toThrow("PTY unavailable");
	});

	it("App API: getApi returns WorkspaceAppApi after mount, undefined after unmount", async () => {
		respondWith(snapshot);
		// 워크스페이스 앱이 레지스트리에 등록돼 있어야 updateApi 가 붙는다.
		await import("../index");
		const { appRegistry } = await import("../../../lib/app-registry");
		const { unmount } = await renderHerdr();

		await waitFor(() => expect(appRegistry.getApi("workspace")).toBeDefined());
		const api = appRegistry.getApi("workspace");
		expect(typeof api?.openFile).toBe("function");
		expect(typeof api?.focusSession).toBe("function");
		expect(typeof api?.getActiveSessions).toBe("function");
		expect(typeof api?.activateApp).toBe("function");

		unmount();
		expect(appRegistry.getApi("workspace")).toBeUndefined();
	});

	it("registers skill_workspace_focus_session handler on mount", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_focus_session")).toBe(true),
		);
	});

	it("skill_workspace_focus_session returns error when dir is missing", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_focus_session")).toBe(true),
		);

		const result = String(
			await toolHandlers.get("skill_workspace_focus_session")?.({}),
		);
		expect(result).toContain("Error");
	});

	it("skill_workspace_focus_session returns error when session not found", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_focus_session")).toBe(true),
		);

		const result = String(
			await toolHandlers.get("skill_workspace_focus_session")?.({
				dir: "nonexistent",
			}),
		);
		expect(result).toContain("Error");
		expect(result).toContain("nonexistent");
	});

	it("skill_workspace_focus_session returns Focused for the matching space", async () => {
		respondWith(statusSnapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_focus_session")).toBe(true),
		);

		await waitFor(async () => {
			expect(
				await toolHandlers.get("skill_workspace_focus_session")?.({
					dir: "naia-os",
				}),
			).toBe("Focused: naia-os");
		});
		expect(mockInvoke).toHaveBeenCalledWith("herdr_focus_workspace", {
			workspaceId: "w1",
		});
	});

	it("skill_workspace_open_file updates editor filepath", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_open_file")).toBe(true),
		);

		const result = String(
			await toolHandlers.get("skill_workspace_open_file")?.({
				path: "src/App.tsx",
			}),
		);
		expect(result).toContain("Opened");
		expect(result).toContain("App.tsx");
		await waitFor(() =>
			expect(screen.getByTestId("file-tree-selection")).toHaveTextContent(
				"/work/naia/src/App.tsx",
			),
		);
	});

	it("registers skill_workspace_send_to_session handler on mount", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_send_to_session")).toBe(true),
		);
	});

	it("skill_workspace_send_to_session returns error when dir or text is missing", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_send_to_session")).toBe(true),
		);

		const send = toolHandlers.get("skill_workspace_send_to_session");
		expect(String(await send?.({}))).toContain("Error");
		expect(String(await send?.({ dir: "/work/naia" }))).toContain("Error");
		expect(String(await send?.({ text: "hello\n" }))).toContain("Error");
	});

	it("skill_workspace_send_to_session returns error when no session is found", async () => {
		respondWith(snapshot);
		await renderHerdr();
		await waitFor(() =>
			expect(toolHandlers.has("skill_workspace_send_to_session")).toBe(true),
		);

		const result = String(
			await toolHandlers.get("skill_workspace_send_to_session")?.({
				dir: "/dev/nonexistent",
				text: "hello",
			}),
		);
		expect(result).toContain("Error");
		expect(result).toContain("nonexistent");
	});
});
