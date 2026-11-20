import {
	type CSSProperties,
	type ChangeEvent,
	type MouseEvent as ReactMouseEvent,
	Suspense,
	lazy,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { t } from "../../lib/i18n";
import { isKioskDemo } from "../../lib/kiosk-demo/flag";
import { Logger } from "../../lib/logger";
import { getStoredLayoutOrientation } from "../../lib/ui-preferences";
import {
	seedKioskAdkWorkspace,
	seedKioskKnowledge,
} from "../../lib/kiosk-demo/knowledge";
import { seedKioskSlidesWorkspace } from "../../lib/kiosk-demo/slides";
import { WEB_ADK_PATH } from "../../lib/web-runtime/web-adk-path";
import {
	KIOSK_ADK_ROOT_ORDER,
	isKioskEditableWebAdkPath,
	isKioskVisibleEntry,
} from "../../lib/web-runtime/web-adk-policy";
import {
	ensureKioskAdkBundle,
	revertKioskAdkFile,
} from "../../lib/web-runtime/web-adk-edit";
import { getWebFs } from "../../lib/web-runtime/web-fs";
import {
	WEB_BGM_MUSIC_CHANGED_EVENT,
	WEB_BGM_MUSIC_DIR,
	readWebBgmMusicBlob,
	webBgmFileName,
} from "../../lib/web-runtime/web-bgm-music";
import { WEB_SETTINGS_ASSETS_CHANGED_EVENT } from "../../lib/web-runtime/web-nva-archive";
import {
	isWebBundledSettingsDirectory,
	mergeWebBundledSettingsEntries,
	webSettingsImportExtensions,
	type WebWorkspaceEntry,
} from "../../lib/web-runtime/web-settings-catalog";
import {
	getWebWorkspaceFile,
	importWebWorkspaceFile,
	isWebWorkspaceImportDirectory,
	openWebWorkspaceImportRoot,
	type WebWorkspaceImportTarget,
} from "../../lib/web-runtime/web-workspace-files";
import {
	getWebAdkStatus,
	subscribeWebAdkStatus,
} from "../../lib/web-runtime/web-adk-status";
import { resolveWorkspaceViewer } from "./viewer-registry";

const Editor = lazy(() =>
	import("./Editor").then((m) => ({ default: m.Editor })),
);
export type { WebWorkspaceEntry } from "../../lib/web-runtime/web-settings-catalog";
type EntriesDirectory = FileSystemDirectoryHandle & {
	values(): AsyncIterable<FileSystemHandle>;
};

export const WEB_WORKSPACE_OPEN_FILE_EVENT = "naia-web-workspace-open-file";
let pendingOpenFilePath: string | null = null;

export function normalizeKioskWorkspaceFilePath(rawPath: string): string {
	const trimmed = rawPath.trim().replace(/^\/+/, "");
	if (trimmed.startsWith(`${WEB_ADK_PATH}/`)) {
		return trimmed;
	}
	return `${WEB_ADK_PATH}/${trimmed}`;
}

export function openWebWorkspaceFile(rawPath: string): void {
	const fullPath = normalizeKioskWorkspaceFilePath(rawPath);
	pendingOpenFilePath = fullPath;
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent(WEB_WORKSPACE_OPEN_FILE_EVENT, {
				detail: { path: fullPath },
			}),
		);
	}
}

// 지나가 실제로 읽는 AGENTS.md 가 탐색기 맨 위·기본 선택이다.
const KIOSK_ROOT_ORDER = KIOSK_ADK_ROOT_ORDER;
const KIOSK_DEFAULT_FILE = `${WEB_ADK_PATH}/AGENTS.md`;

export function isVisibleWebWorkspaceEntry(
	name: string,
	parentPath: string,
	kiosk: boolean = isKioskDemo(),
): boolean {
	if (!kiosk) return true;
	return isKioskVisibleEntry(name, parentPath);
}

