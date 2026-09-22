import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { type AppCenterProps, appRegistry } from "../../lib/app-registry";
import { useAppStore } from "../../stores/app";
import type { EditorHandle } from "./Editor";
import type { TerminalHandle } from "./Terminal";
import type { WorkspaceAppApi } from "./types";
import {
	type HerdrSnapshot,
	type HerdrWorkspace,
	snapshotSessions,
} from "./herdr";
import {
	OPEN_FILE_EDIT_APPROVAL_TIMEOUT_MS,
	type OpenFileEditArgs,
	type OpenFileEditProposal,
	applyOpenFileEdit,
	diffLines,
	editResult,
} from "./open-file-edit";
import { writePty } from "./pty-ipc";
import type { PtyCreated } from "./useHerdrRuntime";

interface AgentOpenFile {
	path: string;
	content: string;
	sha256: string;
	size: number;
}

interface HerdrWorkspaceBridgeOptions {
	naia: AppCenterProps["naia"];
	snapshotRef: RefObject<HerdrSnapshot | null>;
	editorRef: RefObject<EditorHandle | null>;
	terminalRef?: RefObject<TerminalHandle | null>;
	workspaceRoot: string;
	openFilePath: string;
	openDocs?: string[];
	pty?: PtyCreated | null;
	findWorkspace: (target: string) => HerdrWorkspace | undefined;
	focusWorkspace: (workspaceId: string) => Promise<void>;
	openResolvedFile: (path: string) => Promise<string>;
	closeDoc?: (path: string) => void;
	refreshSnapshot: () => Promise<void>;
	showHerdr: () => void;
	setSurface?: (surface: "herdr" | "viewer") => void;
	setEditProposal?: (proposal: OpenFileEditProposal | null) => void;
}

