import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { type IBufferRange, Terminal as XTerminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { Logger } from "../../lib/logger";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
	pty_id: string;
	active: boolean;
	workingDir?: string;
	onExit: (pty_id: string) => void;
	onFileSelect?: (path: string) => void;
	/** Alt+click on a file path in terminal output → ask the conversation rail
	    about that file (instead of opening it in the document viewer). */
	onAskAi?: (path: string) => void;
}

const FILE_PATH_RE =
	/(?:(?:[A-Za-z]:[\\/]|~\/|\.?\.?\/)[\w./\\-]*[\w-]+\.[\w]{1,10}|(?:src|lib|test|tests|dist|build|projects|packages|modules|node_modules|components|panels|scripts|agent|gateway|shell)[\\/][\w./\\-]*[\w-]+\.[\w]{1,10})(?::\d+){0,2}/g;

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

function resolveFilePath(raw: string, cwd?: string): string | null {
	const parts = raw.split(":");
	let filePath = parts[0];
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext || !FILE_EXTENSIONS.has(ext)) return null;
	if (filePath.startsWith("~/")) {
		filePath = `${process.env.HOME || process.env.USERPROFILE || "~"}${filePath.slice(1)}`;
	}
	if (
		!filePath.includes("/") &&
		!filePath.includes("\\") &&
		!filePath.match(/^[A-Za-z]:/)
	) {
		if (cwd) filePath = `${cwd}/${filePath}`;
		else return null;
	}
	return filePath.replace(/\\/g, "/");
}

export function Terminal({
	pty_id,
	active,
	workingDir,
	onExit,
	onFileSelect,
	onAskAi,
}: TerminalProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const activeRef = useRef(active);
	activeRef.current = active;
	const onExitRef = useRef(onExit);
	onExitRef.current = onExit;
	const onFileSelectRef = useRef(onFileSelect);
	onFileSelectRef.current = onFileSelect;
	const onAskAiRef = useRef(onAskAi);
	onAskAiRef.current = onAskAi;
	const workingDirRef = useRef(workingDir);
	workingDirRef.current = workingDir;

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const term = new XTerminal({
			fontFamily: "'Fira Code', 'Noto Sans Mono', monospace",
			fontSize: 13,
			theme: { background: "#1a1a1a", foreground: "#d0d0d0" },
			scrollback: 2000,
			cursorBlink: true,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		fit.fit();

		termRef.current = term;
		fitRef.current = fit;

		if (onFileSelect || onAskAi) {
			term.registerLinkProvider({
				provideLinks(lineNum, callback) {
					const line = term.buffer.active.getLine(lineNum - 1);
					if (!line) {
						callback(undefined);
						return;
					}
					const text = line.translateToString(true);
					FILE_PATH_RE.lastIndex = 0;
					let match: RegExpExecArray | null;
					const links: {
						range: IBufferRange;
						text: string;
						activate: (_e: MouseEvent, text: string) => void;
						leave: () => void;
						hover: () => void;
						dispose: () => void;
					}[] = [];
					// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
					for (
						let m: RegExpExecArray | null = null;
						(m = FILE_PATH_RE.exec(text)) !== null;
					) {
						match = m;
						const resolved = resolveFilePath(match[0], workingDirRef.current);
						if (!resolved) continue;
						const startCol = match.index + 1;
						const endCol = startCol + match[0].length;
						links.push({
							range: {
								start: { x: startCol, y: lineNum },
								end: { x: endCol, y: lineNum },
							},
							text: match[0],
							activate(e, linkText) {
								const path = resolveFilePath(linkText, workingDirRef.current);
								if (!path) return;
								// Alt+click → ask the conversation rail about this file;
								// plain click → open it in the document viewer.
								if (e.altKey && onAskAiRef.current) {
									onAskAiRef.current(path);
								} else {
									onFileSelectRef.current?.(path);
								}
							},
							leave() {},
							hover() {},
							dispose() {},
						});
					}
					callback(links.length > 0 ? links : undefined);
				},
			});
		}

		let cancelled = false;
		const pendingUnlistens: Array<() => void> = [];

		listen<string>(`pty:output:${pty_id}`, (e) => {
			term.write(e.payload);
		}).then((fn) => {
			if (cancelled) {
				fn();
				return;
			}
			pendingUnlistens.push(fn);
		});

		listen<void>(`pty:exit:${pty_id}`, () => {
			if (cancelled) return;
			if (termRef.current) {
				termRef.current.write("\r\n[프로세스 종료]\r\n");
			}
			onExitRef.current(pty_id);
		}).then((fn) => {
			if (cancelled) {
				fn();
				return;
			}
			pendingUnlistens.push(fn);
		});

		const onDataDisposer = term.onData((data) => {
			invoke("pty_write", { pty_id, data }).catch((e) => {
				Logger.warn("Terminal", "pty_write error", { error: String(e) });
			});
		});

		const observer = new ResizeObserver(() => {
			if (!activeRef.current || !fitRef.current || !termRef.current) return;
			fitRef.current.fit();
			const { rows, cols } = termRef.current;
			if (!rows || !cols) return;
			invoke("pty_resize", { pty_id, rows, cols }).catch(() => {});
		});
		observer.observe(container);

		return () => {
			cancelled = true;
			observer.disconnect();
			for (const fn of pendingUnlistens) fn();
			onDataDisposer.dispose();
			termRef.current = null;
			fitRef.current = null;
			term.dispose();
		};
	}, [pty_id, onFileSelect]);

	useEffect(() => {
		if (!active) return;
		const id = setTimeout(() => {
			if (!fitRef.current || !termRef.current) return;
			fitRef.current.fit();
			const { rows, cols } = termRef.current;
			if (!rows || !cols) return;
			invoke("pty_resize", { pty_id, rows, cols }).catch(() => {});
		}, 50);
		return () => clearTimeout(id);
	}, [active, pty_id]);

	return (
		<div
			ref={containerRef}
			className="workspace-panel__terminal"
			style={active ? undefined : { opacity: 0, pointerEvents: "none" }}
		/>
	);
}