export function sortWebWorkspaceEntries(
	entries: readonly WebWorkspaceEntry[],
	parentPath: string,
	kiosk: boolean = isKioskDemo(),
): WebWorkspaceEntry[] {
	const copy = [...entries];
	if (kiosk && parentPath === WEB_ADK_PATH) {
		const rank = (name: string): number => {
			const idx = (KIOSK_ROOT_ORDER as readonly string[]).indexOf(name);
			return idx === -1 ? KIOSK_ROOT_ORDER.length : idx;
		};
		return copy.sort((a, b) => {
			const ra = rank(a.name);
			const rb = rank(b.name);
			if (ra !== rb) return ra - rb;
			return a.name.localeCompare(b.name);
		});
	}
	return copy.sort((a, b) =>
		a.kind === b.kind
			? a.name.localeCompare(b.name)
			: a.kind === "directory"
				? -1
				: 1,
	);
}

type ImportDirectoryProps = {
	importTargetPath?: string;
	onSelectImportTarget?: (target: WebWorkspaceImportTarget) => void;
	treeRevision: number;
};

function Directory({
	dir,
	path,
	onOpen,
	activeFile,
	...importProps
}: {
	/** null 이면 OPFS 에 없는 앱 기본 폴더(R32). */
	dir: FileSystemDirectoryHandle | null;
	path: string;
	onOpen: (path: string) => void;
	activeFile?: string;
} & ImportDirectoryProps) {
	const { treeRevision } = importProps;
	const [entries, setEntries] = useState<WebWorkspaceEntry[] | null>(null);
	const [error, setError] = useState(false);
	useEffect(() => {
		let active = true;
		(async () => {
			try {
				const found: WebWorkspaceEntry[] = [];
				if (dir) {
					for await (const entry of (dir as EntriesDirectory).values()) {
						if (!isVisibleWebWorkspaceEntry(entry.name, path)) continue;
						found.push({ name: entry.name, kind: entry.kind });
					}
				}
				const merged = isKioskDemo()
					? found
					: mergeWebBundledSettingsEntries(path, found);
				const sorted = sortWebWorkspaceEntries(merged, path);
				if (active) {
					setEntries(sorted);
					setError(false);
				}
			} catch (cause) {
				Logger.debug("WebWorkspace", "Could not list directory", {
					error: cause instanceof Error ? cause.name : "UnknownError",
				});
				if (active) setError(true);
			}
		})();
		return () => {
			active = false;
		};
	}, [dir, path, treeRevision]);
	if (error) return <p role="alert">{t("webExplorer.readFailed")}</p>;
	if (path === WEB_BGM_MUSIC_DIR) {
		if (!entries) {
			return <p className="web-workspace-edit-hint" role="status">{t("bgm.loading")}</p>;
		}
		if (entries.length === 0) {
			return <p className="web-workspace-edit-hint">{t("bgm.webNoTracks")}</p>;
		}
	}
	return (
		<ul className="web-workspace-list">
			{entries?.map((entry) =>
				entry.kind === "directory" ? (
					<Folder
						key={entry.name}
						parent={dir}
						name={entry.name}
						path={`${path}/${entry.name}`}
						onOpen={onOpen}
						activeFile={activeFile}
						{...importProps}
					/>
				) : (
					<li key={entry.name}>
						<button
							type="button"
							aria-pressed={activeFile === `${path}/${entry.name}`}
							onClick={() => onOpen(`${path}/${entry.name}`)}
						>
							📄 {entry.name}{" "}
							{entry.bundled && (
								<span className="web-workspace-bundled">
									{t("webExplorer.bundled")}
								</span>
							)}
						</button>
					</li>
				),
			)}
		</ul>
	);
}

