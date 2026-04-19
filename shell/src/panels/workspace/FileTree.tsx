import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ClassifiedDir } from "./WorkspaceCenterPanel";
import { type DirEntry, getFileIcon } from "../../lib/file-search";
import { Logger } from "../../lib/logger";
import { WORKSPACE_ROOT } from "./constants";

// ─── Context menu types ──────────────────────────────────────────────────────

interface ContextMenuState {
	x: number;
	y: number;
	entryPath: string;
}

/**
 * Compute a relative path from `base` to `target`.
 * Falls back to `target` if it doesn't start with `base`.
 */
function relativePath(base: string, target: string): string {
	const normalizedBase = base.replace(/\/$/, "");
	if (!normalizedBase || !target.startsWith(normalizedBase + "/")) {
		return target;
	}
	return target.slice(normalizedBase.length + 1);
}

// Re-export DirEntry from file-search for consumers that imported from FileTree
export type { DirEntry } from "../../lib/file-search";

interface FileTreeProps {
	/** Called when a file is selected */
	onFileSelect: (path: string) => void;
	/** Called when a directory is expanded (e.g. to restore per-repo recent file) */
	onDirExpand?: (dirPath: string) => void;
	/** Currently open file path */
	openFilePath?: string;
	/** Session dirs that have active status (for highlighting) */
	activeDirs?: string[];
	/** Classified dirs for section display (Phase 4) */
	classifiedDirs?: ClassifiedDir[];
	/** Actual workspace root (runtime override or compile-time fallback). */
	workspaceRoot?: string;
	/** Called when user selects "Naia에게 보내기" from context menu */
	onSendToChat?: (path: string) => void;
}

interface TreeNodeProps {
	entry: DirEntry;
	depth: number;
	onFileSelect: (path: string) => void;
	onDirExpand?: (dirPath: string) => void;
	openFilePath?: string;
	activeDirs?: string[];
	classifiedDirs?: ClassifiedDir[];
	onContextMenu?: (e: React.MouseEvent, entryPath: string) => void;
}

/** Strip trailing slash for path comparison */
function normPath(p: string): string {
	return p.replace(/\/$/, "");
}

