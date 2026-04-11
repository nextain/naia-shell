#!/usr/bin/env npx tsx
declare const CLAWHUB_SKILLS_DIR: string;
/** Alternative source: ref-openclaw local checkout (used with --source flag) */
declare const REF_OPENCLAW_SKILLS_DIR: string;
/** Skills already ported as built-in (skip to avoid duplicates) */
declare const SKIP_BUILT_IN: Set<string>;
interface SkillFrontmatter {
    name: string;
    description: string;
    homepage?: string;
    metadata?: {
        openclaw?: {
            emoji?: string;
            requires?: {
                bins?: string[];
                env?: string[];
                config?: string[];
            };
            os?: string[];
            install?: unknown[];
            primaryEnv?: string;
        };
    };
}
/** Tier inference from skill metadata */
declare function inferTier(fm: SkillFrontmatter): number;
/** Parse YAML frontmatter from SKILL.md content */
declare function parseFrontmatter(content: string): SkillFrontmatter | null;
/** Simple YAML-like parser for frontmatter (handles inline JSON in metadata) */
declare function parseYamlLike(raw: string): SkillFrontmatter | null;
declare function generateManifest(fm: SkillFrontmatter): Record<string, unknown>;
export { parseFrontmatter, parseYamlLike, generateManifest, inferTier, SKIP_BUILT_IN, CLAWHUB_SKILLS_DIR, REF_OPENCLAW_SKILLS_DIR, };
export type { SkillFrontmatter };