function Folder({
	parent,
	name,
	path,
	onOpen,
	activeFile,
	...importProps
}: {
	parent: FileSystemDirectoryHandle | null;
	name: string;
	path: string;
	onOpen: (path: string) => void;
	activeFile?: string;
} & ImportDirectoryProps) {
	const { importTargetPath, onSelectImportTarget, treeRevision } = importProps;
	const shouldAutoOpen = Boolean(
		activeFile?.startsWith(`${path}/`) ||
		importTargetPath === path ||
		importTargetPath?.startsWith(`${path}/`),
	);
	const [open, setOpen] = useState(shouldAutoOpen);
	// undefined: 아직 안 읽음. null: 브라우저에 저장된 파일이 없는 기본 폴더.
	const [dir, setDir] = useState<FileSystemDirectoryHandle | null>();
	const [error, setError] = useState(false);
	useEffect(() => {
		if (shouldAutoOpen) setOpen(true);
	}, [shouldAutoOpen, activeFile, importTargetPath]);
	useEffect(() => {
		if (!open) return;
		let active = true;
		void (async () => {
			try {
				const handle = parent ? await parent.getDirectoryHandle(name) : null;
				if (active) {
					setDir(handle);
					setError(false);
				}
			} catch (cause) {
				if (!active) return;
				const bundled = !isKioskDemo() && isWebBundledSettingsDirectory(path);
				if (
					bundled &&
					cause instanceof DOMException &&
					cause.name === "NotFoundError"
				) {
					setDir(null);
					setError(false);
					return;
				}
				setError(true);
			}
		})();
		return () => {
			active = false;
		};
	}, [open, parent, name, path, treeRevision]);
	return (
		<li>
			<details
				open={open}
				onToggle={(event) => setOpen(event.currentTarget.open)}
			>
				<summary>📁 {name}</summary>
				{error && <p role="alert">{t("webExplorer.readFailed")}</p>}
				{!error && dir !== undefined && (
					<>
						{onSelectImportTarget && isWebWorkspaceImportDirectory(path) && (
							<button
								type="button"
								aria-pressed={importTargetPath === path}
								onClick={() => onSelectImportTarget({ path, directory: dir })}
							>
								{t("webExplorer.importPickFolder", { folder: name })}
							</button>
						)}
						<Directory
							dir={dir}
							path={path}
							onOpen={onOpen}
							activeFile={activeFile}
							{...importProps}
						/>
					</>
				)}
			</details>
		</li>
	);
}

export function isMobileWorkspaceViewport(): boolean {
	if (getStoredLayoutOrientation() === "portrait") return true;
	if (typeof window === "undefined") return false;
	if (window.innerWidth > 0 && window.innerWidth <= 600) return true;
	if (typeof window.matchMedia === "function") {
		try {
			if (
				window.matchMedia("(max-width: 600px) and (orientation: portrait)")
					.matches
			) {
				return true;
			}
		} catch {}
	}
	return (
		window.innerWidth > 0 &&
		window.innerWidth <= 600 &&
		window.innerHeight >= window.innerWidth
	);
}

function workspaceImportError(error: unknown) {
	if (error instanceof DOMException) {
		if (error.name === "DataError") return "webExplorer.importType";
		if (error.name === "QuotaExceededError") return "webExplorer.importFull";
		if (error.name === "NotFoundError" || error.name === "TypeMismatchError")
			return "webExplorer.importFolderChanged";
		if (error.name === "NotSupportedError" || error.name === "SecurityError")
			return "webExplorer.importUnavailable";
	}
	return "webExplorer.importFailed";
}

