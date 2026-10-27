import { createHash } from "node:crypto";
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
import { tarotLibraryBook } from "../data/library/tarotBook";
import { APP_LOCALES } from "../i18n";
import { bookLocation } from "../ui";

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
		// cafelua.com/public-home, src/data/gallery/tarotStories.ts, origin/main: 3461f7d
		expect(
			createHash("sha256")
				.update(readFileSync(resolve(appRoot, "data/tarotStories.ts")))
				.digest("hex"),
		).toBe("b713d5b5f87b550d1449291b7e01c278569e6897af8656177c96c669559a87e4");
	});

	it.each([
		// cafelua.com/public-home, src/data/gallery/galleryData.ts, origin/main: 3461f7d
		[
			"gallery data",
			"data/gallery/galleryData.ts",
			"c434bd0bae534f147670bc5c0b01308b011d9bd2cbde523ba53a1d1259abd98b",
		],
		// cafelua.com/public-home, src/data/library/tarotBook.ts, origin/main: 02d48f6
		[
			"tarot book",
			"data/library/tarotBook.ts",
			"c8a69e5d2fe2582bdc0991e19fbee19be466abe40c9370e2772254ee6ada684a",
		],
		// cafelua.com/public-home, src/lib/library-dom-pagination.ts, origin/main: 00c09a7
		[
			"reader pagination",
			"library-dom-pagination.ts",
			"1f802688bc993fc045abfa8b692154c49d46e1433bdfe190b073a5177102cdb9",
		],
		// cafelua.com/public-home, src/components/LibraryPage.css, origin/main: 6d7782d
		[
			"library stylesheet",
			"LibraryPage.css",
			"339d8d2faa478e2f1131e9660442b48ab47d8ec9fcf220ef16aca16d0240b4c2",
		],
	])("keeps the exact upstream %s", (_name, path, expected) => {
		expect(
			createHash("sha256")
				.update(readFileSync(resolve(appRoot, path)))
				.digest("hex"),
		).toBe(expected);
	});

	it("shows the current book part and chapter for all 14 languages", () => {
		for (const locale of APP_LOCALES) {
			const edition = tarotLibraryBook.editions.find(
				(item) => item.lang === (locale === "ko" ? "ko" : "en"),
			)!;
			const first = edition.chapters.find(
				(chapter) => chapter.path === "fable/00.md",
			)!;
			const second = edition.chapters.find(
				(chapter) => chapter.path === "astra/00.md",
			)!;
			const intro = edition.chapters[0];
			const firstLocation = bookLocation(locale, first.path, first.title);
			const secondLocation = bookLocation(locale, second.path, second.title);
			expect(firstLocation).toContain(` · ${first.title}`);
			expect(secondLocation).toContain(` · ${second.title}`);
			expect(firstLocation.split(" · ")[0]).not.toBe(
				secondLocation.split(" · ")[0],
			);
			expect(bookLocation(locale, intro.path, intro.title)).toBe(intro.title);
		}
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
