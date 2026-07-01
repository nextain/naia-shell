import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logger } from "../../lib/logger";
import { SessionCard, type SessionInfo } from "./SessionCard";
import { WorktreeGroup } from "./WorktreeGroup";
import { WORKSPACE_ROOT } from "./constants";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GithubIssue {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED";
	labels: { name: string; color: string }[];
	updatedAt: string;
}

type FetchState = "loading" | "ok" | "no-gh" | "error";

interface IssuesAreaProps {
	/** Called when a session card is clicked (open recent file) */
	onSessionClick: (session: SessionInfo) => void;
	/** Exposes current session list to parent for Naia context push */
	onSessionsUpdate?: (sessions: SessionInfo[]) => void;
	/** Dir of session to visually highlight */
	highlightedDir?: string;
	/** Workspace root path */
	workspaceRoot?: string;
	/** Called when user clicks an issue — sends context to Naia chat */
	onIssueClick?: (issue: GithubIssue) => void;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_KEY = "workspace-issues-cache";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface IssuesCache {
	issues: GithubIssue[];
	fetchedAt: number;
}

function loadCache(): GithubIssue[] | null {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const cache = JSON.parse(raw) as IssuesCache;
		if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) return null;
		return cache.issues;
	} catch {
		return null;
	}
}

function saveCache(issues: GithubIssue[]): void {
	try {
		const cache: IssuesCache = { issues, fetchedAt: Date.now() };
		localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
	} catch {}
}

