import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useEffect, useRef } from "react";
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
import { writePty } from "./pty-ipc";
import type { PtyCreated } from "./useHerdrRuntime";

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
	const findWorkspaceRef = useRef(findWorkspace);
	findWorkspaceRef.current = findWorkspace;
	const focusWorkspaceRef = useRef(focusWorkspace);
	focusWorkspaceRef.current = focusWorkspace;
	const ptyRef = useRef(pty);
	ptyRef.current = pty;

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
					const content = await invoke<string>("workspace_read_file", {
						path: currentPath,
					});
					return JSON.stringify({
						open: true,
						path: currentPath,
						openDocs: docs,
						cursor,
						content,
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
}
