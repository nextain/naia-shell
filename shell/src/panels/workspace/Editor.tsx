import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { EditorState, Transaction } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import AnsiToHtml from "ansi-to-html";
import DOMPurify from "dompurify";
import Papa from "papaparse";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { Document, Page as PdfPage, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import mermaid from "mermaid";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Logger } from "../../lib/logger";
import { AUTOSAVE_DEBOUNCE_MS } from "./constants";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type ViewMode =
	| "editor"
	| "preview"
	| "split"
	| "image"
	| "csv"
	| "log"
	| "pdf"
	| "hwp";

interface EditorProps {
	/** Absolute path of the file being edited. Empty = no file open. */
	filePath: string;
	/** Badge text shown above editor (e.g. "#79 · Build") */
	badge?: string;
	/** If true, editing is disabled (reference repos) */
	readOnly?: boolean;
}

/** Methods exposed to parent via ref */
export interface EditorHandle {
	reloadFile: () => void;
}

function getLanguageExtension(filePath: string) {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") {
		return javascript({
			typescript: ext === "ts" || ext === "tsx",
			jsx: ext === "tsx" || ext === "jsx",
		});
	}
	if (ext === "md" || ext === "mdx") return markdown();
	if (ext === "py") return python();
	if (ext === "rs") return rust();
	if (ext === "yaml" || ext === "yml") return yaml();
	if (ext === "json") return json();
	if (ext === "css" || ext === "scss" || ext === "less") return css();
	if (ext === "sh" || ext === "bash" || ext === "zsh")
		return StreamLanguage.define(shell);
	return null;
}

function isMarkdownFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return ext === "md" || ext === "mdx";
}

function isImageFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	// SVG is intentionally treated as image-only (viewer via <img>); text editing is not supported.
	return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
}

function isCsvFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return ext === "csv";
}

function isLogFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return ext === "log";
}

function isPdfFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return ext === "pdf";
}

function isHwpFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return ext === "hwp" || ext === "hwpx";
}

function detectViewMode(filePath: string): ViewMode {
	if (isImageFile(filePath)) return "image";
	if (isPdfFile(filePath)) return "pdf";
	if (isCsvFile(filePath)) return "csv";
	if (isLogFile(filePath)) return "log";
	if (isHwpFile(filePath)) return "hwp";
	if (isMarkdownFile(filePath)) return "preview";
	return "editor";
}

const ansiConverter = new AnsiToHtml({ escapeXML: true });

mermaid.initialize({
	startOnLoad: false,
	theme: "dark",
	// WebKitGTK does not reliably render <foreignObject> in SVG.
	// Force pure SVG <text> elements for all labels.
	htmlLabels: false,
	flowchart: { htmlLabels: false },
	sequence: { useHtmlLabels: false } as Record<string, unknown>,
});

let mermaidIdCounter = 0;

function MermaidBlock({ code }: { code: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!containerRef.current || !code.trim()) return;
		const id = `mermaid-${++mermaidIdCounter}`;
		let cancelled = false;
		mermaid
			.render(id, code.trim())
			.then(({ svg }) => {
				if (!cancelled && containerRef.current) {
					containerRef.current.innerHTML = DOMPurify.sanitize(svg);
					setError(null);
				}
			})
			.catch((err) => {
				if (!cancelled) setError(String(err?.message ?? err));
			});
		return () => {
			cancelled = true;
		};
	}, [code]);

	if (error) {
		return (
			<div className="workspace-editor__mermaid-error">
				Mermaid 오류: {error}
			</div>
		);
	}

	return <div ref={containerRef} className="workspace-editor__mermaid" />;
}

