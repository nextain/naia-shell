/**
 * AtMentionPopover — inline dropdown for @-mentioning files/folders in chat.
 *
 * Renders positioned ABOVE the chat textarea (Slack/VS Code style).
 * Shows fuzzy-filtered file/folder list with keyboard navigation.
 */
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { loadConfig } from "../lib/config";
import { collectFiles, fuzzyMatch, getFileIcon } from "../lib/file-search";
import { panelRegistry } from "../lib/panel-registry";

/** Max items visible in the dropdown */
const MAX_VISIBLE = 8;

export interface AtMentionResult {
	/** Absolute path */
	path: string;
	/** Relative path (from workspace root) */
	rel: string;
	/** Whether this is a directory */
	isDir: boolean;
}

interface AtMentionPopoverProps {
	/** Search query (text after @) */
	query: string;
	/** Called when user selects an item */
	onSelect: (item: AtMentionResult) => void;
	/** Called when popover should close (Escape, click outside) */
	onClose: () => void;
}

/** Imperative handle for keyboard control from parent */
export interface AtMentionHandle {
	/** Handle keydown; returns true if consumed. */
	handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

/** Check whether the workspace panel is registered (files are available). */
export function isWorkspaceAvailable(): boolean {
	return panelRegistry.get("workspace") !== undefined;
}

/** Resolve the workspace root from config. */
function getWorkspaceRoot(): string {
	const cfg = loadConfig();
	return cfg?.workspaceRoot || "";
}

/** Get icon for entry — delegates to shared getFileIcon, with folder override */
function getIcon(rel: string, isDir: boolean): string {
	if (isDir) return "\uD83D\uDCC1"; // folder emoji
	const name = rel.split("/").pop() ?? rel;
	return getFileIcon(name);
}

// ── Shared file cache ───────────────────────────────────────────────────────
// Avoid re-collecting on every popover open during the same session.
let cachedRoot = "";
let cachedFiles: string[] = [];
let cachePromise: Promise<string[]> | null = null;

function getCachedFiles(root: string): Promise<string[]> {
	if (root === cachedRoot && cachedFiles.length > 0) {
		return Promise.resolve(cachedFiles);
	}
	if (root === cachedRoot && cachePromise) {
		return cachePromise;
	}
	cachedRoot = root;
	cachePromise = collectFiles(root, 0)
		.then((files) => {
			cachedFiles = files;
			return files;
		})
		.catch((err) => {
			cachedFiles = [];
			throw err;
		})
		.finally(() => {
			cachePromise = null;
		});
	return cachePromise;
}

export const AtMentionPopover = forwardRef<
	AtMentionHandle,
	AtMentionPopoverProps
>(function AtMentionPopover({ query, onSelect, onClose }, ref) {
	const [allFiles, setAllFiles] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [activeIndex, setActiveIndex] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);

	const workspaceRoot = getWorkspaceRoot();

	// Load file list on mount (uses cache)
	useEffect(() => {
		if (!workspaceRoot) {
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		getCachedFiles(workspaceRoot).then((files) => {
			if (!cancelled) {
				setAllFiles(files);
				setLoading(false);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [workspaceRoot]);

	// Filter and sort results
	const results: AtMentionResult[] = (() => {
		if (!workspaceRoot) return [];
		const q = query.trim();
		if (!q) {
			return allFiles.slice(0, MAX_VISIBLE).map((f) => ({
				path: f,
				rel: f.startsWith(workspaceRoot)
					? f.slice(workspaceRoot.length + 1)
					: f,
				isDir: f.endsWith("/"),
			}));
		}
		return allFiles
			.map((f) => {
				const rel = f.startsWith(workspaceRoot)
					? f.slice(workspaceRoot.length + 1)
					: f;
				return {
					path: f,
					rel,
					isDir: f.endsWith("/"),
					score: fuzzyMatch(q, rel),
				};
			})
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, MAX_VISIBLE)
			.map(({ path, rel, isDir }) => ({ path, rel, isDir }));
	})();

	// Reset active index when query changes
	useEffect(() => {
		setActiveIndex(0);
	}, [query]);

	// Scroll active item into view
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[activeIndex] as HTMLElement | undefined;
		item?.scrollIntoView?.({ block: "nearest" });
	}, [activeIndex]);

	// Close on click outside
	useEffect(() => {
		function handleMouseDown(e: MouseEvent) {
			if (
				popoverRef.current &&
				!popoverRef.current.contains(e.target as Node)
			) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [onClose]);

	const handleSelect = useCallback(
		(item: AtMentionResult) => {
			onSelect(item);
		},
		[onSelect],
	);

	// Expose keyboard handler to parent
	useImperativeHandle(
		ref,
		() => ({
			handleKeyDown(e: React.KeyboardEvent): boolean {
				if (e.key === "Escape") {
					onClose();
					return true;
				}
				if (e.key === "ArrowDown") {
					setActiveIndex((prev) =>
						results.length > 0 ? Math.min(prev + 1, results.length - 1) : 0,
					);
					return true;
				}
				if (e.key === "ArrowUp") {
					setActiveIndex((prev) => Math.max(prev - 1, 0));
					return true;
				}
				if (e.key === "Enter" || e.key === "Tab") {
					if (results.length > 0 && results[activeIndex]) {
						handleSelect(results[activeIndex]);
					}
					// Always consume Enter/Tab while popover is open — prevent accidental send
					return true;
				}
				return false;
			},
		}),
		[results, activeIndex, onClose, handleSelect],
	);

	return (
		<div
			ref={popoverRef}
			className="chat-at-popover"
			onMouseDown={(e) => e.preventDefault()}
		>
			{loading && (
				<div className="chat-at-popover__empty">파일 목록 불러오는 중...</div>
			)}
			{!loading && results.length === 0 && (
				<div className="chat-at-popover__empty">
					{!workspaceRoot
						? "워크스페이스가 설정되지 않았습니다"
						: "일치하는 파일이 없습니다"}
				</div>
			)}
			<div ref={listRef} className="chat-at-popover__list">
				{results.map((item, i) => (
					<div
						key={item.path}
						className={`chat-at-popover__item${i === activeIndex ? " chat-at-popover__item--active" : ""}`}
						onClick={() => handleSelect(item)}
						onMouseEnter={() => setActiveIndex(i)}
						onKeyDown={() => {}}
					>
						<span className="chat-at-popover__icon">
							{getIcon(item.rel, item.isDir)}
						</span>
						<span className="chat-at-popover__path">{item.rel}</span>
					</div>
				))}
			</div>
		</div>
	);
});
