import { open } from "@tauri-apps/plugin-dialog";
import {
	type KeyboardEvent,
	Suspense,
	lazy,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getAdkPath, setAdkPath } from "../../lib/adk-store";
import { Logger } from "../../lib/logger";
import {
	getProjectAgentState,
	stopProjectAgent,
	waitForProjectAgentStopped,
} from "./project-agent-runtime";
import {
	type CatalogIssue,
	type CatalogProject,
	type ParsedProjectCommandError,
	type ProjectCatalog,
	type ProjectCatalogTruncation,
	type ProjectClassResetResult,
	type ProjectConfigIssueReason,
	parseProjectCommandError,
	resetProjectClass,
	scanProjectCatalog,
} from "./project-catalog";
import {
	type ProjectSession,
	type ProjectStage,
	loadProjectSession,
	normalizeProjectPath,
	saveProjectSession,
	stageForProject,
} from "./project-session";
import { type ProjectTranslationKey, projectText } from "./translations";
import "./projects.css";

const ProjectAgentPanel = lazy(() =>
	import("./ProjectAgentPanel").then((module) => ({
		default: module.ProjectAgentPanel,
	})),
);
const ProjectDocsPanel = lazy(() =>
	import("./ProjectDocsPanel").then((module) => ({
		default: module.ProjectDocsPanel,
	})),
);
const ProjectWebViewPanel = lazy(() =>
	import("./ProjectWebViewPanel").then((module) => ({
		default: module.ProjectWebViewPanel,
	})),
);

type LoadState = "loading" | "ready" | "error";
type ClassResetState = "idle" | "resetting" | "success" | "error";

const TABS: Array<{ id: ProjectStage; label: ProjectTranslationKey }> = [
	{ id: "agent", label: "projects.tabCodingAgent" },
	{ id: "dashboard", label: "projects.tabDashboard" },
	{ id: "issues", label: "projects.tabInternalIssues" },
];

function visibleTabsForProject(
	project: CatalogProject | undefined,
): Array<{ id: ProjectStage; label: ProjectTranslationKey }> {
	const hasDocs =
		Boolean(project?.dashboardUrl?.trim()) ||
		(project?.docsDirs?.length ?? 0) > 0;
	const hasTasks = Boolean(project?.issuesUrl?.trim());
	return TABS.filter((tab) => {
		if (tab.id === "agent") return true;
		if (tab.id === "dashboard") return hasDocs;
		if (tab.id === "issues") return hasTasks;
		return false;
	});
}

function effectiveTabForProject(
	preferred: ProjectStage,
	project: CatalogProject | undefined,
): ProjectStage {
	const visible = visibleTabsForProject(project);
	return visible.some((tab) => tab.id === preferred) ? preferred : "agent";
}

function classResetErrorMessageKey(code: string): ProjectTranslationKey {
	switch (code) {
		case "not_class_project":
			return "projects.classResetErrorNotClass";
		case "agent_running":
			return "projects.classResetErrorAgentRunning";
		case "class_reset_in_progress":
			return "projects.agentClassResetInProgress";
		case "not_git_repo":
			return "projects.classResetErrorNotGitRepo";
		case "baseline_missing":
			return "projects.classResetErrorBaselineMissing";
		case "git_unavailable":
			return "projects.classResetErrorGitUnavailable";
		case "backup_exists":
			return "projects.classResetErrorBackupExists";
		case "backup_failed":
			return "projects.classResetErrorBackupFailed";
		case "reset_failed":
			return "projects.classResetErrorResetFailed";
		case "project_unverified":
			return "projects.agentProjectUnverified";
		case "repository_invalid":
			return "projects.agentRepositoryInvalid";
		case "checkout_missing":
			return "projects.agentCheckoutMissing";
		case "checkout_unsafe":
			return "projects.agentCheckoutUnsafe";
		default:
			return "projects.classResetErrorUnknown";
	}
}

