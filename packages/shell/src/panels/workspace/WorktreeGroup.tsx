import { useState } from "react";
import { SessionCard, type SessionInfo } from "./SessionCard";

interface WorktreeGroupProps {
	/** Repo basename shown as group header (e.g. "naia-os") */
	repoName: string;
	sessions: SessionInfo[];
	onSessionClick: (session: SessionInfo) => void;
	highlightedDir?: string;
}

export function WorktreeGroup({
	repoName,
	sessions,
	onSessionClick,
	highlightedDir,
}: WorktreeGroupProps) {
	const [collapsed, setCollapsed] = useState(false);

	return (
		<div className="workspace-worktree-group">
			<button
				type="button"
				className="workspace-worktree-group__header"
				onClick={() => setCollapsed((c) => !c)}
				title={repoName}
			>
				<span className="workspace-worktree-group__arrow">
					{collapsed ? "▶" : "▼"}
				</span>
				<span className="workspace-worktree-group__name">{repoName}</span>
				<span className="workspace-worktree-group__count">
					{sessions.length}
				</span>
			</button>
			{!collapsed && (
				<div className="workspace-worktree-group__cards">
					{sessions.map((session) => (
						<SessionCard
							key={session.path}
							session={session}
							onClick={onSessionClick}
							highlighted={session.dir === highlightedDir}
						/>
					))}
				</div>
			)}
		</div>
	);
}
