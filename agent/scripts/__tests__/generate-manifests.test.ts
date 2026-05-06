import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CLAWHUB_SKILLS_DIR,
	type SkillFrontmatter,
	generateManifest,
	inferTier,
	parseFrontmatter,
} from "../generate-skill-manifests.js";

/** Path to bundled default-skills for testing new skills */
const DEFAULT_SKILLS_DIR = path.resolve(
	import.meta.dirname,
	"../../assets/default-skills",
);

/** Path to ref-moltbot skills for integration testing */
const REF_SKILLS_DIR = path.resolve(
	import.meta.dirname,
	"../../../ref-moltbot/skills",
);
const hasRefMoltbot = fs.existsSync(REF_SKILLS_DIR);

describe("parseFrontmatter", () => {
	it("parses basic frontmatter with name and description", () => {
		const content = `---
name: test-skill
description: A test skill for testing.
---
# Test Skill`;
		const result = parseFrontmatter(content);
		expect(result).not.toBeNull();
		expect(result?.name).toBe("test-skill");
		expect(result?.description).toBe("A test skill for testing.");
	});

	it("strips surrounding quotes from values", () => {
		const content = `---
name: "quoted-skill"
description: 'Single quoted description'
---`;
		const result = parseFrontmatter(content);
		expect(result?.name).toBe("quoted-skill");
		expect(result?.description).toBe("Single quoted description");
	});

	it("returns null when name is missing", () => {
		const content = `---
description: No name here
---`;
		const result = parseFrontmatter(content);
		expect(result).toBeNull();
	});

	it("returns null when description is missing", () => {
		const content = `---
name: no-desc
---`;
		const result = parseFrontmatter(content);
		expect(result).toBeNull();
	});

	it("parses homepage field", () => {
		const content = `---
name: with-home
description: Has homepage
homepage: https://example.com
---`;
		const result = parseFrontmatter(content);
		expect(result?.homepage).toBe("https://example.com");
	});

	it("ignores unrecognized metadata fields gracefully", () => {
		const content = `---
name: meta-skill
description: Has metadata
---`;
		const result = parseFrontmatter(content);
		expect(result?.name).toBe("meta-skill");
		expect(result?.description).toBe("Has metadata");
	});
});

describe("inferTier", () => {
	it("returns 1 for any skill (tier fixed post-openclaw-removal)", () => {
		const fm: SkillFrontmatter = { name: "t", description: "d" };
		expect(inferTier(fm)).toBe(1);
	});
});

describe("generateManifest", () => {
	it("produces valid skill.json structure", () => {
		const fm: SkillFrontmatter = {
			name: "notion",
			description: "Notion API integration",
		};
		const manifest = generateManifest(fm);
		expect(manifest.name).toBe("notion");
		expect(manifest.description).toBe("Notion API integration");
		expect(manifest.type).toBe("gateway");
		expect(manifest.gatewaySkill).toBe("notion");
		expect(manifest.tier).toBe(1);
		expect(manifest.parameters).toBeDefined();
	});
});

describe("bundled new skills (gh-issues, xurl)", () => {
	for (const skillName of ["gh-issues", "xurl"]) {
		describe(skillName, () => {
			const skillDir = path.join(DEFAULT_SKILLS_DIR, skillName);

			it("has SKILL.md", () => {
				expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
			});

			it("has skill.json with required fields", () => {
				const jsonPath = path.join(skillDir, "skill.json");
				expect(fs.existsSync(jsonPath)).toBe(true);
				const manifest = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
				expect(manifest.name).toBe(skillName);
				expect(manifest.description).toBeTruthy();
				expect(manifest.type).toBe("gateway");
				expect(manifest.gatewaySkill).toBe(skillName);
				expect(typeof manifest.tier).toBe("number");
				expect(manifest.parameters).toBeTruthy();
			});

			it("SKILL.md frontmatter is parseable", () => {
				const content = fs.readFileSync(
					path.join(skillDir, "SKILL.md"),
					"utf-8",
				);
				const fm = parseFrontmatter(content);
				expect(fm).not.toBeNull();
				expect(fm?.name).toBe(skillName);
				expect(fm?.description).toBeTruthy();
			});
		});
	}
});

describe.skipIf(!hasRefMoltbot)(
	"integration: ref-moltbot SKILL.md parsing",
	() => {
		it("parses at least 45 skills from ref-moltbot", () => {
			const entries = fs
				.readdirSync(REF_SKILLS_DIR, { withFileTypes: true })
				.filter((e) => e.isDirectory());

			let parsed = 0;
			for (const entry of entries) {
				const skillMdPath = path.join(REF_SKILLS_DIR, entry.name, "SKILL.md");
				if (!fs.existsSync(skillMdPath)) continue;

				const content = fs.readFileSync(skillMdPath, "utf-8");
				const fm = parseFrontmatter(content);
				if (fm) parsed++;
			}

			expect(parsed).toBeGreaterThanOrEqual(45);
		});

		it("generates valid manifest for notion skill", () => {
			const content = fs.readFileSync(
				path.join(REF_SKILLS_DIR, "notion", "SKILL.md"),
				"utf-8",
			);
			const fm = parseFrontmatter(content);
			expect(fm).not.toBeNull();

			const manifest = generateManifest(fm!);
			expect(manifest.name).toBe("notion");
			expect(manifest.type).toBe("gateway");
		});
	},
);