function ProjectPanelLoading() {
	Logger.debug("ProjectsApp", "showing deferred project panel progress");
	return (
		<output className="projects-app__recovery" aria-live="polite">
			{projectText("projects.panelLoading")}
		</output>
	);
}

function issueMessage(reason: ProjectConfigIssueReason): ProjectTranslationKey {
	switch (reason) {
		case "missing":
			return "projects.fileMissing";
		case "file_unreadable":
		case "directory_unreadable":
		case "entry_unreadable":
			return "projects.fileUnreadable";
		case "invalid_yaml":
			return "projects.fileInvalid";
		case "missing_project_id":
			return "projects.projectIdMissing";
		case "unsafe_path":
			return "projects.unsafePath";
		case "file_too_large":
			return "projects.fileTooLarge";
	}
}

function ProjectCatalogTruncationNotice({
	truncation,
}: {
	truncation: ProjectCatalogTruncation;
}) {
	const shownFiles = truncation.oversizedFiles.slice(0, 3);
	const remainingFiles = truncation.oversizedFiles.length - shownFiles.length;
	return (
		<output
			className="projects-app__truncation"
			aria-live="polite"
			aria-label={projectText("projects.scanLimitedTitle")}
		>
			<strong>{projectText("projects.scanLimitedTitle")}</strong>
			{truncation.moreEntriesAvailable && (
				<span>
					{projectText("projects.scanEntryLimit", {
						scanned: truncation.scannedEntries,
						limit: truncation.maxEntries,
					})}
				</span>
			)}
			{truncation.moreRowsAvailable && (
				<span>
					{projectText("projects.scanRowLimit", {
						shown: truncation.shownRows,
						limit: truncation.maxRows,
					})}
				</span>
			)}
			{truncation.oversizedFiles.length > 0 && (
				<>
					<span>
						{projectText("projects.scanFileLimit", {
							count: truncation.oversizedFiles.length,
							limit: truncation.maxConfigFileBytes,
						})}
					</span>
					<span className="projects-app__truncation-files">
						{shownFiles.map((file) => (
							<span key={file.file}>
								<code>{file.file}</code>{" "}
								{projectText("projects.scanFileObservedBytes", {
									bytes: file.observedBytes,
								})}
							</span>
						))}
					</span>
					{remainingFiles > 0 && (
						<span>
							{projectText("projects.scanMoreFiles", {
								count: remainingFiles,
							})}
						</span>
					)}
				</>
			)}
		</output>
	);
}

function CatalogErrorList({ errors }: { errors: CatalogIssue[] }) {
	if (errors.length === 0) return null;
	return (
		<section
			className="projects-app__catalog-errors"
			aria-label={projectText("projects.catalogErrors")}
		>
			<h2>{projectText("projects.catalogErrors")}</h2>
			<ul className="projects-app__issues">
				{errors.map((issue) => (
					<li key={`${issue.path}:${issue.reason}`}>
						<code>{issue.path}</code> —{" "}
						{projectText(issueMessage(issue.reason))}
					</li>
				))}
			</ul>
		</section>
	);
}

function ProjectRow({
	project,
	onOpen,
}: { project: CatalogProject; onOpen: () => void }) {
	return (
		<li className="projects-app__project">
			<button
				className="projects-app__project-button"
				type="button"
				onClick={onOpen}
			>
				<span className="projects-app__project-heading">
					<strong>{project.name}</strong>
				</span>
				<span className="projects-app__project-meta">{project.projectId}</span>
				<span className="projects-app__project-source">
					{projectText("projects.checkoutLabel")}:{" "}
					<code>{project.sourcePath}</code>
				</span>
			</button>
		</li>
	);
}

