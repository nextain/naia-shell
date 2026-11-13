// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	prewarmWebSpeechAssets,
	resetSpeechAssetPrewarmForTests,
	resolveWebNvaAssetUrl,
	takePrewarmedSpeechAsset,
} from "../speech-asset-prewarm";
import { canonicalSpeechAssetPaths } from "../canonical-speech-stage";
import { parseNvaManifest, resolveNvaAssetPath } from "../../../nva";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestText = readFileSync(
	resolve(__dirname, "../../../../../public/nva/jina/manifest.json"),
	"utf8",
);

describe("speech asset prewarm (kiosk entry screen)", () => {
	afterEach(() => {
		resetSpeechAssetPrewarmForTests();
		vi.unstubAllGlobals();
	});

	it("fetches every canonical speech asset once and hands each to the renderer once", async () => {
		const fetched: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				fetched.push(url);
				return {
					ok: true,
					text: async () => manifestText,
					blob: async () => new Blob([url]),
				};
			}),
		);
		await prewarmWebSpeechAssets("jina");
		await prewarmWebSpeechAssets("jina");
		const manifest = parseNvaManifest(manifestText);
		const urls = canonicalSpeechAssetPaths(manifest).map((path) =>
			resolveWebNvaAssetUrl("/nva/jina", manifest, path, true, resolveNvaAssetPath),
		);
		expect(urls.length).toBeGreaterThan(0);
		expect(fetched.filter((url) => url.endsWith("manifest.json"))).toHaveLength(1);
		for (const url of new Set(urls)) {
			expect(fetched.filter((item) => item === url)).toHaveLength(1);
		}
		const first = [...new Set(urls)][0]!;
		expect(await takePrewarmedSpeechAsset(first)).toBeInstanceOf(Blob);
		expect(await takePrewarmedSpeechAsset(first)).toBeNull();
	});

	it("a failed prewarm is a miss, never an error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.endsWith("manifest.json")
					? { ok: true, text: async () => manifestText }
					: { ok: false, status: 503 },
			),
		);
		await prewarmWebSpeechAssets("jina");
		const manifest = parseNvaManifest(manifestText);
		const url = resolveWebNvaAssetUrl(
			"/nva/jina",
			manifest,
			canonicalSpeechAssetPaths(manifest)[0]!,
			true,
			resolveNvaAssetPath,
		);
		expect(await takePrewarmedSpeechAsset(url)).toBeNull();
		await expect(prewarmWebSpeechAssets("../etc")).resolves.toBeUndefined();
		await expect(prewarmWebSpeechAssets(undefined)).resolves.toBeUndefined();
	});
});
