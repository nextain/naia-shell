/** Snapshot protocol range. Canonical pin is `src-tauri/src/herdr/api.rs`. */
export const HERDR_PROTOCOL_MIN = 19;
export const HERDR_PROTOCOL_MAX = 22;
/** herdr 0.8.0–0.8.2 speak 19; PATH herdr 0.9.1 speaks 22 (#645). */
export const HERDR_SUPPORTED_VERSIONS = "0.8.0–0.9.1";

export function herdrProtocolSupported(protocol: unknown): protocol is number {
	return (
		typeof protocol === "number" &&
		Number.isInteger(protocol) &&
		protocol >= HERDR_PROTOCOL_MIN &&
		protocol <= HERDR_PROTOCOL_MAX
	);
}

export const HERDR_SNAPSHOT_INTERVAL_MS = 750;
export const HERDR_STARTUP_TIMEOUT_MS = 8_000;
export const HERDR_STARTUP_RETRY_MS = 250;

export async function waitForHerdrReady<T>(
	readSnapshot: () => Promise<T>,
	options: { timeoutMs?: number; retryMs?: number } = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? HERDR_STARTUP_TIMEOUT_MS;
	const retryMs = options.retryMs ?? HERDR_STARTUP_RETRY_MS;
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	do {
		try {
			return await readSnapshot();
		} catch (error) {
			lastError = error;
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => globalThis.setTimeout(resolve, retryMs));
	} while (Date.now() < deadline);
	throw lastError ?? new Error("Herdr did not become ready");
}

export interface HerdrWorktree {
	checkout_path: string;
	repo_name?: string;
}

export interface HerdrWorkspace {
	workspace_id: string;
	label: string;
	focused: boolean;
	active_tab_id?: string;
	pane_count: number;
	tab_count: number;
	worktree?: HerdrWorktree;
}

export interface HerdrAgent {
	agent?: string;
	agent_status: string;
	cwd: string;
	foreground_cwd?: string;
	focused: boolean;
	label?: string;
	pane_id: string;
	tab_id: string;
	terminal_title_stripped?: string;
	workspace_id: string;
}

export interface HerdrSnapshot {
	protocol: number;
	version: string;
	focused_pane_id?: string;
	focused_tab_id?: string;
	focused_workspace_id?: string;
	workspaces: HerdrWorkspace[];
	agents: HerdrAgent[];
}

export function workspacePath(
	space: HerdrWorkspace,
	agents: HerdrAgent[],
): string {
	return (
		space.worktree?.checkout_path ||
		agents.find((agent) => agent.workspace_id === space.workspace_id)?.cwd ||
		""
	);
}

export function snapshotSessions(
	snapshot: HerdrSnapshot | null,
): SessionInfo[] {
	if (!snapshot) return [];
	return snapshot.workspaces.map((space) => {
		const agents = snapshot.agents.filter(
			(agent) => agent.workspace_id === space.workspace_id,
		);
		const status: SessionInfo["status"] = agents.some(
			(agent) => agent.agent_status === "working",
		)
			? "active"
			: agents.some((agent) => agent.agent_status === "blocked")
				? "error"
				: agents.length > 0
					? "idle"
					: "stopped";
		return { dir: space.label, path: workspacePath(space, agents), status };
	});
}

export function assertHerdrSnapshot(value: unknown): HerdrSnapshot {
	if (!value || typeof value !== "object") {
		throw new Error("Herdr snapshot is not an object");
	}
	const snapshot = value as Partial<HerdrSnapshot>;
	if (
		!herdrProtocolSupported(snapshot.protocol) ||
		typeof snapshot.version !== "string" ||
		(snapshot.focused_workspace_id !== undefined &&
			typeof snapshot.focused_workspace_id !== "string") ||
		(snapshot.focused_tab_id !== undefined &&
			typeof snapshot.focused_tab_id !== "string") ||
		(snapshot.focused_pane_id !== undefined &&
			typeof snapshot.focused_pane_id !== "string") ||
		!Array.isArray(snapshot.workspaces) ||
		!Array.isArray(snapshot.agents)
	) {
		throw new Error(
			`Unsupported Herdr snapshot protocol: ${snapshot.protocol}`,
		);
	}
	const validWorkspace = (item: unknown): item is HerdrWorkspace => {
		if (!item || typeof item !== "object") return false;
		const space = item as Partial<HerdrWorkspace>;
		return (
			typeof space.workspace_id === "string" &&
			typeof space.label === "string" &&
			typeof space.focused === "boolean" &&
			Number.isInteger(space.pane_count) &&
			Number.isInteger(space.tab_count) &&
			(!space.worktree || typeof space.worktree.checkout_path === "string")
		);
	};
	const validAgent = (item: unknown): item is HerdrAgent => {
		if (!item || typeof item !== "object") return false;
		const agent = item as Partial<HerdrAgent>;
		return (
			typeof agent.workspace_id === "string" &&
			typeof agent.tab_id === "string" &&
			typeof agent.pane_id === "string" &&
			typeof agent.agent_status === "string" &&
			typeof agent.cwd === "string" &&
			typeof agent.focused === "boolean" &&
			(agent.foreground_cwd === undefined ||
				typeof agent.foreground_cwd === "string") &&
			(agent.agent === undefined || typeof agent.agent === "string") &&
			(agent.label === undefined || typeof agent.label === "string") &&
			(agent.terminal_title_stripped === undefined ||
				typeof agent.terminal_title_stripped === "string")
		);
	};
	if (
		!snapshot.workspaces.every(validWorkspace) ||
		!snapshot.agents.every(validAgent)
	) {
		throw new Error("Malformed Herdr snapshot entries");
	}
	return snapshot as HerdrSnapshot;
}

export function focusedHerdrAgent(
	snapshot: HerdrSnapshot | null,
): HerdrAgent | undefined {
	if (!snapshot) return undefined;
	return snapshot.agents.find(
		(agent) => agent.pane_id === snapshot.focused_pane_id || agent.focused,
	);
}

export function activeHerdrRoot(snapshot: HerdrSnapshot | null): string {
	if (!snapshot) return "";
	const workspace = snapshot.workspaces.find(
		(item) =>
			item.workspace_id === snapshot.focused_workspace_id || item.focused,
	);
	return (
		workspace?.worktree?.checkout_path || focusedHerdrAgent(snapshot)?.cwd || ""
	);
}
import type { SessionInfo } from "./types";
