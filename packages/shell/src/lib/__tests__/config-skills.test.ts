// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	getDisabledSkills,
	isSkillDisabled,
	loadConfig,
	saveConfig,
	toggleSkill,
} from "../config";

describe("config disabledSkills helpers", () => {
	afterEach(() => {
		localStorage.clear();
	});

	it("getDisabledSkills returns empty array when no config", () => {
		expect(getDisabledSkills()).toEqual([]);
	});

	it("getDisabledSkills returns empty array when disabledSkills is unset", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
		});
		expect(getDisabledSkills()).toEqual([]);
	});

	it("getDisabledSkills returns stored array", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
			disabledSkills: ["skill_foo", "skill_bar"],
		});
		expect(getDisabledSkills()).toEqual(["skill_foo", "skill_bar"]);
	});

	it("isSkillDisabled returns false when not in list", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
			disabledSkills: ["skill_foo"],
		});
		expect(isSkillDisabled("skill_bar")).toBe(false);
	});

	it("isSkillDisabled returns true when in list", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
			disabledSkills: ["skill_foo"],
		});
		expect(isSkillDisabled("skill_foo")).toBe(true);
	});

	it("toggleSkill adds skill when not disabled", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
		});
		toggleSkill("skill_foo");
		expect(getDisabledSkills()).toEqual(["skill_foo"]);
	});

	it("toggleSkill removes skill when already disabled", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
			disabledSkills: ["skill_foo", "skill_bar"],
		});
		toggleSkill("skill_foo");
		expect(getDisabledSkills()).toEqual(["skill_bar"]);
	});

	it("toggleSkill persists to localStorage", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
		});
		toggleSkill("skill_test");
		const config = loadConfig();
		expect(config?.disabledSkills).toEqual(["skill_test"]);
	});

	it("toggleSkill does not mutate the original array", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
			disabledSkills: ["skill_a", "skill_b"],
		});
		const before = loadConfig()?.disabledSkills;
		toggleSkill("skill_a");
		const after = loadConfig()?.disabledSkills;
		// The original saved array should not have been mutated
		expect(before).toEqual(["skill_a", "skill_b"]);
		expect(after).toEqual(["skill_b"]);
	});

	it("toggleSkill add does not mutate the original array", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
			disabledSkills: ["skill_a"],
		});
		const before = loadConfig()?.disabledSkills;
		toggleSkill("skill_new");
		const after = loadConfig()?.disabledSkills;
		expect(before).toEqual(["skill_a"]);
		expect(after).toEqual(["skill_a", "skill_new"]);
	});
});
