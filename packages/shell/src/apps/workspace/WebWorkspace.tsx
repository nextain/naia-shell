import {
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	Suspense,
	lazy,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { t } from "../../lib/i18n";
import { isKioskDemo } from "../../lib/kiosk-demo/flag";
import { getStoredLayoutOrientation } from "../../lib/ui-preferences";
import {
	listKioskKnowledgeManuscripts,
	seedKioskAdkWorkspace,
	seedKioskKnowledge,
} from "../../lib/kiosk-demo/knowledge";
import { WEB_ADK_PATH } from "../../lib/web-runtime/web-adk-path";
import { getWebFs } from "../../lib/web-runtime/web-fs";
import { getWebWorkspaceFile } from "../../lib/web-runtime/web-workspace-files";
import {
	getWebAdkStatus,
	subscribeWebAdkStatus,
} from "../../lib/web-runtime/web-adk-status";

const Editor = lazy(() =>
	import("./Editor").then((m) => ({ default: m.Editor })),
);
export type WebWorkspaceEntry = { name: string; kind: "file" | "directory" };
type Entry = WebWorkspaceEntry;
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

const KIOSK_ROOT_ORDER = [
	"AGENTS.md",
	"persona",
	"memory",
	"knowledge",
	"rules",
	"conversations",
	"kiosk-demo",
] as const;

const KIOSK_ALLOWED_ROOT_ENTRIES = new Set<string>(KIOSK_ROOT_ORDER);

export function isVisibleWebWorkspaceEntry(
	name: string,
	parentPath: string,
	kiosk: boolean = isKioskDemo(),
): boolean {
	if (!kiosk) return true;
	if (!name || name.startsWith(".")) return false;
	if (/^agents-rules/i.test(name)) return false;
	if (/^(CLAUDE|GEMINI|README|OPENCODE|CODEX)\.md$/i.test(name)) {
		return false;
	}
	if (name === "naia-settings" || name === "projects") return false;
	if (parentPath === WEB_ADK_PATH) {
		return KIOSK_ALLOWED_ROOT_ENTRIES.has(name);
	}
	if (/^AGENTS\.md$/i.test(name)) {
		return false;
	}
	return true;
}

export function sortWebWorkspaceEntries(
	entries: readonly WebWorkspaceEntry[],
	parentPath: string,
	kiosk: boolean = isKioskDemo(),
): WebWorkspaceEntry[] {
	const copy = [...entries];
	if (kiosk && parentPath === WEB_ADK_PATH) {
		const rank = (name: string): number => {
			const idx = KIOSK_ROOT_ORDER.indexOf(
				name as (typeof KIOSK_ROOT_ORDER)[number],
			);
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

function Directory({
	dir,
	path,
	onOpen,
	activeFile,
}: {
	dir: FileSystemDirectoryHandle;
	path: string;
	onOpen: (path: string) => void;
	activeFile?: string;
}) {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [error, setError] = useState(false);
	useEffect(() => {
		let active = true;
		(async () => {
			try {
				const found: Entry[] = [];
				for await (const entry of (dir as EntriesDirectory).values()) {
					if (!isVisibleWebWorkspaceEntry(entry.name, path)) continue;
					found.push({ name: entry.name, kind: entry.kind });
				}
				const sorted = sortWebWorkspaceEntries(found, path);
				if (active) setEntries(sorted);
			} catch {
				if (active) setError(true);
			}
		})();
		return () => {
			active = false;
		};
	}, [dir, path]);
	if (error) return <p role="alert">Unable to read directory</p>;
	return (
		<ul className="web-workspace-list">
			{entries.map((entry) =>
				entry.kind === "directory" ? (
					<Folder
						key={entry.name}
						parent={dir}
						name={entry.name}
						path={`${path}/${entry.name}`}
						onOpen={onOpen}
						activeFile={activeFile}
					/>
				) : (
					<li key={entry.name}>
						<button
							type="button"
							aria-pressed={activeFile === `${path}/${entry.name}`}
							onClick={() => onOpen(`${path}/${entry.name}`)}
						>
							📄 {entry.name}
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
}: {
	parent: FileSystemDirectoryHandle;
	name: string;
	path: string;
	onOpen: (path: string) => void;
	activeFile?: string;
}) {
	const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
	const [error, setError] = useState(false);
	const shouldAutoOpen = Boolean(
		activeFile && activeFile.startsWith(`${path}/`),
	);
	useEffect(() => {
		if (shouldAutoOpen && !dir) {
			void parent
				.getDirectoryHandle(name)
				.then(setDir)
				.catch(() => setError(true));
		}
	}, [shouldAutoOpen, dir, parent, name]);
	return (
		<li>
			<details
				open={shouldAutoOpen || undefined}
				onToggle={(event) => {
					if (event.currentTarget.open && !dir)
						void parent
							.getDirectoryHandle(name)
							.then(setDir)
							.catch(() => setError(true));
				}}
			>
				<summary>📁 {name}</summary>
				{error && <p role="alert">Unable to open folder</p>}
				{dir && (
					<Directory
						dir={dir}
						path={path}
						onOpen={onOpen}
						activeFile={activeFile}
					/>
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

export default function WebWorkspace() {
	const status = useSyncExternalStore(subscribeWebAdkStatus, getWebAdkStatus);
	const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
	const [error, setError] = useState(false);
	const [activeTab, setActiveTab] = useState<"offline" | "knowledge">(
		"offline",
	);
	const [showPath, setShowPath] = useState(false);
	const [explorerOpen, setExplorerOpen] = useState(
		() => !isMobileWorkspaceViewport(),
	);
	const kioskDemo = isKioskDemo();
	const [file, setFile] = useState(() => {
		if (pendingOpenFilePath) {
			const next = pendingOpenFilePath;
			pendingOpenFilePath = null;
			return next;
		}
		return isKioskDemo() ? `${WEB_ADK_PATH}/AGENTS.md` : "";
	});
	const [treeWidth, setTreeWidth] = useState(() => (isKioskDemo() ? 236 : 180));
	const workspaceRef = useRef<HTMLDivElement>(null);
	const kioskManuscripts = useMemo(
		() => (kioskDemo ? listKioskKnowledgeManuscripts() : []),
		[kioskDemo],
	);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onOpenFile = (event: Event) => {
			const detail = (event as CustomEvent<{ path?: string }>).detail;
			if (detail?.path) {
				pendingOpenFilePath = null;
				setActiveTab("offline");
				setFile(detail.path);
			}
		};
		const syncExplorerForViewport = (event: Event) => {
			const detail = (event as CustomEvent<string | undefined>).detail;
			if (detail === "portrait" || isMobileWorkspaceViewport()) {
				setExplorerOpen(false);
			}
		};
		window.addEventListener(WEB_WORKSPACE_OPEN_FILE_EVENT, onOpenFile);
		window.addEventListener(
			"naia:layout-orientation-change",
			syncExplorerForViewport,
		);
		return () => {
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
	const showExplorer = explorerOpen || !file;
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
							aria-pressed={activeTab === "offline"}
							onClick={() => setActiveTab("offline")}
						>
							{t("webExplorer.offline")}
						</button>
						{kioskDemo && (
							<button
								type="button"
								data-testid="web-workspace-tab-knowledge"
								aria-pressed={activeTab === "knowledge"}
								onClick={() => {
									setActiveTab("knowledge");
									if (
										(!file || file === `${WEB_ADK_PATH}/AGENTS.md`) &&
										kioskManuscripts[0]
									) {
										setFile(kioskManuscripts[0].uri);
									}
								}}
							>
								{t("settings.tabKnowledge")}
							</button>
						)}
					</div>
					{activeTab === "knowledge" && kioskDemo ? (
						<ul
							className="web-workspace-list"
							data-testid="web-workspace-knowledge-list"
						>
							{kioskManuscripts.map((item) => (
								<li key={item.name}>
									<button
										type="button"
										aria-pressed={file === item.uri}
										onClick={() => setFile(item.uri)}
									>
										📄 {item.title} ({item.name})
									</button>
								</li>
							))}
						</ul>
					) : (
						<>
							{showPath && (
								<code data-testid="web-workspace-path">{WEB_ADK_PATH}</code>
							)}
							{error && <p role="alert">{t("webExplorer.readFailed")}</p>}
							{root && (
								<Directory
									key={status.phase}
									dir={root}
									path={WEB_ADK_PATH}
									onOpen={setFile}
									activeFile={file}
								/>
							)}
						</>
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
							<button type="button" onClick={() => void download()}>
								{t("webExplorer.download")}
							</button>
							<button
								type="button"
								onClick={() => setFile("")}
								aria-label={t("webExplorer.close")}
							>
								✕
							</button>
						</div>
						<Suspense fallback={null}>
							<Editor filePath={file} readOnly workspaceRoot={WEB_ADK_PATH} />
						</Suspense>
					</main>
				</>
			)}
		</div>
	);
}
