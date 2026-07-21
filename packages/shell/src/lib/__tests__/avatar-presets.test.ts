import { describe, expect, it } from "vitest";
import {
	DEFAULT_AVATAR_MODEL,
	isLegacyBundledVrmModel,
} from "../avatar-presets";

describe("installed VRM defaults", () => {
	it("does not point a fresh installation at the removed Naia demo asset", () => {
		expect(DEFAULT_AVATAR_MODEL).toBe("");
		expect(isLegacyBundledVrmModel("/avatars/Naia.vrm")).toBe(true);
		expect(isLegacyBundledVrmModel("C:\\naia-settings\\vrm-files\\Naia-Hair.vrm")).toBe(true);
	});

	it("keeps installed ADK avatars out of the legacy migration path", () => {
		expect(isLegacyBundledVrmModel("01-Sendagaya-Shino-uniform.vrm")).toBe(false);
		expect(isLegacyBundledVrmModel("03-OL_Woman.vrm")).toBe(false);
	});
});
