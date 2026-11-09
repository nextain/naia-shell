/**
 * ADK Assets E2E — verifies the default ADK inventory and a local copy.
 * Point ADK_SETTINGS_DIR at a checkout of naia-adk/naia-settings.
 *
 * Run opt-in only (skipped by default):
 *   ADK_E2E=1 ADK_SETTINGS_DIR=/path/to/naia-adk/naia-settings pnpm exec vitest run src/lib/__tests__/adk-assets-e2e.test.ts
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADK_E2E = process.env.ADK_E2E === "1";

const EXPECTED_VRM_FILES = ["01-OL_Woman.vrm", "02-Hood_Boy.vrm"];
const EXPECTED_NVA_DIRS = ["naia", "jina", "minho"];
const EXPECTED_BGM_FILES = [
	"Afternoon Whispers.mp3",
	"naia-radio-its-okay-to-turn-off-the-light-en.mp3",
	"naia-radio-its-okay-to-turn-off-the-light-ko.mp3",
];
const EXPECTED_BG_FILES = [
	"naia-sunrise-river.webp",
	"naia-sky-garden.webp",
	"naia-dawn-city-uhd.webp",
	"naia-autumn-office-live.mp4",
	"naia-starlight-lake-live.mp4",
	"naia-rainy-studio-live.mp4",
];

describe.skipIf(!ADK_E2E)("ADK Assets E2E — default ADK assets on disk", () => {
	const assetsDir = process.env.ADK_SETTINGS_DIR ?? "";

	// ── Source file existence ─────────────────────────────────────────────────

	describe("naia-settings source files", () => {
		it("naia-settings directory exists", () => {
			expect(existsSync(assetsDir)).toBe(true);
		});

		it("contains the 2 default VRM files", () => {
			const vrmDir = join(assetsDir, "vrm-files");
			expect(existsSync(vrmDir)).toBe(true);
			const found = readdirSync(vrmDir).filter((f) => f.endsWith(".vrm"));
			for (const expected of EXPECTED_VRM_FILES) {
				expect(found, `Missing VRM: ${expected}`).toContain(expected);
			}
			expect(found).toHaveLength(EXPECTED_VRM_FILES.length);
		});

		it("contains the 3 default NVA bundles", () => {
			const nvaDir = join(assetsDir, "nva-files");
			expect(readdirSync(nvaDir).sort()).toEqual([...EXPECTED_NVA_DIRS].sort());
			for (const name of EXPECTED_NVA_DIRS) {
				expect(existsSync(join(nvaDir, name, "manifest.json"))).toBe(true);
			}
		});

		it("contains all background files", () => {
			const bgDir = join(assetsDir, "background");
			expect(existsSync(bgDir)).toBe(true);
			const found = readdirSync(bgDir);
			for (const expected of EXPECTED_BG_FILES) {
				expect(found, `Missing background: ${expected}`).toContain(expected);
			}
			expect(found).toHaveLength(EXPECTED_BG_FILES.length);
		});

		it("contains the 3 default BGM files", () => {
			const bgmDir = join(assetsDir, "bgm-musics");
			expect(existsSync(bgmDir)).toBe(true);
			const found = readdirSync(bgmDir).filter((f) => f.endsWith(".mp3"));
			for (const expected of EXPECTED_BGM_FILES) {
				expect(found, `Missing BGM: ${expected}`).toContain(expected);
			}
			expect(found).toHaveLength(EXPECTED_BGM_FILES.length);
		});
	});

	// ── Local copy simulation ────────────────────────────────────────────────
	describe("local inventory copy", () => {
		let tmpAdkPath: string;

		beforeAll(() => {
			tmpAdkPath = mkdtempSync(join(require("os").tmpdir(), "naia-adk-e2e-"));
		});

		afterAll(() => {
			if (tmpAdkPath && existsSync(tmpAdkPath)) {
				rmSync(tmpAdkPath, { recursive: true, force: true });
			}
		});

		function copyDefaultAssetsNode(adkPath: string): void {
			const subdirs = ["vrm-files", "nva-files", "background", "bgm-musics"] as const;
			for (const subdir of subdirs) {
				const srcDir = join(assetsDir, subdir);
				const dstDir = join(adkPath, "naia-settings", subdir);
				if (!existsSync(srcDir)) continue;
				mkdirSync(dstDir, { recursive: true });
				for (const file of readdirSync(srcDir)) {
					const dst = join(dstDir, file);
					if (!existsSync(dst)) {
						cpSync(join(srcDir, file), dst, { recursive: true });
					}
				}
			}
		}

		it("copies all VRM files to naia-settings/vrm-files/", () => {
			copyDefaultAssetsNode(tmpAdkPath);

			const dstVrm = join(tmpAdkPath, "naia-settings", "vrm-files");
			expect(existsSync(dstVrm)).toBe(true);

			const found = readdirSync(dstVrm).filter((f) => f.endsWith(".vrm"));
			for (const expected of EXPECTED_VRM_FILES) {
				expect(found, `Missing VRM in naia-settings: ${expected}`).toContain(expected);
			}
			expect(found).toHaveLength(EXPECTED_VRM_FILES.length);
		});

		it("copies all NVA bundles to naia-settings/nva-files/", () => {
			const dstNva = join(tmpAdkPath, "naia-settings", "nva-files");
			expect(readdirSync(dstNva).sort()).toEqual([...EXPECTED_NVA_DIRS].sort());
			for (const name of EXPECTED_NVA_DIRS) {
				expect(existsSync(join(dstNva, name, "manifest.json"))).toBe(true);
			}
		});

		it("copies all background files to naia-settings/background/", () => {
			const dstBg = join(tmpAdkPath, "naia-settings", "background");
			expect(existsSync(dstBg)).toBe(true);

			const found = readdirSync(dstBg);
			for (const expected of EXPECTED_BG_FILES) {
				expect(found, `Missing background in naia-settings: ${expected}`).toContain(expected);
			}
			expect(found).toHaveLength(EXPECTED_BG_FILES.length);
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
			const sentinelPath = join(tmpAdkPath, "naia-settings", "vrm-files", "01-OL_Woman.vrm");
			const statBefore = existsSync(sentinelPath)
				? require("node:fs").statSync(sentinelPath).mtimeMs
				: null;

			// Run copy again
			copyDefaultAssetsNode(tmpAdkPath);

			if (statBefore !== null) {
				const statAfter = require("node:fs").statSync(sentinelPath).mtimeMs;
				expect(statAfter).toBe(statBefore); // mtime unchanged → file was skipped
			}
		});
	});
});