export function useHerdrWorkspaceBridge({
	naia,
	snapshotRef,
	editorRef,
	terminalRef,
	workspaceRoot: _workspaceRoot,
	openFilePath,
	openDocs = [],
	pty = null,
	findWorkspace,
	focusWorkspace,
	openResolvedFile,
	closeDoc,
	refreshSnapshot: _refreshSnapshot,
	showHerdr,
	setSurface,
	setEditProposal,
}: HerdrWorkspaceBridgeOptions) {
	const openFilePathRef = useRef(openFilePath);
	openFilePathRef.current = openFilePath;
	const openDocsRef = useRef(openDocs);
	openDocsRef.current = openDocs;
	const closeDocRef = useRef(closeDoc);
	closeDocRef.current = closeDoc;
	const showHerdrRef = useRef(showHerdr);
	showHerdrRef.current = showHerdr;
	const setSurfaceRef = useRef(setSurface);
	setSurfaceRef.current = setSurface;
	const setEditProposalRef = useRef(setEditProposal);
	setEditProposalRef.current = setEditProposal;
	const findWorkspaceRef = useRef(findWorkspace);
	findWorkspaceRef.current = findWorkspace;
	const focusWorkspaceRef = useRef(focusWorkspace);
	focusWorkspaceRef.current = focusWorkspace;
	const ptyRef = useRef(pty);
	ptyRef.current = pty;

	const pendingRef = useRef<{
		id: string;
		path: string;
		resolve: (decision: "approve" | "reject" | "timeout" | "superseded") => void;
	} | null>(null);
	const busyRef = useRef(false);

	const approveEdit = useCallback((id: string) => {
		if (pendingRef.current && pendingRef.current.id === id) {
			pendingRef.current.resolve("approve");
		}
	}, []);

	const rejectEdit = useCallback((id: string) => {
		if (pendingRef.current && pendingRef.current.id === id) {
			pendingRef.current.resolve("reject");
		}
	}, []);

	useEffect(() => {
		if (pendingRef.current && openFilePath !== pendingRef.current.path) {
			pendingRef.current.resolve("superseded");
		}
	}, [openFilePath]);

	useEffect(() => {
		return () => {
			if (pendingRef.current) {
				pendingRef.current.resolve("superseded");
			}
		};
	}, []);

	useEffect(() => {
		appRegistry.updateApi("workspace", {
			openFile: (path: string) => void openResolvedFile(path),
			focusSession: (dir: string) => {
				const space = findWorkspace(dir);
				if (space) void focusWorkspace(space.workspace_id);
			},
			getActiveSessions: () => snapshotSessions(snapshotRef.current),
			activateApp: () => useAppStore.getState().setActiveApp("workspace"),
		} satisfies WorkspaceAppApi);
		return () => appRegistry.updateApi("workspace", undefined);
	}, [findWorkspace, focusWorkspace, openResolvedFile, snapshotRef]);

	useEffect(() => {
		const unsubscribers = [
			naia.onToolCall("skill_workspace_get_sessions", () => {
				const current = snapshotSessions(snapshotRef.current);
				return JSON.stringify({
					sessions: current,
					summary: {
						total: current.length,
						active: current.filter((item) => item.status === "active").length,
						idle: current.filter((item) => item.status === "idle").length,
						stopped: current.filter((item) => item.status === "stopped").length,
						error: current.filter((item) => item.status === "error").length,
						description: current.length
							? current.map((item) => `${item.dir}: ${item.status}`).join(", ")
							: "no Herdr spaces",
					},
				});
			}),
			naia.onToolCall("skill_workspace_open_file", async (args) => {
				const path = String(args.path ?? "");
				if (!path) return "Error: path is required";
				try {
					return `Opened: ${await openResolvedFile(path)}`;
				} catch (error) {
					return `Error: ${String(error)}`;
				}
			}),
			naia.onToolCall("skill_workspace_get_open_file", async () => {
				const docs = openDocsRef.current ?? [];
				const currentPath = openFilePathRef.current;
				if (!currentPath) {
					return JSON.stringify({ open: false, openDocs: docs });
				}
				const cursor = editorRef.current?.getCursorLocation() ?? null;
				try {
					const file = await invoke<AgentOpenFile>(
						"workspace_agent_read_open_file",
						{ path: currentPath },
					);
					const editorText = editorRef.current?.getText() ?? null;
					const unsavedEditorChanges =
						editorText !== null && editorText !== file.content;
					return JSON.stringify({
						open: true,
						path: currentPath,
						openDocs: docs,
						cursor,
						content: file.content,
						sha256: file.sha256,
						size: file.size,
						unsavedEditorChanges,
					});
				} catch (error) {
					return JSON.stringify({
						open: true,
						path: currentPath,
						openDocs: docs,
						cursor,
						error: String(error),
					});
				}
			}),
			naia.onToolCall("skill_workspace_edit_open_file", async (args) => {
				const path = String(args.path ?? "").trim();
				const current = openFilePathRef.current;
				if (!current) {
					return editResult("invalid", {
						reason: "no file is open in the editor",
					});
				}
				if (path !== current) {
					return editResult("invalid", {
						reason: "path is not the file open in the editor",
						openFilePath: current,
					});
				}
				if (busyRef.current) {
					return editResult("invalid", {
						reason: "another edit is waiting for approval",
					});
				}
				busyRef.current = true;
				try {
					if (pendingRef.current) {
						return editResult("invalid", {
							reason: "another edit is waiting for approval",
						});
					}
					let editor = editorRef.current;
					const isEditorReady = (ed: typeof editor) =>
						Boolean(ed && ed.getFilePath() === path);

					if (!isEditorReady(editor)) {
						const pollIntervalMs = 100;
						const maxWaitMs = 3000;
						let waitedMs = 0;
						while (waitedMs < maxWaitMs) {
							await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
							waitedMs += pollIntervalMs;
							editor = editorRef.current;
							if (isEditorReady(editor)) {
								break;
							}
						}
					}

					if (!editor || editor.getFilePath() !== path) {
						return editResult("error", {
							reason: "editor is not showing the open file",
						});
					}
					if (editor.flushPendingSave()) {
						return editResult("stale", {
							reason:
								"the user has unsaved edits in this file; ask again after it saves",
						});
					}
					let base: AgentOpenFile;
					try {
						base = await invoke<AgentOpenFile>(
							"workspace_agent_read_open_file",
							{ path },
						);
					} catch (error) {
						const msg = (
							error instanceof Error ? error.message : String(error)
						).replace(/^Error:\s*/, "");
						return editResult("denied", { reason: msg });
					}
					let text = editor.getText();
					if (text !== null && text !== base.content) {
						const pollIntervalMs = 100;
						const maxWaitMs = 1500;
						let waitedMs = 0;
						while (waitedMs < maxWaitMs) {
							await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
							waitedMs += pollIntervalMs;
							const currentEditor = editorRef.current;
							if (currentEditor && currentEditor.getFilePath() === path) {
								editor = currentEditor;
								text = currentEditor.getText();
								if (text === null || text === base.content) {
									break;
								}
							}
						}
						if (text !== null && text !== base.content) {
							return editResult("stale", {
								reason: "the editor content differs from disk",
							});
						}
					}
					const editArgs: OpenFileEditArgs = {
						path,
						oldText:
							typeof args.oldText === "string" ? args.oldText : undefined,
						newText:
							typeof args.newText === "string" ? args.newText : undefined,
						content:
							typeof args.content === "string" ? args.content : undefined,
					};
					const applied = applyOpenFileEdit(base.content, editArgs);
					if (!applied.ok) {
						return editResult("invalid", { reason: applied.error });
					}
					const next = applied.next;
					const diff = diffLines(base.content, next);
					const id =
						typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
							? crypto.randomUUID()
							: String(Date.now());
					const timeoutMs = OPEN_FILE_EDIT_APPROVAL_TIMEOUT_MS;
					const expiresAt = Date.now() + timeoutMs;
					setSurfaceRef.current?.("viewer");
					setEditProposalRef.current?.({
						id,
						path,
						expiresAt,
						timeoutMs,
						...diff,
					});

					let decision: "approve" | "reject" | "timeout" | "superseded";
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						decision = await new Promise<
							"approve" | "reject" | "timeout" | "superseded"
						>((resolve) => {
							timer = setTimeout(() => {
								resolve("timeout");
							}, OPEN_FILE_EDIT_APPROVAL_TIMEOUT_MS);
							pendingRef.current = {
								id,
								path,
								resolve: (val) => {
									if (timer) clearTimeout(timer);
									resolve(val);
								},
							};
						});
					} finally {
						if (timer) clearTimeout(timer);
						pendingRef.current = null;
						setEditProposalRef.current?.(null);
					}

					if (decision === "reject") {
						return editResult("rejected", {
							reason: "the user rejected the edit; nothing was written",
						});
					}
					if (decision === "timeout") {
						return editResult("rejected", {
							reason: `no approval within ${OPEN_FILE_EDIT_APPROVAL_TIMEOUT_MS / 1000} s; nothing was written`,
						});
					}
					if (decision === "superseded") {
						return editResult("rejected", {
							reason: "the open file changed before approval; nothing was written",
						});
					}

					// approve
					if (
						openFilePathRef.current !== path ||
						editorRef.current?.getFilePath() !== path
					) {
						return editResult("stale", {
							reason: "the open file switched before approval; nothing was written",
						});
					}
					const currentEditor = editorRef.current;
					const currentText = currentEditor?.getText() ?? null;
					if (
						(currentText !== null && currentText !== base.content) ||
						currentEditor?.flushPendingSave() === true
					) {
						return editResult("stale", {
							reason:
								"the file was edited in the editor after the preview; nothing was written",
						});
					}

					try {
						const written = await invoke<AgentOpenFile>(
							"workspace_agent_write_open_file",
							{
								path,
								content: next,
								expectedSha256: base.sha256,
							},
						);
						editorRef.current?.reloadFile();
						return editResult("applied", {
							path,
							sha256: written.sha256,
							added: diff.added,
							removed: diff.removed,
						});
					} catch (error) {
						const msg = (
							error instanceof Error ? error.message : String(error)
						).replace(/^Error:\s*/, "");
						if (msg.startsWith("stale")) {
							return editResult("stale", { reason: msg });
						}
						if (msg.startsWith("denied")) {
							return editResult("denied", { reason: msg });
						}
						return editResult("error", { reason: msg });
					}
				} finally {
					busyRef.current = false;
				}
			}),
			naia.onToolCall("skill_workspace_close_file", async (args) => {
				const target =
					String(args.path ?? "").trim() || openFilePathRef.current;
				if (!target) return "No open document to close";
				closeDocRef.current?.(target);
				return `Closed: ${target}`;
			}),
			naia.onToolCall("skill_workspace_set_surface", async (args) => {
				const target = String(args.surface ?? "")
					.toLowerCase()
					.trim();
				if (target === "herdr") {
					showHerdrRef.current();
					return "Switched surface to herdr";
				}
				if (target === "viewer") {
					setSurfaceRef.current?.("viewer");
					return "Switched surface to viewer";
				}
				return `Error: invalid surface '${target}', expected 'herdr' or 'viewer'`;
			}),
			naia.onToolCall("skill_workspace_focus_space", async (args) => {
				const target = String(args.target ?? "").trim();
				if (!target) return "Error: target is required";
				const space = findWorkspaceRef.current(target);
				const targetId = space ? space.workspace_id : target;
				try {
					await focusWorkspaceRef.current(targetId);
					return `Focused workspace: ${space?.label || targetId}`;
				} catch (error) {
					return `Error: ${String(error)}`;
				}
			}),
			naia.onToolCall("skill_workspace_terminal_exec", async (args) => {
				const command = String(args.command ?? "");
				if (!command) return "Error: command is required";
				const currentPty = ptyRef.current;
				if (!currentPty?.pty_id) {
					return "Error: Herdr terminal PTY is not running";
				}
				const showTerminal = args.showTerminal !== false;
				if (showTerminal) {
					showHerdrRef.current();
				}
				try {
					const payload = command.endsWith("\n") ? command : `${command}\n`;
					await writePty(currentPty.pty_id, payload);
					return `Command sent to Herdr terminal: ${command}`;
				} catch (error) {
					return `Error writing to terminal: ${String(error)}`;
				}
			}),
			naia.onToolCall("skill_workspace_get_terminal_output", async (args) => {
				const term = terminalRef?.current;
				if (!term || typeof term.getBufferText !== "function") {
					return JSON.stringify({
						output: "",
						error: "Terminal is not mounted",
					});
				}
				const lines = typeof args.lines === "number" ? args.lines : 50;
				const output = term.getBufferText(lines);
				return JSON.stringify({
					output,
					lines: output ? output.split("\n").length : 0,
				});
			}),
		];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [editorRef, naia, openResolvedFile, snapshotRef, terminalRef]);

	return { approveEdit, rejectEdit };
}
