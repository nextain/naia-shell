import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useEffect } from "react";
import { type AppCenterProps, appRegistry } from "../../lib/app-registry";
import { useAppStore } from "../../stores/app";
import type { EditorHandle } from "./Editor";
import type { WorkspaceAppApi } from "./types";
import {
	type HerdrSnapshot,
	type HerdrWorkspace,
	snapshotSessions,
	workspacePath,
} from "./herdr";
import { executePty } from "./pty-ipc";

interface HerdrWorkspaceBridgeOptions {
	naia: AppCenterProps["naia"];
	snapshotRef: RefObject<HerdrSnapshot | null>;
	editorRef: RefObject<EditorHandle | null>;
	workspaceRoot: string;
	openFilePath: string;
	findWorkspace: (target: string) => HerdrWorkspace | undefined;
	focusWorkspace: (workspaceId: string) => Promise<void>;
	openResolvedFile: (path: string) => Promise<string>;
	refreshSnapshot: () => Promise<void>;
	showHerdr: () => void;
}

export function useHerdrWorkspaceBridge({
	naia,
	snapshotRef,
	editorRef,
	workspaceRoot,
	openFilePath,
	findWorkspace,
	focusWorkspace,
	openResolvedFile,
	refreshSnapshot,
	showHerdr,
}: HerdrWorkspaceBridgeOptions) {
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
				if (!openFilePath) return JSON.stringify({ open: false });
				try {
					const content = await invoke<string>("workspace_read_file", {
						path: openFilePath,
					});
					return JSON.stringify({ open: true, path: openFilePath, content });
				} catch (error) {
					return JSON.stringify({
						open: true,
						path: openFilePath,
						error: String(error),
					});
				}
			}),
			naia.onToolCall("skill_workspace_edit_open_file", async (args) => {
				if (!openFilePath) return "Error: no file is open in the editor";
				try {
					const current = await invoke<string>("workspace_read_file", {
						path: openFilePath,
					});
					let content: string;
					if (typeof args.content === "string") content = args.content;
					else if (
						typeof args.search === "string" &&
						typeof args.replace === "string"
					) {
						if (!current.includes(args.search))
							return "Error: search text not found in file";
						content = current.replaceAll(args.search, args.replace);
					} else return "Error: provide content or search and replace";
					await invoke("workspace_write_file", { path: openFilePath, content });
					editorRef.current?.reloadFile();
					return `Edited: ${openFilePath}`;
				} catch (error) {
					return `Error: ${String(error)}`;
				}
			}),
			naia.onToolCall("skill_workspace_focus_session", async (args) => {
				const target = String(args.dir ?? "");
				const space = findWorkspace(target);
				if (!space) return `Error: Herdr space not found: ${target}`;
				try {
					useAppStore.getState().setActiveApp("workspace");
					await focusWorkspace(space.workspace_id);
					return `Focused: ${space.label}`;
				} catch (error) {
					return `Error: ${String(error)}`;
				}
			}),
			naia.onToolCall("skill_workspace_new_session", async (args) => {
				const dir = String(args.dir ?? "");
				if (!dir) return "Error: dir is required";
				try {
					useAppStore.getState().setActiveApp("workspace");
					await invoke("herdr_create_workspace", { cwd: dir, label: null });
					await refreshSnapshot();
					showHerdr();
					return `Started Herdr space: ${dir}`;
				} catch (error) {
					return `Error: ${String(error)}`;
				}
			}),
			naia.onToolCall("skill_workspace_send_to_session", async (args) => {
				const target = String(args.dir ?? "");
				const text = String(args.text ?? "");
				if (!target || !text) return "Error: dir and text are required";
				const current = snapshotRef.current;
				const space = findWorkspace(target);
				const agent =
					current?.agents.find(
						(item) => item.workspace_id === space?.workspace_id && item.focused,
					) ??
					current?.agents.find(
						(item) => item.workspace_id === space?.workspace_id,
					);
				if (!agent) return `Error: no Herdr agent for: ${target}`;
				try {
					await invoke("herdr_prompt_agent", { paneId: agent.pane_id, text });
					return `Prompted: ${target}`;
				} catch (error) {
					return `Error: ${String(error)}`;
				}
			}),
			naia.onToolCall("skill_workspace_execute", async (args) => {
				const command = String(args.command ?? "");
				if (!command.trim()) throw new Error("Error: command is required");
				let dir = String(args.dir ?? "").trim();
				if (dir && !/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(dir)) {
					const space = findWorkspace(dir);
					dir = space
						? workspacePath(space, snapshotRef.current?.agents ?? [])
						: `${workspaceRoot.replace(/[\\/]+$/, "")}/${dir}`;
				}
				if (!dir) dir = workspaceRoot;
				if (!dir) throw new Error("Error: no working directory available");
				let result: Awaited<ReturnType<typeof executePty>>;
				try {
					result = await executePty(
						dir,
						command,
						typeof args.timeout_secs === "number"
							? args.timeout_secs
							: undefined,
					);
				} catch (error) {
					throw error instanceof Error ? error : new Error(String(error));
				}
				if (!result.success) {
					throw new Error(JSON.stringify(result));
				}
				return JSON.stringify(result);
			}),
		];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [
		editorRef,
		findWorkspace,
		focusWorkspace,
		naia,
		openFilePath,
		openResolvedFile,
		refreshSnapshot,
		showHerdr,
		snapshotRef,
		workspaceRoot,
	]);
}
