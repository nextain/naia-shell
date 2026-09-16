export interface ClassifiedDir {
	name: string;
	path: string;
	category: string;
	visibility?: string;
	entryPoint?: string;
}

/**
 * 워크스페이스 앱이 바깥에 내주는 손잡이.
 *
 * 2026-09-05 에 코딩 작업자 패널과 세션 대시보드를 접었다(Herdr 창의 agents
 * 탭과 IDE 뷰어가 그 자리를 대신한다, #554). 그 화면들이 살던
 * `WorkspaceCenterArea.tsx` 는 지웠고, 살아 있는 코드가 쓰던 타입만 여기로
 * 옮겼다 — 타입 하나 때문에 1,986줄이 남아 있으면 다음 사람이 그 파일을
 * 살아 있는 화면으로 읽는다.
 */
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
	last_change?: number | null;
}

export interface WorkspaceAppApi {
	[key: string]: (...args: any[]) => unknown;
	/** Open a file in the Editor. */
	openFile: (path: string) => void;
	/** Highlight a session card by its `dir` identifier and scroll it into view. */
	focusSession: (dir: string) => void;
	/** Return the current live session list. */
	getActiveSessions: () => SessionInfo[];
	/** Switch the center app to Workspace. */
	activateApp: () => void;
}

/** D6: Gemini CLI / OpenCode removed from PTY agent detection. */
export type AgentType = "claude" | "codex" | "grok" | "zai";

export interface TerminalTab {
	pty_id: string;
	dir: string;
	pid: number;
	/** GitHub issue number linked to this terminal (auto-detected from git branch) */
	issueId?: number;
	/** AI agent currently running in this terminal (auto-detected from process) */
	agent?: AgentType;
	/** True when the shell process has exited; tab stays visible for restart */
	exited?: boolean;
}
