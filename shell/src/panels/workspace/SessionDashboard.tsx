import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logger } from "../../lib/logger";
import { SessionCard, type SessionInfo } from "./SessionCard";
import { WorktreeGroup } from "./WorktreeGroup";
import { WORKSPACE_ROOT } from "./constants";

interface SessionDashboardProps {
	onSessionClick: (session: SessionInfo) => void;
	/** Callback to expose current session list to parent */
	onSessionsUpdate?: (sessions: SessionInfo[]) => void;
	/** Dir identifier of the session to visually highlight (from Panel API focusSession) */
	highlightedDir?: string;
	/** Actual workspace root (runtime override or compile-time fallback). Used in empty state display. */
	workspaceRoot?: string;
}

export function SessionDashboard({
	onSessionClick,
	onSessionsUpdate,
	highlightedDir,
	workspaceRoot = WORKSPACE_ROOT,
}: SessionDashboardProps) {
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const onSessionsUpdateRef = useRef(onSessionsUpdate);
	onSessionsUpdateRef.current = onSessionsUpdate;
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const gridRef = useRef<HTMLDivElement>(null);
	// Monotonically increasing ID — prevents stale invoke responses from overwriting
	// a fresher result when multiple loadSessions calls are in-flight simultaneously.
	const fetchIdRef = useRef(0);
	// Tracks whether at least one successful load has completed — used to decide
	// whether to notify the parent on error (first failure) vs. stay silent (retry failure).
	const hasLoadedOnceRef = useRef(false);

	const loadSessions = useCallback(async () => {
		const id = ++fetchIdRef.current;
		const _ts0 = Date.now();
		Logger.info("SessionDashboard", "workspace_get_sessions start", { id });
		try {
			const result = await invoke<SessionInfo[]>("workspace_get_sessions");
			if (id !== fetchIdRef.current) return; // stale response — discard
			Logger.info("SessionDashboard", "workspace_get_sessions ok", { id, count: result.length, ms: Date.now() - _ts0 });
			setSessions(result);
			hasLoadedOnceRef.current = true;
			onSessionsUpdateRef.current?.(result);
		} catch (e) {
			if (id !== fetchIdRef.current) return;
			Logger.warn("SessionDashboard", "workspace_get_sessions failed", {
				error: String(e),
				ms: Date.now() - _ts0,
			});
			// On first-ever failure: notify parent with [] so the parent's
			// initialized state unblocks (avoids permanent loading overlay).
			// On retry failures: stay silent — parent retains last-known session list.
			if (!hasLoadedOnceRef.current) {
				onSessionsUpdateRef.current?.([]);
			}
		} finally {
			if (id === fetchIdRef.current) setLoading(false);
		}
	}, []); // stable: depends only on stable refs and setState

	const debouncedLoadSessions = useCallback(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => void loadSessions(), 300);
	}, [loadSessions]);

	useEffect(() => {
		void loadSessions();

		// Listen for file change events — debounced to coalesce rapid bursts
		// (e.g. git checkout rewriting many files at once).
		const unlistenPromise = listen<{
			session: string;
			file: string;
			timestamp: number;
		}>("workspace:file-changed", () => {
			debouncedLoadSessions();
		});

		// Periodic refresh every 15s for status re-computation
		const intervalId = setInterval(() => void loadSessions(), 15000);

		return () => {
			unlistenPromise.then((fn) => fn()).catch(() => {});
			clearInterval(intervalId);
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [loadSessions, debouncedLoadSessions]);

	// Scroll highlighted session card into view whenever highlightedDir changes
	useEffect(() => {
		if (!highlightedDir || !gridRef.current) return;
		const card = gridRef.current.querySelector<HTMLElement>(
			`[data-dir="${CSS.escape(highlightedDir)}"]`,
		);
		card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, [highlightedDir]);

	if (loading) {
		return (
			<div className="workspace-dashboard workspace-dashboard--loading">
				세션 스캔 중…
			</div>
		);
	}

	if (sessions.length === 0) {
		return (
			<div className="workspace-dashboard workspace-dashboard--empty">
				<div className="workspace-dashboard__empty-hint">
					Git 레포가 없습니다.{" "}
					<span className="workspace-dashboard__empty-path">
						{workspaceRoot}
					</span>
					에 git 레포가 있어야 합니다.
				</div>
			</div>
		);
	}

	return (
		<div className="workspace-dashboard">
			<div className="workspace-dashboard__header">
				<span className="workspace-dashboard__title">
					세션 ({sessions.length})
				</span>
				<button
					type="button"
					className="workspace-dashboard__refresh"
					onClick={() => void loadSessions()}
					title="새로고침"
				>
					↻
				</button>
			</div>
			<div className="workspace-dashboard__grid" ref={gridRef}>
				{renderGrouped(sessions, onSessionClick, highlightedDir)}
			</div>
		</div>
	);
}

/**
 * Group sessions by their main-repo key (origin_path ?? path), then render:
 * - group size > 1  → WorktreeGroup (collapsible)
 * - group size == 1 → standalone SessionCard
 */
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