function TreeNode({
	entry,
	depth,
	onFileSelect,
	onDirExpand,
	openFilePath,
	activeDirs,
	classifiedDirs: classifiedDirsProp,
	onContextMenu: handleContextMenu,
}: TreeNodeProps) {
	const [expanded, setExpanded] = useState(false);
	const [children, setChildren] = useState<DirEntry[] | null>(null);
	const [loading, setLoading] = useState(false);
	const nodeRef = useRef<HTMLButtonElement>(null);
	/** Tracks which openFilePath we last auto-revealed for — prevents re-expanding after manual fold */
	const lastRevealedRef = useRef<string | null>(null);
	const isOpen = openFilePath
		? normPath(openFilePath) === normPath(entry.path)
		: false;
	const isActive =
		activeDirs?.some((d) => normPath(d) === normPath(entry.path)) ?? false;

	// Auto-reveal: if this directory is an ancestor of the open file, expand it (once per file change)
	const shouldReveal =
		entry.is_dir &&
		openFilePath &&
		normPath(openFilePath).startsWith(`${normPath(entry.path)}/`) &&
		lastRevealedRef.current !== openFilePath;

	useEffect(() => {
		if (!shouldReveal || !openFilePath) return;
		lastRevealedRef.current = openFilePath;
		setExpanded(true);
		if (children === null && !loading) {
			setLoading(true);
			invoke<DirEntry[]>("workspace_list_dirs", { parent: entry.path })
				.then((result) => setChildren(result))
				.catch((e) => {
					Logger.warn("FileTree", "Failed to list dir (reveal)", {
						path: entry.path,
						error: String(e),
					});
					setChildren([]);
				})
				.finally(() => setLoading(false));
		}
	}, [shouldReveal, openFilePath, entry.path, children, loading]);

	// Auto-scroll to the open file node
	useEffect(() => {
		if (isOpen && nodeRef.current) {
			nodeRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
	}, [isOpen]);

	const toggle = useCallback(async () => {
		if (!entry.is_dir) {
			onFileSelect(entry.path);
			return;
		}
		if (expanded) {
			setExpanded(false);
			return;
		}
		setExpanded(true);
		onDirExpand?.(entry.path);
		if (children === null && !loading) {
			setLoading(true);
			try {
				const result = await invoke<DirEntry[]>("workspace_list_dirs", {
					parent: entry.path,
				});
				setChildren(result);
			} catch (e) {
				Logger.warn("FileTree", "Failed to list dir", {
					path: entry.path,
					error: String(e),
				});
				setChildren([]);
			} finally {
				setLoading(false);
			}
		}
	}, [entry, expanded, children, loading, onFileSelect, onDirExpand]);

	const indent = depth * 16;
	const icon = entry.is_dir ? (expanded ? "▼" : "▶") : getFileIcon(entry.name);

	return (
		<div>
			<button
				ref={nodeRef}
				type="button"
				className={[
					"workspace-tree__node",
					isOpen ? "workspace-tree__node--open" : "",
					isActive ? "workspace-tree__node--active" : "",
					entry.is_dir
						? "workspace-tree__node--dir"
						: "workspace-tree__node--file",
				]
					.filter(Boolean)
					.join(" ")}
				style={{ paddingLeft: `${indent + 8}px` }}
				onClick={toggle}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					handleContextMenu?.(e, entry.path);
				}}
				title={entry.path}
			>
				<span className="workspace-tree__icon">{icon}</span>
				<span className="workspace-tree__name">{entry.name}</span>
				{(() => {
					const cd = classifiedDirsProp?.find((d) => normPath(d.path) === normPath(entry.path));
					if (!cd) return null;
					return <>
						{cd.visibility && (
							<span className={`workspace-tree__badge ${cd.visibility === "public" ? "workspace-tree__badge--public" : "workspace-tree__badge--private"}`}>
								{cd.visibility === "public" ? "pub" : "priv"}
							</span>
						)}
						{cd.entryPoint && (
							<span className="workspace-tree__entrypoint" title={cd.entryPoint}>
								⎆
							</span>
						)}
					</>;
				})()}
				{isActive && (
					<span className="workspace-tree__active-dot" title="Active session" />
				)}
			</button>
			{entry.is_dir && expanded && (
				<div className="workspace-tree__children">
					{loading && (
						<div
							className="workspace-tree__loading"
							style={{ paddingLeft: `${indent + 24}px` }}
						>
							…
						</div>
					)}
					{children?.map((child) => (
						<TreeNode
							key={child.path}
							entry={child}
							depth={depth + 1}
							onFileSelect={onFileSelect}
							onDirExpand={onDirExpand}
							openFilePath={openFilePath}
							activeDirs={activeDirs}
							classifiedDirs={classifiedDirsProp}
							onContextMenu={handleContextMenu}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function FileTree({
	onFileSelect,
	onDirExpand,
	openFilePath,
	activeDirs,
	classifiedDirs,
	workspaceRoot = WORKSPACE_ROOT,
	onSendToChat,
}: FileTreeProps) {
	const [entries, setEntries] = useState<DirEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Monotonically increasing ID — prevents stale invoke responses from
	// overwriting a fresher result when multiple loadEntries calls are in-flight.
	const fetchIdRef = useRef(0);

	// ── Context menu state ───────────────────────────────────────────────
	const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
	const ctxMenuRef = useRef<HTMLDivElement>(null);

	const openContextMenu = useCallback(
		(e: React.MouseEvent, entryPath: string) => {
			// Clamp position so the menu doesn't overflow the viewport
			const x = Math.min(e.clientX, window.innerWidth - 220);
			const y = Math.min(e.clientY, window.innerHeight - 120);
			setCtxMenu({ x, y, entryPath });
		},
		[],
	);

	const closeContextMenu = useCallback(() => setCtxMenu(null), []);

	// Close on outside click, Escape, or scroll
	useEffect(() => {
		if (!ctxMenu) return;

		const onClickOutside = (e: MouseEvent) => {
			if (
				ctxMenuRef.current &&
				!ctxMenuRef.current.contains(e.target as Node)
			) {
				closeContextMenu();
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeContextMenu();
		};
		const onScroll = () => closeContextMenu();

		document.addEventListener("mousedown", onClickOutside);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("mousedown", onClickOutside);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [ctxMenu, closeContextMenu]);

	const handleCopyRelative = useCallback(() => {
		if (!ctxMenu) return;
		const rel = relativePath(workspaceRoot, ctxMenu.entryPath);
		navigator.clipboard.writeText(rel).catch(() => {});
		closeContextMenu();
	}, [ctxMenu, workspaceRoot, closeContextMenu]);

	const handleCopyAbsolute = useCallback(() => {
		if (!ctxMenu) return;
		navigator.clipboard.writeText(ctxMenu.entryPath).catch(() => {});
		closeContextMenu();
	}, [ctxMenu, closeContextMenu]);

	const handleSendToChat = useCallback(() => {
		if (!ctxMenu) return;
		const rel = relativePath(workspaceRoot, ctxMenu.entryPath);
		onSendToChat?.(rel);
		closeContextMenu();
	}, [ctxMenu, workspaceRoot, onSendToChat, closeContextMenu]);

	// ── Data loading ─────────────────────────────────────────────────────

	const loadEntries = useCallback(async () => {
		const id = ++fetchIdRef.current;
		try {
			const result = await invoke<DirEntry[]>("workspace_list_dirs", {
				parent: workspaceRoot,
			});
			if (id !== fetchIdRef.current) return; // stale response — discard
			setEntries(result);
			Logger.info("FileTree", "Loaded workspace root", {
				count: result.length,
			});
		} catch (e) {
			if (id !== fetchIdRef.current) return;
			Logger.warn("FileTree", "Failed to load workspace root", {
				error: String(e),
			});
		} finally {
			if (id === fetchIdRef.current) setLoading(false);
		}
	}, [workspaceRoot]);

	const debouncedLoadEntries = useCallback(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => void loadEntries(), 300);
	}, [loadEntries]);

	useEffect(() => {
		void loadEntries();

		// Refresh root entries on file-change events — debounced to coalesce
		// rapid bursts (e.g. git checkout rewriting many files at once).
		const unlistenPromise = listen<{
			session: string;
			file: string;
			timestamp: number;
		}>("workspace:file-changed", () => {
			debouncedLoadEntries();
		});

		return () => {
			unlistenPromise.then((fn) => fn()).catch(() => {});
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [loadEntries, debouncedLoadEntries]);

	// ── Context menu portal ──────────────────────────────────────────────
	const contextMenuEl = ctxMenu ? (
		<div
			ref={ctxMenuRef}
			className="workspace-ctx-menu"
			style={{ left: ctxMenu.x, top: ctxMenu.y }}
		>
			<button
				type="button"
				className="workspace-ctx-menu__item"
				onClick={handleCopyRelative}
			>
				상대경로 복사
			</button>
			<button
				type="button"
				className="workspace-ctx-menu__item"
				onClick={handleCopyAbsolute}
			>
				절대경로 복사
			</button>
			{onSendToChat && (
				<>
					<div className="workspace-ctx-menu__divider" />
					<button
						type="button"
						className="workspace-ctx-menu__item"
						onClick={handleSendToChat}
					>
						Naia에게 보내기
					</button>
				</>
			)}
		</div>
	) : null;

	if (loading) {
		return (
			<div className="workspace-tree workspace-tree--loading">불러오는 중…</div>
		);
	}

	// Phase 4: if classified dirs provided, show in sections
	if (classifiedDirs && classifiedDirs.length > 0) {
		const sections: Record<string, typeof classifiedDirs> = {
			project: [],
			worktree: [],
			reference: [],
			docs: [],
			other: [],
		};
		for (const d of classifiedDirs) {
			const cat = d.category in sections ? d.category : "other";
			sections[cat].push(d);
		}

		const sectionLabels: Record<string, string> = {
			project: "🏗 프로젝트",
			worktree: "🌿 워크트리",
			reference: "📚 참조",
			docs: "📝 문서",
			other: "📁 기타",
		};

		// Guard: if no classified dir matches any loaded entry (path mismatch or
		// entries not yet loaded), show a fallback instead of a blank panel.
		const hasAnyMatch = Object.values(sections).some((dirs) =>
			dirs.some((d) =>
				entries.some((e) => normPath(d.path) === normPath(e.path)),
			),
		);

		if (!hasAnyMatch) {
			return (
				<div className="workspace-tree workspace-tree--empty">
					<div className="workspace-tree__empty-hint">
						분류된 디렉토리를 찾을 수 없습니다
					</div>
				</div>
			);
		}

		return (
			<div className="workspace-tree">
				{Object.entries(sections).map(([cat, dirs]) => {
					if (dirs.length === 0) return null;
					const classifiedEntries = entries.filter((e) =>
						dirs.some((d) => normPath(d.path) === normPath(e.path)),
					);
					if (classifiedEntries.length === 0) return null;
					return (
						<div key={cat} className="workspace-tree__section">
							<div className="workspace-tree__section-label">
								{sectionLabels[cat]}
							</div>
							{classifiedEntries.map((entry) => (
								<TreeNode
									key={entry.path}
									entry={entry}
									depth={0}
									onFileSelect={onFileSelect}
									onDirExpand={onDirExpand}
									openFilePath={openFilePath}
									activeDirs={activeDirs}
									classifiedDirs={classifiedDirs}
									onContextMenu={openContextMenu}
								/>
							))}
						</div>
					);
				})}
				{contextMenuEl}
			</div>
		);
	}

	return (
		<div className="workspace-tree">
			{entries.map((entry) => (
				<TreeNode
					key={entry.path}
					entry={entry}
					depth={0}
					onFileSelect={onFileSelect}
					onDirExpand={onDirExpand}
					openFilePath={openFilePath}
					activeDirs={activeDirs}
					classifiedDirs={classifiedDirs}
					onContextMenu={openContextMenu}
				/>
			))}
			{contextMenuEl}
		</div>
	);
}
