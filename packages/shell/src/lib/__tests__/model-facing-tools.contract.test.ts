import { describe, expect, it } from "vitest";
import {
	filterModelFacingTools,
	isModelFacingToolAllowed,
	MODEL_FACING_TOOL_KEEP_LIST,
} from "../model-facing-tools";

describe("model-facing tool contract", () => {
	it("keeps one exact, duplicate-free model-facing list", () => {
		expect(new Set(MODEL_FACING_TOOL_KEEP_LIST).size).toBe(
			MODEL_FACING_TOOL_KEEP_LIST.length,
		);
		expect([...MODEL_FACING_TOOL_KEEP_LIST]).toEqual([
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
		]);
	});

	it("removes direct work tools from every assembled list", () => {
		const incoming = [
			...MODEL_FACING_TOOL_KEEP_LIST.map((name) => ({ name })),
			{ name: "shell_exec" },
			{ name: "write_file" },
			{ name: "github_list_issues" },
			{ name: "github_get_issue" },
			{ name: "obsidian_list_notes" },
			{ name: "obsidian_read_note" },
			{ name: "obsidian_search" },
			{ name: "skill_example_from_adk" },
			{ name: "notify" },
			{ name: "mcp__server__tool" },
			{ name: "skill_environment" },
			{ name: "env_browser_navigate" },
			{ name: "skill_workspace_execute" },
			{ name: "skill_workspace_edit_open_file" },
		];

		expect(filterModelFacingTools(incoming).map((tool) => tool.name)).toEqual(
			MODEL_FACING_TOOL_KEEP_LIST,
		);
	});

	it("does not infer permission from a tool prefix", () => {
		expect(isModelFacingToolAllowed("skill_browser_navigate")).toBe(true);
		expect(isModelFacingToolAllowed("skill_browser_delete_everything")).toBe(
			false,
		);
		expect(isModelFacingToolAllowed("skill_knowledge_search")).toBe(true);
		expect(isModelFacingToolAllowed("skill_knowledge_delete")).toBe(false);
		expect(isModelFacingToolAllowed("skill_knowledge_compile")).toBe(false);
		expect(isModelFacingToolAllowed("skill_memory_recall")).toBe(true);
		expect(isModelFacingToolAllowed("memory_save")).toBe(false);
		expect(isModelFacingToolAllowed("skill_memory_save")).toBe(false);
		expect(isModelFacingToolAllowed("skill_memory_delete")).toBe(false);
	});

	it("workspace app tools stay inside the keep list", async () => {
		const { WORKSPACE_TOOLS } = await import("../../apps/workspace/index");
		expect(filterModelFacingTools(WORKSPACE_TOOLS).map((t) => t.name)).toEqual(
			WORKSPACE_TOOLS.map((t) => t.name),
		);
		expect(
			WORKSPACE_TOOLS.every((tool) => isModelFacingToolAllowed(tool.name)),
		).toBe(true);
	});
});