/** Custom code block renderer — intercepts ```mermaid blocks */
function CodeBlock({
	className,
	children,
}: { className?: string; children?: React.ReactNode }) {
	const match = /language-mermaid/.exec(className ?? "");
	if (match) {
		const code = String(children).replace(/\n$/, "");
		return <MermaidBlock code={code} />;
	}
	return <code className={className}>{children}</code>;
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
	{ filePath, badge, readOnly = false },
	ref,
) {
	const editorRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	/** Content state — used for MD preview and initial doc load */
	const [content, setContent] = useState("");
	const [viewMode, setViewMode] = useState<ViewMode>("editor");
	const [hwpSidecar, setHwpSidecar] = useState<string | null>(null);
	// ── Zoom (Ctrl+Scroll) — persisted, not applied during print ─────
	const [zoom, setZoom] = useState(() => {
		try {
			return Number(localStorage.getItem("workspace-editor-zoom")) || 100;
		} catch {
			return 100;
		}
	});
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState("");
	const [reloading, setReloading] = useState(false);
	/** Error message from a failed file load; null = no error. Shown in UI instead of editor. */
	const [loadError, setLoadError] = useState<string | null>(null);
	/** Ref mirror of loadError for synchronous updateListener access */
	const loadErrorRef = useRef(false);
	const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const filePathRef = useRef(filePath);
	filePathRef.current = filePath;
	/** Track whether the editor was just loaded so we don't trigger double-sync */
	const justLoadedRef = useRef(false);

	/** CSV sort state */
	const [sortCol, setSortCol] = useState<number | null>(null);
	const [sortAsc, setSortAsc] = useState(true);

	/** PDF state */
	const [pdfNumPages, setPdfNumPages] = useState(0);

	/** Image viewer state */
	const [imageZoom, setImageZoom] = useState<"fit" | "original" | number>(
		"fit",
	);
	const [imageInfo, setImageInfo] = useState<{
		width: number;
		height: number;
		fileSize: string;
		format: string;
	} | null>(null);
	const [imageBlobUrl, setImageBlobUrl] = useState<string | null>(null);
	const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);

	const isMd = filePath ? isMarkdownFile(filePath) : false;

	// ── Reset viewMode (and sort/pdf/image state) when file changes ─────
	useEffect(() => {
		setViewMode(filePath ? detectViewMode(filePath) : "editor");
		setSortCol(null);
		setSortAsc(true);
		setPdfNumPages(0);
		setImageZoom("fit");
		setImageInfo(null);
		// Revoke previous blob URLs to free memory
		setImageBlobUrl((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return null;
		});
		setPdfBlobUrl((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return null;
		});
	}, [filePath]);

	// ── Load image as blob URL (asset protocol unreliable on Linux) ─────
	useEffect(() => {
		if (!filePath || !isImageFile(filePath)) return;
		const thisPath = filePath;
		invoke<number[]>("workspace_read_file_bytes", { path: thisPath })
			.then((bytes) => {
				if (filePathRef.current !== thisPath) return;
				const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
				const mimeMap: Record<string, string> = {
					png: "image/png",
					jpg: "image/jpeg",
					jpeg: "image/jpeg",
					gif: "image/gif",
					webp: "image/webp",
					svg: "image/svg+xml",
					bmp: "image/bmp",
				};
				const mime = mimeMap[ext] ?? "image/png";
				const blob = new Blob([new Uint8Array(bytes)], { type: mime });
				const url = URL.createObjectURL(blob);
				setImageBlobUrl((prev) => {
					if (prev) URL.revokeObjectURL(prev);
					return url;
				});
				// File size from byte length
				const kb = bytes.length / 1024;
				const sizeStr =
					kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
				setImageInfo((prev) =>
					prev
						? { ...prev, fileSize: sizeStr }
						: {
								width: 0,
								height: 0,
								format: ext.toUpperCase(),
								fileSize: sizeStr,
							},
				);
			})
			.catch((e) => {
				if (filePathRef.current !== thisPath) return;
				Logger.error("Editor", "Failed to load image bytes", {
					path: thisPath,
					error: String(e),
				});
			});
		return () => {
			setImageBlobUrl((prev) => {
				if (prev) URL.revokeObjectURL(prev);
				return null;
			});
		};
	}, [filePath]);

	// ── Load PDF as blob URL (asset protocol unreliable on Linux) ────────
	useEffect(() => {
		if (!filePath || !isPdfFile(filePath)) return;
		const thisPath = filePath;
		invoke<number[]>("workspace_read_file_bytes", { path: thisPath })
			.then((bytes) => {
				if (filePathRef.current !== thisPath) return;
				const blob = new Blob([new Uint8Array(bytes)], {
					type: "application/pdf",
				});
				const url = URL.createObjectURL(blob);
				setPdfBlobUrl((prev) => {
					if (prev) URL.revokeObjectURL(prev);
					return url;
				});
			})
			.catch((e) => {
				if (filePathRef.current !== thisPath) return;
				loadErrorRef.current = true;
				setLoadError(`PDF 로드 실패: ${String(e)}`);
			});
		return () => {
			setPdfBlobUrl((prev) => {
				if (prev) URL.revokeObjectURL(prev);
				return null;
			});
		};
	}, [filePath]);

	// ── Load HWP/HWPX sidecar .txt ────────────────────────────────────
	useEffect(() => {
		if (!filePath || !isHwpFile(filePath)) {
			setHwpSidecar(null);
			return;
		}
		const sidecarPath = `${filePath}.txt`;
		let cancelled = false;
		invoke<string>("workspace_read_file", { path: sidecarPath })
			.then((text) => {
				if (!cancelled) setHwpSidecar(text);
			})
			.catch(() => {
				if (!cancelled) setHwpSidecar(null);
			});
		return () => { cancelled = true; };
	}, [filePath]);

	// ── Load file ─────────────────────────────────────────────────────────
	useEffect(() => {
		if (!filePath) {
			setContent("");
			setLoadError(null);
			loadErrorRef.current = false;
			return;
		}
		// Images and PDFs are rendered via blob URL — no text read needed
		if (isImageFile(filePath) || isPdfFile(filePath)) {
			setContent("");
			setLoadError(null);
			loadErrorRef.current = false;
			return;
		}
		const thisPath = filePath;
		// Reset error state at load start (ref first — read synchronously by updateListener)
		loadErrorRef.current = false;
		setLoadError(null);
		invoke<string>("workspace_read_file", { path: thisPath })
			.then((text) => {
				// Guard against stale response when user switches files quickly
				if (filePathRef.current !== thisPath) return;
				justLoadedRef.current = true;
				loadErrorRef.current = false;
				setLoadError(null);
				setContent(text);
				Logger.info("Editor", "File loaded", {
					path: thisPath,
					length: text.length,
				});
			})
			.catch((e) => {
				if (filePathRef.current !== thisPath) return;
				// Mark load as failed — autosave is disabled while this is true.
				// Do NOT set content to the error string; show error in UI instead.
				loadErrorRef.current = true;
				setLoadError(String(e));
				Logger.error("Editor", "Failed to load file", {
					path: thisPath,
					error: String(e),
				});
			});
	}, [filePath]);

	// ── Save ──────────────────────────────────────────────────────────────
	const saveFile = useCallback(
		async (text: string) => {
			if (!filePath || readOnly) return;
			setSaving(true);
			setSaveError("");
			try {
				await invoke("workspace_write_file", { path: filePath, content: text });
				Logger.info("Editor", "File saved", { path: filePath });
			} catch (e) {
				setSaveError(String(e));
				Logger.error("Editor", "Save failed", {
					path: filePath,
					error: String(e),
				});
			} finally {
				setSaving(false);
			}
		},
		[filePath, readOnly],
	);

	// ── Reload from disk ──────────────────────────────────────────────────
	const reloadFile = useCallback(async () => {
		if (!filePath) return;
		// Images and PDFs use blob URLs — no text reload needed
		if (isImageFile(filePath) || isPdfFile(filePath)) return;
		setReloading(true);
		try {
			const text = await invoke<string>("workspace_read_file", {
				path: filePath,
			});
			justLoadedRef.current = true;
			loadErrorRef.current = false;
			setLoadError(null);
			setContent(text);
			Logger.info("Editor", "File reloaded", {
				path: filePath,
				length: text.length,
			});
		} catch (e) {
			loadErrorRef.current = true;
			setLoadError(String(e));
			Logger.error("Editor", "Reload failed", {
				path: filePath,
				error: String(e),
			});
		} finally {
			setReloading(false);
		}
	}, [filePath]);

	// Expose reloadFile to parent via ref
	useImperativeHandle(ref, () => ({ reloadFile }), [reloadFile]);

	// ── Ctrl+Scroll zoom ─────────────────────────────────────────────────
	const wrapperRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = wrapperRef.current;
		if (!el) return;
		const handler = (e: WheelEvent) => {
			if (!(e.ctrlKey || e.metaKey)) return;
			e.preventDefault();
			const delta = e.deltaY > 0 ? -10 : 10;
			const next = Math.max(50, Math.min(200, zoomRef.current + delta));
			if (next !== zoomRef.current) {
				setZoom(next);
				try {
					localStorage.setItem("workspace-editor-zoom", String(next));
				} catch {}
			}
		};
		el.addEventListener("wheel", handler, { passive: false });
		return () => el.removeEventListener("wheel", handler);
	}, []);

	// ── Setup CodeMirror ──────────────────────────────────────────────────
	// biome-ignore lint/correctness/useExhaustiveDependencies: content intentionally excluded (synced via dispatch)
	useEffect(() => {
		if (
			!editorRef.current ||
			viewMode === "preview" ||
			viewMode === "image" ||
			viewMode === "pdf" ||
			viewMode === "csv" ||
			viewMode === "log" ||
			viewMode === "hwp"
		)
			return;

		const langExt = filePath ? getLanguageExtension(filePath) : null;

		const saveKeymap = keymap.of([
			{
				key: "Ctrl-s",
				preventDefault: true,
				run: (view) => {
					const text = view.state.doc.toString();
					void saveFile(text);
					return true;
				},
			},
		]);

		const extensions = [
			history(),
			keymap.of([...defaultKeymap, ...historyKeymap]),
			saveKeymap,
			lineNumbers(),
			oneDark,
			EditorView.lineWrapping,
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					// Don't trigger autosave/preview-sync on the initial load sync
					if (justLoadedRef.current) {
						justLoadedRef.current = false;
						return;
					}
					if (!readOnly) {
						const text = update.state.doc.toString();
						// Don't autosave while a file-load error is active
						if (loadErrorRef.current) return;
						// Update content state for live split-view preview
						setContent(text);
						// Autosave debounce
						if (autosaveTimerRef.current) {
							clearTimeout(autosaveTimerRef.current);
						}
						autosaveTimerRef.current = setTimeout(() => {
							void saveFile(text);
						}, AUTOSAVE_DEBOUNCE_MS);
					}
				}
			}),
			...(readOnly ? [EditorState.readOnly.of(true)] : []),
			...(langExt ? [langExt] : []),
		];

		const view = new EditorView({
			state: EditorState.create({
				doc: content,
				extensions,
			}),
			parent: editorRef.current,
		});

		viewRef.current = view;

		// If a file was loaded while viewMode was "preview", the sync effect could not
		// clear justLoadedRef (viewRef was null at that time). Clear it now so the user's
		// first edit after switching to editor mode is not mistakenly swallowed.
		// The doc was initialised with `content` above, so no dispatch is needed.
		if (justLoadedRef.current) {
			justLoadedRef.current = false;
		}

		return () => {
			view.destroy();
			viewRef.current = null;
			// Clear any pending autosave when the view is torn down (viewMode change,
			// file switch, or unmount) to prevent stale saves after the context changes.
			if (autosaveTimerRef.current) {
				clearTimeout(autosaveTimerRef.current);
				autosaveTimerRef.current = null;
			}
		};
		// content excluded intentionally — we update it via transaction below
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filePath, readOnly, viewMode, saveFile]);

	// ── Sync content into existing editor when file changes ───────────────
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const currentDoc = view.state.doc.toString();
		const isFileLoad = justLoadedRef.current;
		if (currentDoc !== content) {
			// When the change originates from a file load (justLoadedRef=true), mark the
			// transaction as non-history so it does not pollute the undo stack.
			// The updateListener will clear justLoadedRef.current after this dispatch.
			view.dispatch({
				changes: {
					from: 0,
					to: view.state.doc.length,
					insert: content,
				},
				...(isFileLoad && {
					annotations: Transaction.addToHistory.of(false),
				}),
			});
		} else if (isFileLoad) {
			// Content unchanged after file load (new file has same content as previous).
			// No dispatch needed, but clear the flag so the user's first edit is not
			// mistakenly swallowed by the justLoadedRef guard in updateListener.
			justLoadedRef.current = false;
		}
	}, [content]);

	// ── CSV: parse and sort ───────────────────────────────────────────────
	const csvResult = useMemo(() => {
		if (!isCsvFile(filePath) || !content) return null;
		return Papa.parse<string[]>(content, { skipEmptyLines: true });
	}, [filePath, content]);

	const csvRows = useMemo(() => {
		if (!csvResult || csvResult.data.length < 2) return [];
		const rows = csvResult.data.slice(1);
		if (sortCol === null) return rows;
		return [...rows].sort((a, b) => {
			const av = a[sortCol] ?? "";
			const bv = b[sortCol] ?? "";
			const cmp = av.localeCompare(bv, undefined, { numeric: true });
			return sortAsc ? cmp : -cmp;
		});
	}, [csvResult, sortCol, sortAsc]);

	// ── Log: ANSI → sanitized HTML ────────────────────────────────────────
	const logHtml = useMemo(() => {
		if (!isLogFile(filePath) || !content) return "";
		return DOMPurify.sanitize(ansiConverter.toHtml(content));
	}, [filePath, content]);

	// ── Empty state ───────────────────────────────────────────────────────
	if (!filePath) {
		return (
			<div className="workspace-editor workspace-editor--empty">
				<div className="workspace-editor__empty-hint">
					← 파일 탐색기에서 파일을 선택하거나 세션 카드를 클릭하세요
				</div>
			</div>
		);
	}

	const shortName = filePath.split("/").pop() ?? filePath;

	// ── Load error state ──────────────────────────────────────────────────
	if (loadError) {
		return (
			<div className="workspace-editor workspace-editor--error">
				<div className="workspace-editor__header">
					<span className="workspace-editor__filename">{shortName}</span>
					<button
						type="button"
						className="workspace-editor__view-btn workspace-editor__copy-path-btn"
						onClick={() => void navigator.clipboard.writeText(filePath)}
						title="경로 복사"
					>
						📋
					</button>
				</div>
				<div className="workspace-editor__load-error">
					파일을 열 수 없습니다: {loadError}
				</div>
			</div>
		);
	}

	return (
		<div ref={wrapperRef} className="workspace-editor" style={{ fontSize: `${zoom}%` }}>
			{/* Header bar */}
			<div className="workspace-editor__header">
				<span className="workspace-editor__filename">{shortName}</span>
				<button
					type="button"
					className="workspace-editor__view-btn workspace-editor__copy-path-btn"
					onClick={() => void navigator.clipboard.writeText(filePath)}
					title="경로 복사"
				>
					📋
				</button>
				{badge && <span className="workspace-editor__badge">{badge}</span>}
				<button
					type="button"
					className="workspace-editor__view-btn workspace-editor__reload-btn"
					onClick={() => void reloadFile()}
					disabled={reloading}
					title="디스크에서 다시 읽기"
				>
					{reloading ? "…" : "↻"}
				</button>
				{saving && <span className="workspace-editor__saving">저장 중…</span>}
				{saveError && (
					<span className="workspace-editor__error" title={saveError}>
						저장 실패
					</span>
				)}
				{readOnly && (
					<span className="workspace-editor__readonly">읽기 전용</span>
				)}
				{isMd && viewMode === "preview" && (
					<button
						type="button"
						className="workspace-editor__view-btn"
						onClick={() => setViewMode("split")}
						title="편집 모드로 전환"
					>
						편집
					</button>
				)}
				{isMd && viewMode === "split" && (
					<>
						<button
							type="button"
							className="workspace-editor__view-btn"
							onClick={() => setViewMode("preview")}
							title="미리보기만 표시"
						>
							미리보기만
						</button>
						<button
							type="button"
							className="workspace-editor__view-btn workspace-editor__view-btn--active"
							onClick={() => setViewMode("editor")}
							title="편집기만 표시"
						>
							편집만
						</button>
					</>
				)}
				{isMd && viewMode === "editor" && (
					<button
						type="button"
						className="workspace-editor__view-btn"
						onClick={() => setViewMode("preview")}
						title="미리보기 모드로 전환"
					>
						미리보기
					</button>
				)}
				<button
					type="button"
					className="workspace-editor__view-btn workspace-editor__print-btn"
					onClick={() => {
						if (isMd && viewMode !== "preview") {
							const prev = viewMode;
							setViewMode("preview");
							// Double rAF: first frame commits React state, second ensures
							// DOM is painted before printing. Single rAF may fire before
							// React flushes the preview content.
							requestAnimationFrame(() => {
								requestAnimationFrame(() => {
									window.print();
									setViewMode(prev);
								});
							});
						} else {
							window.print();
						}
					}}
					title="인쇄"
				>
					🖨
				</button>
			</div>

			{/* Viewer / Editor area */}
			{viewMode === "image" ? (
				<div className="workspace-editor__image-viewer">
					<div className="workspace-editor__image-toolbar">
						<button
							type="button"
							className={`workspace-editor__image-btn${imageZoom === "fit" ? " workspace-editor__image-btn--active" : ""}`}
							onClick={() => setImageZoom("fit")}
							title="화면 맞춤"
						>
							맞춤
						</button>
						<button
							type="button"
							className={`workspace-editor__image-btn${imageZoom === "original" ? " workspace-editor__image-btn--active" : ""}`}
							onClick={() => setImageZoom("original")}
							title="원본 크기"
						>
							1:1
						</button>
						<button
							type="button"
							className="workspace-editor__image-btn"
							onClick={() =>
								setImageZoom((prev) => {
									const current =
										prev === "fit" ? 1 : prev === "original" ? 1 : prev;
									return Math.max(0.1, current - 0.25);
								})
							}
							title="축소"
						>
							−
						</button>
						<span className="workspace-editor__image-zoom-label">
							{imageZoom === "fit"
								? "맞춤"
								: imageZoom === "original"
									? "100%"
									: `${Math.round(imageZoom * 100)}%`}
						</span>
						<button
							type="button"
							className="workspace-editor__image-btn"
							onClick={() =>
								setImageZoom((prev) => {
									const current =
										prev === "fit" ? 1 : prev === "original" ? 1 : prev;
									return Math.min(5, current + 0.25);
								})
							}
							title="확대"
						>
							+
						</button>
						{imageInfo && (
							<span className="workspace-editor__image-meta">
								{imageInfo.width}×{imageInfo.height} · {imageInfo.format} ·{" "}
								{imageInfo.fileSize}
							</span>
						)}
					</div>
					<div className="workspace-editor__image-container">
						{imageBlobUrl ? (
							<img
								src={imageBlobUrl}
								alt={shortName}
								className="workspace-editor__image"
								style={
									imageZoom === "fit"
										? {
												maxWidth: "100%",
												maxHeight: "100%",
												objectFit: "contain",
											}
										: imageZoom === "original"
											? { width: "auto", height: "auto" }
											: {
													width: "auto",
													height: "auto",
													transform: `scale(${imageZoom})`,
													transformOrigin: "top left",
												}
								}
								onLoad={(e) => {
									const img = e.currentTarget;
									const ext = filePath.split(".").pop()?.toUpperCase() ?? "IMG";
									setImageInfo((prev) => ({
										width: img.naturalWidth,
										height: img.naturalHeight,
										format: ext,
										fileSize: prev?.fileSize ?? "",
									}));
								}}
							/>
						) : (
							<div className="workspace-editor__image-loading">
								이미지 로딩 중…
							</div>
						)}
					</div>
				</div>
			) : viewMode === "pdf" ? (
				<div className="workspace-editor__pdf-viewer">
					<Document
						file={pdfBlobUrl ?? ""}
						onLoadSuccess={({ numPages }) => setPdfNumPages(numPages)}
						onLoadError={(err) => {
							loadErrorRef.current = true;
							setLoadError(`PDF 로드 실패: ${String(err?.message ?? err)}`);
						}}
						loading={
							<div className="workspace-editor__pdf-loading">PDF 로딩 중…</div>
						}
					>
						{Array.from({ length: pdfNumPages }, (_, i) => (
							<PdfPage
								key={`page-${i + 1}`}
								pageNumber={i + 1}
								width={Math.min(
									800,
									(typeof window !== "undefined" ? window.innerWidth : 800) -
										80,
								)}
								className="workspace-editor__pdf-page"
							/>
						))}
					</Document>
				</div>
			) : viewMode === "hwp" ? (
				<div className="workspace-editor__hwp-viewer">
					{hwpSidecar !== null ? (
						<pre className="workspace-editor__hwp-content">{hwpSidecar}</pre>
					) : (
						<div className="workspace-editor__hwp-placeholder">
							<div className="workspace-editor__hwp-placeholder-icon">📄</div>
							<div className="workspace-editor__hwp-placeholder-text">
								HWP/HWPX 파일 미리보기를 사용할 수 없습니다
							</div>
							<div className="workspace-editor__hwp-placeholder-hint">
								사이드카 .txt 파일이 없습니다. /read-doc 스킬로 추출하세요.
							</div>
						</div>
					)}
				</div>
			) : viewMode === "csv" ? (
				<div className="workspace-editor__csv-viewer">
					{csvResult && csvResult.data.length > 0 ? (
						<table className="workspace-editor__csv-table">
							<thead>
								<tr>
									{csvResult.data[0].map((header, i) => {
										const toggleSort = () => {
											if (sortCol === i) {
												setSortAsc((prev) => !prev);
											} else {
												setSortCol(i);
												setSortAsc(true);
											}
										};
										return (
											<th
												// biome-ignore lint/suspicious/noArrayIndexKey: CSV columns have no natural key
												key={i}
												className="workspace-editor__csv-th"
												onClick={toggleSort}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														toggleSort();
													}
												}}
											>
												{header}
												{sortCol === i ? (sortAsc ? " ▲" : " ▼") : ""}
											</th>
										);
									})}
								</tr>
							</thead>
							<tbody>
								{csvRows.map((row, ri) => (
									<tr
										// biome-ignore lint/suspicious/noArrayIndexKey: CSV rows have no natural key
										key={ri}
									>
										{row.map((cell, ci) => (
											<td
												// biome-ignore lint/suspicious/noArrayIndexKey: CSV cells have no natural key
												key={ci}
												className="workspace-editor__csv-td"
											>
												{cell}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<div className="workspace-editor__empty-hint">
							CSV 데이터가 없습니다
						</div>
					)}
				</div>
			) : viewMode === "log" ? (
				<div className="workspace-editor__log-viewer">
					<pre
						className="workspace-editor__log-pre"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify
						dangerouslySetInnerHTML={{ __html: logHtml }}
					/>
				</div>
			) : viewMode === "preview" ? (
				<div className="workspace-editor__preview">
					<Markdown
						remarkPlugins={[remarkGfm]}
						components={{ code: CodeBlock }}
					>
						{content}
					</Markdown>
				</div>
			) : viewMode === "split" ? (
				<div className="workspace-editor__body--split">
					<div
						ref={editorRef}
						className="workspace-editor__codemirror workspace-editor__codemirror--half"
					/>
					<div className="workspace-editor__preview workspace-editor__preview--half">
						<Markdown
							remarkPlugins={[remarkGfm]}
							components={{ code: CodeBlock }}
						>
							{content}
						</Markdown>
					</div>
				</div>
			) : (
				<div ref={editorRef} className="workspace-editor__codemirror" />
			)}
		</div>
	);
});
