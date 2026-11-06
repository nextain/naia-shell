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
import {
	listKioskKnowledgeManuscripts,
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
type Entry = { name: string; kind: "file" | "directory" };
type EntriesDirectory = FileSystemDirectoryHandle & {
	values(): AsyncIterable<FileSystemHandle>;
};

const KIOSK_ALLOWED_ROOT_DIRS = new Set([
	"kiosk-demo",
	"conversations",
	"knowledge",
]);

export function isVisibleWebWorkspaceEntry(
	name: string,
	parentPath: string,
	kiosk: boolean = isKioskDemo(),
): boolean {
	if (!kiosk) return true;
	if (!name || name.startsWith(".")) return false;
	if (/^agents-rules/i.test(name)) return false;
	if (/^(AGENTS|CLAUDE|GEMINI|README|OPENCODE|CODEX)\.md$/i.test(name)) {
		return false;
	}
	if (name === "naia-settings" || name === "projects") return false;
	if (parentPath === WEB_ADK_PATH) {
		return KIOSK_ALLOWED_ROOT_DIRS.has(name);
	}
	return true;
}

function Directory({
	dir,
	path,
	onOpen,
}: {
	dir: FileSystemDirectoryHandle;
	path: string;
	onOpen: (path: string) => void;
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
				found.sort((a, b) =>
					a.kind === b.kind
						? a.name.localeCompare(b.name)
						: a.kind === "directory"
							? -1
							: 1,
				);
				if (active) setEntries(found);
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
					/>
				) : (
					<li key={entry.name}>
						<button
							type="button"
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
}: {
	parent: FileSystemDirectoryHandle;
	name: string;
	path: string;
	onOpen: (path: string) => void;
}) {
	const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
	const [error, setError] = useState(false);
	return (
		<li>
			<details
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
				{dir && <Directory dir={dir} path={path} onOpen={onOpen} />}
			</details>
		</li>
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
	const [file, setFile] = useState("");
	const [treeWidth, setTreeWidth] = useState(200);
	const workspaceRef = useRef<HTMLDivElement>(null);
	const kioskDemo = isKioskDemo();
	const kioskManuscripts = useMemo(
		() => (kioskDemo ? listKioskKnowledgeManuscripts() : []),
		[kioskDemo],
	);
	useEffect(() => {
		let active = true;
		void Promise.resolve()
			.then(async () => {
				if (isKioskDemo()) {
					await seedKioskKnowledge(getWebFs()).catch(() => {});
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
	return (
		<div
			ref={workspaceRef}
			className="web-workspace"
			style={{ "--web-tree-width": `${treeWidth}px` } as CSSProperties}
		>
			<aside className="herdr-workspace__files web-workspace-tree">
				<header className="herdr-workspace__section-title">
					<button
						type="button"
						className="herdr-workspace__toggle-btn"
						aria-expanded={showPath}
						onClick={() => setShowPath(!showPath)}
					>
						{t("webExplorer.title")}
					</button>
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
								if (!file && kioskManuscripts[0]) {
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
							/>
						)}
					</>
				)}
			</aside>
			{file && (
				<>
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="탐색기 폭 조절"
						className="web-workspace-resizer"
						data-testid="web-workspace-resizer"
						onMouseDown={handleResizerMouseDown}
					/>
					<main className="web-workspace-viewer" data-testid="web-workspace-viewer">
						<div className="web-workspace-viewer-bar">
							<code>{file}</code>
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
