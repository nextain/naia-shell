import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { TerminalHandle } from "./Terminal";
import { WorkspaceQuadView } from "./WorkspaceQuadView";
import { focusedHerdrAgent } from "./herdr";
import type { OpenFileEditProposal } from "./open-file-edit";
import { writePty } from "./pty-ipc";
import type { TerminalSource, TerminalSourceKind } from "./terminal-source";
import { useHerdrDocuments } from "./useHerdrDocuments";
import type { HerdrSurface } from "./useHerdrRuntime";
import { useHerdrRuntime } from "./useHerdrRuntime";
import { useHerdrWorkspaceBridge } from "./useHerdrWorkspaceBridge";
import { usePtyTerminalSource } from "./usePtyTerminalSource";

export function HerdrWorkspaceCenterArea({ naia }: AppCenterProps) {
	const runtime = useHerdrRuntime();
	const activeApp = useAppStore((s) => s.activeApp);

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

	const ensureStandardLayout = useCallback(() => {
		if (layout !== "standard") {
			setLayout("standard");
			void patchUiPreferences({
				[UI_PREFERENCE_KEYS.workspaceLayout]: "standard",
			});
		}
	}, [layout]);

	const toggleLayout = useCallback(() => {
		const next = layout === "quad" ? "standard" : "quad";
		setLayout(next);
		void patchUiPreferences({ [UI_PREFERENCE_KEYS.workspaceLayout]: next });
	}, [layout]);

	// Herdr용 터미널 ref와 일반 PTY용 터미널 ref 분리
	const herdrTerminalRef = runtime.terminalRef;
	const ptyTerminalRef = useRef<TerminalHandle>(null);

	const [selectedSourceKind, setSelectedSourceKind] =
		useState<TerminalSourceKind>("pty");

	const activeTerminalRef =
		selectedSourceKind === "herdr" ? herdrTerminalRef : ptyTerminalRef;

	// 1단 복귀 시 3단 체류 중 발생했던 timeout 실패 오버레이 억제
	const [suppressHerdrError, setSuppressHerdrError] = useState(false);
	const prevLayoutRef = useRef(layout);

	useEffect(() => {
		if (prevLayoutRef.current === "quad" && layout === "standard") {
			setSuppressHerdrError(true);
			const timer = window.setTimeout(() => {
				setSuppressHerdrError(false);
			}, 8000);
			return () => window.clearTimeout(timer);
		}
		prevLayoutRef.current = layout;
	}, [layout]);

	const handleHerdrTerminalReady = useCallback(() => {
		setSuppressHerdrError(false);
		runtime.onTerminalReady();
	}, [runtime]);

	// opencode 시작 명령을 로컬 UI 설정에서 읽고, 비어 있으면 자동 입력 안 함
	const opencodeCommandPref = useUiPreference<string>(
		UI_PREFERENCE_KEYS.opencodeCommand,
		"",
	);

	// 일반 PTY는 3단이면서 그 소스가 선택됐을 때만 띄우고 다른 레이아웃·소스·언마운트에서 killPty.
	// 워크스페이스 탭을 열기 전 자동 스폰 금지.
	const isPtySourceActive =
		activeApp === "workspace" &&
		layout === "quad" &&
		selectedSourceKind === "pty";

	const ptySource = usePtyTerminalSource({
		workspaceRoot: runtime.workspaceRoot,
		enabled: isPtySourceActive,
		initialCommand: opencodeCommandPref,
	});

	const herdrSource = useMemo<TerminalSource>(
		() => ({
			kind: "herdr",
			pty: runtime.pty,
			launching: runtime.launching,
			launchError: runtime.launchError,
			terminalReady: runtime.terminalReady,
			terminalError: suppressHerdrError ? "" : runtime.terminalError,
			workingDir: runtime.workspaceRoot,
			launch: runtime.launchHerdr,
			retry: runtime.retryHerdr,
			onTerminalReady: handleHerdrTerminalReady,
			onPtyExit: runtime.onPtyExit,
			runOpencode: runtime.pty
				? () => {
						const cmd = opencodeCommandPref?.trim() || "opencode";
						if (cmd.includes("\n") || cmd.includes("\r")) return Promise.resolve();
						return writePty(runtime.pty!.pty_id, `${cmd}\r`);
					}
				: undefined,
		}),
		[
			handleHerdrTerminalReady,
			opencodeCommandPref,
			runtime,
			suppressHerdrError,
		],
	);

	const activeTerminalSource =
		selectedSourceKind === "herdr" ? herdrSource : ptySource;

	// 파일 열기·터미널 명령 표시 처리
	const handleShowHerdr = useCallback(() => {
		if (layout === "quad") {
			activeTerminalRef.current?.focus();
			return;
		}
		runtime.showHerdr();
	}, [activeTerminalRef, layout, runtime]);

	const handleSetSurface = useCallback(
		(surface: HerdrSurface) => {
			if (surface === "viewer") {
				ensureStandardLayout();
			}
			runtime.setSurface(surface);
		},
		[ensureStandardLayout, runtime],
	);

	const documents = useHerdrDocuments({
		naia,
		locationGenerationRef: runtime.locationGenerationRef,
		snapshotRef: runtime.snapshotRef,
		setSurface: handleSetSurface,
		showHerdr: handleShowHerdr,
		terminalRef: herdrTerminalRef,
	});

	const [editProposal, setEditProposal] = useState<OpenFileEditProposal | null>(
		null,
	);

	const handleShowViewer = useCallback(async () => {
		ensureStandardLayout();
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
	}, [documents, ensureStandardLayout, runtime]);

	const handleFileSelect = useCallback(
		(file: string) => {
			ensureStandardLayout();
			documents.openFromTree(file);
		},
		[documents, ensureStandardLayout],
	);

	const handleOpenResolvedFile = useCallback(
		async (path: string) => {
			ensureStandardLayout();
			return documents.openResolvedFile(path);
		},
		[documents, ensureStandardLayout],
	);

	// 3단에서 레일·나이아 도구가 쓰는 PTY와 화면의 xterm을 같은 세션으로 일치시킨다.
	const bridgePty =
		layout === "quad" ? activeTerminalSource.pty : runtime.pty;
	const bridgeTerminalRef =
		layout === "quad" ? activeTerminalRef : herdrTerminalRef;

	const { approveEdit, rejectEdit } = useHerdrWorkspaceBridge({
		naia,
		snapshotRef: runtime.snapshotRef,
		editorRef: documents.editorRef,
		terminalRef: bridgeTerminalRef,
		workspaceRoot: runtime.workspaceRoot,
		openFilePath: documents.openFilePath,
		openDocs: documents.openDocs,
		pty: bridgePty,
		findWorkspace: runtime.findWorkspace,
		focusWorkspace: runtime.focusWorkspace,
		openResolvedFile: handleOpenResolvedFile,
		closeDoc: documents.closeDoc,
		refreshSnapshot: runtime.refreshSnapshot,
		showHerdr: handleShowHerdr,
		setSurface: handleSetSurface,
		setEditProposal,
	});

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
								typeof bridgeTerminalRef.current?.getBufferText === "function"
									? bridgeTerminalRef.current.getBufferText(20) || null
									: null,
						}
					: null,
			},
		});
	}, [
		activeApp,
		bridgeTerminalRef,
		documents.editorRef,
		documents.openDocs,
		documents.openFilePath,
		layout,
		naia,
		runtime.snapshot,
		runtime.surface,
		runtime.workspaceRoot,
	]);

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
				onFileSelect={handleFileSelect}
				onSendToNaia={documents.sendToNaia}
				onShowHerdr={handleShowHerdr}
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
					terminalRef={activeTerminalRef}
					onFileLocation={documents.openLocation}
					onAskAi={documents.sendToNaia}
					workspaceRoot={runtime.workspaceRoot}
				/>
			) : (
				<HerdrWorkspaceSurface
					{...runtime}
					terminalError={suppressHerdrError ? "" : runtime.terminalError}
					onTerminalReady={handleHerdrTerminalReady}
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
