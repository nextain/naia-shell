import { open } from "@tauri-apps/plugin-dialog";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { Logger } from "../../lib/logger";
import {
	type CatalogProject,
	type ProjectCatalog,
	type ProjectCatalogTruncation,
	type ProjectConfigIssue,
	type ProjectConfigIssueReason,
	scanProjectCatalog,
} from "./project-catalog";
import { type ProjectTranslationKey, projectText } from "./translations";
import "./projects.css";

type ProjectTab = "agent" | "dashboard" | "issues";
type LoadState = "choose" | "loading" | "ready" | "error";

const TABS: Array<{ id: ProjectTab; label: ProjectTranslationKey }> = [
	{ id: "agent", label: "projects.tabCodingAgent" },
	{ id: "dashboard", label: "projects.tabDashboard" },
	{ id: "issues", label: "projects.tabInternalIssues" },
];

function issueMessage(reason: ProjectConfigIssueReason): ProjectTranslationKey {
	switch (reason) {
		case "missing":
			return "projects.fileMissing";
		case "unreadable":
			return "projects.fileUnreadable";
		case "invalid_yaml":
			return "projects.fileInvalid";
		case "missing_project_id":
			return "projects.projectIdMissing";
		case "unsafe_path":
			return "projects.unsafePath";
	}
}