function WorkspaceMusicPreview({ path, name }: { path: string; name: string }) {
	const [url, setUrl] = useState<string>();
	const [error, setError] = useState(false);
	useEffect(() => {
		let active = true;
		let objectUrl: string | undefined;
		void readWebBgmMusicBlob(path)
			.then((blob) => {
				if (!active) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			})
			.catch((cause) => {
				Logger.debug("WebWorkspace", "Could not open imported audio", {
					error: cause instanceof Error ? cause.name : "UnknownError",
				});
				if (active) setError(true);
			});
		return () => {
			active = false;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [path]);
	return (
		<div className="workspace-editor__media-viewer">
			{error ? (
				<p className="workspace-editor__media-error" role="alert">
					{t("workspace.mediaOpenError")}
				</p>
			) : url ? (
				<audio
					controls
					preload="metadata"
					aria-label={name}
					src={url}
					onError={() => setError(true)}
				>
					<track kind="captions" />
				</audio>
			) : (
				<p role="status">{t("bgm.loading")}</p>
			)}
		</div>
	);
}

export default function WebWorkspace() {
	const status = useSyncExternalStore(subscribeWebAdkStatus, getWebAdkStatus);
	const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
	const [error, setError] = useState(false);
	const [showPath, setShowPath] = useState(false);
	const [explorerOpen, setExplorerOpen] = useState(
		() => !isMobileWorkspaceViewport(),
	);
	const [file, setFile] = useState(() => {
		if (pendingOpenFilePath) {
			const next = pendingOpenFilePath;
			pendingOpenFilePath = null;
			return next;
		}
		return isKioskDemo() ? KIOSK_DEFAULT_FILE : "";
	});
	const [editorRevision, setEditorRevision] = useState(0);
	const [revertNotice, setRevertNotice] = useState("");
	const editable = Boolean(file) && isKioskEditableWebAdkPath(file);
	const [treeWidth, setTreeWidth] = useState(() => (isKioskDemo() ? 236 : 180));
	const workspaceRef = useRef<HTMLDivElement>(null);
	const importInput = useRef<HTMLInputElement>(null);
	const pickedTarget = useRef<WebWorkspaceImportTarget | null>(null);
	const [importTarget, setImportTarget] = useState<WebWorkspaceImportTarget | null>(null);
	const importExtensions = importTarget
		? webSettingsImportExtensions(importTarget.path)
		: undefined;
	const importTypes = { types: importExtensions?.join(", ") ?? "" };
	const [importStatus, setImportStatus] = useState<"idle" | "saving" | "done">("idle");
	const [importError, setImportError] = useState<ReturnType<typeof workspaceImportError> | null>(null);
	const [importedPath, setImportedPath] = useState("");
	const [treeRevision, setTreeRevision] = useState(0);
	const showImport = !isKioskDemo();
	const importAvailable = Boolean(
		status.phase === "ready" && root && navigator.locks?.request,
	);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onOpenFile = (event: Event) => {
			const detail = (event as CustomEvent<{ path?: string }>).detail;
			if (detail?.path) {
				pendingOpenFilePath = null;
				setFile(detail.path);
			}
		};
		const syncExplorerForViewport = (event: Event) => {
			const detail = (event as CustomEvent<string | undefined>).detail;
			if (detail === "portrait" || isMobileWorkspaceViewport()) {
				setExplorerOpen(false);
			}
		};
		const refreshTree = () => setTreeRevision((previous) => previous + 1);
		window.addEventListener(WEB_BGM_MUSIC_CHANGED_EVENT, refreshTree);
		window.addEventListener(WEB_SETTINGS_ASSETS_CHANGED_EVENT, refreshTree);
		window.addEventListener(WEB_WORKSPACE_OPEN_FILE_EVENT, onOpenFile);
		window.addEventListener(
			"naia:layout-orientation-change",
			syncExplorerForViewport,
		);
		return () => {
			window.removeEventListener(WEB_BGM_MUSIC_CHANGED_EVENT, refreshTree);
			window.removeEventListener(
				WEB_SETTINGS_ASSETS_CHANGED_EVENT,
				refreshTree,
			);
			window.removeEventListener(WEB_WORKSPACE_OPEN_FILE_EVENT, onOpenFile);
			window.removeEventListener(
				"naia:layout-orientation-change",
				syncExplorerForViewport,
			);
		};
	}, []);
	useEffect(() => {
		let active = true;
		void Promise.resolve()
			.then(async () => {
				if (isKioskDemo()) {
					const fs = getWebFs();
					await seedKioskKnowledge(fs).catch(() => {});
					await seedKioskAdkWorkspace(fs).catch(() => {});
					await ensureKioskAdkBundle(fs).catch(() => {});
					await seedKioskSlidesWorkspace(fs).catch(() => {});
				}
				return navigator.storage.getDirectory();
			})
			.then((dir) => dir.getDirectoryHandle("naia-adk"))
			.then((dir) => {
				if (active) {
					setRoot(dir);
					setError(false);
				}
			})
			.catch(() => {
				if (active && status.phase === "ready") setError(true);
			});
		return () => {
			active = false;
		};
	}, [status.phase]);
	function handleResizerMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
		event.preventDefault();
		const container = workspaceRef.current;
		if (!container) return;
		const rect = container.getBoundingClientRect();
		const onMove = (moveEvent: MouseEvent) => {
			const nextWidth = Math.round(moveEvent.clientX - rect.left);
			const maxWidth = Math.max(180, Math.floor(rect.width * 0.45));
			setTreeWidth(Math.min(maxWidth, Math.max(140, nextWidth)));
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}
	async function revertToOriginal() {
		setRevertNotice("");
		try {
			await revertKioskAdkFile(file);
			setEditorRevision((n) => n + 1);
			setRevertNotice("원본으로 되돌렸어요.");
		} catch {
			setRevertNotice("원본으로 되돌리지 못했어요.");
		}
	}
	async function download() {
		try {
			const blob = await getWebWorkspaceFile(file);
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = blob.name;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch {
			setError(true);
		}
	}

	function selectImportTarget(next: WebWorkspaceImportTarget) {
		setImportTarget(next);
		setImportError(null);
		setImportStatus("idle");
	}

	async function selectDefaultImportTarget() {
		try {
			selectImportTarget(await openWebWorkspaceImportRoot());
			setTreeRevision((previous) => previous + 1);
		} catch (cause) {
			setImportError(workspaceImportError(cause));
		}
	}

	async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
		const selected = event.currentTarget.files?.[0];
		const target = pickedTarget.current;
		event.currentTarget.value = "";
		pickedTarget.current = null;
		if (!selected || !target) return;
		setImportStatus("saving");
		setImportError(null);
		try {
			const savedPath = await importWebWorkspaceFile(target, selected);
			setImportedPath(savedPath.slice(WEB_ADK_PATH.length + 1));
			setTreeRevision((previous) => previous + 1);
			setImportStatus("done");
		} catch (cause) {
			const message = workspaceImportError(cause);
			setImportStatus("idle");
			setImportError(message);
			if (message === "webExplorer.importFolderChanged") {
				setImportTarget((current) => current === target ? null : current);
			}
		}
	}
	const showExplorer = explorerOpen || !file;
	const isSettingsModel = /\.(vrm|nva)$/i.test(file);
	const musicName = resolveWorkspaceViewer(file) === "audio" ? null : webBgmFileName(file);
	return (
		<div
			ref={workspaceRef}
			className={`web-workspace${showExplorer ? " web-workspace--tree-open" : " web-workspace--tree-closed"}`}
			style={{ "--web-tree-width": `${treeWidth}px` } as CSSProperties}
		>
			{showExplorer && (
				<aside
					className="herdr-workspace__files web-workspace-tree"
					data-testid="web-workspace-tree"
				>
					<header className="herdr-workspace__section-title">
						<button
							type="button"
							className="herdr-workspace__toggle-btn"
							aria-expanded={showPath}
							onClick={() => setShowPath(!showPath)}
						>
							{t("webExplorer.title")}
						</button>
						{file && (
							<button
								type="button"
								className="web-workspace-tree-collapse"
								data-testid="web-workspace-tree-collapse"
								aria-label="파일 탐색기 닫기"
								onClick={() => setExplorerOpen(false)}
							>
								접기
							</button>
						)}
					</header>
					<div className="web-workspace-tabs">
						<button
							type="button"
							data-testid="web-workspace-tab-offline"
							aria-pressed
						>
							{t("webExplorer.offline")}
						</button>
					</div>
					{showImport && (
						<div className="web-workspace-import">
							{importTarget ? (
								<code data-testid="web-workspace-import-destination">
									{t("webExplorer.importDestination", {
										folder: importTarget.path.slice(WEB_ADK_PATH.length + 1),
									})}
								</code>
							) : (
								<p>
									{t(importAvailable ? "webExplorer.importChoose" : "webExplorer.importUnavailable")}
								</p>
							)}
							<button
								type="button"
								disabled={!importAvailable || importStatus === "saving"}
								onClick={() => void selectDefaultImportTarget()}
							>
								{t("webExplorer.importChooseRoot")}
							</button>
							<button
								type="button"
								disabled={!importAvailable || !importTarget || importStatus === "saving"}
								onClick={() => {
									pickedTarget.current = importTarget;
									importInput.current?.click();
								}}
							>
								{t("webExplorer.importFile")}
							</button>
							{importExtensions && !importError && (
								<p>{t("webExplorer.importType", importTypes)}</p>
							)}
							<input
								ref={importInput}
								type="file"
								hidden
								accept={importExtensions?.join(",")}
								onChange={handleImportFile}
							/>
							{importStatus !== "idle" && (
								<p role="status">
									{importStatus === "saving"
										? t("webExplorer.importSaving")
										: t("webExplorer.importDone", { path: importedPath })}
								</p>
							)}
							{importError && <p role="alert">{t(importError, importTypes)}</p>}
						</div>
					)}
					{showPath && (
						<code data-testid="web-workspace-path">{WEB_ADK_PATH}</code>
					)}
					{error && <p role="alert">{t("webExplorer.readFailed")}</p>}
					{root && (
						<Directory
							key={status.phase}
							dir={root}
							path={WEB_ADK_PATH}
							onOpen={(next) => {
								setRevertNotice("");
								setFile(next);
							}}
							activeFile={file}
							treeRevision={treeRevision}
							importTargetPath={importTarget?.path}
							onSelectImportTarget={
								showImport && importAvailable && importStatus !== "saving"
									? selectImportTarget
									: undefined
							}
						/>
					)}
				</aside>
			)}
			{file && (
				<>
					{showExplorer && (
						<div
							role="separator"
							aria-orientation="vertical"
							aria-label="탐색기 폭 조절"
							className="web-workspace-resizer"
							data-testid="web-workspace-resizer"
							onMouseDown={handleResizerMouseDown}
						/>
					)}
					<main className="web-workspace-viewer" data-testid="web-workspace-viewer">
						<div className="web-workspace-viewer-bar">
							<button
								type="button"
								className="web-workspace-tree-toggle"
								data-testid="web-workspace-tree-toggle"
								aria-expanded={showExplorer}
								aria-pressed={showExplorer}
								onClick={() => setExplorerOpen((prev) => !prev)}
							>
								📁 {t("webExplorer.title")}
							</button>
							<code title={file}>
								{file.split("/").filter(Boolean).pop() ?? file}
							</code>
							{editable && (
								<button
									type="button"
									data-testid="web-workspace-revert"
									onClick={() => void revertToOriginal()}
								>
									원본으로 되돌리기
								</button>
							)}
							<button type="button" onClick={() => void download()}>
								{t("webExplorer.download")}
							</button>
							<button
								type="button"
								className="web-workspace-file-close"
								onClick={() => setFile("")}
								aria-label={t("webExplorer.close")}
							>
								✕
							</button>
						</div>
						{editable && (
							<p className="web-workspace-edit-hint" role="status">
								{revertNotice ||
									"고치면 바로 저장되고, 지나의 다음 대답부터 반영돼요. 새로고침하면 원본으로 돌아갑니다."}
							</p>
						)}
						{isSettingsModel ? (
							<p className="web-workspace-edit-hint" role="status">
								{t("webExplorer.binaryPreview")}
							</p>
						) : musicName ? (
							<WorkspaceMusicPreview key={file} path={file} name={musicName} />
						) : (
							<Suspense fallback={null}>
								<Editor
									key={`${file}#${editorRevision}`}
									filePath={file}
									readOnly={!editable}
									workspaceRoot={WEB_ADK_PATH}
								/>
							</Suspense>
						)}
					</main>
				</>
			)}
		</div>
	);
}
