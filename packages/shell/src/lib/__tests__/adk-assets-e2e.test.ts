/**
 * ADK Assets E2E — verifies bundled assets exist and the copy-to-naia-settings
 * logic works end-to-end using Node.js fs (mirrors the Rust copy_bundled_assets).
 *
 * Run opt-in only (skipped by default):
 *   ADK_E2E=1 pnpm exec vitest run src/lib/__tests__/adk-assets-e2e.test.ts
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADK_E2E = process.env.ADK_E2E === "1";

/** Resolve the shell/public/assets directory relative to this test file. */
function findPublicAssetsDir(): string {
	// __dirname = shell/src/lib/__tests__
	return resolve(__dirname, "../../../public/assets");
}

const EXPECTED_VRM_FILES = [
	"01-Sendagaya-Shino-uniform.vrm",
	"02-Sakurada-Fumiriya.vrm",
	"03-OL_Woman.vrm",
	"04-Hood_Boy.vrm",
];

const EXPECTED_BGM_FILES = [
	"Afternoon Whispers.mp3",
	"Frosted Horizons.mp3",
	"atelier.mp3",
	"intro.mp3",
	"lounge.mp3",
];

const EXPECTED_BG_FILES = [
	"background-space.png",
	"anime-rainbow-landscape.jpg",
	"fantasy-anime-style-scene.jpg",
	"grup-background.jpg",
	"cat-cloud.3840x2160.mp4",
	"flower-shop-beachside-moewalls-com.mp4",
	"meteors-at-dawn.3840x2160.mp4",
	"morning-coffee.3840x2160.mp4",
];

describe.skipIf(!ADK_E2E)("ADK Assets E2E — bundled assets on disk", () => {
	const assetsDir = findPublicAssetsDir();

	// ── Source file existence ─────────────────────────────────────────────────

	describe("public/assets source files", () => {
		it("public/assets directory exists", () => {
			expect(existsSync(assetsDir)).toBe(true);
		});

		it("contains all 4 bundled VRM files", () => {
			const vrmDir = join(assetsDir, "vrm-files");
			expect(existsSync(vrmDir)).toBe(true);
			const found = readdirSync(vrmDir).filter((f) => f.endsWith(".vrm"));
			for (const expected of EXPECTED_VRM_FILES) {
				expect(found, `Missing VRM: ${expected}`).toContain(expected);
			}
			expect(found).toHaveLength(EXPECTED_VRM_FILES.length);
		});

		it("contains all background files", () => {
			const bgDir = join(assetsDir, "background");
			expect(existsSync(bgDir)).toBe(true);
			const found = readdirSync(bgDir);
			for (const expected of EXPECTED_BG_FILES) {
				expect(found, `Missing background: ${expected}`).toContain(expected);
			}
		});

		it("contains all 5 BGM files", () => {
			const bgmDir = join(assetsDir, "bgm-musics");
			expect(existsSync(bgmDir)).toBe(true);
			const found = readdirSync(bgmDir).filter((f) => f.endsWith(".mp3"));
			for (const expected of EXPECTED_BGM_FILES) {
				expect(found, `Missing BGM: ${expected}`).toContain(expected);
			}
			expect(found).toHaveLength(EXPECTED_BGM_FILES.length);
		});
	});

	// ── Copy simulation ───────────────────────────────────────────────────────
	// Mirrors the Rust copy_bundled_assets logic: for each subdir in assets,
	// create dst dir and copy files (skip existing). Verifies the logic works.

	describe("copy_bundled_assets simulation", () => {
		let tmpAdkPath: string;

		beforeAll(() => {
			tmpAdkPath = mkdtempSync(join(require("os").tmpdir(), "naia-adk-e2e-"));
		});

		afterAll(() => {
			if (tmpAdkPath && existsSync(tmpAdkPath)) {
				rmSync(tmpAdkPath, { recursive: true, force: true });
			}
		});

		function copyBundledAssetsNode(adkPath: string): void {
			const subdirs = ["vrm-files", "background", "bgm-musics"] as const;
			for (const subdir of subdirs) {
				const srcDir = join(assetsDir, subdir);
				const dstDir = join(adkPath, "naia-settings", subdir);
				if (!existsSync(srcDir)) continue;
				mkdirSync(dstDir, { recursive: true });
				for (const file of readdirSync(srcDir)) {
					const dst = join(dstDir, file);
					if (!existsSync(dst)) {
						cpSync(join(srcDir, file), dst);
					}
				}
			}
		}

		it("copies all VRM files to naia-settings/vrm-files/", () => {
			copyBundledAssetsNode(tmpAdkPath);

			const dstVrm = join(tmpAdkPath, "naia-settings", "vrm-files");
			expect(existsSync(dstVrm)).toBe(true);

			const found = readdirSync(dstVrm).filter((f) => f.endsWith(".vrm"));
			for (const expected of EXPECTED_VRM_FILES) {
				expect(found, `Missing VRM in naia-settings: ${expected}`).toContain(expected);
			}
			expect(found).toHaveLength(EXPECTED_VRM_FILES.length);
		});

		it("copies all background files to naia-settings/background/", () => {
			const dstBg = join(tmpAdkPath, "naia-settings", "background");
			expect(existsSync(dstBg)).toBe(true);

			const found = readdirSync(dstBg);
			for (const expected of EXPECTED_BG_FILES) {
				expect(found, `Missing background in naia-settings: ${expected}`).toContain(expected);
			}
		});

		it("copies all BGM files to naia-settings/bgm-musics/", () => {
			const dstBgm = join(tmpAdkPath, "naia-settings", "bgm-musics");
			expect(existsSync(dstBgm)).toBe(true);

			const found = readdirSync(dstBgm).filter((f) => f.endsWith(".mp3"));
			for (const expected of EXPECTED_BGM_FILES) {
				expect(found, `Missing BGM in naia-settings: ${expected}`).toContain(expected);
			}
			expect(found).toHaveLength(EXPECTED_BGM_FILES.length);
		});

		it("skips existing files on re-copy (idempotent)", () => {
			// Write a sentinel file that should NOT be overwritten
			const sentinelPath = join(tmpAdkPath, "naia-settings", "vrm-files", "01-Sendagaya-Shino-uniform.vrm");
			const statBefore = existsSync(sentinelPath)
				? require("node:fs").statSync(sentinelPath).mtimeMs
				: null;

			// Run copy again
			copyBundledAssetsNode(tmpAdkPath);

			if (statBefore !== null) {
				const statAfter = require("node:fs").statSync(sentinelPath).mtimeMs;
				expect(statAfter).toBe(statBefore); // mtime unchanged → file was skipped
			}
		});
	});
});