function checkoutLabel(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function ProjectIssueList({ issues }: { issues: ProjectConfigIssue[] }) {
	return (
		<ul className="projects-app__issues">
			{issues.map((issue) => (
				<li key={`${issue.file}:${issue.reason}`}>
					<code>{issue.file}</code> —{" "}
					{projectText(issueMessage(issue.reason), { file: issue.file })}
				</li>
			))}
		</ul>
	);
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

function ProjectRow({
	project,
	selected,
	onSelect,
}: {
	project: CatalogProject;
	selected: boolean;
	onSelect: () => void;
}) {
	if (project.configErrors.length > 0) {
		return (
			<li className="projects-app__project projects-app__project--unavailable">
				<div className="projects-app__project-heading">
					<strong>{project.name}</strong>
					<span className="projects-app__badge">
						{projectText("projects.unavailable")}
					</span>
				</div>
				<p className="projects-app__project-meta">{project.projectId}</p>
				<p>{projectText("projects.configError")}</p>
				<ProjectIssueList issues={project.configErrors} />
				<p className="projects-app__hint">
					{projectText("projects.configErrorHint")}
				</p>
			</li>
		);
	}

	return (
		<li className="projects-app__project">
			<button
				className="projects-app__project-button"
				type="button"
				aria-pressed={selected}
				onClick={onSelect}
			>
				<span className="projects-app__project-heading">
					<strong>{project.name}</strong>
					{selected && (
						<span className="projects-app__badge">
							{projectText("projects.selected")}
						</span>
					)}
				</span>
				<span className="projects-app__project-meta">
					{project.projectId}
					{project.repository ? ` · ${project.repository}` : ""}
				</span>
			</button>
		</li>
	);
}

export function ProjectsApp() {
	const [checkoutPath, setCheckoutPath] = useState<string | null>(null);
	const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
	const [selectedDirectory, setSelectedDirectory] = useState<string | null>(
		null,
	);
	const [activeTab, setActiveTab] = useState<ProjectTab>("agent");
	const [search, setSearch] = useState("");
	const [loadState, setLoadState] = useState<LoadState>("choose");
	const [pickerError, setPickerError] = useState(false);
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

	const selectedProject = catalog?.projects.find(
		(project) =>
			project.directoryName === selectedDirectory &&
			project.configErrors.length === 0,
	);
	const visibleProjects = useMemo(() => {
		const query = search.trim().toLocaleLowerCase();
		if (!query) return catalog?.projects ?? [];
		return (catalog?.projects ?? []).filter((project) =>
			[project.name, project.projectId, project.repository ?? ""].some(
				(value) => value.toLocaleLowerCase().includes(query),
			),
		);
	}, [catalog, search]);

	async function chooseCheckout() {
		setPickerError(false);
		try {
			const selected = await open({
				directory: true,
				multiple: false,
				title: projectText("projects.chooseCheckout"),
			});
			if (typeof selected !== "string") {
				Logger.debug("ProjectsApp", "checkout selection cancelled");
				return;
			}

			setCheckoutPath(selected);
			setCatalog(null);
			setSelectedDirectory(null);
			setSearch("");
			setLoadState("loading");
			Logger.debug("ProjectsApp", "project catalog scan started");
			const result = await scanProjectCatalog(selected);
			setCatalog(result);
			setLoadState("ready");
			Logger.info("ProjectsApp", "project catalog scan completed", {
				projectCount: result.projects.length,
				configErrorCount: result.projects.reduce(
					(total, project) => total + project.configErrors.length,
					0,
				),
			});
		} catch (error) {
			setLoadState("error");
			setPickerError(true);
			Logger.warn("ProjectsApp", "project checkout could not be read", {
				error: String(error),
			});
		}
	}

	function selectProject(project: CatalogProject) {
		setSelectedDirectory(project.directoryName);
		setActiveTab("agent");
		Logger.info("ProjectsApp", "project opened", {
			projectId: project.projectId,
		});
	}

	function handleTabKeyDown(
		event: KeyboardEvent<HTMLButtonElement>,
		index: number,
	) {
		let nextIndex: number | null = null;
		if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
		if (event.key === "ArrowLeft")
			nextIndex = (index + TABS.length - 1) % TABS.length;
		if (event.key === "Home") nextIndex = 0;
		if (event.key === "End") nextIndex = TABS.length - 1;
		if (nextIndex === null) return;
		event.preventDefault();
		setActiveTab(TABS[nextIndex].id);
		tabRefs.current[nextIndex]?.focus();
	}

	return (
		<main className="projects-app" aria-labelledby="projects-app-title">
			<header className="projects-app__header">
				<div>
					<p className="projects-app__eyebrow">
						{projectText("projects.title")}
					</p>
					<h1 id="projects-app-title">
						{selectedProject?.name ?? projectText("projects.chooseTitle")}
					</h1>
					{checkoutPath && (
						<p className="projects-app__checkout">
							{projectText("projects.checkoutLabel")}:{" "}
							<strong>{checkoutLabel(checkoutPath)}</strong>
						</p>
					)}
				</div>
				<button
					className="projects-app__primary-button"
					type="button"
					onClick={chooseCheckout}
					disabled={loadState === "loading"}
				>
					{checkoutPath
						? projectText("projects.changeCheckout")
						: projectText("projects.chooseCheckout")}
				</button>
			</header>

			{loadState === "choose" && (
				<section
					className="projects-app__notice"
					aria-labelledby="projects-empty-title"
				>
					<h2 id="projects-empty-title">
						{projectText("projects.noCheckoutTitle")}
					</h2>
					<p>{projectText("projects.noCheckoutHint")}</p>
				</section>
			)}

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
					{pickerError && (
						<button type="button" onClick={chooseCheckout}>
							{projectText("projects.chooseAnother")}
						</button>
					)}
				</section>
			)}

			{loadState === "ready" &&
				catalog?.truncation &&
				(catalog.truncation.moreEntriesAvailable ||
					catalog.truncation.oversizedFiles.length > 0) && (
					<ProjectCatalogTruncationNotice truncation={catalog.truncation} />
				)}

			{loadState === "ready" && catalog && (
				<div className="projects-app__layout">
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
										key={project.directoryName}
										project={project}
										selected={selectedDirectory === project.directoryName}
										onSelect={() => selectProject(project)}
									/>
								))}
							</ul>
						)}
					</aside>

					<section
						className="projects-app__content"
						aria-label={projectText("projects.projectContent")}
					>
						{selectedProject ? (
							<>
								<div className="projects-app__selected">
									<p className="projects-app__eyebrow">
										{projectText("projects.selectedProject")}
									</p>
									<h2>{selectedProject.name}</h2>
									<p>{selectedProject.projectId}</p>
								</div>
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
											onClick={() => setActiveTab(tab.id)}
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
									<h3>
										{projectText(
											TABS.find((tab) => tab.id === activeTab)?.label ??
												TABS[0].label,
										)}
									</h3>
									<p>{projectText("projects.stageOneEmpty")}</p>
								</div>
							</>
						) : (
							<div className="projects-app__notice">
								<h2>{projectText("projects.selectTitle")}</h2>
								<p>{projectText("projects.selectHint")}</p>
							</div>
						)}
					</section>
				</div>
			)}
		</main>
	);
}

export default ProjectsApp;
