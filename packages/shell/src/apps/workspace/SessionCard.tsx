import { useEffect, useState } from "react";

export interface SessionInfo {
	dir: string;
	path: string;
	branch?: string | null;
	/** Main worktree absolute path when this session is a linked git worktree; null/undefined if main. */
	origin_path?: string | null;
	status: "active" | "idle" | "stopped" | "error";
	progress?: {
		issue?: string | null;
		phase?: string | null;
		title?: string | null;
	} | null;
	recent_file?: string | null;
	last_change?: number | null; // Unix timestamp seconds
}

interface SessionCardProps {
	session: SessionInfo;
	onClick: (session: SessionInfo) => void;
	/** Highlight this card (triggered by Panel API focusSession) */
	highlighted?: boolean;
}

const STATUS_ICONS: Record<string, string> = {
	active: "🟢",
	idle: "🟡",
	error: "🔴",
	stopped: "⚫",
};

const STATUS_LABELS: Record<string, string> = {
	active: "활성",
	idle: "대기",
	error: "오류",
	stopped: "중단",
};

function useRelativeTime(timestamp: number | null | undefined): string {
	const [label, setLabel] = useState("");

	useEffect(() => {
		if (!timestamp) {
			setLabel("");
			return;
		}
		function compute() {
			if (!timestamp) return;
			const diffSec = Math.floor(Date.now() / 1000) - timestamp;
			if (diffSec < 10) {
				setLabel("방금 전");
			} else if (diffSec < 60) {
				setLabel(`${diffSec}초 전`);
			} else if (diffSec < 3600) {
				setLabel(`${Math.floor(diffSec / 60)}분 전`);
			} else {
				setLabel(`${Math.floor(diffSec / 3600)}시간 전`);
			}
		}
		compute();
		const id = setInterval(compute, 10000);
		return () => clearInterval(id);
	}, [timestamp]);

	return label;
}

export function SessionCard({
	session,
	onClick,
	highlighted,
}: SessionCardProps) {
	const relTime = useRelativeTime(session.last_change);
	const statusIcon = STATUS_ICONS[session.status] ?? "⚫";
	const statusLabel = STATUS_LABELS[session.status] ?? session.status;

	const issuePhase =
		session.progress?.issue && session.progress?.phase
			? `${session.progress.issue} · ${session.progress.phase}`
			: (session.progress?.issue ?? null);

	return (
		<button
			type="button"
			className={`workspace-session-card workspace-session-card--${session.status}${highlighted ? " workspace-session-card--highlighted" : ""}`}
			onClick={() => onClick(session)}
			title={`${session.dir}\n${session.path}`}
			data-dir={session.dir}
		>
			<div className="workspace-session-card__header">
				<span className="workspace-session-card__status-icon">
					{statusIcon}
				</span>
				<span className="workspace-session-card__dir">{session.dir}</span>
				<span className="workspace-session-card__status-label">
					{statusLabel}
				</span>
			</div>
			{session.branch && (
				<div className="workspace-session-card__branch" title="Git branch">
					<span className="workspace-session-card__branch-icon">⎇</span>
					<span className="workspace-session-card__branch-name">
						{session.branch}
					</span>
				</div>
			)}
			{issuePhase && (
				<div className="workspace-session-card__issue">{issuePhase}</div>
			)}
			{session.recent_file && (
				<div
					className="workspace-session-card__recent-file"
					title={session.recent_file}
				>
					{truncatePath(session.recent_file)}
				</div>
			)}
			{relTime && <div className="workspace-session-card__time">{relTime}</div>}
		</button>
	);
}

/** Truncate long paths to show only the last two segments */
function truncatePath(p: string): string {
	const parts = p.replace(/\\/g, "/").split("/");
	if (parts.length <= 2) return p;
	return `…/${parts.slice(-2).join("/")}`;
}
