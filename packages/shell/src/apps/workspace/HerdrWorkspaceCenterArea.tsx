import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect } from "react";
import type { AppCenterProps } from "../../lib/app-registry";
import { HerdrWorkspaceRail } from "./HerdrWorkspaceRail";
import { HerdrWorkspaceSurface } from "./HerdrWorkspaceSurface";
import { QuickOpen } from "./QuickOpen";
import { focusedHerdrAgent } from "./herdr";
import { useHerdrDocuments } from "./useHerdrDocuments";
import { useHerdrRuntime } from "./useHerdrRuntime";
import { useHerdrWorkspaceBridge } from "./useHerdrWorkspaceBridge";

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
		if (!runtime.snapshot) return;
		const focused = focusedHerdrAgent(runtime.snapshot);
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
				herdr: {
					version: runtime.snapshot.version,
					workspaceId: runtime.snapshot.focused_workspace_id ?? null,
					paneId: runtime.snapshot.focused_pane_id ?? null,
					agent: focused?.agent ?? null,
					agentStatus: focused?.agent_status ?? null,
					cwd: focused?.foreground_cwd ?? focused?.cwd ?? null,
					terminalTail:
						typeof runtime.terminalRef.current?.getBufferText === "function"
							? runtime.terminalRef.current.getBufferText(20) || null
							: null,
				},
			},
		});
	}, [
		documents.editorRef,
		documents.openDocs,
		documents.openFilePath,
		naia,
		runtime.snapshot,
		runtime.surface,
		runtime.terminalRef,
		runtime.workspaceRoot,
	]);

	useHerdrWorkspaceBridge({
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
	});

	return (
		<div className="herdr-workspace" data-testid="herdr-workspace">
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
			/>
			<HerdrWorkspaceSurface {...runtime} {...documents} />
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