export function ProjectsApp() {
	Logger.debug("ProjectsApp", "rendering single-project application shell");
	const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
	const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(
		null,
	);
	const [activeTab, setActiveTab] = useState<ProjectStage>("agent");
	const [session, setSession] = useState<ProjectSession>(
		() => loadProjectSession().session,
	);
	const [loadState, setLoadState] = useState<LoadState>("loading");
	const [search, setSearch] = useState("");
	const [showCatalog, setShowCatalog] = useState(true);
	const [recoveryNeeded, setRecoveryNeeded] = useState(false);
	const [sessionInvalid, setSessionInvalid] = useState(false);
	const [sessionSaveFailed, setSessionSaveFailed] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const [showResetDialog, setShowResetDialog] = useState(false);
	const [classResetState, setClassResetState] =
		useState<ClassResetState>("idle");
	const [classResetResult, setClassResetResult] =
		useState<ProjectClassResetResult | null>(null);
	const [classResetError, setClassResetError] =
		useState<ParsedProjectCommandError | null>(null);
	const [docsRefreshToken, setDocsRefreshToken] = useState(0);
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const resetTriggerButtonRef = useRef<HTMLButtonElement | null>(null);
	const cancelResetButtonRef = useRef<HTMLButtonElement | null>(null);
	const confirmResetButtonRef = useRef<HTMLButtonElement | null>(null);
	const projectHeaderRef = useRef<HTMLElement | null>(null);
	const projectViewRef = useRef<HTMLElement | null>(null);
	const wasDialogOpenRef = useRef(false);
	const pendingResetFocusRef = useRef(false);
	const initialized = useRef(false);

	const currentProject = catalog?.projects.find(
		(project) =>
			normalizeProjectPath(project.projectPath) === currentProjectPath,
	);
	const visibleTabs = useMemo(
		() => visibleTabsForProject(currentProject),
		[currentProject],
	);
	const effectiveActiveTab = useMemo(
		() => effectiveTabForProject(activeTab, currentProject),
		[activeTab, currentProject],
	);
	const visibleProjects = useMemo(() => {
		const query = search.trim().toLocaleLowerCase();
		if (!query) return catalog?.projects ?? [];
		return (catalog?.projects ?? []).filter((project) =>
			[
				project.name,
				project.projectId,
				project.repository ?? "",
				project.sourcePath,
			].some((value) => value.toLocaleLowerCase().includes(query)),
		);
	}, [catalog, search]);

	const resetProjectTransientState = useCallback(() => {
		wasDialogOpenRef.current = false;
		pendingResetFocusRef.current = false;
		setShowResetDialog(false);
		setClassResetState("idle");
		setClassResetResult(null);
		setClassResetError(null);
	}, []);

	const restoreLastProject = useCallback(
		(nextCatalog: ProjectCatalog, saved: ProjectSession) => {
			setCatalog(nextCatalog);
			setLoadState("ready");
			setLoadError(false);
			if (!saved.lastProject) {
				setCurrentProjectPath(null);
				setShowCatalog(true);
				setRecoveryNeeded(false);
				return;
			}
			const restored = nextCatalog.projects.find(
				(project) =>
					normalizeProjectPath(project.projectPath) === saved.lastProject?.path,
			);
			if (restored) {
				const preferred = stageForProject(saved, restored.projectPath);
				setCurrentProjectPath(normalizeProjectPath(restored.projectPath));
				setActiveTab(effectiveTabForProject(preferred, restored));
				setShowCatalog(false);
				setRecoveryNeeded(false);
			} else {
				setCurrentProjectPath(null);
				setShowCatalog(true);
				setRecoveryNeeded(true);
			}
		},
		[],
	);

	const scanAndOpen = useCallback(
		async (path: string, persistPath: boolean, saved: ProjectSession) => {
			const nextCatalog = await scanProjectCatalog(path);
			if (persistPath) await setAdkPath(path);
			restoreLastProject(nextCatalog, saved);
			Logger.info("ProjectsApp", "naia-adk project catalog loaded", {
				projectCount: nextCatalog.projects.length,
				catalogErrorCount: nextCatalog.catalogErrors.length,
			});
		},
		[restoreLastProject],
	);

	const chooseAdkFolder = useCallback(
		async (saved: ProjectSession) => {
			setLoadError(false);
			setLoadState("loading");
			try {
				const selected = await open({
					directory: true,
					multiple: false,
					title: projectText("projects.chooseCheckout"),
				});
				if (typeof selected !== "string") {
					setLoadState("error");
					setLoadError(true);
					return;
				}
				await scanAndOpen(selected, true, saved);
			} catch (error) {
				setCatalog(null);
				setCurrentProjectPath(null);
				setShowCatalog(true);
				setLoadState("error");
				setLoadError(true);
				Logger.warn("ProjectsApp", "naia-adk folder could not be read", {
					error: String(error),
				});
			}
		},
		[scanAndOpen],
	);

	const reloadCatalog = useCallback(async () => {
		const savedPath = getAdkPath();
		Logger.debug("ProjectsApp", "reloading project catalog from saved path", {
			hasSavedPath: Boolean(savedPath),
		});
		if (!savedPath) {
			await chooseAdkFolder(session);
			return;
		}
		setLoadError(false);
		setLoadState("loading");
		try {
			const nextCatalog = await scanProjectCatalog(savedPath);
			setCatalog(nextCatalog);
			setLoadState("ready");
			if (currentProjectPath) {
				const stillPresent = nextCatalog.projects.find(
					(project) =>
						normalizeProjectPath(project.projectPath) === currentProjectPath,
				);
				if (stillPresent) {
					setActiveTab((previous) =>
						effectiveTabForProject(previous, stillPresent),
					);
					setRecoveryNeeded(false);
				} else {
					setCurrentProjectPath(null);
					setShowCatalog(true);
					setRecoveryNeeded(true);
				}
			}
			Logger.info("ProjectsApp", "naia-adk project catalog reloaded", {
				projectCount: nextCatalog.projects.length,
				catalogErrorCount: nextCatalog.catalogErrors.length,
			});
		} catch (error) {
			setLoadState("error");
			setLoadError(true);
			Logger.warn("ProjectsApp", "naia-adk catalog reload failed", {
				error: String(error),
			});
		}
	}, [chooseAdkFolder, currentProjectPath, session]);

	useEffect(() => {
		if (initialized.current) return;
		initialized.current = true;
		const loaded = loadProjectSession();
		setSession(loaded.session);
		setSessionInvalid(loaded.invalid);
		const savedPath = getAdkPath();
		if (savedPath) {
			void scanAndOpen(savedPath, false, loaded.session).catch(
				async (error) => {
					Logger.warn(
						"ProjectsApp",
						"saved naia-adk folder could not be read",
						{
							error: String(error),
						},
					);
					await chooseAdkFolder(loaded.session);
				},
			);
		} else {
			void chooseAdkFolder(loaded.session);
		}
	}, [chooseAdkFolder, scanAndOpen]);

	const isResetDialogOpen =
		showResetDialog && Boolean(currentProject?.class?.baselineRef);

	useEffect(() => {
		const backgroundNodes = [projectHeaderRef.current, projectViewRef.current];
		for (const node of backgroundNodes) {
			if (!node) continue;
			if (isResetDialogOpen) {
				node.setAttribute("inert", "");
			} else {
				node.removeAttribute("inert");
			}
		}
	}, [isResetDialogOpen]);

	useEffect(() => {
		if (!isResetDialogOpen) return;
		wasDialogOpenRef.current = true;
		cancelResetButtonRef.current?.focus();
		const handleKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				setShowResetDialog(false);
				return;
			}
			if (event.key === "Tab") {
				const focusable = [
					cancelResetButtonRef.current,
					confirmResetButtonRef.current,
				].filter((el): el is HTMLButtonElement => Boolean(el && !el.disabled));
				if (focusable.length === 0) return;
				event.preventDefault();
				const currentIndex = focusable.indexOf(
					document.activeElement as HTMLButtonElement,
				);
				if (event.shiftKey) {
					const nextIndex =
						currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
					focusable[nextIndex]?.focus();
				} else {
					const nextIndex =
						currentIndex === -1 || currentIndex >= focusable.length - 1
							? 0
							: currentIndex + 1;
					focusable[nextIndex]?.focus();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isResetDialogOpen]);

	useEffect(() => {
		if (isResetDialogOpen) return;
		if (wasDialogOpenRef.current) {
			wasDialogOpenRef.current = false;
			if (classResetState === "resetting") {
				pendingResetFocusRef.current = true;
				return;
			}
			resetTriggerButtonRef.current?.focus();
			return;
		}
		if (pendingResetFocusRef.current && classResetState !== "resetting") {
			pendingResetFocusRef.current = false;
			resetTriggerButtonRef.current?.focus();
		}
	}, [classResetState, isResetDialogOpen]);

	function openProject(project: CatalogProject) {
		Logger.debug("ProjectsApp", "opening selected project", {
			projectId: project.projectId,
		});
		resetProjectTransientState();
		const projectPath = normalizeProjectPath(project.projectPath);
		const stagesByProjectPath = { ...session.stagesByProjectPath };
		if (currentProjectPath) {
			stagesByProjectPath[currentProjectPath] = effectiveActiveTab;
		}
		const nextSession: ProjectSession = {
			version: 1,
			lastProject: { id: project.projectId, path: projectPath },
			stagesByProjectPath,
		};
		const savedTab = stageForProject(nextSession, projectPath);
		const nextTab = effectiveTabForProject(savedTab, project);
		nextSession.stagesByProjectPath[projectPath] = nextTab;
		setSession(nextSession);
		persistSession(nextSession);
		setCurrentProjectPath(projectPath);
		setActiveTab(nextTab);
		setShowCatalog(false);
		setRecoveryNeeded(false);
		setSessionInvalid(false);
		Logger.info("ProjectsApp", "project opened", {
			projectId: project.projectId,
		});
	}

	function persistSession(nextSession: ProjectSession) {
		Logger.debug("ProjectsApp", "persisting project selection and tab only");
		setSessionSaveFailed(!saveProjectSession(nextSession));
	}

	function changeTab(tab: ProjectStage) {
		Logger.debug("ProjectsApp", "changing active project view", { tab });
		setActiveTab(tab);
		if (!currentProjectPath) return;
		const nextSession: ProjectSession = {
			...session,
			stagesByProjectPath: {
				...session.stagesByProjectPath,
				[currentProjectPath]: tab,
			},
		};
		setSession(nextSession);
		persistSession(nextSession);
	}

	function showOtherProjects() {
		Logger.debug("ProjectsApp", "showing project catalog");
		wasDialogOpenRef.current = false;
		pendingResetFocusRef.current = false;
		setSearch("");
		setShowResetDialog(false);
		setShowCatalog(true);
	}

	function returnToCurrentProject() {
		Logger.debug("ProjectsApp", "returning to current project");
		if (!currentProject) return;
		const preferred = stageForProject(session, currentProject.projectPath);
		setActiveTab(effectiveTabForProject(preferred, currentProject));
		setShowCatalog(false);
	}

	function handleTabKeyDown(
		event: KeyboardEvent<HTMLButtonElement>,
		index: number,
	) {
		Logger.debug("ProjectsApp", "handling project tab keyboard navigation", {
			key: event.key,
		});
		if (visibleTabs.length === 0) return;
		let nextIndex: number | null = null;
		if (event.key === "ArrowRight")
			nextIndex = (index + 1) % visibleTabs.length;
		if (event.key === "ArrowLeft")
			nextIndex = (index + visibleTabs.length - 1) % visibleTabs.length;
		if (event.key === "Home") nextIndex = 0;
		if (event.key === "End") nextIndex = visibleTabs.length - 1;
		if (nextIndex === null) return;
		event.preventDefault();
		changeTab(visibleTabs[nextIndex].id);
		tabRefs.current[nextIndex]?.focus();
	}

	async function handleConfirmClassReset() {
		if (!currentProject) return;
		Logger.debug("ProjectsApp", "confirming class project reset", {
			projectId: currentProject.projectId,
		});
		setShowResetDialog(false);
		setClassResetState("resetting");
		setClassResetResult(null);
		setClassResetError(null);
		try {
			const agentState = getProjectAgentState(currentProject.projectPath);
			if (
				(agentState.status === "running" ||
					agentState.status === "starting" ||
					agentState.status === "connecting" ||
					agentState.status === "stopping") &&
				agentState.selectedAppId
			) {
				await stopProjectAgent(
					currentProject.projectPath,
					currentProject.adapterRoot,
					agentState.selectedAppId,
				);
				const stopped = await waitForProjectAgentStopped(
					currentProject.projectPath,
					currentProject.adapterRoot,
					agentState.selectedAppId,
				);
				if (!stopped) {
					throw new Error("agent_running");
				}
			}
			const result = await resetProjectClass(
				currentProject.adapterRoot,
				currentProject.projectPath,
			);
			setClassResetResult(result);
			setClassResetState("success");
			setDocsRefreshToken((token) => token + 1);
			Logger.info("ProjectsApp", "class project reset completed", {
				projectId: currentProject.projectId,
				backedUpFiles: result.backedUpFiles,
			});
		} catch (error) {
			const parsed = parseProjectCommandError(error);
			setClassResetError(parsed);
			setClassResetState("error");
			Logger.warn("ProjectsApp", "class project reset failed", {
				projectId: currentProject.projectId,
				code: parsed.code,
			});
		}
	}

	const catalogIsVisible = showCatalog || !currentProject;
	const hasClassReset = Boolean(currentProject?.class?.baselineRef);
	const hasDocsDirs = (currentProject?.docsDirs?.length ?? 0) > 0;
	const activeTabLabel =
		visibleTabs.find((tab) => tab.id === effectiveActiveTab)?.label ??
		TABS[0].label;

	return (
		<main className="projects-app" aria-labelledby="projects-app-title">
			{!catalogIsVisible && currentProject ? (
				<>
					<header
						ref={projectHeaderRef}
						className="projects-app__project-header"
						aria-hidden={isResetDialogOpen ? "true" : undefined}
					>
						<h1 id="projects-app-title">{currentProject.name}</h1>
						<div className="projects-app__header-actions">
							{hasClassReset && (
								<button
									ref={resetTriggerButtonRef}
									className="projects-app__secondary-button"
									type="button"
									disabled={classResetState === "resetting"}
									onClick={() => setShowResetDialog(true)}
								>
									{projectText("projects.classResetButton")}
								</button>
							)}
							<button
								className="projects-app__secondary-button"
								type="button"
								onClick={showOtherProjects}
							>
								{projectText("projects.changeCheckout")}
							</button>
						</div>
					</header>
					{sessionSaveFailed && (
						<output className="projects-app__recovery" aria-live="polite">
							{projectText("projects.sessionSaveFailed")}
						</output>
					)}
					{classResetState === "resetting" && (
						<output className="projects-app__notice" aria-live="polite">
							{projectText("projects.classResetting")}
						</output>
					)}
					{classResetState === "success" && classResetResult && (
						<output
							className="projects-app__notice projects-app__notice--success"
							aria-live="polite"
						>
							<strong>{projectText("projects.classResetSuccessTitle")}</strong>{" "}
							<span>
								{projectText("projects.classResetSuccessDetail", {
									count: classResetResult.backedUpFiles,
									path: classResetResult.backupRelativePath,
								})}
							</span>
						</output>
					)}
					{classResetState === "error" && classResetError && (
						<section
							className="projects-app__notice projects-app__notice--error"
							role="alert"
						>
							<h2>{projectText("projects.classResetErrorTitle")}</h2>
							<p>
								{projectText(classResetErrorMessageKey(classResetError.code))}
							</p>
							{classResetError.relativePathDetail && (
								<p>
									{projectText("projects.agentExpectedCheckoutLabel")}{" "}
									<code>{classResetError.relativePathDetail}</code>
								</p>
							)}
						</section>
					)}
					{showResetDialog && hasClassReset && (
						<div className="projects-app__dialog-backdrop">
							<div
								className="projects-app__dialog"
								// biome-ignore lint/a11y/useSemanticElements: Modal confirmation uses explicit role="dialog" and aria-modal="true" for consistent cross-webview behavior.
								role="dialog"
								aria-modal="true"
								aria-labelledby="projects-class-reset-dialog-title"
							>
								<h2 id="projects-class-reset-dialog-title">
									{projectText("projects.classResetDialogTitle")}
								</h2>
								<ul className="projects-app__dialog-notes">
									<li>{projectText("projects.classResetDialogStopAgent")}</li>
									<li>{projectText("projects.classResetDialogBackup")}</li>
									<li>{projectText("projects.classResetDialogRestore")}</li>
								</ul>
								<div className="projects-app__dialog-actions">
									<button
										ref={cancelResetButtonRef}
										type="button"
										className="projects-app__secondary-button"
										onClick={() => setShowResetDialog(false)}
									>
										{projectText("projects.classResetCancel")}
									</button>
									<button
										ref={confirmResetButtonRef}
										type="button"
										className="projects-app__primary-button"
										onClick={() => void handleConfirmClassReset()}
									>
										{projectText("projects.classResetConfirm")}
									</button>
								</div>
							</div>
						</div>
					)}
					<section
						ref={projectViewRef}
						className="projects-app__project-view"
						aria-hidden={isResetDialogOpen ? "true" : undefined}
					>
						{visibleTabs.length > 1 && (
							<div
								className="projects-app__tabs"
								role="tablist"
								aria-label={projectText("projects.tabsLabel")}
							>
								{visibleTabs.map((tab, index) => (
									<button
										key={tab.id}
										type="button"
										ref={(element) => {
											tabRefs.current[index] = element;
										}}
										id={`projects-tab-${tab.id}`}
										className="projects-app__tab"
										role="tab"
										aria-selected={effectiveActiveTab === tab.id}
										aria-controls="projects-tab-panel"
										tabIndex={effectiveActiveTab === tab.id ? 0 : -1}
										onClick={() => changeTab(tab.id)}
										onKeyDown={(event) => handleTabKeyDown(event, index)}
									>
										{projectText(tab.label)}
									</button>
								))}
							</div>
						)}
						<div
							id="projects-tab-panel"
							className="projects-app__panel"
							role="tabpanel"
							aria-labelledby={
								visibleTabs.length > 1
									? `projects-tab-${effectiveActiveTab}`
									: "projects-tab-heading"
							}
							// biome-ignore lint/a11y/noNoninteractiveTabindex: ARIA tab panels receive focus when their content has no controls.
							tabIndex={0}
						>
							<h2 id="projects-tab-heading">{projectText(activeTabLabel)}</h2>
							{effectiveActiveTab === "agent" && (
								<Suspense fallback={<ProjectPanelLoading />}>
									<ProjectAgentPanel
										projectPath={currentProject.projectPath}
										adapterRoot={currentProject.adapterRoot}
										codingApp={currentProject.codingApp}
										resetting={classResetState === "resetting"}
									/>
								</Suspense>
							)}
							{effectiveActiveTab === "dashboard" && (
								<Suspense fallback={<ProjectPanelLoading />}>
									{hasDocsDirs ? (
										<ProjectDocsPanel
											adapterRoot={currentProject.adapterRoot}
											projectPath={currentProject.projectPath}
											dashboardUrl={currentProject.dashboardUrl}
											docsDirs={currentProject.docsDirs ?? []}
											refreshToken={docsRefreshToken}
										/>
									) : (
										<ProjectWebViewPanel
											adapterRoot={currentProject.adapterRoot}
											projectPath={currentProject.projectPath}
											view="dashboard"
											url={currentProject.dashboardUrl}
										/>
									)}
								</Suspense>
							)}
							{effectiveActiveTab === "issues" && (
								<Suspense fallback={<ProjectPanelLoading />}>
									<ProjectWebViewPanel
										adapterRoot={currentProject.adapterRoot}
										projectPath={currentProject.projectPath}
										view="issues"
										url={currentProject.issuesUrl}
									/>
								</Suspense>
							)}
						</div>
					</section>
				</>
			) : (
				<>
					<header className="projects-app__header">
						<div>
							<p className="projects-app__eyebrow">
								{projectText("projects.title")}
							</p>
							<h1 id="projects-app-title">
								{projectText("projects.chooseTitle")}
							</h1>
						</div>
						<div className="projects-app__header-actions">
							<button
								className="projects-app__secondary-button"
								type="button"
								disabled={loadState === "loading"}
								onClick={() => void reloadCatalog()}
							>
								{loadState === "loading"
									? projectText("projects.reloadingCatalog")
									: projectText("projects.reloadCatalog")}
							</button>
							{currentProject && (
								<button
									className="projects-app__secondary-button"
									type="button"
									onClick={returnToCurrentProject}
								>
									{projectText("projects.returnToCurrentProject", {
										name: currentProject.name,
									})}
								</button>
							)}
						</div>
					</header>
					{loadState === "loading" && (
						<output className="projects-app__notice" aria-live="polite">
							{projectText("projects.loading")}
						</output>
					)}
					{loadState === "error" && (
						<section
							className="projects-app__notice projects-app__notice--error"
							role="alert"
						>
							<h2>{projectText("projects.checkoutError")}</h2>
							<p>{projectText("projects.checkoutErrorHint")}</p>
							{loadError && (
								<button
									type="button"
									onClick={() => void chooseAdkFolder(session)}
								>
									{projectText("projects.chooseAnother")}
								</button>
							)}
						</section>
					)}
					{loadState === "ready" && catalog && (
						<>
							{recoveryNeeded && (
								<output className="projects-app__recovery" aria-live="polite">
									{projectText("projects.lastProjectMissing")}
								</output>
							)}
							{sessionInvalid && (
								<output className="projects-app__recovery" aria-live="polite">
									{projectText("projects.sessionInvalid")}
								</output>
							)}
							{catalog.truncation &&
								(catalog.truncation.moreEntriesAvailable ||
									catalog.truncation.moreRowsAvailable ||
									catalog.truncation.oversizedFiles.length > 0) && (
									<ProjectCatalogTruncationNotice
										truncation={catalog.truncation}
									/>
								)}
							<div className="projects-app__catalog-layout">
								<aside
									className="projects-app__sidebar"
									aria-label={projectText("projects.catalogLabel")}
								>
									<label
										className="projects-app__search-label"
										htmlFor="projects-search"
									>
										{projectText("projects.searchLabel")}
									</label>
									<input
										id="projects-search"
										className="projects-app__search"
										type="search"
										value={search}
										placeholder={projectText("projects.searchPlaceholder")}
										onChange={(event) => setSearch(event.target.value)}
									/>
									{catalog.projects.length === 0 ? (
										<div className="projects-app__notice">
											<h2>{projectText("projects.emptyTitle")}</h2>
											<p>{projectText("projects.emptyHint")}</p>
										</div>
									) : visibleProjects.length === 0 ? (
										<output className="projects-app__hint" aria-live="polite">
											{projectText("projects.noSearchResults")}
										</output>
									) : (
										<ul className="projects-app__list">
											{visibleProjects.map((project) => (
												<ProjectRow
													key={normalizeProjectPath(project.projectPath)}
													project={project}
													onOpen={() => openProject(project)}
												/>
											))}
										</ul>
									)}
									<CatalogErrorList errors={catalog.catalogErrors} />
								</aside>
							</div>
						</>
					)}
				</>
			)}
		</main>
	);
}

export default ProjectsApp;
