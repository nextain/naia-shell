/**
 * The only tools the model may see from the Shell boundary.
 * Memory save stays automatic; the only memory tool the model sees is the
 * read-only skill_memory_recall (nextain/naia-shell#693, Luke 2026-09-23).
 * Knowledge tools are read-only compiled workspace knowledge
 * (nextain/naia-shell#699, Luke 2026-09-23 「다 고쳐」);
 * write/exec/GitHub/Obsidian/notify/MCP/ADK-skill tools stay out.
 */
export const MODEL_FACING_TOOL_KEEP_LIST = [
	"get_time",
	"get_weather",
	"memo_list",
	"memo_get",
	"memo_save",
	"skill_memory_recall",
	"skill_knowledge_ask",
	"skill_knowledge_search",
	"skill_knowledge_graph",
	"skill_knowledge_scope",
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
	"skill_workspace_close_file",
	"skill_workspace_set_surface",
	"skill_workspace_focus_space",
	"skill_workspace_terminal_exec",
	"skill_workspace_get_terminal_output",
] as const;

const MODEL_FACING_TOOL_KEEP_SET = new Set<string>(
	MODEL_FACING_TOOL_KEEP_LIST,
);

export type ModelFacingToolName = (typeof MODEL_FACING_TOOL_KEEP_LIST)[number];

export function isModelFacingToolAllowed(name: string): boolean {
	return MODEL_FACING_TOOL_KEEP_SET.has(name);
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

