import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assetUrl } from "../assets";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	STORY_AUTHORS,
	storyForCard,
	validatePackagedContent,
} from "../content";
import { FALLBACK_TAROT_CARDS } from "../data/fallbackCards";
import { TAROT_STORY_EDITIONS } from "../data/tarotStories";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Cafe Lua v2.0 packaged content", () => {
	it("keeps all 22 card illustrations, meanings, and paired story chapters in order", () => {
		expect(validatePackagedContent()).toBe(true);
		expect(FALLBACK_TAROT_CARDS).toHaveLength(22);
		for (const card of FALLBACK_TAROT_CARDS) {
			expect(
				existsSync(resolve(appRoot, "package-public", card.imagePath.slice(1))),
			).toBe(true);
			expect(storyForCard("fable", card.id)?.titleKo).toBeTruthy();
			expect(storyForCard("astra", card.id)?.titleEn).toBeTruthy();
		}
		expect(TAROT_STORY_EDITIONS.fable.chapters).toHaveLength(22);
		expect(TAROT_STORY_EDITIONS.astra.chapters).toHaveLength(22);
		expect(STORY_AUTHORS).toEqual({
			fable: "Claude Fable 5.1",
			astra: "GPT-6 Astra",
		});
	});

	it("keeps the exact upstream story source", () => {
		const original = execFileSync("git", [
			"-C",
			"/var/home/luke/alpha-adk/projects/cafelua.com/public-home",
			"show",
			"origin/main:src/data/gallery/tarotStories.ts",
		]);
		const actual = readFileSync(resolve(appRoot, "data/tarotStories.ts"));
		const hash = (bytes: Buffer) =>
			createHash("sha256").update(bytes).digest("hex");
		expect(hash(actual)).toBe(hash(original));
	});
	it("resolves runtime assets from the bundle directory even with encoded document paths", () => {
		expect(
			assetUrl(
				"/tarot/card-back.webp",
				"https://example.test/apps%2Ftarot/assets/app.js",
			),
		).toBe("https://example.test/apps%2Ftarot/tarot/card-back.webp");
	});

	it("packages the original BGM, attribution, and a 16:9 storefront thumbnail", () => {
		const license = readFileSync(
			resolve(appRoot, "package-public/ASSET-LICENSE.md"),
			"utf8",
		);
		const manifest = JSON.parse(
			readFileSync(resolve(appRoot, "package-public/app.json"), "utf8"),
		) as { thumbnailUrl: string };
		expect(
			existsSync(resolve(appRoot, "package-public/sounds/taro-bgm.mp3")),
		).toBe(true);
		expect(license).toContain("CC BY-NC-SA 4.0");
		expect(license).toContain("no external sound file or recording");
		expect(manifest.thumbnailUrl).toMatch(/thumbnail\.png$/);
	});
});
