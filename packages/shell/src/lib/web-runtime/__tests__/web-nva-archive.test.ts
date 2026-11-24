// @vitest-environment jsdom
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listNaiaAssets } from "../../adk-store";
import { setWebAssetsModeForTests } from "../web-assets";
import {
	isCandidateWebUploadedNvaModel,
	listWebNvaAssets,
	loadWebUploadedNvaArchive,
	parseWebNvaZipBytes,
} from "../web-nva-archive";

function buildNvaZip(options?: {
	nestedFolder?: string;
	includeStacked?: boolean;
	entryPathOverride?: string;
}): Uint8Array {
	const prefix = options?.nestedFolder ? `${options.nestedFolder}/` : "";
	const manifest = {
		nva_version: "0.2",
		canvas: { width: 720, height: 1280 },
		animations: {
			idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
			talking: { clip: "clips/talking-ko.webm", loop: true, can_talk: true },
		},
		...(options?.includeStacked
			? {
					stacked_alpha: {
						layout: "color-top-alpha-bottom",
						clips: {
							"clips/idle.webm": "clips/idle.stacked.mp4",
						},
					},
				}
			: {}),
	};
	const entries: Record<string, Uint8Array> = {
		[`${prefix}manifest.json`]: strToU8(JSON.stringify(manifest)),
		[`${prefix}clips/idle.webm`]: strToU8("webm-idle-bytes"),
		[`${prefix}clips/talking-ko.webm`]: strToU8("webm-talk-bytes"),
		[`${prefix}speech/atlas.bin`]: strToU8("atlas-bytes"),
	};
	if (options?.includeStacked) {
		entries[`${prefix}clips/idle.stacked.mp4`] = strToU8("stacked-idle-bytes");
	}
	if (options?.entryPathOverride) {
		entries[options.entryPathOverride] = strToU8("bad");
	}
	return zipSync(entries);
}

describe("web-nva-archive (R17 uploaded NVA bundles)", () => {
	afterEach(() => {
		setWebAssetsModeForTests(null);
		vi.unstubAllGlobals();
	});

	it("parses flat and single-folder .nva ZIP archives, resolves stacked/webm clips, and rejects traversal", async () => {
		const flat = parseWebNvaZipBytes(
			buildNvaZip({ includeStacked: true }),
			"opfs://naia-adk/naia-settings/nva-files/custom.nva",
		);
		expect(flat.manifest.canvas).toEqual({ width: 720, height: 1280 });
		await expect(flat.resolveAssetUrl("clips/idle.webm", true)).resolves.toBe(
			"opfs://naia-adk/naia-settings/nva-files/custom.nva/clips/idle.stacked.mp4",
		);
		await expect(flat.resolveAssetUrl("clips/idle.webm", false)).resolves.toBe(
			"opfs://naia-adk/naia-settings/nva-files/custom.nva/clips/idle.webm",
		);
		const stackedBlob = await flat.loadAssetBlob("clips/idle.webm", true);
		expect(stackedBlob.type).toBe("video/mp4");
		expect(new TextDecoder().decode(await stackedBlob.arrayBuffer())).toBe(
			"stacked-idle-bytes",
		);

		const nested = parseWebNvaZipBytes(
			buildNvaZip({ nestedFolder: "내 아바타" }),
			"opfs://naia-adk/naia-settings/nva-files/내 아바타.nva",
		);
		const idleBlob = await nested.loadAssetBlob("clips/idle.webm", true);
		expect(idleBlob.type).toBe("video/webm");

		expect(() =>
			parseWebNvaZipBytes(
				buildNvaZip({ entryPathOverride: "../escape.txt" }),
				"opfs://naia-adk/naia-settings/nva-files/bad.nva",
			),
		).toThrow("nva_invalid_entry_path");
		expect(() =>
			parseWebNvaZipBytes(
				strToU8("not a zip"),
				"opfs://naia-adk/naia-settings/nva-files/corrupt.nva",
			),
		).toThrow("nva_invalid_zip");
	});

	it("lists OPFS uploaded .nva files alongside built-ins via listNaiaAssets('nva-files') and loads them from OPFS", async () => {
		setWebAssetsModeForTests(true);
		const zipBytes = buildNvaZip({ includeStacked: true });
		const nvaFile = new File([zipBytes as BlobPart], "내 아바타.nva", {
			type: "application/zip",
		});
		const nvaFilesDir = {
			kind: "directory",
			name: "nva-files",
			async *values() {
				yield { kind: "file", name: "내 아바타.nva" };
				yield { kind: "file", name: "ignore.txt" };
			},
			async getFileHandle(name: string) {
				if (name === "내 아바타.nva") {
					return { getFile: async () => nvaFile };
				}
				throw new DOMException("Missing", "NotFoundError");
			},
		};
		const settingsDir = {
			async getDirectoryHandle(name: string) {
				if (name === "nva-files") return nvaFilesDir;
				throw new DOMException("Missing", "NotFoundError");
			},
		};
		const adkDir = {
			async getDirectoryHandle(name: string) {
				if (name === "naia-settings") return settingsDir;
				throw new DOMException("Missing", "NotFoundError");
			},
		};
		vi.stubGlobal("navigator", {
			storage: {
				getDirectory: async () => ({
					getDirectoryHandle: async (name: string) => {
						if (name === "naia-adk") return adkDir;
						throw new DOMException("Missing", "NotFoundError");
					},
				}),
			},
		});

		expect(isCandidateWebUploadedNvaModel("naia")).toBe(false);
		expect(isCandidateWebUploadedNvaModel("내 아바타.nva")).toBe(true);

		const allNvas = await listWebNvaAssets();
		expect(allNvas).toContain("naia");
		expect(allNvas).toContain("내 아바타.nva");
		expect(allNvas).not.toContain("ignore.txt");
		await expect(listNaiaAssets("nva-files")).resolves.toEqual(allNvas);

		const loaded = await loadWebUploadedNvaArchive("내 아바타.nva");
		expect(loaded).not.toBeNull();
		expect(loaded?.bundleDir).toBe(
			"opfs://naia-adk/naia-settings/nva-files/내 아바타.nva",
		);
		await expect(loadWebUploadedNvaArchive("naia")).resolves.toBeNull();
	});
});
