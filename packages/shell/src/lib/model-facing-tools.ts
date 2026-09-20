/**
 * The only tools the model may see from the Shell boundary.
 * Memory remains an automatic Agent recall/save path and therefore has no
 * model-facing tool name here.
 */
export const MODEL_FACING_TOOL_KEEP_LIST = [
	"get_time",
	"get_weather",
	"memo_list",
	"memo_get",
	"memo_save",
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
