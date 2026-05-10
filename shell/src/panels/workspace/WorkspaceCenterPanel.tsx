import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAdkPath } from "../../lib/adk-store";
import { loadConfig, saveConfig } from "../../lib/config";
import { Logger } from "../../lib/logger";
import { panelRegistry } from "../../lib/panel-registry";
import type { PanelCenterProps } from "../../lib/panel-registry";
import { useChatStore } from "../../stores/chat";
import { usePanelStore } from "../../stores/panel";
import { Editor, type EditorHandle } from "./Editor";
import { FileTree } from "./FileTree";
import { QuickOpen } from "./QuickOpen";
import type { SessionInfo } from "./SessionCard";
import { SessionDashboard } from "./SessionDashboard";
import { SkillLauncher } from "./SkillLauncher";
import { Terminal } from "./Terminal";
import { ACTIVE_THRESHOLD_SECONDS, WORKSPACE_ROOT } from "./constants";

// ─── File navigation history ─────────────────────────────────────────────────

/**
 * Hook that wraps file path state with back/forward navigation history.
 * Mirrors browser-style history: navigating to a new file while mid-history
 * truncates the forward stack.
 */
function useFileNavHistory() {
	const [openFilePath, openFileRaw] = useState("");
	/** Full ordered history of visited file paths */
	const historyRef = useRef<string[]>([]);
	/** Current position within historyRef (-1 = no history) */
	const indexRef = useRef(-1);
	/** Flag to suppress history push when navigating via back/forward */
	const navigatingRef = useRef(false);

	/** Open a file — called by all file-open paths (tree click, session click, API, etc.) */
	const openFile = useCallback((path: string) => {
		if (!path) {
			openFileRaw("");
			return;
		}
		if (navigatingRef.current) {
			// Navigation via back/forward — don't modify history
			navigatingRef.current = false;
			openFileRaw(path);
			return;
		}
		// Skip duplicate consecutive entries
		if (
			historyRef.current.length > 0 &&
			historyRef.current[indexRef.current] === path
		) {
			return;
		}
		// Truncate forward history when opening a new file mid-history
		historyRef.current = historyRef.current.slice(0, indexRef.current + 1);
		historyRef.current.push(path);
		indexRef.current = historyRef.current.length - 1;
		openFileRaw(path);
	}, []);

	/** Navigate backward in history */
	const goBack = useCallback(() => {
		if (indexRef.current <= 0) return;
		indexRef.current--;
		navigatingRef.current = true;
		openFile(historyRef.current[indexRef.current]);
	}, [openFile]);

	/** Navigate forward in history */
	const goForward = useCallback(() => {
		if (indexRef.current >= historyRef.current.length - 1) return;
		indexRef.current++;
		navigatingRef.current = true;
		openFile(historyRef.current[indexRef.current]);
	}, [openFile]);

	return { openFilePath, openFile, goBack, goForward };
}

// ─── Panel API ───────────────────────────────────────────────────────────────

/**
 * Programmatic API exposed by the Workspace panel.
 * Access via `panelRegistry.getApi<WorkspacePanelApi>("workspace")`.
 */
export interface WorkspacePanelApi {
	/** Open a file in the Editor. */
	openFile: (path: string) => void;
	/**
	 * Highlight (visually focus) a session card by its `dir` identifier
	 * and scroll it into view.
	 * Caller should invoke `activatePanel()` first if the Workspace panel
	 * is not currently visible — focusSession only highlights/scrolls, it
	 * does not switch panels.
	 */
	focusSession: (dir: string) => void;
	/** Return the current live session list. */
	getActiveSessions: () => SessionInfo[];
	/** Switch the center panel to Workspace. */
	activatePanel: () => void;
}

// ─── Terminal tab ─────────────────────────────────────────────────────────────

interface TerminalTab {
	pty_id: string;
	dir: string;
	pid: number;
}

// ─── Re-export for FileTree ───────────────────────────────────────────────────

import type { ClassifiedDir } from "./types";

export type { ClassifiedDir };

const CLASSIFIED_DIRS_KEY = "workspace-classified-dirs";

function loadClassifiedDirs(): ClassifiedDir[] | null {
	try {
		const raw = localStorage.getItem(CLASSIFIED_DIRS_KEY);
		if (raw) return JSON.parse(raw) as ClassifiedDir[];
	} catch {}
	return null;
}

function saveClassifiedDirs(dirs: ClassifiedDir[]): void {
	try {
		localStorage.setItem(CLASSIFIED_DIRS_KEY, JSON.stringify(dirs));
	} catch {}
}

// ─── Recent file persistence (per-workspace + per-repo) ─────────────────────

const LAST_FILE_KEY = "workspace-last-file";
const REPO_RECENT_KEY = "workspace-repo-recent";

function loadLastFile(): string {
	try {
		return localStorage.getItem(LAST_FILE_KEY) ?? "";
	} catch {
		return "";
	}
}

