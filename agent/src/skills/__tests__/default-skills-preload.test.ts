/**
 * E2E: default-skills preload validation (Issue #208)
 *
 * Verifies that all cross-platform skills in assets/default-skills/ are
 * properly formed — skill.json present, valid JSON, required fields, no
 * duplicate names, and that SKILL.md (where present) is parseable.
 *
 * Darwin-only skills (os: ["darwin"]) are catalogued separately and NOT
 * expected to be loaded on Linux. food-order and naia-* skills are
 * metadata-only (no SKILL.md) and tested against their skill.json only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type SkillFrontmatter,
	parseFrontmatter,
} from "../../../scripts/generate-skill-manifests.js";

const ASSETS_DIR = path.resolve(
	import.meta.dirname,
	"../../../assets/default-skills",
);

// ---------------------------------------------------------------------------
// Classification (by platform availability)
// ---------------------------------------------------------------------------

/**
 * Darwin-only: os: ["darwin"] — not loaded on Linux/Windows.
 * These are excluded from the cross-platform preload list.
 */
const DARWIN_ONLY_SKILLS = new Set([
	"apple-notes",
	"apple-reminders",
	"bear-notes",
	"imsg",
	"model-usage",
	"peekaboo",
	"things-mac",
]);

/**
 * Naia built-in skills (metadata-only, no SKILL.md).
 * Handled as TypeScript built-ins; skill.json is for Shell/gateway discovery.
 */
const NAIA_BUILTIN_SKILLS = new Set([
	"naia-agents",
	"naia-approvals",
	"naia-botmadang",
	"naia-channels",
	"naia-config",
	"naia-cron",
	"naia-device",
	"naia-diagnostics",
	"naia-discord",
	"naia-google-chat",
	"naia-sessions",
	"naia-tts",
	"naia-voicewake",
]);

/**
 * Skills with skill.json only (no SKILL.md), not naia-*.
 * Gateway skill whose SKILL.md lives in the Gateway repo.
 */
