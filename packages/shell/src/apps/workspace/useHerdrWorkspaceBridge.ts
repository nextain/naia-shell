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
} from "./herdr";

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
	editorRef: _editorRef,
	workspaceRoot: _workspaceRoot,
	openFilePath,
	findWorkspace,
	focusWorkspace,
	openResolvedFile,
	refreshSnapshot: _refreshSnapshot,
	showHerdr: _showHerdr,
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
		];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [naia, openFilePath, openResolvedFile, snapshotRef]);
}
