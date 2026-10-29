import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Logger } from "../../lib/logger";
import { MarkdownPreview } from "../workspace/MarkdownPreview";
import { ProjectWebViewPanel } from "./ProjectWebViewPanel";
import {
	type ParsedProjectCommandError,
	type ProjectDocEntry,
	listProjectDocs,
	parseProjectCommandError,
	readProjectDoc,
} from "./project-catalog";
import { type ProjectTranslationKey, projectText } from "./translations";

function docsErrorMessageKey(code: string): ProjectTranslationKey {
	switch (code) {
		case "timeout":
			return "projects.docsErrorTimeout";
		case "project_unverified":
			return "projects.agentProjectUnverified";
		case "repository_invalid":
			return "projects.agentRepositoryInvalid";
		case "checkout_missing":
			return "projects.agentCheckoutMissing";
		case "checkout_unsafe":
			return "projects.agentCheckoutUnsafe";
		case "doc_too_large":
			return "projects.docsErrorTooLarge";
		case "doc_not_found":
			return "projects.docsErrorNotFound";
		case "doc_outside_configured_dirs":
		case "doc_symlink_rejected":
		case "doc_invalid_path":
		case "doc_path_invalid":
		case "doc_not_regular_file":
		case "doc_not_markdown":
			return "projects.docsErrorOutside";
		default:
			return "projects.docsErrorRecovery";
	}
}

function displayPathWithinDir(entry: ProjectDocEntry): string {
	const prefix = `${entry.dir}/`;
	return entry.relativePath.startsWith(prefix)
		? entry.relativePath.slice(prefix.length)
		: entry.relativePath;
}

const PROJECT_DOCS_REQUEST_TIMEOUT_MS = 10_000;

async function withDocsTimeout<T>(request: Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			request,
			new Promise<T>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("timeout")),
					PROJECT_DOCS_REQUEST_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