const JSON_ONLY_SKILLS = new Set(["food-order"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SkillManifest {
	name: string;
	description: string;
	type: "gateway" | "command" | "mcp";
	gatewaySkill?: string;
	tier?: number;
	parameters?: Record<string, unknown>;
}

function readSkillJson(dir: string): SkillManifest | null {
	const jsonPath = path.join(dir, "skill.json");
	if (!fs.existsSync(jsonPath)) return null;
	try {
		return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as SkillManifest;
	} catch {
		return null;
	}
}

function readSkillMd(dir: string): SkillFrontmatter | null {
	const mdPath = path.join(dir, "SKILL.md");
	if (!fs.existsSync(mdPath)) return null;
	const content = fs.readFileSync(mdPath, "utf-8");
	return parseFrontmatter(content);
}

function getAllSkillDirs(): string[] {
	return fs
		.readdirSync(ASSETS_DIR, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

function getCrossPlatformSkillDirs(): string[] {
	return getAllSkillDirs().filter(
		(name) =>
			!DARWIN_ONLY_SKILLS.has(name) &&
			!NAIA_BUILTIN_SKILLS.has(name) &&
			!JSON_ONLY_SKILLS.has(name),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("default-skills directory", () => {
	it("contains at least 60 skill directories", () => {
		const dirs = getAllSkillDirs();
		expect(dirs.length).toBeGreaterThanOrEqual(60);
	});

	it("darwin-only skill set is correct (7 skills)", () => {
		expect(DARWIN_ONLY_SKILLS.size).toBe(7);
		// Verify each darwin-only skill actually exists in the directory
		for (const name of DARWIN_ONLY_SKILLS) {
			expect(
				fs.existsSync(path.join(ASSETS_DIR, name)),
				`darwin skill dir missing: ${name}`,
			).toBe(true);
		}
	});

	it("naia built-in skill set is correct (13 skills)", () => {
		expect(NAIA_BUILTIN_SKILLS.size).toBe(13);
		for (const name of NAIA_BUILTIN_SKILLS) {
			expect(
				fs.existsSync(path.join(ASSETS_DIR, name)),
				`naia built-in dir missing: ${name}`,
			).toBe(true);
		}
	});
});

describe("cross-platform skills — skill.json integrity", () => {
	const crossPlatformDirs = getCrossPlatformSkillDirs();

	it("has at least 40 cross-platform skills", () => {
		expect(crossPlatformDirs.length).toBeGreaterThanOrEqual(40);
	});

	for (const skillName of crossPlatformDirs) {
		describe(skillName, () => {
			const skillDir = path.join(ASSETS_DIR, skillName);

			it("has a skill.json", () => {
				expect(
					fs.existsSync(path.join(skillDir, "skill.json")),
					`Missing skill.json in ${skillName}`,
				).toBe(true);
			});

			it("skill.json is valid JSON with required fields", () => {
				const manifest = readSkillJson(skillDir);
				expect(manifest, `Invalid or missing skill.json in ${skillName}`).not.toBeNull();
				if (!manifest) return;

				expect(manifest.name, `${skillName}: name missing`).toBeTruthy();
				expect(manifest.description, `${skillName}: description missing`).toBeTruthy();
				expect(
					manifest.type,
					`${skillName}: type must be gateway/command/mcp`,
				).toMatch(/^(gateway|command|mcp)$/);
			});

			it("skill.json name matches directory name", () => {
				const manifest = readSkillJson(skillDir);
				if (!manifest) return;
				// Name in skill.json may use underscores (e.g. food_order vs food-order)
				// Allow hyphen↔underscore variation but base name must match
				const normalizedManifest = manifest.name.replace(/_/g, "-");
				const normalizedDir = skillName.replace(/_/g, "-");
				expect(
					normalizedManifest,
					`${skillName}: skill.json name mismatch`,
				).toBe(normalizedDir);
			});

			it("has a SKILL.md", () => {
				expect(
					fs.existsSync(path.join(skillDir, "SKILL.md")),
					`Missing SKILL.md in ${skillName}`,
				).toBe(true);
			});

			it("SKILL.md frontmatter is parseable", () => {
				const mdPath = path.join(skillDir, "SKILL.md");
				if (!fs.existsSync(mdPath)) return;

				const fm = readSkillMd(skillDir);
				expect(
					fm,
					`${skillName}: parseFrontmatter returned null`,
				).not.toBeNull();
				if (!fm) return;

				expect(fm.name, `${skillName}: SKILL.md name missing`).toBeTruthy();
				expect(fm.description, `${skillName}: SKILL.md description missing`).toBeTruthy();
			});
		});
	}
});

describe("naia built-in skills — skill.json only", () => {
	for (const skillName of NAIA_BUILTIN_SKILLS) {
		describe(skillName, () => {
			const skillDir = path.join(ASSETS_DIR, skillName);

			it("has a skill.json", () => {
				expect(
					fs.existsSync(path.join(skillDir, "skill.json")),
					`Missing skill.json in ${skillName}`,
				).toBe(true);
			});

			it("skill.json is valid JSON with required fields", () => {
				const manifest = readSkillJson(skillDir);
				expect(manifest).not.toBeNull();
				if (!manifest) return;

				expect(manifest.name).toBeTruthy();
				expect(manifest.description).toBeTruthy();
				expect(manifest.type).toMatch(/^(gateway|command|mcp)$/);
			});

			it("does NOT have a SKILL.md (metadata-only)", () => {
				expect(
					fs.existsSync(path.join(skillDir, "SKILL.md")),
					`${skillName} should not have SKILL.md (it is a built-in)`,
				).toBe(false);
			});
		});
	}
});

describe("darwin-only skills — catalogued correctly", () => {
	for (const skillName of DARWIN_ONLY_SKILLS) {
		describe(skillName, () => {
			const skillDir = path.join(ASSETS_DIR, skillName);

			it("has a SKILL.md with os: [darwin]", () => {
				const mdPath = path.join(skillDir, "SKILL.md");
				expect(fs.existsSync(mdPath)).toBe(true);
				const content = fs.readFileSync(mdPath, "utf-8");
				expect(content).toContain('"darwin"');
			});
		});
	}
});

describe("no duplicate skill names", () => {
	it("all skill.json names are unique across default-skills", () => {
		const allDirs = getAllSkillDirs();
		const seen = new Map<string, string>(); // name → dir
		const duplicates: string[] = [];

		for (const dirName of allDirs) {
			const skillDir = path.join(ASSETS_DIR, dirName);
			const manifest = readSkillJson(skillDir);
			if (!manifest) continue;

			const name = manifest.name;
			if (seen.has(name)) {
				duplicates.push(`"${name}" in both "${seen.get(name)}" and "${dirName}"`);
			} else {
				seen.set(name, dirName);
			}
		}

		expect(
			duplicates,
			`Duplicate skill names found:\n${duplicates.join("\n")}`,
		).toHaveLength(0);
	});
});

describe("food-order (json-only gateway skill)", () => {
	const skillDir = path.join(ASSETS_DIR, "food-order");

	it("has a skill.json", () => {
		expect(fs.existsSync(path.join(skillDir, "skill.json"))).toBe(true);
	});

	it("skill.json has required fields", () => {
		const manifest = readSkillJson(skillDir);
		expect(manifest).not.toBeNull();
		if (!manifest) return;
		expect(manifest.name).toBe("food-order");
		expect(manifest.type).toBe("gateway");
	});
});