function saveLastFile(path: string): void {
	try {
		localStorage.setItem(LAST_FILE_KEY, path);
	} catch {}
}

/** Map of repo root path → last opened file path */
function loadRepoRecent(): Record<string, string> {
	try {
		const raw = localStorage.getItem(REPO_RECENT_KEY);
		return raw ? (JSON.parse(raw) as Record<string, string>) : {};
	} catch {
		return {};
	}
}

function saveRepoRecent(repoRoot: string, filePath: string): void {
	try {
		const map = loadRepoRecent();
		map[repoRoot] = filePath;
		localStorage.setItem(REPO_RECENT_KEY, JSON.stringify(map));
	} catch {}
}

function getRepoRecentFile(repoRoot: string): string | undefined {
	return loadRepoRecent()[repoRoot];
}

export function WorkspaceCenterPanel({ naia }: PanelCenterProps) {
	// Resolved workspace root — read from config, fall back to naia-adk path.
	const [activeWorkspaceRoot, setActiveWorkspaceRoot] = useState(() => {
		const cfg = loadConfig();
		return cfg?.workspaceRoot || getAdkPath() || WORKSPACE_ROOT;
	});

	const detectAdkRoot = useCallback(async (): Promise<string | null> => {
		try {
			const detected = await invoke<string>("workspace_detect_adk_root");
			return detected;
		} catch {
			return null;
		}
	}, []);

	const { openFilePath, openFile, goBack, goForward } = useFileNavHistory();
	const editorRef = useRef<EditorHandle>(null);
	const [editorBadge, setEditorBadge] = useState("");
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	// Terminal tab management
	const [terminals, setTerminals] = useState<TerminalTab[]>([]);
	const terminalsRef = useRef<TerminalTab[]>(terminals);
	terminalsRef.current = terminals;
	// Tracks dirs of all open+pending terminals. Updated synchronously BEFORE await so
	// concurrent duplicate spawn is blocked even before React commits the new state.
	const openDirsRef = useRef(new Set<string>());
	const [activeTab, setActiveTab] = useState<string>("editor");
	const [quickOpenVisible, setQuickOpenVisible] = useState(false);
	const sessionsRef = useRef<SessionInfo[]>([]);
	const [classifiedDirs, setClassifiedDirs] = useState<ClassifiedDir[] | null>(
		null,
	);
	const [classifyPending, setClassifyPending] = useState(false);
	const [idleToast, setIdleToast] = useState<string | null>(null);
	const idleToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const idleNotifiedRef = useRef<Set<string>>(new Set());
	/** Tracks sessions already notified for error — prevents repeat pushContext per session */
	const errorNotifiedRef = useRef<Set<string>>(new Set());
	/** Session dir highlighted by focusSession() API call — cleared after 3s */
	const [highlightedSessionDir, setHighlightedSessionDir] = useState<
		string | null
	>(null);
	const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Highlight a session card for 3s, canceling any in-flight highlight first. */
	const startHighlight = useCallback((dir: string) => {
		if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
		setHighlightedSessionDir(dir);
		highlightTimerRef.current = setTimeout(() => {
			setHighlightedSessionDir(null);
			highlightTimerRef.current = null;
		}, 3000);
	}, []); // stable: setters and refs never change
	/** True until the first session fetch resolves (hides blank flash on first render) */
	const initializedRef = useRef(false);
	const [initialized, setInitialized] = useState(false);

	// ── Drag-resize panel widths ───────────────────────────────────────────
	const [treeWidth, setTreeWidth] = useState(220);
	const treeWidthRef = useRef(220);
	treeWidthRef.current = treeWidth;
	const [sessionsWidth, setSessionsWidth] = useState(200);
	const sessionsWidthRef = useRef(200);
	sessionsWidthRef.current = sessionsWidth;

	const onTreeResizeStart = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = treeWidthRef.current;
		document.body.classList.add("resizing-col");
		const onMove = (ev: PointerEvent) => {
			setTreeWidth(Math.max(120, Math.min(400, startW + ev.clientX - startX)));
		};
		const onUp = () => {
			document.body.classList.remove("resizing-col");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, []);

	const onSessionsResizeStart = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = sessionsWidthRef.current;
		document.body.classList.add("resizing-col");
		const onMove = (ev: PointerEvent) => {
			// Handle is on the left edge of sessions → dragging left increases width
			setSessionsWidth(
				Math.max(120, Math.min(400, startW - (ev.clientX - startX))),
			);
		};
		const onUp = () => {
			document.body.classList.remove("resizing-col");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, []);

	// Gates SessionDashboard mount until workspace_set_root has completed (or failed).
	// This ensures workspace_get_sessions always uses the correct configured root,
	// not the compile-time fallback. React child effects (SessionDashboard) fire before
	// parent effects, so without this gate the first session fetch could race set_root.
	const [workspaceReady, setWorkspaceReady] = useState(false);
	// Tracks the root actually accepted by the backend. If workspace_set_root fails
	// (e.g. path does not exist), falls back to WORKSPACE_ROOT so the empty-state
	// message shown to the user matches what the backend actually scans.
	const [resolvedRoot, setResolvedRoot] = useState(activeWorkspaceRoot);

	// ── Auto-detect naia-adk root on mount ─────────────────────────────────
	useEffect(() => {
		if (activeWorkspaceRoot) return;
		let cancelled = false;
		(async () => {
			const detected = await detectAdkRoot();
			if (cancelled || !detected) return;
			const cfg = loadConfig();
			if (cfg) saveConfig({ ...cfg, workspaceRoot: detected });
			setActiveWorkspaceRoot(detected);
		})();
		return () => {
			cancelled = true;
		};
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// ── Set workspace root from config on mount ────────────────────────────
	useEffect(() => {
		if (!activeWorkspaceRoot) {
			setWorkspaceReady(true);
			return;
		}
		invoke<string>("workspace_set_root", { root: activeWorkspaceRoot })
			.then((canonical) => setResolvedRoot(canonical))
			.catch((e) => {
				Logger.warn("WorkspaceCenterPanel", "workspace_set_root failed", {
					error: String(e),
				});
				setResolvedRoot(WORKSPACE_ROOT);
				// Clear stale path so next launch doesn't hit the same failure
				const cfg = loadConfig();
				if (cfg) saveConfig({ ...cfg, workspaceRoot: undefined });
				setActiveWorkspaceRoot("");
			})
			.finally(() => setWorkspaceReady(true));
	}, [activeWorkspaceRoot]);

	// ── Restore last opened file after workspace is ready ────────────────
	const restoredRef = useRef(false);
	useEffect(() => {
		if (!workspaceReady || restoredRef.current) return;
		restoredRef.current = true;
		const last = loadLastFile();
		if (last) openFile(last);
	}, [workspaceReady]); // eslint-disable-line react-hooks/exhaustive-deps

	// ── Persist open file path + per-repo tracking ───────────────────────
	useEffect(() => {
		if (!openFilePath) return;
		saveLastFile(openFilePath);
		// Track per-repo: find which repo root this file belongs to
		// Simple heuristic — walk up from the file and match against workspace root children
		const norm = openFilePath.replace(/\\/g, "/");
		const rootNorm = resolvedRoot.replace(/\\/g, "/");
		if (norm.startsWith(rootNorm + "/")) {
			const rel = norm.slice(rootNorm.length + 1);
			const topDir = rel.split("/")[0];
			if (topDir) {
				saveRepoRecent(`${rootNorm}/${topDir}`, openFilePath);
			}
		}
	}, [openFilePath, resolvedRoot]);

	// ── Load project-index.yaml for classified dirs (P1-2) ──────────────────
	useEffect(() => {
		if (!resolvedRoot) return;
		let cancelled = false;
		(async () => {
			try {
				const index = await invoke<any>("workspace_load_project_index");
				if (cancelled) return;
				const dirs: ClassifiedDir[] = [];
				const sections = [
					{ key: "submodules", defaultCat: "project" },
					{ key: "local_projects", defaultCat: "project" },
				];
				for (const section of sections) {
					const items = index?.[section.key];
					if (!items || typeof items !== "object") continue;
					for (const [, entry] of Object.entries(
						items as Record<string, any>,
					)) {
						if (!entry?.path) continue;
						const typeToCat: Record<string, string> = {
							project: "project",
							docs: "docs",
							lib: "lib",
							reference: "reference",
						};
						const cat = typeToCat[entry.type] || section.defaultCat;
						let absPath = entry.path as string;
						if (absPath.startsWith("./") || absPath.startsWith(".\\")) {
							absPath = `${resolvedRoot.replace(/\\/g, "/")}/${absPath.slice(2)}`;
						}
						dirs.push({
							name: entry.description
								? entry.description
										.split("—")[0]
										.split("(")[0]
										.trim()
										.split(" ")
										.slice(0, 3)
										.join(" ")
								: absPath?.split("/").pop() || "",
							path: absPath,
							category: cat,
							visibility: entry.visibility,
							entryPoint: entry.rulesEntrypoint,
						});
					}
				}
				if (dirs.length > 0 && !cancelled) {
					setClassifiedDirs(dirs);
					saveClassifiedDirs(dirs);
				}
			} catch {
				// project-index.yaml not found — fall through to heuristic classification
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [resolvedRoot]);

	// ── Load persisted classification ─────────────────────────────────────
	useEffect(() => {
		const saved = loadClassifiedDirs();
		if (saved) {
			setClassifiedDirs(saved);
		} else {
			// First launch: trigger classification recommendation via Naia
			setClassifyPending(true);
		}
	}, []);

	// ── Phase 4: First-run classification recommendation ──────────────────
	useEffect(() => {
		if (!classifyPending) return;
		// Run classification and push recommendation via Naia context
		invoke<ClassifiedDir[]>("workspace_classify_dirs")
			.then((dirs) => {
				naia.pushContext({
					type: "workspace",
					data: {
						classificationRecommendation: dirs,
						message:
							"workspace_classify_dirs 결과입니다. skill_workspace_classify_dirs 도구를 통해 사용자에게 분류 추천을 보여주세요.",
					},
				});
				Logger.info(
					"WorkspaceCenterPanel",
					"Classification recommendation pushed",
					{ count: dirs.length },
				);
			})
			.catch((e) => {
				Logger.warn("WorkspaceCenterPanel", "Classification failed", {
					error: String(e),
				});
			})
			.finally(() => {
				setClassifyPending(false);
			});
	}, [classifyPending, naia]);

	// ── Sessions update ───────────────────────────────────────────────────
	const handleSessionsUpdate = useCallback(
		(updated: SessionInfo[]) => {
			sessionsRef.current = updated;
			setSessions(updated);
			if (!initializedRef.current) {
				initializedRef.current = true;
				setInitialized(true);
			}

			// Re-arm idle notification immediately when a session becomes active,
			// without waiting for the 10-second setInterval tick. This prevents
			// brief active periods (<10s) from being invisible to the notifier.
			for (const s of updated) {
				if (s.status === "active" || s.status === "idle") {
					idleNotifiedRef.current.delete(s.path);
					// Re-arm error notification on recovery — error → active/idle → error should re-notify
					errorNotifiedRef.current.delete(s.path);
				}
				// Proactive error notification — fires once per session per conversation
				if (s.status === "error" && !errorNotifiedRef.current.has(s.path)) {
					errorNotifiedRef.current.add(s.path);
					naia.pushContext({
						type: "workspace",
						data: {
							errorAlert: {
								dir: s.dir,
								message: `${s.dir} 세션에서 오류가 발생했습니다 (blockers 감지). 확인이 필요합니다.`,
							},
						},
					});
					Logger.warn("WorkspaceCenterPanel", "Error session detected", {
						dir: s.dir,
					});
				}
			}

			// Update Naia context with session state
			naia.pushContext({
				type: "workspace",
				data: {
					sessions: updated.map((s) => ({
						dir: s.dir,
						status: s.status,
						branch: s.branch ?? null,
						issue: s.progress?.issue ?? null,
						phase: s.progress?.phase ?? null,
						recentFile: s.recent_file ?? null,
						idleSince: s.last_change
							? Math.floor(Date.now() / 1000) - s.last_change
							: null,
					})),
				},
			});
		},
		[naia],
	);

	// ── Idle session notification ─────────────────────────────────────────
	useEffect(() => {
		const id = setInterval(() => {
			for (const session of sessionsRef.current) {
				if (session.status === "idle" && session.last_change) {
					const idleSec = Math.floor(Date.now() / 1000) - session.last_change;
					if (
						idleSec >= ACTIVE_THRESHOLD_SECONDS &&
						!idleNotifiedRef.current.has(session.path)
					) {
						idleNotifiedRef.current.add(session.path);
						const idleMin = Math.max(1, Math.floor(idleSec / 60));
						const alertMsg = `${session.dir} 세션이 ${idleMin}분째 입력을 기다리고 있어요`;
						// Visible toast in panel
						if (idleToastTimerRef.current)
							clearTimeout(idleToastTimerRef.current);
						setIdleToast(alertMsg);
						idleToastTimerRef.current = setTimeout(() => {
							setIdleToast(null);
							idleToastTimerRef.current = null;
						}, 6000);
						// Also push to Naia context for AI awareness
						naia.pushContext({
							type: "workspace",
							data: {
								idleAlert: {
									dir: session.dir,
									idleSeconds: idleSec,
									message: alertMsg,
								},
							},
						});
						Logger.info("WorkspaceCenterPanel", "Idle session alert", {
							dir: session.dir,
							idleSec,
						});
					}
				}
				// Active re-arm is handled in handleSessionsUpdate on every session
				// poll — no need to duplicate here every 10 seconds.
			}
		}, 10000);
		return () => {
			clearInterval(id);
			if (idleToastTimerRef.current) {
				clearTimeout(idleToastTimerRef.current);
				idleToastTimerRef.current = null;
			}
		};
	}, [naia]);

	// ── Clear idle state on new conversation ──────────────────────────────
	const sessionId = useChatStore((s) => s.sessionId);
	useEffect(() => {
		if (sessionId !== null) return;
		// newConversation() sets sessionId to null — user is starting fresh,
		// so dismiss any lingering idle toast and re-arm all notifications.
		// On initial mount sessionId is also null, but idleNotifiedRef is empty
		// and idleToast is null, so this is a no-op and causes no harm.
		idleNotifiedRef.current.clear();
		errorNotifiedRef.current.clear();
		setIdleToast(null);
		if (idleToastTimerRef.current) {
			clearTimeout(idleToastTimerRef.current);
			idleToastTimerRef.current = null;
		}
	}, [sessionId]);

	// ── Session card click → open recent file ─────────────────────────────
	const handleSessionClick = useCallback(
		async (session: SessionInfo) => {
			Logger.info("WorkspaceCenterPanel", "Session card clicked", {
				dir: session.dir,
			});

			// Badge from progress
			const badge =
				session.progress?.issue && session.progress?.phase
					? `${session.progress.issue} · ${session.progress.phase}`
					: "";
			setEditorBadge(badge);

			// Determine which file to open
			let fileToOpen = "";
			if (session.recent_file) {
				fileToOpen = `${session.path}/${session.recent_file}`;
			} else {
				// Fallback: AGENTS.md or README.md
				for (const fallback of ["AGENTS.md", "README.md"]) {
					const candidate = `${session.path}/${fallback}`;
					try {
						await invoke("workspace_read_file", { path: candidate });
						fileToOpen = candidate;
						break;
					} catch {
						// not found, try next
					}
				}
			}

			if (fileToOpen) {
				openFile(fileToOpen);
			}
		},
		[openFile],
	);

	// ── File select from tree ─────────────────────────────────────────────
	const handleFileSelect = useCallback(
		(path: string) => {
			openFile(path);
			// Clear badge when directly selecting a file
			setEditorBadge("");
		},
		[openFile],
	);

	// ── Dir expand → open per-repo recent file ──────────────────────────
	const handleDirExpand = useCallback(
		(dirPath: string) => {
			const recent = getRepoRecentFile(dirPath.replace(/\\/g, "/"));
			if (recent) openFile(recent);
		},
		[openFile],
	);

	/** Send a file path to the chat input via the naia:ask-ai custom event. */
	const handleSendToChat = useCallback((path: string) => {
		window.dispatchEvent(new CustomEvent("naia:ask-ai", { detail: path }));
	}, []);

	// ── Ctrl+P — Quick Open (only when workspace panel is active) ───────
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "p") {
				if (usePanelStore.getState().activePanel !== "workspace") return;
				e.preventDefault();
				setQuickOpenVisible((prev) => !prev);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);

	// ── Ctrl+R — Reload current document (prevent app refresh) ──────────
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "r") {
				e.preventDefault();
				editorRef.current?.reloadFile();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);

	// ── File navigation: back/forward (Ctrl+←/→, mouse buttons 3/4) ─────
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey)) return;
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				goBack();
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				goForward();
			}
		};
		const onMouseUp = (e: MouseEvent) => {
			if (e.button === 3) {
				e.preventDefault();
				goBack();
			} else if (e.button === 4) {
				e.preventDefault();
				goForward();
			}
		};
		// Bind mousedown as well to intercept WebKitGTK default back/forward
		// navigation before it triggers. mouseup alone may fire too late.
		const onMouseDown = (e: MouseEvent) => {
			if (e.button === 3 || e.button === 4) {
				e.preventDefault();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("mouseup", onMouseUp);
		window.addEventListener("mousedown", onMouseDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("mouseup", onMouseUp);
			window.removeEventListener("mousedown", onMouseDown);
		};
	}, [goBack, goForward]);

	// Hide Chrome X11 embed while Quick Open overlay is visible
	useEffect(() => {
		if (quickOpenVisible) {
			const { pushModal, popModal } = usePanelStore.getState();
			pushModal();
			return () => popModal();
		}
	}, [quickOpenVisible]);

	// ── Panel API (WorkspacePanelApi) ─────────────────────────────────────
	// Register a live API so other panels (e.g. Issue Desk) can call
	// openFile / focusSession without importing internal component modules.
	useEffect(() => {
		panelRegistry.updateApi("workspace", {
			openFile: (path: string) => {
				openFile(path);
				setEditorBadge("");
			},
			focusSession: (dir: string) => {
				if (!sessionsRef.current.some((s) => s.dir === dir)) {
					Logger.warn("WorkspaceCenterPanel", "focusSession: dir not found", {
						dir,
					});
					return;
				}
				startHighlight(dir);
			},
			getActiveSessions: () => sessionsRef.current,
			activatePanel: () => usePanelStore.getState().setActivePanel("workspace"),
		} satisfies WorkspacePanelApi);
		return () => {
			panelRegistry.updateApi("workspace", undefined);
			// Cancel pending highlight timer on unmount to avoid setState after unmount
			if (highlightTimerRef.current) {
				clearTimeout(highlightTimerRef.current);
				highlightTimerRef.current = null;
			}
		};
	}, [startHighlight]); // stable: setters and refs never change (startHighlight is useCallback([]))

	// ── Naia tool: skill_workspace_get_sessions ───────────────────────────
	useEffect(() => {
		const unsub = naia.onToolCall("skill_workspace_get_sessions", () => {
			const currentSessions = sessionsRef.current;
			const counts = { active: 0, idle: 0, stopped: 0, error: 0 };
			for (const s of currentSessions) {
				const key = s.status as keyof typeof counts;
				if (key in counts) counts[key]++;
			}
			// Build natural-language description for "내가 뭐 하고 있어?" queries
			const activeDetails = currentSessions
				.filter((s) => s.status === "active")
				.map((s) => {
					const issue = s.progress?.issue ? ` (${s.progress.issue})` : "";
					const branch = s.branch ? ` [${s.branch}]` : "";
					return `${s.dir}${branch}${issue}`;
				});
			const parts: string[] = [];
			if (counts.active > 0)
				parts.push(`active ${counts.active}개: ${activeDetails.join(", ")}`);
			if (counts.idle > 0) parts.push(`idle ${counts.idle}개`);
			if (counts.stopped > 0) parts.push(`stopped ${counts.stopped}개`);
			if (counts.error > 0) parts.push(`error ${counts.error}개`);
			const description = parts.length > 0 ? parts.join(", ") : "세션 없음";
			return JSON.stringify({
				sessions: currentSessions,
				summary: {
					total: counts.active + counts.idle + counts.stopped + counts.error,
					active: counts.active,
					idle: counts.idle,
					stopped: counts.stopped,
					error: counts.error,
					description,
				},
			});
		});
		return unsub;
	}, [naia]);

	// ── Naia tool: skill_workspace_open_file ─────────────────────────────
	useEffect(() => {
		const unsub = naia.onToolCall("skill_workspace_open_file", (args) => {
			const path = String(args.path ?? "");
			if (!path) return "Error: path is required";
			openFile(path);
			setEditorBadge("");
			return `Opened: ${path}`;
		});
		return unsub;
	}, [naia]);

	// ── Naia tool: skill_workspace_classify_dirs ─────────────────────────
	useEffect(() => {
		const unsub = naia.onToolCall(
			"skill_workspace_classify_dirs",
			async (args) => {
				// If dirs provided in args, apply them (user confirmed)
				const confirmed = args.confirmed as ClassifiedDir[] | undefined;
				if (confirmed && Array.isArray(confirmed)) {
					setClassifiedDirs(confirmed);
					saveClassifiedDirs(confirmed);
					// Also persist to config
					const cfg = loadConfig();
					if (cfg) {
						saveConfig({ ...cfg });
					}
					return `Classification applied: ${confirmed.length} directories`;
				}
				// Otherwise run classification and return recommendation
				try {
					const dirs = await invoke<ClassifiedDir[]>("workspace_classify_dirs");
					return JSON.stringify(dirs);
				} catch (e) {
					return `Error: ${String(e)}`;
				}
			},
		);
		return unsub;
	}, [naia]);

	// ── Terminal: close (user-initiated) ─────────────────────────────────
	const handleCloseTerminal = useCallback((pty_id: string) => {
		// pty_kill is fire-and-forget. On failure, the OS process may stay alive, but
		// we still remove the dir from openDirsRef so the user can re-open the same dir.
		// Trade-off: in the rare case pty_kill fails and the process survives, a second
		// spawn creates two PTYs for the same dir. Keeping the dir blocked on kill failure
		// would be worse UX (permanent lockout until app restart).
		invoke("pty_kill", { pty_id }).catch((e) => {
			Logger.warn("WorkspaceCenterPanel", "pty_kill failed", {
				error: String(e),
			});
		});
		// terminalsRef.current is updated synchronously in the render body, NOT on
		// setTerminals(). So even if handleTerminalExit already queued a setTerminals(),
		// terminalsRef still holds the current (pre-render) tabs here — find() is safe.
		const tab = terminalsRef.current.find((t) => t.pty_id === pty_id);
		if (tab) openDirsRef.current.delete(tab.dir);
		// React 18 automatic batching: these two setStates are committed in a single
		// render pass, so there is no intermediate frame where terminals is empty
		// but activeTab still holds the old pty_id.
		setTerminals((prev) => prev.filter((t) => t.pty_id !== pty_id));
		setActiveTab((prev) => (prev === pty_id ? "editor" : prev));
	}, []);

	// ── Terminal: exit (process-initiated) ───────────────────────────────
	const handleTerminalExit = useCallback((pty_id: string) => {
		// Same terminalsRef timing guarantee as handleCloseTerminal above.
		const tab = terminalsRef.current.find((t) => t.pty_id === pty_id);
		if (tab) openDirsRef.current.delete(tab.dir);
		setTerminals((prev) => prev.filter((t) => t.pty_id !== pty_id));
		setActiveTab((prev) => (prev === pty_id ? "editor" : prev));
	}, []);

	// ── Naia tool: skill_workspace_new_session ────────────────────────────
	useEffect(() => {
		const unsub = naia.onToolCall(
			"skill_workspace_new_session",
			async (args) => {
				// Normalize trailing slash so "/path/" and "/path" map to the same openDirsRef key.
				const dir = String(args.dir ?? "").replace(/\/+$/, "");
				if (!dir) return "Error: dir is required";
				if (!dir.startsWith("/") && !/^[a-zA-Z]:[/\\]/.test(dir))
					return "Error: dir must be an absolute path";
				// openDirsRef tracks both committed AND in-flight dirs. Add BEFORE the
				// await so concurrent calls for the same dir are blocked immediately —
				// before any state update and before React renders. Only delete on
				// failure; on success the entry stays until the tab is closed.
				if (openDirsRef.current.has(dir)) {
					const existing = terminalsRef.current.find((t) => t.dir === dir);
					if (existing) {
						setActiveTab(existing.pty_id);
						usePanelStore.getState().setActivePanel("workspace");
						return `Already open: ${dir}, pid: ${existing.pid}`;
					}
					// openDirsRef has the dir but terminalsRef doesn't yet — pty_create
					// is in-flight for this dir. Do NOT delete from openDirsRef here;
					// the in-flight call will either add the tab (success) or delete
					// from openDirsRef itself (catch). No permanent lock.
					return "Error: terminal creation already in progress for this dir";
				}
				openDirsRef.current.add(dir);
				try {
					const result = await invoke<{ pty_id: string; pid: number }>(
						"pty_create",
						{
							dir,
							command: navigator.userAgent.includes("Windows")
								? "powershell"
								: "bash",
							rows: 24,
							cols: 80,
						},
					);
					// React 18 batching: setTerminals + setActiveTab committed in one render
					// — no intermediate frame where activeTab === pty_id but terminals is
					// still empty (same guarantee as in handleCloseTerminal).
					setTerminals((prev) => [
						...prev,
						{ pty_id: result.pty_id, dir, pid: result.pid },
					]);
					setActiveTab(result.pty_id);
					usePanelStore.getState().setActivePanel("workspace");
					return `Started: ${dir}, pid: ${result.pid}`;
				} catch (e) {
					openDirsRef.current.delete(dir);
					return `Error: ${String(e)}`;
				}
			},
		);
		return unsub;
	}, [naia]);

	// ── Naia tool: skill_workspace_focus_session ──────────────────────────
	useEffect(() => {
		const unsub = naia.onToolCall("skill_workspace_focus_session", (args) => {
			const dir = String(args.dir ?? "");
			if (!dir) return "Error: dir is required";
			const session = sessionsRef.current.find((s) => s.dir === dir);
			if (!session) return `Error: session not found: ${dir}`;

			// Activate workspace panel
			usePanelStore.getState().setActivePanel("workspace");
			startHighlight(dir);

			// Optionally open recent file
			let openedFile: string | null = null;
			if (args.open_recent_file === true) {
				if (session.recent_file) {
					const fullPath = `${session.path}/${session.recent_file}`;
					openFile(fullPath);
					setEditorBadge(
						session.progress?.issue && session.progress?.phase
							? `${session.progress.issue} · ${session.progress.phase}`
							: "",
					);
					openedFile = fullPath;
				} else {
					// No recent_file — clear stale badge consistent with skill_workspace_open_file
					setEditorBadge("");
				}
			}

			return openedFile
				? `Focused: ${dir}, opened: ${openedFile}`
				: `Focused: ${dir}`;
		});
		return unsub;
	}, [naia, startHighlight]); // startHighlight is stable (useCallback([]))

	// ── Naia tool: skill_workspace_send_to_session ────────────────────────
	useEffect(() => {
		const unsub = naia.onToolCall(
			"skill_workspace_send_to_session",
			async (args) => {
				const dir = String(args.dir ?? "");
				const text = String(args.text ?? "");
				if (!dir || !text) return "Error: dir and text are required";
				const tab = terminalsRef.current.find((t) => t.dir === dir);
				if (!tab) return `Error: no PTY session for: ${dir}`;
				try {
					await invoke("pty_write", { pty_id: tab.pty_id, data: text });
					return `Sent to: ${dir}`;
				} catch (e) {
					return `Error: pty_write failed: ${String(e)}`;
				}
			},
		);
		return unsub;
	}, [naia]);

	// ── Active session dirs (for FileTree highlighting) ───────────────────
	const activeDirs = sessions
		.filter((s) => {
			if (s.status !== "active") return false;
			if (!s.last_change) return false;
			return (
				Math.floor(Date.now() / 1000) - s.last_change < ACTIVE_THRESHOLD_SECONDS
			);
		})
		.map((s) => s.path);

	// ── Read-only: reference repos (ref-*) ────────────────────────────────
	const editorReadOnly = openFilePath
		? openFilePath.split("/").some((part) => part.startsWith("ref-"))
		: false;

	// No workspace root configured — direct user to settings
	if (!activeWorkspaceRoot) {
		return (
			<div
				className="workspace-panel"
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					flexDirection: "column",
					gap: "0.75rem",
					padding: "2rem",
				}}
			>
				<p style={{ opacity: 0.7, textAlign: "center", margin: 0 }}>
					워크스페이스 경로가 설정되지 않았습니다.
					<br />
					설정 → 워크스페이스(naia-adk)에서 경로를 지정해 주세요.
				</p>
			</div>
		);
	}

	return (
		<div className="workspace-panel">
			{/* Initial loading overlay — hides blank flash before first session fetch */}
			{!initialized && (
				<div className="workspace-panel__loading">
					<span className="workspace-panel__loading-spinner" />
					<span>워크스페이스 로딩 중…</span>
				</div>
			)}
			{/* Idle session toast (F8) */}
			{idleToast && (
				<div
					className="workspace-panel__idle-toast"
					onClick={() => setIdleToast(null)}
					role="alert"
				>
					🟡 {idleToast}
				</div>
			)}

			{/* Left: FileTree */}
			<div
				className="workspace-panel__tree"
				style={{ width: `${treeWidth}px` }}
			>
				<div className="workspace-panel__tree-header">
					<span className="workspace-panel__tree-title">탐색기</span>
				</div>
				<div className="workspace-panel__tree-body">
					{workspaceReady ? (
						<FileTree
							onFileSelect={handleFileSelect}
							onDirExpand={handleDirExpand}
							openFilePath={openFilePath}
							activeDirs={activeDirs}
							classifiedDirs={classifiedDirs ?? undefined}
							workspaceRoot={resolvedRoot}
							onSendToChat={handleSendToChat}
						/>
					) : (
						<div className="workspace-panel__tree-loading">
							<span className="workspace-panel__tree-loading-text">
								워크스페이스 준비 중…
							</span>
						</div>
					)}
				</div>
				<div className="workspace-panel__tree-divider" />
				<SkillLauncher />
			</div>
			<div
				className="workspace-panel__resize-handle"
				onPointerDown={onTreeResizeStart}
			/>

			{/* Center: Editor / Terminal tabs */}
			<div className="workspace-panel__center">
				{terminals.length > 0 && (
					<div className="workspace-panel__tab-bar" role="tablist">
						<div
							role="tab"
							tabIndex={0}
							aria-selected={activeTab === "editor"}
							className={`workspace-panel__tab${activeTab === "editor" ? " workspace-panel__tab--active" : ""}`}
							onClick={() => setActiveTab("editor")}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") setActiveTab("editor");
							}}
						>
							에디터
						</div>
						{terminals.map((t) => (
							<div
								key={t.pty_id}
								role="tab"
								tabIndex={0}
								aria-selected={activeTab === t.pty_id}
								className={`workspace-panel__tab${activeTab === t.pty_id ? " workspace-panel__tab--active" : ""}`}
								onClick={() => setActiveTab(t.pty_id)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ")
										setActiveTab(t.pty_id);
								}}
							>
								<span className="workspace-panel__tab-label">
									{t.dir.split(/[/\\]/).pop() ?? t.dir}
								</span>
								<button
									type="button"
									aria-label={`터미널 닫기: ${t.dir}`}
									className="workspace-panel__tab-close"
									onClick={(e) => {
										e.stopPropagation();
										handleCloseTerminal(t.pty_id);
									}}
								>
									×
								</button>
							</div>
						))}
					</div>
				)}
				<div className="workspace-panel__center-content">
					<div
						className="workspace-panel__editor-slot"
						style={
							activeTab !== "editor"
								? { opacity: 0, pointerEvents: "none" }
								: undefined
						}
					>
						<Editor
							ref={editorRef}
							filePath={openFilePath}
							badge={editorBadge}
							readOnly={editorReadOnly}
						/>
					</div>
					{terminals.map((t) => (
						<Terminal
							key={t.pty_id}
							pty_id={t.pty_id}
							active={activeTab === t.pty_id}
							onExit={handleTerminalExit}
						/>
					))}
				</div>
			</div>
			<div
				className="workspace-panel__resize-handle"
				onPointerDown={onSessionsResizeStart}
			/>

			{/* Right: Session sidebar (vertical card list) */}
			<div
				className="workspace-panel__sessions"
				style={{ width: `${sessionsWidth}px` }}
			>
				{workspaceReady && (
					<SessionDashboard
						onSessionClick={handleSessionClick}
						onSessionsUpdate={handleSessionsUpdate}
						highlightedDir={highlightedSessionDir ?? undefined}
						workspaceRoot={resolvedRoot}
					/>
				)}
			</div>
			{quickOpenVisible && (
				<QuickOpen
					workspaceRoot={resolvedRoot}
					onSelect={(path) => {
						openFile(path);
						setEditorBadge("");
						setActiveTab("editor");
					}}
					onClose={() => setQuickOpenVisible(false)}
				/>
			)}
		</div>
	);
}