function clearCache(): void {
	try {
		localStorage.removeItem(CACHE_KEY);
	} catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	return `${Math.floor(hrs / 24)}d`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function IssuesArea({
	onSessionClick,
	onSessionsUpdate,
	highlightedDir,
	workspaceRoot = WORKSPACE_ROOT,
	onIssueClick,
}: IssuesAreaProps) {
	const [issues, setIssues] = useState<GithubIssue[]>([]);
	const [fetchState, setFetchState] = useState<FetchState>("loading");
	const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
	const fetchIdRef = useRef(0);
	// Vertical drag-resize: issues list ↕ sessions section
	const [issuesListHeight, setIssuesListHeight] = useState(180);
	const issuesListHeightRef = useRef(180);
	issuesListHeightRef.current = issuesListHeight;
	const issuesPanelRef = useRef<HTMLDivElement>(null);
	const onIssuesSectionResizeStart = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		const startY = e.clientY;
		const startH = issuesListHeightRef.current;
		document.body.classList.add("resizing-row");
		const onMove = (ev: PointerEvent) => {
			setIssuesListHeight(Math.max(60, Math.min(500, startH + (ev.clientY - startY))));
		};
		const onUp = () => {
			document.body.classList.remove("resizing-row");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}, []);
	// Ref so fetchIssues closure always reads the latest workspaceRoot without
	// being recreated on every path-normalization change (which would re-trigger
	// the useEffect and restart "loading" in a loop).
	const workspaceRootRef = useRef(workspaceRoot);
	workspaceRootRef.current = workspaceRoot;

	const fetchIssues = useCallback(
		async (bust = false) => {
			if (bust) clearCache();

			// Serve from cache if fresh
			const cached = loadCache();
			if (cached && !bust) {
				setIssues(cached);
				setFetchState("ok");
				return;
			}

			const id = ++fetchIdRef.current;
			setFetchState("loading");

			// JS-side 20 s timeout — guards against pty_execute_sync hanging on
			// Windows (ConPTY does not honour SIGKILL so Rust timeout may not fire).
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("timeout")), 20_000),
			);

			try {
				const result = await Promise.race([
					invoke<{
						success: boolean;
						output: string;
						exit_code: number;
					}>("pty_execute_sync", {
						dir: workspaceRootRef.current || ".",
						command:
							"gh issue list --state open --limit 50 --json number,title,state,labels,updatedAt",
						timeout_secs: 15,
					}),
					timeoutPromise,
				]);

				if (id !== fetchIdRef.current) return;

				if (!result.success || result.exit_code !== 0) {
					// gh not installed or not authenticated
					const out = result.output.toLowerCase();
					if (
						out.includes("not found") ||
						out.includes("command not found") ||
						out.includes("'gh'") ||
						result.exit_code === 127
					) {
						setFetchState("no-gh");
					} else {
						setFetchState("error");
					}
					Logger.warn("IssuesArea", "gh issue list failed", {
						exit_code: result.exit_code,
						output: result.output.slice(0, 200),
					});
					return;
				}

				const parsed = JSON.parse(result.output) as GithubIssue[];
				saveCache(parsed);
				setIssues(parsed);
				setFetchState("ok");
				Logger.info("IssuesArea", "Issues loaded", { count: parsed.length });
			} catch (e) {
				if (id !== fetchIdRef.current) return;
				const msg = String(e).toLowerCase();
				if (
					msg.includes("timeout") ||
					msg.includes("not found") ||
					msg.includes("no such file") ||
					msg.includes("pty_execute_sync")
				) {
					setFetchState("no-gh");
				} else {
					setFetchState("error");
				}
				Logger.warn("IssuesArea", "fetchIssues error", { error: String(e) });
			}
		},
		[], // stable — reads workspaceRoot via ref, never recreated on prop change
	);

	// Initial load on mount
	useEffect(() => {
		void fetchIssues();
	}, [fetchIssues]);

	// Re-fetch when workspaceRoot meaningfully changes (non-empty, different value).
	// Using a separate effect so fetchIssues stays stable and does not cause
	// the above effect to re-run on every path-normalization render cycle.
	const prevRootRef = useRef(workspaceRoot);
	useEffect(() => {
		if (!workspaceRoot) return;
		if (workspaceRoot === prevRootRef.current) return;
		prevRootRef.current = workspaceRoot;
		// bust=false: use cache if fresh (avoids redundant gh call)
		void fetchIssues();
	}, [workspaceRoot, fetchIssues]);

	// ── Render states ──────────────────────────────────────────────────────────

	const renderIssuesBody = () => {
		if (fetchState === "loading") {
			return (
				<div className="issues-panel__empty">
					<span className="issues-panel__spinner" />
					<span>이슈 불러오는 중…</span>
				</div>
			);
		}

		if (fetchState === "no-gh") {
			return (
				<div className="issues-panel__empty issues-panel__empty--warn">
					<div className="issues-panel__empty-title">GitHub CLI 필요</div>
					<div className="issues-panel__empty-desc">
						<code>gh</code> CLI를 설치하고 <code>gh auth login</code>을
						실행하면 이슈 목록이 표시됩니다.
					</div>
				</div>
			);
		}

		if (fetchState === "error") {
			return (
				<div className="issues-panel__empty issues-panel__empty--warn">
					<div className="issues-panel__empty-title">불러오기 실패</div>
					<button
						type="button"
						className="issues-panel__retry"
						onClick={() => void fetchIssues(true)}
					>
						다시 시도
					</button>
				</div>
			);
		}

		if (issues.length === 0) {
			return (
				<div className="issues-panel__empty">
					열린 이슈가 없습니다
				</div>
			);
		}

		return issues.map((issue) => (
			<button
				key={issue.number}
				type="button"
				className="issues-panel__card"
				onClick={() => onIssueClick?.(issue)}
				title={issue.title}
			>
				<div className="issues-panel__card-top">
					<span className="issues-panel__card-number">#{issue.number}</span>
					<span className="issues-panel__card-age">
						{relativeTime(issue.updatedAt)}
					</span>
				</div>
				<div className="issues-panel__card-title">{issue.title}</div>
				{issue.labels.length > 0 && (
					<div className="issues-panel__card-labels">
						{issue.labels.slice(0, 3).map((l) => (
							<span
								key={l.name}
								className="issues-panel__card-label"
								style={{ borderColor: `#${l.color}`, color: `#${l.color}` }}
							>
								{l.name}
							</span>
						))}
					</div>
				)}
			</button>
		));
	};

	return (
		<div className="issues-panel" ref={issuesPanelRef}>
			{/* ── Issues section ───────────────────────────────────────────── */}
			<div className="issues-panel__section-header">
				<span className="issues-panel__section-title">열린 이슈</span>
				<button
					type="button"
					className="issues-panel__refresh"
					title="새로고침"
					onClick={() => void fetchIssues(true)}
				>
					↺
				</button>
			</div>
			<div
				className="issues-panel__list"
				style={{ height: `${issuesListHeight}px`, flex: "none" }}
			>
				{renderIssuesBody()}
			</div>

			{/* ── Drag handle between issues and sessions ───────────────────── */}
			<div
				className="workspace-panel__row-resize-handle"
				onPointerDown={onIssuesSectionResizeStart}
			/>

			{/* ── Sessions section (collapsible) ───────────────────────────── */}
			<button
				type="button"
				className="issues-panel__section-header issues-panel__section-header--toggle"
				onClick={() => setSessionsCollapsed((v) => !v)}
			>
				<span className="issues-panel__section-title">
					{sessionsCollapsed ? "▶" : "▼"} 에이전트 세션
				</span>
			</button>
			{!sessionsCollapsed && (
				<div className="issues-panel__sessions">
					<SessionDashboardInline
						onSessionClick={onSessionClick}
						onSessionsUpdate={onSessionsUpdate}
						highlightedDir={highlightedDir}
						workspaceRoot={workspaceRoot}
					/>
				</div>
			)}
		</div>
	);
}

