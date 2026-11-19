import { describe, expect, it } from "vitest";
import {
	DEFAULT_VISUAL_AGENT_SLUG,
	buildVisualAgentPublicUrl,
	isVisualAgentSlug,
	readVisualAgentSlugFromSearch,
} from "../visual-agent-slug";

describe("R39 visual-agent slug", () => {
	it("R39 uses the naia default and a path-based public address", () => {
		expect(DEFAULT_VISUAL_AGENT_SLUG).toBe("naia");
		expect(buildVisualAgentPublicUrl(DEFAULT_VISUAL_AGENT_SLUG)).toBe(
			"https://naia.land/visual-agent/naia",
		);
		expect(buildVisualAgentPublicUrl("alpha-42")).toBe(
			"https://naia.land/visual-agent/alpha-42",
		);
	});

	it("R39 accepts only 3–32 lowercase letters, digits and hyphens", () => {
		for (const slug of ["naia", "abc", "alpha-42", "-a-", "z".repeat(32)]) {
			expect(isVisualAgentSlug(slug), slug).toBe(true);
		}
		for (const slug of ["", "ab", "a".repeat(33), "Alpha", "../alpha", "abc\n", "a_b", null]) {
			expect(isVisualAgentSlug(slug), String(slug)).toBe(false);
		}
	});

	it("R39 reads the public route handoff without mistaking private or invalid query parameters", () => {
		expect(readVisualAgentSlugFromSearch("?visualAgent=alpha&x=1")).toBe("alpha");
		expect(readVisualAgentSlugFromSearch("?slug=alpha")).toBeNull();
		expect(readVisualAgentSlugFromSearch("?visualAgent=%2falpha")).toBeNull();
	});
});
