import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppCenterProps } from "../../lib/app-registry";
import {
	UI_PREFERENCE_KEYS,
	patchUiPreferences,
	useUiPreference,
} from "../../lib/ui-preferences";
import { useAppStore } from "../../stores/app";
import { HerdrWorkspaceRail } from "./HerdrWorkspaceRail";
import { HerdrWorkspaceSurface } from "./HerdrWorkspaceSurface";
import { QuickOpen } from "./QuickOpen";
import { WorkspaceQuadView } from "./WorkspaceQuadView";
import { focusedHerdrAgent } from "./herdr";
import type { OpenFileEditProposal } from "./open-file-edit";
import { writePty } from "./pty-ipc";
import type { TerminalSource, TerminalSourceKind } from "./terminal-source";
import { useHerdrDocuments } from "./useHerdrDocuments";
import { useHerdrRuntime } from "./useHerdrRuntime";
import { useHerdrWorkspaceBridge } from "./useHerdrWorkspaceBridge";
import { usePtyTerminalSource } from "./usePtyTerminalSource";

export function HerdrWorkspaceCenterArea({ naia }: AppCenterProps) {
	const runtime = useHerdrRuntime();
	const documents = useHerdrDocuments({
		naia,
		locationGenerationRef: runtime.locationGenerationRef,
		snapshotRef: runtime.snapshotRef,
		setSurface: runtime.setSurface,
		showHerdr: runtime.showHerdr,
		terminalRef: runtime.terminalRef,
	});

	const [editProposal, setEditProposal] = useState<OpenFileEditProposal | null>(
		null,
	);

	const activeApp = useAppStore((s) => s.activeApp);

	const handleShowViewer = useCallback(async () => {
		if (documents.openFilePath) {
			runtime.setSurface("viewer");
			return;
		}
		if (documents.openDocs.length > 0) {
			documents.setOpenFilePath(documents.openDocs[documents.openDocs.length - 1]);
			runtime.setSurface("viewer");
			return;
		}
		if (runtime.workspaceRoot) {
			try {
				const files = await invoke<string[]>("workspace_list_files_recursive", {
					parent: runtime.workspaceRoot,
				});
				if (files.length > 0) {
					const readme = files.find((f) => /readme\.md$/i.test(f));
					const target = readme ?? files[0];
					void documents.openResolvedFile(target);
					return;
				}
			} catch {}
		}
		runtime.setSurface("viewer");
	}, [documents, runtime]);

	useEffect(() => {
		if (activeApp !== "workspace") return;
		const snapshot = runtime.snapshot;
		const focused = snapshot ? focusedHerdrAgent(snapshot) : null;
		naia.pushContext({
			type: "workspace",
			data: {
				surface: runtime.surface,
				workspaceRoot: runtime.workspaceRoot,
				openFilePath: documents.openFilePath || null,
				openDocs: documents.openDocs,
				cursor:
					typeof documents.editorRef.current?.getCursorLocation === "function"
						? documents.editorRef.current.getCursorLocation()
						: null,
				herdr: snapshot
					? {
							version: snapshot.version,
							workspaceId: snapshot.focused_workspace_id ?? null,
							paneId: snapshot.focused_pane_id ?? null,
							agent: focused?.agent ?? null,
							agentStatus: focused?.agent_status ?? null,
							cwd: focused?.foreground_cwd ?? focused?.cwd ?? null,
							terminalTail:
								typeof runtime.terminalRef.current?.getBufferText === "function"
									? runtime.terminalRef.current.getBufferText(20) || null
									: null,
						}
					: null,
			},
		});
	}, [
		activeApp,
		documents.editorRef,
		documents.openDocs,
		documents.openFilePath,
		naia,
		runtime.snapshot,
		runtime.surface,
		runtime.terminalRef,
		runtime.workspaceRoot,
	]);

	const { approveEdit, rejectEdit } = useHerdrWorkspaceBridge({
		naia,
		snapshotRef: runtime.snapshotRef,
		editorRef: documents.editorRef,
		terminalRef: runtime.terminalRef,
		workspaceRoot: runtime.workspaceRoot,
		openFilePath: documents.openFilePath,
		openDocs: documents.openDocs,
		pty: runtime.pty,
		findWorkspace: runtime.findWorkspace,
		focusWorkspace: runtime.focusWorkspace,
		openResolvedFile: documents.openResolvedFile,
		closeDoc: documents.closeDoc,
		refreshSnapshot: runtime.refreshSnapshot,
		showHerdr: runtime.showHerdr,
		setSurface: runtime.setSurface,
		setEditProposal,
	});

	const layoutPreference = useUiPreference<string>(
		UI_PREFERENCE_KEYS.workspaceLayout,
		"quad",
	);
	const [layout, setLayout] = useState<"quad" | "standard">(
		layoutPreference === "standard" ? "standard" : "quad",
	);

	useEffect(() => {
		if (layoutPreference === "standard" || layoutPreference === "quad") {
			setLayout(layoutPreference);
		}
	}, [layoutPreference]);

	const toggleLayout = useCallback(() => {
		const next = layout === "quad" ? "standard" : "quad";
		setLayout(next);
		void patchUiPreferences({ [UI_PREFERENCE_KEYS.workspaceLayout]: next });
	}, [layout]);

	const ptySource = usePtyTerminalSource({
		workspaceRoot: runtime.workspaceRoot,
		autoLaunchOpencode: true,
	});

	const herdrSource = useMemo<TerminalSource>(
		() => ({
			kind: "herdr",
			pty: runtime.pty,
			launching: runtime.launching,
			launchError: runtime.launchError,
			terminalReady: runtime.terminalReady,
			terminalError: runtime.terminalError,
			workingDir: runtime.workspaceRoot,
			launch: runtime.launchHerdr,
			retry: runtime.retryHerdr,
			onTerminalReady: runtime.onTerminalReady,
			onPtyExit: runtime.onPtyExit,
			runOpencode: runtime.pty
				? () => writePty(runtime.pty!.pty_id, "opencode\r")
				: undefined,
		}),
		[runtime],
	);

	const [selectedSourceKind, setSelectedSourceKind] =
		useState<TerminalSourceKind>("pty");

	const activeTerminalSource =
		selectedSourceKind === "herdr" ? herdrSource : ptySource;

	return (
		<div
			className="herdr-workspace"
			data-testid="herdr-workspace"
			data-layout={layout}
		>
			<HerdrWorkspaceRail
				workspaceRoot={runtime.workspaceRoot}
				surface={runtime.surface}
				openFilePath={documents.openFilePath}
				openDocs={documents.openDocs}
				classifiedDirs={documents.classifiedDirs}
				fileTreeRegionRef={documents.fileTreeRegionRef}
				snapshot={runtime.snapshot}
				onFileSelect={documents.openFromTree}
				onSendToNaia={documents.sendToNaia}
				onShowHerdr={runtime.showHerdr}
				onShowViewer={handleShowViewer}
				onFocusWorkspace={runtime.focusWorkspace}
				onFocusAgent={runtime.focusAgent}
				layout={layout}
				onToggleLayout={toggleLayout}
			/>
			{layout === "quad" ? (
				<WorkspaceQuadView
					terminalSource={activeTerminalSource}
					availableSources={["pty", "herdr"]}
					selectedSourceKind={selectedSourceKind}
					onSelectSourceKind={setSelectedSourceKind}
					terminalRef={runtime.terminalRef}
					onFileLocation={documents.openLocation}
					onAskAi={documents.sendToNaia}
					workspaceRoot={runtime.workspaceRoot}
				/>
			) : (
				<HerdrWorkspaceSurface
					{...runtime}
					{...documents}
					editProposal={editProposal}
					onApproveEdit={approveEdit}
					onRejectEdit={rejectEdit}
				/>
			)}
			{documents.quickOpenVisible && runtime.workspaceRoot && (
				<QuickOpen
					workspaceRoot={runtime.workspaceRoot}
					onSelect={documents.openFromTree}
					onClose={() => documents.setQuickOpenVisible(false)}
				/>
			)}
		</div>
	);
}

export default HerdrWorkspaceCenterArea;
