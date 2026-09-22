// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHerdrWorkspaceBridge } from "../useHerdrWorkspaceBridge";
import type { EditorHandle } from "../Editor";
import type { TerminalHandle } from "../Terminal";
import type { HerdrSnapshot, HerdrWorkspace } from "../herdr";
import { writePty } from "../pty-ipc";

vi.mock("../pty-ipc", () => ({
	writePty: vi.fn(async () => {}),
}));

const defaultInvoke = async (cmd: string, args: any) => {
	if (cmd === "workspace_read_file") {
		return `content of ${args.path}`;
	}
	if (cmd === "workspace_agent_read_open_file") {
		return {
			path: args.path,
			content: "line 1\nline 2\n",
			sha256: "sha-line-1-2",
			size: 14,
		};
	}
	if (cmd === "workspace_agent_write_open_file") {
		return {
			path: args.path,
			content: args.content,
			sha256: "sha-written",
			size: args.content?.length ?? 0,
		};
	}
	return null;
};

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

describe("useHerdrWorkspaceBridge (#680 Epics 8 & 9)", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockImplementation(defaultInvoke);
		vi.mocked(invoke).mockClear();
	});

	function createBridge(options?: { initialEditor?: EditorHandle | null }) {
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
			getText: vi.fn(() => "line 1\nline 2\n"),
			getFilePath: vi.fn(() => "/work/root/src/index.ts"),
			flushPendingSave: vi.fn(() => false),
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

		const editorRef = {
			current:
				options?.initialEditor !== undefined
					? options.initialEditor
					: mockEditor,
		};
		const terminalRef = { current: mockTerminal };
		const snapshotRef = { current: mockSnapshot };

		const focusWorkspace = vi.fn(async () => {});
		const openResolvedFile = vi.fn(async (path: string) => `/resolved/${path}`);
		const closeDoc = vi.fn();
		const showHerdr = vi.fn();
		const setSurface = vi.fn();
		const setEditProposal = vi.fn();
		const findWorkspace = vi.fn((target: string) =>
			mockSnapshot.workspaces.find(
				(w) => w.workspace_id === target || w.label === target,
			),
		);

		const initialProps = {
			openFilePath: "/work/root/src/index.ts",
			openDocs: ["/work/root/src/index.ts"],
			pty: { pty_id: "pty-live-1", pid: 1234 },
		};

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
					setEditProposal,
				}),
			{
				initialProps,
			},
		);

		return {
			toolHandlers,
			mockNaia,
			mockEditor,
			editorRef,
			mockTerminal,
			focusWorkspace,
			openResolvedFile,
			closeDoc,
			showHerdr,
			setSurface,
			setEditProposal,
			findWorkspace,
			hook,
			initialProps,
		};
	}

	it("skill_workspace_get_open_file includes openDocs, cursor, sha256, and unsavedEditorChanges", async () => {
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
			content: "line 1\nline 2\n",
			sha256: "sha-line-1-2",
			size: 14,
			unsavedEditorChanges: false,
		});
	});

	it("skill_workspace_get_open_file returns error and no content on sensitive read error", async () => {
		vi.mocked(invoke).mockImplementationOnce(async (cmd: string) => {
			if (cmd === "workspace_agent_read_open_file") {
				throw new Error("denied: path is sensitive (denylisted)");
			}
			return null;
		});
		const { toolHandlers } = createBridge();
		const handler = toolHandlers.get("skill_workspace_get_open_file");
		const result = JSON.parse(await handler!({}));
		expect(result).toMatchObject({
			open: true,
			path: "/work/root/src/index.ts",
			error: "Error: denied: path is sensitive (denylisted)",
		});
		expect(result.content).toBeUndefined();
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

	it("edit approve sets proposal, writes on approve, and calls reloadFile", async () => {
		const { toolHandlers, hook, setEditProposal, mockEditor } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");
		expect(handler).toBeDefined();

		const editPromise = handler!({
			path: "/work/root/src/index.ts",
			oldText: "line 2",
			newText: "line 2 modified",
		});

		await Promise.resolve();
		expect(setEditProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/work/root/src/index.ts",
				added: 1,
				removed: 1,
			}),
		);

		const proposal = setEditProposal.mock.calls[0][0];
		hook.result.current.approveEdit(proposal.id);
		const result = JSON.parse(await editPromise);
		expect(result.status).toBe("applied");
		expect(result.path).toBe("/work/root/src/index.ts");
		expect(invoke).toHaveBeenCalledWith("workspace_agent_write_open_file", {
			path: "/work/root/src/index.ts",
			content: "line 1\nline 2 modified\n",
			expectedSha256: "sha-line-1-2",
		});
		expect(mockEditor.reloadFile).toHaveBeenCalledTimes(1);
	});

	it("edit reject results in rejected and does not invoke write", async () => {
		const { toolHandlers, hook, setEditProposal } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const editPromise = handler!({
			path: "/work/root/src/index.ts",
			oldText: "line 2",
			newText: "line 2 modified",
		});
		await Promise.resolve();

		const proposal = setEditProposal.mock.calls[0][0];
		hook.result.current.rejectEdit(proposal.id);
		const result = JSON.parse(await editPromise);
		expect(result.status).toBe("rejected");
		expect(invoke).not.toHaveBeenCalledWith(
			"workspace_agent_write_open_file",
			expect.anything(),
		);
	});

	it("approveEdit with wrong id leaves edit pending and never writes", async () => {
		const { toolHandlers, hook, setEditProposal } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const editPromise = handler!({
			path: "/work/root/src/index.ts",
			content: "new content",
		});
		await Promise.resolve();
		const proposal = setEditProposal.mock.calls[0][0];

		hook.result.current.approveEdit("wrong-id");
		await Promise.resolve();

		expect(invoke).not.toHaveBeenCalledWith(
			"workspace_agent_write_open_file",
			expect.anything(),
		);

		hook.result.current.approveEdit(proposal.id);
		const result = JSON.parse(await editPromise);
		expect(result.status).toBe("applied");
	});

	it("stale disk rejects write and returns stale status", async () => {
		vi.mocked(invoke).mockImplementationOnce(async (cmd: string, args: any) => {
			if (cmd === "workspace_agent_read_open_file") {
				return {
					path: args.path,
					content: "line 1\nline 2\n",
					sha256: "sha-1",
					size: 14,
				};
			}
			return null;
		});
		vi.mocked(invoke).mockImplementationOnce(async (cmd: string) => {
			if (cmd === "workspace_agent_write_open_file") {
				throw new Error("stale: the file changed on disk after the preview");
			}
			return null;
		});

		const { toolHandlers, hook, setEditProposal } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const editPromise = handler!({
			path: "/work/root/src/index.ts",
			content: "new content",
		});
		await Promise.resolve();

		const proposal = setEditProposal.mock.calls[0][0];
		hook.result.current.approveEdit(proposal.id);
		const result = JSON.parse(await editPromise);
		expect(result.status).toBe("stale");
		expect(result.reason).toContain("stale:");
	});

	it("stale editor text before approve returns stale and does not write", async () => {
		const { toolHandlers, hook, mockEditor, setEditProposal } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const editPromise = handler!({
			path: "/work/root/src/index.ts",
			content: "new content",
		});
		await Promise.resolve();

		vi.mocked(mockEditor.getText).mockReturnValue(
			"line 1\nuser typed something\n",
		);

		const proposal = setEditProposal.mock.calls[0][0];
		hook.result.current.approveEdit(proposal.id);
		const result = JSON.parse(await editPromise);
		expect(result.status).toBe("stale");
		expect(invoke).not.toHaveBeenCalledWith(
			"workspace_agent_write_open_file",
			expect.anything(),
		);
	});

	it("wrong path or no open file returns invalid without invoking read/write", async () => {
		const { toolHandlers } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const resWrong = JSON.parse(
			await handler!({ path: "/different/file.ts", content: "foo" }),
		);
		expect(resWrong.status).toBe("invalid");
		expect(invoke).not.toHaveBeenCalledWith(
			"workspace_agent_read_open_file",
			expect.anything(),
		);

		const bridgeNoOpen = createBridge();
		bridgeNoOpen.hook.rerender({
			...bridgeNoOpen.initialProps,
			openFilePath: "",
		});
		const handlerNoOpen = bridgeNoOpen.toolHandlers.get(
			"skill_workspace_edit_open_file",
		);
		const resNoOpen = JSON.parse(
			await handlerNoOpen!({
				path: "/work/root/src/index.ts",
				content: "foo",
			}),
		);
		expect(resNoOpen.status).toBe("invalid");
	});

	it("sensitive path on read returns denied and sets no proposal", async () => {
		vi.mocked(invoke).mockImplementationOnce(async (cmd: string) => {
			if (cmd === "workspace_agent_read_open_file") {
				throw new Error("denied: path is sensitive (denylisted)");
			}
			return null;
		});

		const { toolHandlers, setEditProposal } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const result = JSON.parse(
			await handler!({ path: "/work/root/src/index.ts", content: "foo" }),
		);
		expect(result.status).toBe("denied");
		expect(result.reason).toContain("denied:");
		expect(setEditProposal).not.toHaveBeenCalled();
	});

	it("open file switched while pending rejects as superseded without writing", async () => {
		const { toolHandlers, hook, initialProps } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const editPromise = handler!({
			path: "/work/root/src/index.ts",
			content: "foo",
		});
		await Promise.resolve();

		hook.rerender({ ...initialProps, openFilePath: "/work/root/src/other.ts" });

		const result = JSON.parse(await editPromise);
		expect(result.status).toBe("rejected");
		expect(result.reason).toContain("changed before approval");
		expect(invoke).not.toHaveBeenCalledWith(
			"workspace_agent_write_open_file",
			expect.anything(),
		);
	});

	it("timeout resolves rejected without writing", async () => {
		vi.useFakeTimers();
		try {
			const { toolHandlers } = createBridge();
			const handler = toolHandlers.get("skill_workspace_edit_open_file");

			const editPromise = handler!({
				path: "/work/root/src/index.ts",
				content: "foo",
			});
			await vi.advanceTimersByTimeAsync(50_000);

			const result = JSON.parse(await editPromise);
			expect(result.status).toBe("rejected");
			expect(result.reason).toContain("no approval within 50 s");
			expect(invoke).not.toHaveBeenCalledWith(
				"workspace_agent_write_open_file",
				expect.anything(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("second concurrent edit while one is pending returns invalid", async () => {
		const { toolHandlers, hook, setEditProposal } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const firstPromise = handler!({
			path: "/work/root/src/index.ts",
			content: "first edit",
		});
		await Promise.resolve();

		const secondResult = JSON.parse(
			await handler!({
				path: "/work/root/src/index.ts",
				content: "second edit",
			}),
		);
		expect(secondResult.status).toBe("invalid");
		expect(secondResult.reason).toContain(
			"another edit is waiting for approval",
		);

		const proposal = setEditProposal.mock.calls[0][0];
		hook.result.current.rejectEdit(proposal.id);
		await firstPromise;
	});

	it("two calls started without awaiting: second returns invalid and sets exactly one proposal", async () => {
		const { toolHandlers, hook, setEditProposal } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const p1 = handler!({
			path: "/work/root/src/index.ts",
			content: "first content",
		});
		const p2 = handler!({
			path: "/work/root/src/index.ts",
			content: "second content",
		});

		const res2 = JSON.parse(await p2);
		expect(res2.status).toBe("invalid");
		expect(res2.reason).toContain("another edit is waiting for approval");

		await Promise.resolve();
		expect(setEditProposal).toHaveBeenCalledTimes(1);

		const proposal = setEditProposal.mock.calls[0][0];
		hook.result.current.rejectEdit(proposal.id);
		await p1;
	});

	it("non-bypass behavioural test: reject, wrong-id timeout, and timeout produce 0 writes; only approveEdit(correctId) produces 1 write", async () => {
		vi.useFakeTimers();
		try {
			const { toolHandlers, hook, setEditProposal } = createBridge();
			const handler = toolHandlers.get("skill_workspace_edit_open_file");

			// 1. rejectEdit(id)
			const p1 = handler!({
				path: "/work/root/src/index.ts",
				content: "content 1",
			});
			await Promise.resolve();
			const prop1 = setEditProposal.mock.calls[0][0];
			hook.result.current.rejectEdit(prop1.id);
			const r1 = JSON.parse(await p1);
			expect(r1.status).toBe("rejected");

			// 2. approveEdit("wrong") then times out
			setEditProposal.mockClear();
			const p2 = handler!({
				path: "/work/root/src/index.ts",
				content: "content 2",
			});
			await Promise.resolve();
			hook.result.current.approveEdit("wrong");
			await vi.advanceTimersByTimeAsync(50_000);
			const r2 = JSON.parse(await p2);
			expect(r2.status).toBe("rejected");

			// 3. timeout directly
			setEditProposal.mockClear();
			const p3 = handler!({
				path: "/work/root/src/index.ts",
				content: "content 3",
			});
			await vi.advanceTimersByTimeAsync(50_000);
			const r3 = JSON.parse(await p3);
			expect(r3.status).toBe("rejected");

			// Verify 0 writes so far
			expect(invoke).not.toHaveBeenCalledWith(
				"workspace_agent_write_open_file",
				expect.anything(),
			);

			// 4. approveEdit(correctId) -> produces exactly 1 write
			setEditProposal.mockClear();
			const p4 = handler!({
				path: "/work/root/src/index.ts",
				content: "content 4",
			});
			await Promise.resolve();
			const prop4 = setEditProposal.mock.calls[0][0];
			hook.result.current.approveEdit(prop4.id);
			const r4 = JSON.parse(await p4);
			expect(r4.status).toBe("applied");

			const writeCalls = vi.mocked(invoke).mock.calls.filter(
				(call) => call[0] === "workspace_agent_write_open_file",
			);
			expect(writeCalls).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("write mock rejects with new Error('stale: ...') returns status stale", async () => {
		vi.mocked(invoke).mockImplementationOnce(async (cmd: string, args: any) => {
			if (cmd === "workspace_agent_read_open_file") {
				return {
					path: args.path,
					content: "line 1\nline 2\n",
					sha256: "sha-1",
					size: 14,
				};
			}
			return null;
		});
		vi.mocked(invoke).mockImplementationOnce(async (cmd: string) => {
			if (cmd === "workspace_agent_write_open_file") {
				throw new Error("stale: the file changed on disk after the preview");
			}
			return null;
		});

		const { toolHandlers, hook, setEditProposal } = createBridge();
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const editPromise = handler!({
			path: "/work/root/src/index.ts",
			content: "new content",
		});
		await Promise.resolve();

		const proposal = setEditProposal.mock.calls[0][0];
		hook.result.current.approveEdit(proposal.id);
		const result = JSON.parse(await editPromise);
		expect(result.status).toBe("stale");
		expect(result.reason).toBe("stale: the file changed on disk after the preview");
	});

	it("editorRef initially null, set after 300 ms (fake timers) -> proposal appears", async () => {
		vi.useFakeTimers();
		try {
			const { toolHandlers, mockEditor, setEditProposal, editorRef, hook } =
				createBridge({ initialEditor: null });
			const handler = toolHandlers.get("skill_workspace_edit_open_file");

			const editPromise = handler!({
				path: "/work/root/src/index.ts",
				content: "new content",
			});

			// Advance 200 ms - still null
			await vi.advanceTimersByTimeAsync(200);
			expect(setEditProposal).not.toHaveBeenCalled();

			// At 300 ms, editor becomes ready
			editorRef.current = mockEditor;
			await vi.advanceTimersByTimeAsync(100);

			expect(setEditProposal).toHaveBeenCalledTimes(1);
			const proposal = setEditProposal.mock.calls[0][0];
			expect(proposal.path).toBe("/work/root/src/index.ts");

			// Clean up pending proposal
			hook.result.current.rejectEdit(proposal.id);
			await editPromise;
		} finally {
			vi.useRealTimers();
		}
	});

	it("editor whose getText returns null (preview mode) -> proposal appears, approve -> write happens once, status applied", async () => {
		const previewEditor: EditorHandle = {
			reloadFile: vi.fn(),
			revealLocation: vi.fn(),
			getCursorLocation: vi.fn(() => null),
			getText: vi.fn(() => null),
			getFilePath: vi.fn(() => "/work/root/src/index.ts"),
			flushPendingSave: vi.fn(() => false),
		};
		const { toolHandlers, hook, setEditProposal } = createBridge({
			initialEditor: previewEditor,
		});
		const handler = toolHandlers.get("skill_workspace_edit_open_file");

		const editPromise = handler!({
			path: "/work/root/src/index.ts",
			content: "new content",
		});
		await Promise.resolve();

		expect(setEditProposal).toHaveBeenCalledTimes(1);
		const proposal = setEditProposal.mock.calls[0][0];
		expect(proposal.path).toBe("/work/root/src/index.ts");

		hook.result.current.approveEdit(proposal.id);
		const result = JSON.parse(await editPromise);

		expect(result.status).toBe("applied");
		expect(previewEditor.reloadFile).toHaveBeenCalled();
		const writeCalls = vi.mocked(invoke).mock.calls.filter(
			(call) => call[0] === "workspace_agent_write_open_file",
		);
		expect(writeCalls).toHaveLength(1);
	});

	it("getText returns empty string first and base.content after 300 ms -> proposal appears (no stale)", async () => {
		vi.useFakeTimers();
		try {
			let text = "";
			const loadingEditor: EditorHandle = {
				reloadFile: vi.fn(),
				revealLocation: vi.fn(),
				getCursorLocation: vi.fn(() => null),
				getText: vi.fn(() => text),
				getFilePath: vi.fn(() => "/work/root/src/index.ts"),
				flushPendingSave: vi.fn(() => false),
			};
			const { toolHandlers, hook, setEditProposal } = createBridge({
				initialEditor: loadingEditor,
			});
			const handler = toolHandlers.get("skill_workspace_edit_open_file");

			const editPromise = handler!({
				path: "/work/root/src/index.ts",
				content: "new content",
			});

			// Advance 200 ms - still ""
			await vi.advanceTimersByTimeAsync(200);
			expect(setEditProposal).not.toHaveBeenCalled();

			// At 300 ms, getText returns base.content
			text = "line 1\nline 2\n";
			await vi.advanceTimersByTimeAsync(100);

			expect(setEditProposal).toHaveBeenCalledTimes(1);
			const proposal = setEditProposal.mock.calls[0][0];
			expect(proposal.path).toBe("/work/root/src/index.ts");

			// Clean up pending proposal
			hook.result.current.rejectEdit(proposal.id);
			const result = JSON.parse(await editPromise);
			expect(result.status).toBe("rejected");
		} finally {
			vi.useRealTimers();
		}
	});
});
