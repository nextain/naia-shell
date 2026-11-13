import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PRIVATE_SLIDES_PATHS,
	ensureWebKioskPrivateSlides,
	readPrivateSlidesManifest,
} from "../web-kiosk-private-slides.mjs";

const IMAGE = "0123456789abcdef.jpg";
const IMAGE_BYTES = Buffer.from("picture-bytes-for-test");
const DECK = {
	slides: [
		{ page: 7, image: IMAGE, title: "시험용 장", script: "시험용 원고예요." },
	],
};
const SCRIPT_BYTES = Buffer.from(JSON.stringify(DECK));

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let root: string;
let sourceDir: string;
let paths: { manifestPath: string; imageDir: string; scriptFile: string };

function writeManifest(slide: Record<string, unknown> = {}) {
	fs.writeFileSync(
		paths.manifestPath,
		JSON.stringify({
			script: {
				file: "deck-private.json",
				sha256: sha(SCRIPT_BYTES),
				bytes: SCRIPT_BYTES.length,
			},
			slides: [
				{
					page: 7,
					image: IMAGE,
					sha256: sha(IMAGE_BYTES),
					bytes: IMAGE_BYTES.length,
					...slide,
				},
			],
		}),
	);
}

function writeSource(
	image: Buffer | string = IMAGE_BYTES,
	script = SCRIPT_BYTES,
) {
	fs.writeFileSync(path.join(sourceDir, IMAGE), image);
	fs.writeFileSync(path.join(sourceDir, "deck-private.json"), script);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "web-kiosk-private-slides-"));
	sourceDir = path.join(root, "source");
	fs.mkdirSync(sourceDir);
	paths = {
		manifestPath: path.join(root, "manifest.json"),
		imageDir: path.join(root, "public", "private"),
		scriptFile: path.join(root, "deck.generated.json"),
	};
	writeManifest();
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("web-kiosk-private-slides", () => {
	it("fails without a source when the private slides are missing", () => {
		expect(() => ensureWebKioskPrivateSlides(paths)).toThrow(
			/NAIA_WEB_KIOSK_PRIVATE_SLIDES_SOURCE/,
		);
	});

	it("copies pictures and script from a local source and then accepts them as is", () => {
		writeSource();
		expect(
			ensureWebKioskPrivateSlides({ ...paths, source: sourceDir }),
		).toEqual(DECK);
		expect(fs.readFileSync(path.join(paths.imageDir, IMAGE))).toEqual(
			IMAGE_BYTES,
		);
		expect(fs.readFileSync(paths.scriptFile)).toEqual(SCRIPT_BYTES);
		expect(ensureWebKioskPrivateSlides(paths)).toEqual(DECK);
	});

	it("rejects a source picture whose digest differs and leaves nothing behind", () => {
		writeSource("picture-bytes-for-tesT");
		expect(() =>
			ensureWebKioskPrivateSlides({ ...paths, source: sourceDir }),
		).toThrow(/0123456789abcdef\.jpg/);
		expect(fs.readdirSync(paths.imageDir)).toEqual([]);
		expect(fs.existsSync(paths.scriptFile)).toBe(false);
	});

	it("rejects a source script whose digest differs", () => {
		writeSource(IMAGE_BYTES, Buffer.from(JSON.stringify({ slides: [] })));
		expect(() =>
			ensureWebKioskPrivateSlides({ ...paths, source: sourceDir }),
		).toThrow(/deck-private\.json/);
		expect(fs.existsSync(paths.scriptFile)).toBe(false);
	});

	it("replaces a present picture that no longer matches the record", () => {
		writeSource();
		fs.mkdirSync(paths.imageDir, { recursive: true });
		fs.writeFileSync(path.join(paths.imageDir, IMAGE), "stale");
		ensureWebKioskPrivateSlides({ ...paths, source: sourceDir });
		expect(fs.readFileSync(path.join(paths.imageDir, IMAGE))).toEqual(
			IMAGE_BYTES,
		);
	});

	it("rejects a relative source", () => {
		writeSource();
		expect(() =>
			ensureWebKioskPrivateSlides({ ...paths, source: "source" }),
		).toThrow(/가져오지 못했습니다/);
	});

	it("rejects a script whose pages or pictures differ from the record", () => {
		writeSource();
		writeManifest({ page: 8 });
		expect(() =>
			ensureWebKioskPrivateSlides({ ...paths, source: sourceDir }),
		).toThrow(/기록과 다릅니다/);
	});

	it("rejects a record that points outside the picture directory", () => {
		writeManifest({ image: "../escape.jpg" });
		expect(() => readPrivateSlidesManifest(paths.manifestPath)).toThrow(
			/올바르지 않습니다/,
		);
	});

	it("keeps the committed record valid: pages, random picture names, digests only", () => {
		const manifest = readPrivateSlidesManifest(
			DEFAULT_PRIVATE_SLIDES_PATHS.manifestPath,
		);
		expect(manifest.slides.length).toBeGreaterThan(0);
		expect(
			fs.readFileSync(DEFAULT_PRIVATE_SLIDES_PATHS.manifestPath, "utf8"),
		).not.toMatch(/title|script"\s*:\s*"|[가-힣]/);
	});
});
