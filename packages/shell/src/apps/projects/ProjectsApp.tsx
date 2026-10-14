import { open } from "@tauri-apps/plugin-dialog";
import {
	type KeyboardEvent,
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getAdkPath, setAdkPath } from "../../lib/adk-store";
import { Logger } from "../../lib/logger";
const ProjectAgentPanel = lazy(() =>
	import("./ProjectAgentPanel").then((module) => ({
		default: module.ProjectAgentPanel,
	})),
);
const ProjectWebViewPanel = lazy(() =>
	import("./ProjectWebViewPanel").then((module) => ({
		default: module.ProjectWebViewPanel,
	})),
);
import {
	type CatalogIssue,
	type CatalogProject,
	type ProjectCatalog,
	type ProjectCatalogTruncation,
	type ProjectConfigIssueReason,
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

type LoadState = "loading" | "ready" | "error";

const TABS: Array<{ id: ProjectStage; label: ProjectTranslationKey }> = [
	{ id: "agent", label: "projects.tabCodingAgent" },
	{ id: "dashboard", label: "projects.tabDashboard" },
	{ id: "issues", label: "projects.tabInternalIssues" },
];

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
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const initialized = useRef(false);

	const currentProject = catalog?.projects.find(
		(project) =>
			normalizeProjectPath(project.projectPath) === currentProjectPath,
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
				setCurrentProjectPath(normalizeProjectPath(restored.projectPath));
				setActiveTab(stageForProject(saved, restored.projectPath));
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

	function openProject(project: CatalogProject) {
		Logger.debug("ProjectsApp", "opening selected project", {
			projectId: project.projectId,
		});
		const projectPath = normalizeProjectPath(project.projectPath);
		const stagesByProjectPath = { ...session.stagesByProjectPath };
		if (currentProjectPath) stagesByProjectPath[currentProjectPath] = activeTab;
		const nextSession: ProjectSession = {
			version: 1,
			lastProject: { id: project.projectId, path: projectPath },
			stagesByProjectPath,
		};
		const nextTab = stageForProject(nextSession, projectPath);
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
		setSearch("");
		setShowCatalog(true);
	}

	function returnToCurrentProject() {
		Logger.debug("ProjectsApp", "returning to current project");
		if (!currentProject) return;
		setActiveTab(stageForProject(session, currentProject.projectPath));
		setShowCatalog(false);
	}

	function handleTabKeyDown(
		event: KeyboardEvent<HTMLButtonElement>,
		index: number,
	) {
		Logger.debug("ProjectsApp", "handling project tab keyboard navigation", {
			key: event.key,
		});
		let nextIndex: number | null = null;
		if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
		if (event.key === "ArrowLeft")
			nextIndex = (index + TABS.length - 1) % TABS.length;
		if (event.key === "Home") nextIndex = 0;
		if (event.key === "End") nextIndex = TABS.length - 1;
		if (nextIndex === null) return;
		event.preventDefault();
		changeTab(TABS[nextIndex].id);
		tabRefs.current[nextIndex]?.focus();
	}

	const catalogIsVisible = showCatalog || !currentProject;

	return (
		<main className="projects-app" aria-labelledby="projects-app-title">
			{!catalogIsVisible && currentProject ? (
				<>
					<header className="projects-app__project-header">
						<h1 id="projects-app-title">{currentProject.name}</h1>
						<button
							className="projects-app__secondary-button"
							type="button"
							onClick={showOtherProjects}
						>
							{projectText("projects.changeCheckout")}
						</button>
					</header>
					{sessionSaveFailed && (
						<output className="projects-app__recovery" aria-live="polite">
							{projectText("projects.sessionSaveFailed")}
						</output>
					)}
					<section className="projects-app__project-view">
						<div
							className="projects-app__tabs"
							role="tablist"
							aria-label={projectText("projects.tabsLabel")}
						>
							{TABS.map((tab, index) => (
								<button
									key={tab.id}
									type="button"
									ref={(element) => {
										tabRefs.current[index] = element;
									}}
									id={`projects-tab-${tab.id}`}
									className="projects-app__tab"
									role="tab"
									aria-selected={activeTab === tab.id}
									aria-controls="projects-tab-panel"
									tabIndex={activeTab === tab.id ? 0 : -1}
									onClick={() => changeTab(tab.id)}
									onKeyDown={(event) => handleTabKeyDown(event, index)}
								>
									{projectText(tab.label)}
								</button>
							))}
						</div>
						<div
							id="projects-tab-panel"
							className="projects-app__panel"
							role="tabpanel"
							aria-labelledby={`projects-tab-${activeTab}`}
							// biome-ignore lint/a11y/noNoninteractiveTabindex: ARIA tab panels receive focus when their content has no controls.
							tabIndex={0}
						>
							<h2>
								{projectText(
									TABS.find((tab) => tab.id === activeTab)?.label ??
										TABS[0].label,
								)}
							</h2>
							{activeTab === "agent" && (
								<Suspense fallback={<ProjectPanelLoading />}>
									<ProjectAgentPanel
										projectPath={currentProject.projectPath}
										adapterRoot={currentProject.adapterRoot}
									/>
								</Suspense>
							)}
							{activeTab === "dashboard" && (
								<Suspense fallback={<ProjectPanelLoading />}>
									<ProjectWebViewPanel
										adapterRoot={currentProject.adapterRoot}
										projectPath={currentProject.projectPath}
										view="dashboard"
										url={currentProject.dashboardUrl}
									/>
								</Suspense>
							)}
							{activeTab === "issues" && (
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
