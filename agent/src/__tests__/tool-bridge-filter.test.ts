import { describe, expect, it } from "vitest";
import { getAllTools, skillRegistry } from "../gateway/tool-bridge.js";

describe("getAllTools disabledSkills filtering", () => {
	it("returns all tools when no disabledSkills", () => {
		const allTools = getAllTools(false);
		const withDisabled = getAllTools(false, []);
		expect(withDisabled.length).toBe(allTools.length);
	});

	it("returns all tools when disabledSkills is undefined", () => {
		const allTools = getAllTools(false);
		const withDisabled = getAllTools(false, undefined);
		expect(withDisabled.length).toBe(allTools.length);
	});

	it("filters out disabled skill tools", () => {
		const allTools = getAllTools(false);
		// Built-in skills: skill_time, skill_system_status, skill_memo, skill_weather, skill_skill_manager
		const disabled = getAllTools(false, ["skill_time"]);
		expect(disabled.length).toBe(allTools.length - 1);
		expect(disabled.find((t) => t.name === "skill_time")).toBeUndefined();
	});

	it("does not filter gateway tools even if named in disabledSkills", () => {
		const allTools = getAllTools(true);
		const disabled = getAllTools(true, ["execute_command"]);
		// Gateway tools are not filtered because they are not in skillRegistry
		const hasExecCommand = disabled.find((t) => t.name === "execute_command");
		expect(hasExecCommand).toBeDefined();
	});

	it("does not expose gateway-only tools when gateway is disconnected", () => {
		const names = getAllTools(false).map((t) => t.name);
		expect(names).toContain("execute_command");
		expect(names).toContain("read_file");
		expect(names).toContain("search_files");
		expect(names).not.toContain("web_search");
		expect(names).not.toContain("browser");
		expect(names).not.toContain("sessions_spawn");
	});

	it("filters multiple disabled skills", () => {
		const allTools = getAllTools(false);
		const disabled = getAllTools(false, ["skill_time", "skill_memo"]);
		expect(disabled.length).toBe(allTools.length - 2);
	});

	it("skill_time is in the default registry", () => {
		expect(skillRegistry.has("skill_time")).toBe(true);
	});

	it("skill_weather is in the default registry", () => {
		expect(skillRegistry.has("skill_weather")).toBe(true);
	});
});
