/**
 * Generate skill.json manifests from ClawHub SKILL.md files.
 * Reads frontmatter from each skill's SKILL.md, creates ~/.naia/skills/{name}/skill.json.
 *
 * Usage: npx tsx agent/scripts/generate-skill-manifests.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const CLAWHUB_SKILLS_DIR = path.join(os.homedir(), ".naia", "openclaw", "node_modules", "openclaw", "skills");
/** Alternative source: ref-openclaw local checkout (used with --source flag) */
const REF_OPENCLAW_SKILLS_DIR = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), "ref-openclaw", "skills");
const OUTPUT_DIR = path.join(os.homedir(), ".naia", "skills");
/** Skills already ported as built-in (skip to avoid duplicates) */
const SKIP_BUILT_IN = new Set([
    "time",
    "memo",
    "system_status",
    "weather",
    "notify_slack",
    "notify_discord",
    "notify_google_chat",
    "naia_discord",
    "skill_manager",
    "agents",
    "approvals",
    "botmadang",
    "channels",
    "config",
    "cron",
    "device",
    "diagnostics",
    "sessions",
    "tts",
    "voicewake",
]);
/** Tier inference from skill metadata */
function inferTier(fm) {
    const req = fm.metadata?.openclaw?.requires;
    if (!req)
        return 1;
    // Config/env required = higher tier (needs setup)
    if (req.config && req.config.length > 0)
        return 2;
    if (req.env && req.env.length > 0)
        return 2;
    // Simple binary requirement = lower tier
    if (req.bins && req.bins.length > 0)
        return 1;
    return 1;
}
/** Parse YAML frontmatter from SKILL.md content */
function parseFrontmatter(content) {
    // Strip BOM and normalize line endings for cross-platform compatibility
    const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    const match = normalized.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
        // Try single-line frontmatter: ---\n{yaml}\n---
        const singleLine = normalized.match(/^---\n([\s\S]*?)---/);
        if (!singleLine)
            return null;
        return parseYamlLike(singleLine[1]);
    }
    return parseYamlLike(match[1]);
}
/** Simple YAML-like parser for frontmatter (handles inline JSON in metadata) */
function parseYamlLike(raw) {
    const result = {};
    // Extract name
    const nameMatch = raw.match(/^name:\s*(.+)$/m);
    if (nameMatch) {
        result.name = nameMatch[1].replace(/^["']|["']$/g, "").trim();
    }
    // Extract description
    const descMatch = raw.match(/^description:\s*(.+)$/m);
    if (descMatch) {
        result.description = descMatch[1].replace(/^["']|["']$/g, "").trim();
    }
    // Extract homepage
    const homeMatch = raw.match(/^homepage:\s*(.+)$/m);
    if (homeMatch) {
        result.homepage = homeMatch[1].trim();
    }
    // Extract metadata (inline JSON)
    const metaMatch = raw.match(/^metadata:\s*(\{[\s\S]*\})\s*$/m);
    if (metaMatch) {
        try {
            result.metadata = JSON.parse(metaMatch[1]);
        }
        catch {
            // Try multi-line JSON
            const fullJson = raw
                .slice(raw.indexOf("metadata:") + "metadata:".length)
                .trim();
            // Find the JSON object
            const jsonMatch = fullJson.match(/^\s*(\{[\s\S]*\})/);
            if (jsonMatch) {
                try {
                    result.metadata = JSON.parse(jsonMatch[1]);
                }
                catch {
                    // Skip metadata
                }
            }
        }
    }
    if (!result.name || !result.description)
        return null;
    return result;
}
function generateManifest(fm) {
    return {
        name: fm.name,
        description: fm.description,
        type: "gateway",
        gatewaySkill: fm.name,
        tier: inferTier(fm),
        parameters: {
            type: "object",
            properties: {
                input: {
                    type: "string",
                    description: `Input for the ${fm.name} skill`,
                },
            },
        },
    };
}
// --- Exports for testing ---
export { parseFrontmatter, parseYamlLike, generateManifest, inferTier, SKIP_BUILT_IN, CLAWHUB_SKILLS_DIR, REF_OPENCLAW_SKILLS_DIR, };
// --- Main (only when executed directly, not imported) ---
function main() {
    // --source <path> overrides default ClawHub skills dir
    const sourceArgIdx = process.argv.indexOf("--source");
    const skillsDir = sourceArgIdx !== -1 && process.argv[sourceArgIdx + 1]
        ? process.argv[sourceArgIdx + 1]
        : process.argv.includes("--ref-openclaw")
            ? REF_OPENCLAW_SKILLS_DIR
            : CLAWHUB_SKILLS_DIR;
    if (!fs.existsSync(skillsDir)) {
        console.error(`Skills source not found at: ${skillsDir}`);
        console.error("Use --source <path> or --ref-openclaw to specify skills directory");
        process.exit(1);
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const entries = fs.readdirSync(skillsDir, {
        withFileTypes: true,
    });
    let generated = 0;
    let skipped = 0;
    let failed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        if (SKIP_BUILT_IN.has(entry.name)) {
            skipped++;
            continue;
        }
        const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) {
            console.warn(`  SKIP ${entry.name}: no SKILL.md`);
            skipped++;
            continue;
        }
        const content = fs.readFileSync(skillMdPath, "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm) {
            console.warn(`  FAIL ${entry.name}: could not parse frontmatter`);
            failed++;
            continue;
        }
        const manifest = generateManifest(fm);
        const outDir = path.join(OUTPUT_DIR, entry.name);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "skill.json"), JSON.stringify(manifest, null, "\t"));
        console.log(`  OK   ${entry.name} (tier ${manifest.tier})`);
        generated++;
    }
    console.log(`\nDone: ${generated} generated, ${skipped} skipped, ${failed} failed`);
}
// Run main only when invoked directly (not when imported for testing)
const isDirectRun = process.argv[1]?.endsWith("generate-skill-manifests.ts") ||
    process.argv[1]?.endsWith("generate-skill-manifests.js");
if (isDirectRun) {
    main();
}
//# sourceMappingURL=generate-skill-manifests.js.map