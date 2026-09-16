import { afterEach, describe, expect, it } from "vitest";
import { useSkillsStore } from "../skills";

describe("useSkillsStore", () => {
	afterEach(() => {
		useSkillsStore.setState(useSkillsStore.getInitialState());
	});

	it("has correct initial state", () => {
		const state = useSkillsStore.getState();
		expect(state.configVersion).toBe(0);
	});

	it("bumpConfigVersion increments configVersion", () => {
		expect(useSkillsStore.getState().configVersion).toBe(0);
		useSkillsStore.getState().bumpConfigVersion();
		expect(useSkillsStore.getState().configVersion).toBe(1);
		useSkillsStore.getState().bumpConfigVersion();
		expect(useSkillsStore.getState().configVersion).toBe(2);
	});
});
