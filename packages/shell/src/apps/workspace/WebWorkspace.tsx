import {
	Suspense,
	lazy,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { getLocale } from "../../lib/i18n";
import { WEB_ADK_PATH } from "../../lib/web-runtime/web-adk-path";
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
				for await (const entry of (dir as EntriesDirectory).values())
					found.push({ name: entry.name, kind: entry.kind });
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
	}, [dir]);
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
	const ko = getLocale() === "ko";
	const status = useSyncExternalStore(subscribeWebAdkStatus, getWebAdkStatus);
	const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
	const [error, setError] = useState(false);
	const [online, setOnline] = useState(false);
	const [file, setFile] = useState("");
	useEffect(() => {
		let active = true;
		void Promise.resolve()
			.then(() => navigator.storage.getDirectory())
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
		<div className="web-workspace">
			<aside className="herdr-workspace__files web-workspace-tree">
				<header className="herdr-workspace__section-title">
					{ko ? "파일 탐색기" : "File explorer"}
				</header>
				<div className="web-workspace-tabs">
					<button
						type="button"
						aria-pressed={!online}
						onClick={() => setOnline(false)}
					>
						{ko ? "오프라인" : "Offline"}
					</button>
					<button
						type="button"
						aria-pressed={online}
						onClick={() => setOnline(true)}
					>
						{ko ? "온라인 (준비 중)" : "Online (coming soon)"}
					</button>
				</div>
				{online ? (
					<p>
						{ko
							? "온라인 탐색기는 준비 중입니다."
							: "Online explorer is coming soon."}
					</p>
				) : (
					<>
						<code data-testid="web-workspace-path">{WEB_ADK_PATH}</code>
						{error && (
							<p role="alert">
								{ko ? "파일을 읽지 못했습니다." : "Could not read files."}
							</p>
						)}
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
			{file && !online && (
				<main className="web-workspace-viewer">
					<div className="web-workspace-viewer-bar">
						<code>{file}</code>
						<button type="button" onClick={() => void download()}>
							{ko ? "내려받기" : "Download"}
						</button>
						<button
							type="button"
							onClick={() => setFile("")}
							aria-label={ko ? "닫기" : "Close"}
						>
							✕
						</button>
					</div>
					<Suspense fallback={null}>
						<Editor filePath={file} readOnly workspaceRoot={WEB_ADK_PATH} />
					</Suspense>
				</main>
			)}
		</div>
	);
}
