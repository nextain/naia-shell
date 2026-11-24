import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureWebNvaAtlases, listWebNvaAtlases } from "../web-nva-atlas.mjs";

const ATLAS = Buffer.from("atlas-bytes-for-test");
const SHA = createHash("sha256").update(ATLAS).digest("hex");

let root: string;
let nvaDir: string;
let sourceDir: string;

function writeBundle(bundle: string, sha256 = SHA, bytes = ATLAS.length) {
	const speech = path.join(nvaDir, bundle, "speech");
	fs.mkdirSync(speech, { recursive: true });
	fs.writeFileSync(
		path.join(speech, "generation-result.json"),
		JSON.stringify({
			assets: [
				{ role: "neutral_head", path: "speech/neutral-head.png" },
				{ role: "speech_atlas", path: "speech/atlas.bin", sha256, bytes },
			],
		}),
	);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "web-nva-atlas-"));
	nvaDir = path.join(root, "nva");
	sourceDir = path.join(root, "source");
	fs.mkdirSync(path.join(sourceDir, "jina", "speech"), { recursive: true });
	fs.mkdirSync(path.join(nvaDir, "minho", "clips"), { recursive: true });
	writeBundle("jina");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("web-nva-atlas", () => {
	it("lists only bundles that record a speech atlas", () => {
		expect(listWebNvaAtlases(nvaDir)).toEqual([
			{
				bundle: "jina",
				relPath: "jina/speech/atlas.bin",
				file: path.join(nvaDir, "jina", "speech", "atlas.bin"),
				sha256: SHA,
				bytes: ATLAS.length,
			},
		]);
	});

	it("fails without a source when the atlas is missing", async () => {
		await expect(ensureWebNvaAtlases({ nvaDir })).rejects.toThrow(
			/NAIA_WEB_NVA_ATLAS_SOURCE/,
		);
	});

	it("copies a missing atlas from a local source and then accepts it as is", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "jina", "speech", "atlas.bin"),
			ATLAS,
		);
		await expect(
			ensureWebNvaAtlases({ nvaDir, source: sourceDir }),
		).resolves.toEqual(["jina/speech/atlas.bin"]);
		expect(
			fs.readFileSync(path.join(nvaDir, "jina", "speech", "atlas.bin")),
		).toEqual(ATLAS);
		await expect(ensureWebNvaAtlases({ nvaDir })).resolves.toEqual([
			"jina/speech/atlas.bin",
		]);
	});

	it("rejects a source file whose digest differs and leaves nothing behind", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "jina", "speech", "atlas.bin"),
			"atlas-bytes-for-tesT",
		);
		await expect(
			ensureWebNvaAtlases({ nvaDir, source: sourceDir }),
		).rejects.toThrow(/jina\/speech\/atlas\.bin/);
		expect(fs.readdirSync(path.join(nvaDir, "jina", "speech"))).toEqual([
			"generation-result.json",
		]);
	});

	it("replaces a present atlas that no longer matches the record", async () => {
		fs.writeFileSync(path.join(nvaDir, "jina", "speech", "atlas.bin"), "stale");
		fs.writeFileSync(
			path.join(sourceDir, "jina", "speech", "atlas.bin"),
			ATLAS,
		);
		await ensureWebNvaAtlases({ nvaDir, source: sourceDir });
		expect(
			fs.readFileSync(path.join(nvaDir, "jina", "speech", "atlas.bin")),
		).toEqual(ATLAS);
	});

	it("rejects a record that points outside the bundle", () => {
		fs.writeFileSync(
			path.join(nvaDir, "jina", "speech", "generation-result.json"),
			JSON.stringify({
				assets: [
					{
						role: "speech_atlas",
						path: "../../escape.bin",
						sha256: SHA,
						bytes: 1,
					},
				],
			}),
		);
		expect(() => listWebNvaAtlases(nvaDir)).toThrow(/올바르지 않습니다/);
	});
});
