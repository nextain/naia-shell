import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	MODEL_FACING_TOOL_KEEP_LIST,
	filterModelFacingTools,
	isModelFacingToolAllowed,
} from "../model-facing-tools";

/**
 * #611 absence proof (shell slice): direct-work tool UI/handlers and model
 * assembly paths must not re-advertise removed tools.
 */
describe("#611 direct-work model tools absent", () => {
	const root = join(import.meta.dirname, "../..");

	it.each([
		"components/KnowledgeToolResult.tsx",
		"__tests__/knowledge-tool-result.test.tsx",
	])("%s is deleted", (rel) => {
		expect(() => readFileSync(join(root, rel), "utf8")).toThrow();
	});

	it("workspace app registers only keep-list read tools", () => {
		const index = readFileSync(join(root, "apps/workspace/index.tsx"), "utf8");
		for (const name of [
			"skill_workspace_edit_open_file",
			"skill_workspace_execute",
			"skill_workspace_focus_session",
			"skill_workspace_new_session",
			"skill_workspace_send_to_session",
			"skill_workspace_classify_dirs",
		]) {
			expect(index.includes(`"${name}"`)).toBe(false);
		}
		for (const name of [
			"skill_workspace_get_sessions",
			"skill_workspace_open_file",
			"skill_workspace_get_open_file",
		]) {
			expect(index.includes(`"${name}"`)).toBe(true);
			expect(isModelFacingToolAllowed(name)).toBe(true);
		}
	});

	it("chat-service filters model-facing tools and clears empty app skills", () => {
		const chat = readFileSync(join(root, "lib/chat-service.ts"), "utf8");
		expect(chat.includes("filterModelFacingTools")).toBe(true);
		expect(chat.includes("app_skills_clear")).toBe(true);
	});

	it("App and ChatArea clear skill_environment instead of registering it", () => {
		const app = readFileSync(join(root, "App.tsx"), "utf8");
		const chatArea = readFileSync(join(root, "components/ChatArea.tsx"), "utf8");
		const environment = readFileSync(join(root, "lib/environment-skill.ts"), "utf8");
		expect(app.includes("SKILL_ENVIRONMENT")).toBe(false);
		expect(chatArea.includes("SKILL_ENVIRONMENT")).toBe(false);
		expect(environment.includes("SKILL_ENVIRONMENT")).toBe(false);
		expect(environment.includes("executeEnvironmentSkill")).toBe(false);
		expect(app.includes('sendAppSkillsClear(ENVIRONMENT_APP_ID')).toBe(true);
		expect(chatArea.includes("sendAppSkillsClear(ENVIRONMENT_APP_ID")).toBe(
			true,
		);
		expect(chatArea.includes("blocked non-model-facing app tool")).toBe(true);
		expect(chatArea.includes("blocked non-model-facing voice tool")).toBe(true);
	});

	it("keep list rejects the removed direct-work names", () => {
		const removed = [
			"shell_exec",
			"write_file",
			"skill_knowledge_ask",
			"skill_environment",
			"skill_workspace_execute",
			"notify",
			"mcp__server__tool",
		];
		expect(
			filterModelFacingTools(removed.map((name) => ({ name }))).map(
				(tool) => tool.name,
			),
		).toEqual([]);
		expect(MODEL_FACING_TOOL_KEEP_LIST).not.toContain("skill_environment");
	});
});