export function ProjectDocsPanel({
	adapterRoot,
	projectPath,
	dashboardUrl,
	docsDirs,
	refreshToken = 0,
}: {
	adapterRoot: string;
	projectPath: string;
	dashboardUrl: string | null;
	docsDirs: string[];
	refreshToken?: number;
}) {
	Logger.debug("ProjectDocsPanel", "rendering project docs panel", {
		docsDirCount: docsDirs.length,
		hasDashboardUrl: Boolean(dashboardUrl?.trim()),
	});
	const [entries, setEntries] = useState<ProjectDocEntry[]>([]);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [content, setContent] = useState<string>("");
	const [loadingList, setLoadingList] = useState<boolean>(true);
	const [loadingFile, setLoadingFile] = useState<boolean>(false);
	const [listError, setListError] = useState<ParsedProjectCommandError | null>(
		null,
	);
	const [readError, setReadError] = useState<ParsedProjectCommandError | null>(
		null,
	);
	const selectedPathRef = useRef<string | null>(null);
	selectedPathRef.current = selectedPath;
	const requestSeqRef = useRef(0);
	const fileRequestSeqRef = useRef(0);

	const loadFile = useCallback(
		async (relativePath: string) => {
			const fileSeq = ++fileRequestSeqRef.current;
			setSelectedPath(relativePath);
			setLoadingFile(true);
			setReadError(null);
			try {
				const text = await withDocsTimeout(
					readProjectDoc(adapterRoot, projectPath, relativePath),
				);
				if (fileRequestSeqRef.current !== fileSeq) return;
				setContent(text);
				setLoadingFile(false);
			} catch (error) {
				if (fileRequestSeqRef.current !== fileSeq) return;
				const parsed = parseProjectCommandError(error);
				setContent("");
				setReadError(parsed);
				setLoadingFile(false);
				Logger.warn("ProjectDocsPanel", "project doc could not be read", {
					code: parsed.code,
				});
			}
		},
		[adapterRoot, projectPath],
	);

	const loadDocsList = useCallback(async () => {
		const seq = ++requestSeqRef.current;
		setLoadingList(true);
		setListError(null);
		try {
			const nextEntries = await withDocsTimeout(
				listProjectDocs(adapterRoot, projectPath),
			);
			if (requestSeqRef.current !== seq) return;
			setEntries(nextEntries);
			setLoadingList(false);
			const previousSelected = selectedPathRef.current;
			const nextSelected =
				previousSelected &&
				nextEntries.some((entry) => entry.relativePath === previousSelected)
					? previousSelected
					: (nextEntries[0]?.relativePath ?? null);
			if (nextSelected) {
				void loadFile(nextSelected);
			} else {
				setSelectedPath(null);
				setContent("");
				setReadError(null);
			}
		} catch (error) {
			if (requestSeqRef.current !== seq) return;
			const parsed = parseProjectCommandError(error);
			setEntries([]);
			setSelectedPath(null);
			setContent("");
			setListError(parsed);
			setLoadingList(false);
			Logger.warn("ProjectDocsPanel", "project docs list could not be loaded", {
				code: parsed.code,
			});
		}
	}, [adapterRoot, loadFile, projectPath]);

	useEffect(() => {
		selectedPathRef.current = null;
		setSelectedPath(null);
		setContent("");
		setReadError(null);
		void loadDocsList();
	}, [loadDocsList]);

	useEffect(() => {
		if (refreshToken > 0) {
			Logger.debug("ProjectDocsPanel", "refreshing docs after token change", {
				refreshToken,
			});
			void loadDocsList();
		}
	}, [loadDocsList, refreshToken]);

	const groupedEntries = useMemo(() => {
		const groups = new Map<string, ProjectDocEntry[]>();
		for (const dir of docsDirs) {
			groups.set(dir, []);
		}
		for (const entry of entries) {
			const bucket = groups.get(entry.dir);
			if (bucket) {
				bucket.push(entry);
			} else {
				groups.set(entry.dir, [entry]);
			}
		}
		return Array.from(groups.entries()).filter(([, items]) => items.length > 0);
	}, [docsDirs, entries]);

	const hasDashboardUrl = Boolean(dashboardUrl?.trim());

	return (
		<div className="projects-app__docs-wrapper">
			{hasDashboardUrl && (
				<ProjectWebViewPanel
					adapterRoot={adapterRoot}
					projectPath={projectPath}
					view="dashboard"
					url={dashboardUrl}
				/>
			)}
			<section
				className="projects-app__docs"
				aria-label={projectText("projects.docsSectionLabel")}
			>
				<div className="projects-app__docs-toolbar">
					<button
						type="button"
						className="projects-app__secondary-button"
						disabled={loadingList}
						onClick={() => void loadDocsList()}
					>
						{loadingList
							? projectText("projects.docsRefreshing")
							: projectText("projects.docsRefresh")}
					</button>
				</div>
				{loadingList && entries.length === 0 && !listError && (
					<output className="projects-app__notice" aria-live="polite">
						{projectText("projects.docsLoadingList")}
					</output>
				)}
				{listError && (
					<section
						className="projects-app__notice projects-app__notice--error"
						role="alert"
					>
						<h3>{projectText("projects.docsListErrorTitle")}</h3>
						<p>{projectText(docsErrorMessageKey(listError.code))}</p>
						{listError.relativePathDetail && (
							<p>
								{projectText("projects.agentExpectedCheckoutLabel")}{" "}
								<code>{listError.relativePathDetail}</code>
							</p>
						)}
						{docsErrorMessageKey(listError.code) !==
							"projects.docsErrorRecovery" && (
							<p>{projectText("projects.docsErrorRecovery")}</p>
						)}
					</section>
				)}
				{!loadingList && !listError && entries.length === 0 && (
					<div className="projects-app__notice">
						<h3>{projectText("projects.docsEmptyTitle")}</h3>
						<p>{projectText("projects.docsEmptyHint")}</p>
					</div>
				)}
				{!listError && entries.length > 0 && (
					<div className="projects-app__docs-layout">
						<nav
							className="projects-app__docs-list"
							aria-label={projectText("projects.docsListLabel")}
						>
							{groupedEntries.map(([dir, dirEntries]) => (
								<div key={dir} className="projects-app__docs-group">
									<h3 className="projects-app__docs-group-title">{dir}</h3>
									<ul className="projects-app__docs-items">
										{dirEntries.map((entry) => {
											const isSelected = selectedPath === entry.relativePath;
											return (
												<li key={entry.relativePath}>
													<button
														type="button"
														className={`projects-app__docs-item${isSelected ? " projects-app__docs-item--selected" : ""}`}
														aria-current={isSelected ? "true" : undefined}
														title={entry.relativePath}
														onClick={() => void loadFile(entry.relativePath)}
													>
														{displayPathWithinDir(entry)}
													</button>
												</li>
											);
										})}
									</ul>
								</div>
							))}
						</nav>
						<div
							className="projects-app__docs-preview"
							aria-label={projectText("projects.docsPreviewLabel")}
						>
							{loadingFile && (
								<output className="projects-app__notice" aria-live="polite">
									{projectText("projects.docsLoadingFile")}
								</output>
							)}
							{!loadingFile && readError && (
								<section
									className="projects-app__notice projects-app__notice--error"
									role="alert"
								>
									<h3>{projectText("projects.docsReadErrorTitle")}</h3>
									<p>{projectText(docsErrorMessageKey(readError.code))}</p>
									{readError.relativePathDetail && (
										<p>
											{projectText("projects.agentExpectedCheckoutLabel")}{" "}
											<code>{readError.relativePathDetail}</code>
										</p>
									)}
									{docsErrorMessageKey(readError.code) !==
										"projects.docsErrorRecovery" && (
										<p>{projectText("projects.docsErrorRecovery")}</p>
									)}
								</section>
							)}
							{!loadingFile && !readError && selectedPath && (
								<MarkdownPreview
									content={content}
									filePath={selectedPath}
									workspaceRoot=""
								/>
							)}
							{!loadingFile && !readError && !selectedPath && (
								<p className="projects-app__hint">
									{projectText("projects.docsSelectHint")}
								</p>
							)}
						</div>
					</div>
				)}
			</section>
		</div>
	);
}