// ─── Inline session list (reuses SessionCard, replaces SessionDashboard) ──────
// Keeps SessionDashboard's data-fetch logic but rendered inside IssuesArea.

interface SessionDashboardInlineProps {
	onSessionClick: (session: SessionInfo) => void;
	onSessionsUpdate?: (sessions: SessionInfo[]) => void;
	highlightedDir?: string;
	workspaceRoot?: string;
}

function SessionDashboardInline({
	onSessionClick,
	onSessionsUpdate,
	highlightedDir,
	workspaceRoot = WORKSPACE_ROOT,
}: SessionDashboardInlineProps) {
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const onSessionsUpdateRef = useRef(onSessionsUpdate);
	onSessionsUpdateRef.current = onSessionsUpdate;
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const fetchIdRef = useRef(0);
	const hasLoadedRef = useRef(false);

	const loadSessions = useCallback(async () => {
		const id = ++fetchIdRef.current;
		try {
			const result = await invoke<SessionInfo[]>("workspace_get_sessions");
			if (id !== fetchIdRef.current) return;
			setSessions(result);
			hasLoadedRef.current = true;
			onSessionsUpdateRef.current?.(result);
		} catch (e) {
			if (id !== fetchIdRef.current) return;
			Logger.warn("SessionDashboardInline", "load failed", { error: String(e) });
		} finally {
			if (id === fetchIdRef.current) setLoading(false);
		}
	}, []);

	const debouncedLoad = useCallback(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => void loadSessions(), 300);
	}, [loadSessions]);

	useEffect(() => {
		void loadSessions();
		const interval = setInterval(() => void loadSessions(), 15000);
		const unlistenPromise = listen("workspace:file-changed", debouncedLoad);
		return () => {
			clearInterval(interval);
			unlistenPromise.then((fn) => fn()).catch(() => {});
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [loadSessions, debouncedLoad]);

	if (loading && !hasLoadedRef.current) {
		return (
			<div className="issues-panel__sessions-loading">세션 로딩 중…</div>
		);
	}

	if (sessions.length === 0) {
		return (
			<div className="issues-panel__sessions-empty">
				{workspaceRoot
					? "실행 중인 Claude Code 세션 없음"
					: "워크스페이스 경로를 설정해 주세요"}
			</div>
		);
	}

	return <>{renderGrouped(sessions, onSessionClick, highlightedDir)}</>;
}

function renderGrouped(
	sessions: SessionInfo[],
	onSessionClick: (s: SessionInfo) => void,
	highlightedDir?: string,
): React.ReactNode {
	const groupMap = new Map<string, SessionInfo[]>();
	for (const session of sessions) {
		const key = session.origin_path ?? session.path;
		const bucket = groupMap.get(key);
		if (bucket) {
			bucket.push(session);
		} else {
			groupMap.set(key, [session]);
		}
	}
	return [...groupMap.entries()].map(([key, group]) => {
		if (group.length > 1) {
			const repoName =
				key.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? key;
			return (
				<WorktreeGroup
					key={key}
					repoName={repoName}
					sessions={group}
					onSessionClick={onSessionClick}
					highlightedDir={highlightedDir}
				/>
			);
		}
		return (
			<SessionCard
				key={group[0].path}
				session={group[0]}
				onClick={onSessionClick}
				highlighted={group[0].dir === highlightedDir}
			/>
		);
	});
}
