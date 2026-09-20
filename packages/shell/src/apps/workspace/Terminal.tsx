import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { type IBufferRange, Terminal as XTerminal } from "@xterm/xterm";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { t } from "../../lib/i18n";
import { Logger } from "../../lib/logger";
import {
	hasPrimaryModifier,
	type ShortcutPlatform,
} from "../../lib/platform-shortcuts";
import { attachPty, resizePty, writePty } from "./pty-ipc";
import "@xterm/xterm/css/xterm.css";

export interface TerminalProps {
	pty_id: string;
	active: boolean;
	workingDir?: string;
	onExit: (pty_id: string) => void;
	onFileSelect?: (path: string) => void;
	onFileLocation?: (location: FileLocation) => void;
	/** Alt+click on a file path in terminal output → ask the conversation rail
	    about that file (instead of opening it in the document viewer). */
	onAskAi?: (path: string) => void;
	/** Fires only after xterm has parsed real PTY output. */
	onReady?: () => void;
}

export interface FileLocation {
	path: string;
	line?: number;
	column?: number;
}

export interface TerminalHandle {
	focus: () => void;
	getBufferText: (maxLines?: number) => string;
}

export function shouldOpenTerminalFileLink(
	event: Pick<MouseEvent, "ctrlKey" | "metaKey">,
	platform?: ShortcutPlatform,
): boolean {
	return hasPrimaryModifier(event, platform);
}

const FILE_PATH_RE =
	/(?:(?:[A-Za-z]:[\\/]|~\/|\.?\.?\/)[\w./\\-]*[\w-]+\.[\w]{1,10}|(?:src|lib|test|tests|dist|build|projects|packages|modules|node_modules|components|apps|scripts|agent|gateway|shell)[\\/][\w./\\-]*[\w-]+\.[\w]{1,10}|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|xml|csv|md|txt|log|env|rs|go|py|rb|java|kt|swift|c|cpp|h|hpp|css|scss|less|html|svg|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|proto|wasm|lock)\b)(?::\d+){0,2}/g;

const FILE_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"yaml",
	"yml",
	"toml",
	"xml",
	"csv",
	"md",
	"txt",
	"log",
	"env",
	"rs",
	"go",
	"py",
	"rb",
	"java",
	"kt",
	"swift",
	"c",
	"cpp",
	"h",
	"hpp",
	"css",
	"scss",
	"less",
	"html",
	"svg",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"bat",
	"cmd",
	"sql",
	"graphql",
	"proto",
	"wasm",
	"lock",
	"cargo",
	"toml",
	"rs",
]);

export function parseFileLocation(
	raw: string,
	cwd?: string,
): FileLocation | null {
	const match = raw.match(/^(.*\.[\w]{1,10})(?::(\d+))?(?::(\d+))?$/);
	if (!match) return null;
	let filePath = match[1];
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext || !FILE_EXTENSIONS.has(ext)) return null;
	// Home expansion is intentionally left to the trusted Rust boundary.
	if (
		!filePath.includes("/") &&
		!filePath.includes("\\") &&
		!filePath.match(/^[A-Za-z]:/)
	) {
		if (cwd) filePath = `${cwd}/${filePath}`;
		else return null;
	}
	return {
		path: filePath.replace(/\\/g, "/"),
		line: match[2] ? Number(match[2]) : undefined,
		column: match[3] ? Number(match[3]) : undefined,
	};
}

/** Resolve a CSS custom property (e.g. "--bg-base") to a concrete rgb() color,
    following var() indirection, so xterm gets a usable color for any shell theme. */
function readThemeColor(varRef: string, fallback: string): string {
	const probe = document.createElement("span");
	probe.style.color = `var(${varRef})`;
	probe.style.display = "none";
	document.body.appendChild(probe);
	const value = getComputedStyle(probe).color;
	probe.remove();
	return value || fallback;
}

/** xterm theme mirrored from the shell's current theme (base surface + text +
    accent cursor) so the embedded terminal follows light/dark like the rest of
    the app. */
function currentXtermTheme(): {
	background: string;
	foreground: string;
	cursor: string;
} {
	return {
		background: readThemeColor("--bg-base", "#1a1a1a"),
		foreground: readThemeColor("--text-primary", "#d0d0d0"),
		cursor: readThemeColor("--accent", "#8ab4f8"),
	};
}

