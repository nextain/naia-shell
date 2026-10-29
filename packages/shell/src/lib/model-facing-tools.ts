import { useAppStore } from "../stores/app";
import { appRegistry } from "./app-registry";

/**
 * The only tools the model may see from the Shell boundary.
 * Memory save stays automatic; the only memory tool the model sees is the
 * read-only skill_memory_recall (nextain/naia-shell#693, Luke 2026-09-23).
 * Knowledge tools are read-only compiled workspace knowledge
 * (nextain/naia-shell#699, Luke 2026-09-23 「다 고쳐」);
 * write/exec/GitHub/Obsidian/notify/MCP/ADK-skill tools stay out, except for
 * intentional model-facing exceptions: workspace terminal exec / open-file edit,
 * and delegate_agent (delegate_agent is intentionally model-facing, gated agent-side).
 */
export const MODEL_FACING_TOOL_KEEP_LIST = [
	"get_time",
	"get_weather",
	"memo_list",
	"memo_get",
	"memo_save",
	"skill_memory_recall",
	"skill_memory_save",
	"skill_knowledge_ask",
	"skill_knowledge_search",
	"skill_knowledge_graph",
	"skill_knowledge_scope",
	"skill_knowledge_store",
	"list_dir",
	"read_file",
	"skill_youtube_bgm",
	"skill_browser_navigate",
	"skill_browser_back",
	"skill_browser_forward",
	"skill_browser_reload",
	"skill_browser_click",
	"skill_browser_fill",
	"skill_browser_scroll",
	"skill_browser_press",
	"skill_browser_snapshot",
	"skill_browser_get_text",
	"skill_tab_screenshot",
	"skill_browser_eval",
	"skill_workspace_get_sessions",
	"skill_workspace_open_file",
	"skill_workspace_get_open_file",
	// #687 narrowed write exception (Luke 2026-09-22 「쓰기 가능하게 해줘」): open editor file only, per-edit diff approval
	"skill_workspace_edit_open_file",
	"skill_workspace_close_file",
	"skill_workspace_set_surface",
	"skill_workspace_focus_space",
	"skill_workspace_terminal_exec",
	"skill_workspace_get_terminal_output",
	"delegate_agent",
] as const;

const MODEL_FACING_TOOL_KEEP_SET = new Set<string>(MODEL_FACING_TOOL_KEEP_LIST);
/**
 * Names owned by the Shell or its paired Agent, including built-ins deliberately
 * excluded from model-facing tools. Keep in sync with the inline skill-name
 * array returned by `list_skills` in src-tauri/src/lib.rs.
 */
export const SHELL_RESERVED_TOOL_NAMES = new Set<string>([
	...MODEL_FACING_TOOL_KEEP_LIST,
	"skill_time",
	"skill_system_status",
	"skill_memo",
	"skill_weather",
	"skill_notify_slack",
	"skill_notify_google_chat",
	"skill_agents",
	"skill_approvals",
	"skill_botmadang",
	"skill_channels",
	"skill_config",
	"skill_device",
	"skill_diagnostics",
	"skill_sessions",
	"skill_tts",
	"skill_voicewake",
	"skill_app",
	// This old environment tool must remain outside app-owned model tools too.
	"skill_environment",
]);
// The built-in skill allowlist omits this historical Store app tool because it
// is registered by the app iframe. Keep its legacy name here so the app can be
// invoked when its signed Store manifest owns it.
export const LEGACY_APP_TOOL_KEEP_LIST = ["skill_blackjack_tutor"] as const;
const LEGACY_APP_TOOL_KEEP_SET = new Set<string>(LEGACY_APP_TOOL_KEEP_LIST);

export type ModelFacingToolName = (typeof MODEL_FACING_TOOL_KEEP_LIST)[number];

export function isModelFacingToolAllowed(name: string): boolean {
	if (MODEL_FACING_TOOL_KEEP_SET.has(name)) return true;
	if (LEGACY_APP_TOOL_KEEP_SET.has(name)) {
		// This compatibility exception belongs only to a verified Store owner;
		// an unsigned iframe must not compete for the legacy dispatch name.
		const activeAppId = useAppStore.getState().activeApp;
		return appRegistry.list().some((app) => {
			if (
				app.source !== "installed" ||
				app.storeSignatureVerified !== true ||
				app.id !== activeAppId ||
				!app.tools?.some((tool) => tool.name === name)
			) {
				return false;
			}
			return true;
		});
	}
	if (!name.startsWith("skill_")) return false;
	if (SHELL_RESERVED_TOOL_NAMES.has(name)) return false;
	const activeAppId = useAppStore.getState().activeApp;
	if (!activeAppId) return false;
	const app = appRegistry.get(activeAppId);
	return (
		app?.source === "installed" &&
		app.storeSignatureVerified === true &&
		app.tools?.some((tool) => tool.name === name) === true
	);
}

export function filterModelFacingTools<T extends { name: string }>(
	tools: readonly T[],
): T[] {
	return tools.filter((tool) => isModelFacingToolAllowed(tool.name));
}

export interface ModelToolBoundary {
	readonly disabledSkills: readonly string[];
	readonly toolsAllowed: boolean;
}

export function makeModelToolBoundary(deps: {
	fetchTools: () => Promise<readonly { name: string }[]>;
	timeoutMs?: number; // default 1500
	warn?: (message: string, ctx?: Record<string, unknown>) => void;
}): {
	resolve(): Promise<ModelToolBoundary>;
	prefetch(): void;
	/** test isolation: drops an in-flight fetch */
	reset(): void;
} {
	const timeoutMs = deps.timeoutMs ?? 1500;
	let inFlight: Promise<ModelToolBoundary> | null = null;

	async function doFetch(): Promise<ModelToolBoundary> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeoutPromise = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
			});

			let fetchPromise: Promise<readonly { name: string }[]>;
			try {
				fetchPromise = Promise.resolve(deps.fetchTools());
			} catch (e) {
				fetchPromise = Promise.reject(e);
			}
			fetchPromise.catch(() => {});

			const rawTools = await Promise.race([fetchPromise, timeoutPromise]);
			if (!Array.isArray(rawTools)) {
				throw new Error("fetchTools did not return an array");
			}

			const disallowed: string[] = [];
			for (const item of rawTools) {
				if (item && typeof item.name === "string" && item.name.length > 0) {
					if (
						!isModelFacingToolAllowed(item.name) &&
						!disallowed.includes(item.name)
					) {
						disallowed.push(item.name);
					}
				}
			}
			return { disabledSkills: Object.freeze(disallowed), toolsAllowed: true };
		} catch (err) {
			try {
				deps.warn?.("Failed to resolve model tools boundary", {
					error: err instanceof Error ? err.message : String(err),
				});
			} catch {
				// ignore
			}
			return { disabledSkills: [], toolsAllowed: false };
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}

	function resolve(): Promise<ModelToolBoundary> {
		if (inFlight) {
			return inFlight;
		}
		inFlight = doFetch().finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	function prefetch(): void {
		void resolve();
	}

	/** test isolation: drops an in-flight fetch */
	function reset(): void {
		inFlight = null;
	}

	return { resolve, prefetch, reset };
}
