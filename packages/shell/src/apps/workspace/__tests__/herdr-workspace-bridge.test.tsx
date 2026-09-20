// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHerdrWorkspaceBridge } from "../useHerdrWorkspaceBridge";
import type { EditorHandle } from "../Editor";
import type { TerminalHandle } from "../Terminal";
import type { HerdrSnapshot, HerdrWorkspace } from "../herdr";
import { writePty } from "../pty-ipc";

vi.mock("../pty-ipc", () => ({
	writePty: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, args: any) => {
		if (cmd === "workspace_read_file") {
			return `content of ${args.path}`;
		}
		return null;
	}),
}));

describe("useHerdrWorkspaceBridge (#680 Epics 8 & 9)", () => {
	function createBridge() {
		const toolHandlers = new Map<string, (args: any) => Promise<any> | any>();
		const mockNaia = {
			pushContext: vi.fn(),
			onToolCall: vi.fn((name: string, handler: any) => {
				toolHandlers.set(name, handler);
				return () => toolHandlers.delete(name);
			}),
		} as any;

		const mockEditor: EditorHandle = {
			reloadFile: vi.fn(),
			revealLocation: vi.fn(),
			getCursorLocation: vi.fn(() => ({
				line: 42,
				column: 10,
				selectedText: "hello world",
			})),
		};

		const mockTerminal: TerminalHandle = {
			focus: vi.fn(),
			getBufferText: vi.fn((maxLines?: number) =>
				maxLines === 2 ? "line 3\nline 4" : "line 1\nline 2\nline 3\nline 4",
			),
		};

		const mockSnapshot: HerdrSnapshot = {
			protocol: 19,
			version: "0.8.0",
			focused_workspace_id: "space-alpha",
			focused_pane_id: "pane-1",
			workspaces: [
				{
					workspace_id: "space-alpha",
					label: "Alpha Space",
					panes: [],
				} as unknown as HerdrWorkspace,
			],
			agents: [],
		};

		const editorRef = { current: mockEditor };
		const terminalRef = { current: mockTerminal };
		const snapshotRef = { current: mockSnapshot };

		const focusWorkspace = vi.fn(async () => {});
		const openResolvedFile = vi.fn(async (path: string) => `/resolved/${path}`);
		const closeDoc = vi.fn();
		const showHerdr = vi.fn();
		const setSurface = vi.fn();
		const findWorkspace = vi.fn((target: string) =>
			mockSnapshot.workspaces.find(
				(w) => w.workspace_id === target || w.label === target,
			),
		);

		const hook = renderHook(
			(props: any) =>
				useHerdrWorkspaceBridge({
					naia: mockNaia,
					snapshotRef,
					editorRef,
					terminalRef,
					workspaceRoot: "/work/root",
					openFilePath: props.openFilePath ?? "/work/root/src/index.ts",
					openDocs: props.openDocs ?? ["/work/root/src/index.ts"],
					pty: props.pty ?? { pty_id: "pty-live-1", pid: 1234 },
					findWorkspace,
					focusWorkspace,
					openResolvedFile,
					closeDoc,
					refreshSnapshot: vi.fn(async () => {}),
					showHerdr,
					setSurface,
				}),
			{
				initialProps: {
					openFilePath: "/work/root/src/index.ts",
					openDocs: ["/work/root/src/index.ts"],
					pty: { pty_id: "pty-live-1", pid: 1234 },
				},
			},
		);

		return {
			toolHandlers,
			mockNaia,
			mockEditor,
			mockTerminal,
			focusWorkspace,
			openResolvedFile,
			closeDoc,
			showHerdr,
			setSurface,
			findWorkspace,
			hook,
		};
	}

	it("skill_workspace_get_open_file includes openDocs and cursor location", async () => {
		const { toolHandlers } = createBridge();
		const handler = toolHandlers.get("skill_workspace_get_open_file");
		expect(handler).toBeDefined();

		const result = JSON.parse(await handler!({}));
		expect(result).toMatchObject({
			open: true,
			path: "/work/root/src/index.ts",
			openDocs: ["/work/root/src/index.ts"],
			cursor: {
				line: 42,
				column: 10,
				selectedText: "hello world",
			},
			content: "content of /work/root/src/index.ts",
		});
	});

	it("skill_workspace_close_file closes active or specified document", async () => {
		const { toolHandlers, closeDoc } = createBridge();
		const handler = toolHandlers.get("skill_workspace_close_file");
		expect(handler).toBeDefined();

		// Close without path -> closes current active file
		const res1 = await handler!({});
		expect(closeDoc).toHaveBeenCalledWith("/work/root/src/index.ts");
		expect(res1).toBe("Closed: /work/root/src/index.ts");

		// Close with specific path
		const res2 = await handler!({ path: "/work/root/src/other.ts" });
		expect(closeDoc).toHaveBeenCalledWith("/work/root/src/other.ts");
		expect(res2).toBe("Closed: /work/root/src/other.ts");
	});

	it("skill_workspace_set_surface switches between herdr and viewer", async () => {
		const { toolHandlers, showHerdr, setSurface } = createBridge();
		const handler = toolHandlers.get("skill_workspace_set_surface");
		expect(handler).toBeDefined();

		const res1 = await handler!({ surface: "herdr" });
		expect(showHerdr).toHaveBeenCalledTimes(1);
		expect(res1).toBe("Switched surface to herdr");

		const res2 = await handler!({ surface: "viewer" });
		expect(setSurface).toHaveBeenCalledWith("viewer");
		expect(res2).toBe("Switched surface to viewer");

		const res3 = await handler!({ surface: "invalid" });
		expect(res3).toContain("Error: invalid surface");
	});

	it("skill_workspace_focus_space focuses target workspace by ID or label", async () => {
		const { toolHandlers, focusWorkspace } = createBridge();
		const handler = toolHandlers.get("skill_workspace_focus_space");
		expect(handler).toBeDefined();

		const res = await handler!({ target: "Alpha Space" });
		expect(focusWorkspace).toHaveBeenCalledWith("space-alpha");
		expect(res).toBe("Focused workspace: Alpha Space");
	});

	it("skill_workspace_terminal_exec writes command to active PTY and switches to Herdr", async () => {
		const { toolHandlers, showHerdr } = createBridge();
		const handler = toolHandlers.get("skill_workspace_terminal_exec");
		expect(handler).toBeDefined();

		const res = await handler!({ command: "pnpm test", showTerminal: true });
		expect(showHerdr).toHaveBeenCalledTimes(1);
		expect(writePty).toHaveBeenCalledWith("pty-live-1", "pnpm test\n");
		expect(res).toBe("Command sent to Herdr terminal: pnpm test");
	});

	it("skill_workspace_get_terminal_output extracts buffer text from terminal handle", async () => {
		const { toolHandlers, mockTerminal } = createBridge();
		const handler = toolHandlers.get("skill_workspace_get_terminal_output");
		expect(handler).toBeDefined();

		const res = JSON.parse(await handler!({ lines: 2 }));
		expect(mockTerminal.getBufferText).toHaveBeenCalledWith(2);
		expect(res.output).toBe("line 3\nline 4");
		expect(res.lines).toBe(2);
	});
});
