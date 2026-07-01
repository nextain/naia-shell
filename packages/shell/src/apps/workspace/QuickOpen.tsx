import { useCallback, useEffect, useRef, useState } from "react";
import { collectFilesOnly, fuzzyMatch } from "../../lib/file-search";

interface QuickOpenProps {
	workspaceRoot: string;
	onSelect: (path: string) => void;
	onClose: () => void;
}

/** Maximum number of results to display */
const MAX_RESULTS = 50;

export function QuickOpen({
	workspaceRoot,
	onSelect,
	onClose,
}: QuickOpenProps) {
	const [query, setQuery] = useState("");
	const [files, setFiles] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	// Focus input on mount
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Load file list on mount
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		collectFilesOnly(workspaceRoot, 0).then((f) => {
			if (!cancelled) {
				setFiles(f);
				setLoading(false);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [workspaceRoot]);

	// Filter and sort results
	const results = query.trim()
		? files
				.map((f) => {
					const rel = f.startsWith(workspaceRoot)
						? f.slice(workspaceRoot.length + 1)
						: f;
					return { path: f, rel, score: fuzzyMatch(query, rel) };
				})
				.filter((r) => r.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, MAX_RESULTS)
		: files.slice(0, MAX_RESULTS).map((f) => ({
				path: f,
				rel: f.startsWith(workspaceRoot)
					? f.slice(workspaceRoot.length + 1)
					: f,
				score: 0,
			}));

	// Reset selection when query changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	// Scroll selected item into view
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[selectedIndex] as HTMLElement | undefined;
		item?.scrollIntoView?.({ block: "nearest" });
	}, [selectedIndex]);

	const handleSelect = useCallback(
		(path: string) => {
			onSelect(path);
			onClose();
		},
		[onSelect, onClose],
	);

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelectedIndex((prev) =>
				results.length > 0 ? Math.min(prev + 1, results.length - 1) : 0,
			);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (results[selectedIndex]) {
				handleSelect(results[selectedIndex].path);
			}
		}
	}

	return (
		<div className="quick-open-overlay" onClick={onClose} onKeyDown={() => {}}>
			<div
				className="quick-open"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={() => {}}
			>
				<input
					ref={inputRef}
					type="text"
					className="quick-open__input"
					placeholder="파일 이름으로 검색… (한글 초성 지원)"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={handleKeyDown}
				/>
				<div ref={listRef} className="quick-open__list">
					{loading && (
						<div className="quick-open__empty">파일 목록 불러오는 중…</div>
					)}
					{results.map((r, i) => (
						<div
							key={r.path}
							className={`quick-open__item${i === selectedIndex ? " quick-open__item--selected" : ""}`}
							onClick={() => handleSelect(r.path)}
							onKeyDown={() => {}}
						>
							<span className="quick-open__filename">
								{r.rel.split("/").pop()}
							</span>
							<span className="quick-open__path">{r.rel}</span>
						</div>
					))}
					{!loading && results.length === 0 && query.trim() && (
						<div className="quick-open__empty">일치하는 파일이 없습니다</div>
					)}
				</div>
			</div>
		</div>
	);
}