/** True when the shell's current base surface is dark (drives the Herdr theme). */
function shellIsDark(): boolean {
	const rgb = readThemeColor("--bg-base", "#1a1a1a").match(/\d+(?:\.\d+)?/g);
	if (!rgb || rgb.length < 3) return true;
	const [r, g, b] = rgb.map((n) => Number(n) / 255);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
	function Terminal(
		{
			pty_id,
			active,
			workingDir,
			onExit,
			onFileSelect,
			onFileLocation,
			onAskAi,
			onReady,
		}: TerminalProps,
		ref,
	) {
		const containerRef = useRef<HTMLDivElement>(null);
		const termRef = useRef<XTerminal | null>(null);
		const fitRef = useRef<FitAddon | null>(null);
		const activeRef = useRef(active);
		activeRef.current = active;
		const onExitRef = useRef(onExit);
		onExitRef.current = onExit;
		const onFileSelectRef = useRef(onFileSelect);
		onFileSelectRef.current = onFileSelect;
		const onFileLocationRef = useRef(onFileLocation);
		onFileLocationRef.current = onFileLocation;
		const onAskAiRef = useRef(onAskAi);
		onAskAiRef.current = onAskAi;
		const workingDirRef = useRef(workingDir);
		workingDirRef.current = workingDir;
		const onReadyRef = useRef(onReady);
		onReadyRef.current = onReady;

		const [toastMessage, setToastMessage] = useState<string | null>(null);
		const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

		const showToast = useCallback((msg: string) => {
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
			setToastMessage(msg);
			toastTimerRef.current = setTimeout(() => {
				setToastMessage(null);
			}, 3000);
		}, []);

		const getBufferText = useCallback((maxLines?: number): string => {
			const term = termRef.current;
			if (!term) return "";
			const buffer = term.buffer.active;
			const totalLines = buffer.length;
			const limit =
				typeof maxLines === "number" && maxLines > 0
					? Math.min(maxLines, totalLines)
					: totalLines;
			const start = Math.max(0, totalLines - limit);
			const lines: string[] = [];
			for (let i = start; i < totalLines; i++) {
				const line = buffer.getLine(i);
				if (line) lines.push(line.translateToString(true));
			}
			while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
				lines.pop();
			}
			return lines.join("\n");
		}, []);

		useImperativeHandle(
			ref,
			() => ({
				focus: () => termRef.current?.focus(),
				getBufferText,
			}),
			[getBufferText],
		);

		// A full-screen TUI (the embedded Herdr client) only repaints on a real
		// SIGWINCH. Two cases leave the surface blank with a plain resize:
		//   1. First attach — the client's opening frame can be emitted before this
		//      component's pty:output listener is registered (Tauri events are not
		//      buffered), so that frame is lost.
		//   2. Reattach — the fit size can equal the client's current size, so the
		//      resize is a no-op and the client never redraws.
		// Nudge to a distinct size then back so the PTY always sees a real size
		// change and the client redraws the whole screen into xterm.
		const forceRedraw = useCallback(() => {
			const term = termRef.current;
			const fit = fitRef.current;
			if (!activeRef.current || !term || !fit) return;
			fit.fit();
			const { rows, cols } = term;
			if (!rows || !cols) return;
			void resizePty(pty_id, Math.max(1, rows - 1), cols)
				.then(() => resizePty(pty_id, rows, cols))
				.catch(() => {});
		}, [pty_id]);

		useEffect(() => {
			const container = containerRef.current;
			if (!container) return;

			const term = new XTerminal({
				// Windows-available terminal fonts first (Fira Code / Noto are not
				// bundled and fall back to an ugly generic monospace otherwise).
				fontFamily:
					"'Cascadia Code', 'Cascadia Mono', Consolas, 'Fira Code', 'Noto Sans Mono', monospace",
				fontSize: 13,
				theme: currentXtermTheme(),
				scrollback: 2000,
				cursorBlink: true,
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(container);
			fit.fit();

			termRef.current = term;
			fitRef.current = fit;

			term.registerLinkProvider({
				provideLinks(lineNum, callback) {
					const line = term.buffer.active.getLine(lineNum - 1);
					if (!line) {
						callback(undefined);
						return;
					}
					const text = line.translateToString(true);
					FILE_PATH_RE.lastIndex = 0;
					const links: {
						range: IBufferRange;
						text: string;
						activate: (_e: MouseEvent, text: string) => void;
						leave: () => void;
						hover: () => void;
						dispose: () => void;
					}[] = [];
					let match = FILE_PATH_RE.exec(text);
					while (match !== null) {
						const resolved = parseFileLocation(match[0], workingDirRef.current);
						if (resolved) {
							const startCol = match.index + 1;
							const endCol = startCol + match[0].length;
							links.push({
								range: {
									start: { x: startCol, y: lineNum },
									end: { x: endCol, y: lineNum },
								},
								text: match[0],
								async activate(e, linkText) {
									// Preserve xterm's normal click/drag selection. File links
									// activate only with the platform primary modifier.
									if (!shouldOpenTerminalFileLink(e)) return;
									const location = parseFileLocation(
										linkText,
										workingDirRef.current,
									);
									if (!location) return;
									// Alt+primary-click asks the conversation rail; primary-click
									// opens the document viewer.
									if (e.altKey && onAskAiRef.current) {
										onAskAiRef.current(location.path);
										return;
									}
									try {
										const exists = await invoke<boolean>("fs_exists", {
											path: location.path,
											cwd: workingDirRef.current,
										});
										if (!exists) {
											showToast(`파일을 찾을 수 없습니다: ${location.path}`);
											return;
										}
									} catch (err) {
										Logger.warn("Terminal", "fs_exists error", {
											error: String(err),
										});
									}
									onFileLocationRef.current?.(location);
									onFileSelectRef.current?.(location.path);
								},
								leave() {},
								hover() {},
								dispose() {},
							});
						}
						match = FILE_PATH_RE.exec(text);
					}
					callback(links.length > 0 ? links : undefined);
				},
			});

			let cancelled = false;
			const pendingUnlistens: Array<() => void> = [];
			let observer: ResizeObserver | null = null;

			let reportedReady = false;
			const outputListener = listen<string>(`pty:output:${pty_id}`, (e) => {
				term.write(e.payload, () => {
					if (reportedReady || e.payload.length === 0) return;
					reportedReady = true;
					onReadyRef.current?.();
				});
			});
			const exitListener = listen<void>(`pty:exit:${pty_id}`, () => {
				if (cancelled) return;
				if (termRef.current) {
					termRef.current.write(
						`\r\n[${t("workspace.terminalProcessExited")}]\r\n`,
					);
				}
				onExitRef.current(pty_id);
			});

			const onDataDisposer = term.onData((data) => {
				writePty(pty_id, data).catch((e) => {
					Logger.warn("Terminal", "pty_write error", { error: String(e) });
				});
			});
			const onBinaryDisposer =
				typeof term.onBinary === "function"
					? term.onBinary((data) => {
							writePty(pty_id, data).catch((e) => {
								Logger.warn("Terminal", "pty_write binary error", {
									error: String(e),
								});
							});
						})
					: { dispose: () => {} };

			// A PTY can emit its first frame before this component mounts (notably when
			// the embedded Herdr client is reused). Register both listeners first, then
			// send SIGWINCH through pty_resize so full-screen TUIs redraw into xterm.
			Promise.all([outputListener, exitListener]).then((unlistens) => {
				if (cancelled) {
					for (const unlisten of unlistens) unlisten();
					return;
				}
				pendingUnlistens.push(...unlistens);
				void attachPty(pty_id).catch((error) => {
					Logger.warn("Terminal", "pty_attach error", { error: String(error) });
				});
				const fitAndResize = () => {
					if (!activeRef.current || !fitRef.current || !termRef.current) return;
					fitRef.current.fit();
					const { rows, cols } = termRef.current;
					if (!rows || !cols) return;
					resizePty(pty_id, rows, cols).catch(() => {});
				};
				observer = new ResizeObserver(fitAndResize);
				observer.observe(container);
				// Initial attach: force a redraw so a lost opening frame cannot leave
				// the Herdr surface blank. Ongoing user-driven resizes go through
				// fitAndResize (real size changes already trigger a repaint).
				forceRedraw();
				term.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
			});

			return () => {
				cancelled = true;
				observer?.disconnect();
				for (const fn of pendingUnlistens) fn();
				onDataDisposer.dispose();
				onBinaryDisposer.dispose();
				termRef.current = null;
				fitRef.current = null;
				term.dispose();
			};
		}, [pty_id, forceRedraw, showToast]);

		useEffect(() => {
			if (!active) return;
			// Switching back to the Herdr surface reattaches the same client; force a
			// redraw so a no-op resize cannot leave the restored surface blank.
			const id = setTimeout(() => {
				forceRedraw();
				termRef.current?.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
			}, 50);
			return () => clearTimeout(id);
		}, [active, forceRedraw]);

		// Follow the shell's light/dark theme: recolor xterm and hot-reload the
		// Herdr theme whenever the app's data-theme changes (and once on mount).
		useEffect(() => {
			let lastDark: boolean | null = null;
			const sync = () => {
				if (termRef.current)
					termRef.current.options.theme = currentXtermTheme();
				// Only hot-reload the Herdr theme when the light/dark mode actually
				// flips — switching between two dark themes just recolors xterm.
				const dark = shellIsDark();
				if (dark !== lastDark) {
					lastDark = dark;
					invoke("herdr_set_theme", { dark }).catch(() => {});
				}
			};
			sync();
			const observer = new MutationObserver((mutations) => {
				if (mutations.some((m) => m.attributeName === "data-theme")) sync();
			});
			observer.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ["data-theme"],
			});
			return () => observer.disconnect();
		}, []);

		return (
			<div
				ref={containerRef}
				className="workspace-app__terminal"
				// Suppress the WebView's default (browser) context menu so a
				// right-click reaches xterm's mouse reporting and Herdr shows its
				// own right-click menu instead.
				onContextMenu={(e) => e.preventDefault()}
				onDragOverCapture={(e) => {
					if (e.dataTransfer.types.includes("Files")) {
						e.preventDefault();
						e.stopPropagation();
					}
				}}
				onDropCapture={(e) => {
					if (e.dataTransfer.types.includes("Files")) {
						e.preventDefault();
						e.stopPropagation();
					}
				}}
				style={active ? undefined : { opacity: 0, pointerEvents: "none" }}
			>
				{toastMessage && (
					<div
						className="workspace-app__idle-toast"
						role="alert"
						onClick={() => setToastMessage(null)}
					>
						{toastMessage}
					</div>
				)}
			</div>
		);
	},
);
