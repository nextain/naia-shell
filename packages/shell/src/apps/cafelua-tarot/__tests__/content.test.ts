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

	it.each([
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_spring_day_sunny.webp, origin/main: 02d48f6
		[
			"lounge_bg_spring_day_sunny.webp",
			"a373dcfab1fdb1466433ae01b4e596defad54e57ebe2fbe7b6cbf94c9cf74bca",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_spring_sunset_clear.webp, origin/main: 02d48f6
		[
			"lounge_bg_spring_sunset_clear.webp",
			"551eb49951638aebe98ed18fd0ffd6bf23b12c0d1142ec208c90ef34b43ee4f2",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_spring_night_closed.webp, origin/main: 02d48f6
		[
			"lounge_bg_spring_night_closed.webp",
			"e1083bb831ff87bef6c4ea7094830658547a5e3b4dd082e28e3c11bcfdbefb51",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_summer_day_sunny.webp, origin/main: 02d48f6
		[
			"lounge_bg_summer_day_sunny.webp",
			"c34c81ad2c10700c5ecef81d5a58f06c161c6e96f1b0b67ac7a919ba65527376",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_summer_sunset_clear.webp, origin/main: 02d48f6
		[
			"lounge_bg_summer_sunset_clear.webp",
			"5745f239840ee76476dcd99eb68656f21e2254ef25308cc726c12a53e105d2b4",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_summer_night_closed.webp, origin/main: 02d48f6
		[
			"lounge_bg_summer_night_closed.webp",
			"5fa4385fe891713c2b5268545b2763d029f7d82443d0c981bd0d9e6d0923884b",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_autumn_day_sunny.webp, origin/main: 02d48f6
		[
			"lounge_bg_autumn_day_sunny.webp",
			"9096e9d6fa2cc3591fa02768e59f603f70059b6ad029bc657488e989c7547b5f",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_autumn_sunset_clear.webp, origin/main: 02d48f6
		[
			"lounge_bg_autumn_sunset_clear.webp",
			"279745daa3ea15a37f62215994866613d466ca1f917880e4d38e38f254cbf7ba",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_autumn_night_closed.webp, origin/main: 02d48f6
		[
			"lounge_bg_autumn_night_closed.webp",
			"de96170792f6722d21405151fe6c5655a85efeb03fc4a0609719556b3923b6fa",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_winter_day_sunny.webp, origin/main: 02d48f6
		[
			"lounge_bg_winter_day_sunny.webp",
			"db5ba9dc96be5cb6756de5151faa9e820674afd1e54d9a03ed7b04715a35e6d8",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_winter_sunset_clear.webp, origin/main: 02d48f6
		[
			"lounge_bg_winter_sunset_clear.webp",
			"75a98b2468fc33cd39baf09a90e08675c49d24988aef4c5859e84982c0d058b0",
		],
		// cafelua.com/public-home, public/lounge-background-img/lounge_bg_winter_night_closed.webp, origin/main: 02d48f6
		[
			"lounge_bg_winter_night_closed.webp",
			"c713b61b43d1b6bfb1255d471aa96614ff055b21d555d2185681b823341b922b",
		],
	])("keeps the exact upstream lounge background %s", (name, expected) => {
		expect(
			createHash("sha256")
				.update(
					readFileSync(
						resolve(appRoot, "package-public/lounge-background-img", name),
					),
				)
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
