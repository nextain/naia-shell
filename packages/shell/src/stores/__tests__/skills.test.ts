import { afterEach, describe, expect, it } from "vitest";
import type { SkillManifestInfo } from "../../lib/types";
import { useSkillsStore } from "../skills";

const MOCK_SKILLS: SkillManifestInfo[] = [
	{
		name: "skill_time",
		description: "Get current date and time",
		type: "built-in",
		tier: 0,
		source: "built-in",
	},
	{
		name: "skill_weather",
		description: "Get weather info",
		type: "built-in",
		tier: 0,
		source: "built-in",
	},
	{
		name: "skill_code_review",
		description: "Review code changes",
		type: "gateway",
		tier: 2,
		source: "/home/user/.naia/skills/code-review/skill.json",
		gatewaySkill: "code-review",
	},
];

describe("useSkillsStore", () => {
	afterEach(() => {
		useSkillsStore.setState(useSkillsStore.getInitialState());
	});

	it("has correct initial state", () => {
		const state = useSkillsStore.getState();
		expect(state.skills).toEqual([]);
		expect(state.isLoading).toBe(false);
		expect(state.searchQuery).toBe("");
		expect(state.configVersion).toBe(0);
	});

	it("setSkills replaces the skills array", () => {
		useSkillsStore.getState().setSkills(MOCK_SKILLS);
		expect(useSkillsStore.getState().skills).toEqual(MOCK_SKILLS);
	});

	it("setLoading toggles loading state", () => {
		useSkillsStore.getState().setLoading(true);
		expect(useSkillsStore.getState().isLoading).toBe(true);
	});

	it("setSearchQuery updates query", () => {
		useSkillsStore.getState().setSearchQuery("weather");
		expect(useSkillsStore.getState().searchQuery).toBe("weather");
	});

	it("bumpConfigVersion increments configVersion", () => {
		expect(useSkillsStore.getState().configVersion).toBe(0);
		useSkillsStore.getState().bumpConfigVersion();
		expect(useSkillsStore.getState().configVersion).toBe(1);
		useSkillsStore.getState().bumpConfigVersion();
		expect(useSkillsStore.getState().configVersion).toBe(2);
	});
});
