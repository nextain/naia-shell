// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEB_BACKGROUND_ASSETS, WEB_VRM_ASSETS } from "../web-assets";
import {
	isWebBundledSettingsDirectory,
	mergeWebBundledSettingsEntries,
	webBundledSettingsEntries,
	webBundledSettingsFileUrl,
	webSettingsImportExtensions,
} from "../web-settings-catalog";
import {
	getWebWorkspaceFile,
	importWebWorkspaceFile,
} from "../web-workspace-files";

afterEach(() => vi.unstubAllGlobals());

const ROOT = "opfs://naia-adk";
const SETTINGS = `${ROOT}/naia-settings`;

describe("R32 web naia-settings catalog", () => {
	it("R32 lists the desktop naia-settings folders under the ADK root", () => {
		expect(webBundledSettingsEntries(ROOT)).toEqual([
			{ name: "naia-settings", kind: "directory" },
		]);
		expect(webBundledSettingsEntries(SETTINGS).map((e) => e.name)).toEqual([
			"background",
			"vrm-files",
			"bgm-musics",
			"nva-files",
		]);
	});

	it("R32 lists every bundled background and avatar by its file name", () => {
		expect(
			webBundledSettingsEntries(`${SETTINGS}/background`).map((e) => e.name),
		).toEqual(WEB_BACKGROUND_ASSETS.map((asset) => asset.filename));
		expect(
			webBundledSettingsEntries(`${SETTINGS}/vrm-files`).map((e) => e.name),
		).toEqual(WEB_VRM_ASSETS.map((asset) => asset.filename));
		expect(webBundledSettingsEntries(`${SETTINGS}/nva-files/naia`)).toEqual([
			{ name: "manifest.json", kind: "file", url: "/nva/naia/manifest.json" },
		]);
		expect(webBundledSettingsEntries(`${ROOT}/work`)).toEqual([]);
		expect(webBundledSettingsEntries(`${SETTINGS}/constructor`)).toEqual([]);
	});

	it("R32 points bundled files at the app asset instead of a copy", () => {
		expect(
			webBundledSettingsFileUrl(
				`${SETTINGS}/background/naia-sunrise-river.webp`,
			),
		).toBe("/backgrounds/naia-sunrise-river.webp");
		expect(
			webBundledSettingsFileUrl(`${SETTINGS}/vrm-files/03-OL_Woman.vrm`),
		).toBe("/avatars/03-OL_Woman.vrm");
		expect(
			webBundledSettingsFileUrl(`${SETTINGS}/background/../x.webp`),
		).toBeNull();
		expect(webBundledSettingsFileUrl(`${SETTINGS}/config.json`)).toBeNull();
		expect(isWebBundledSettingsDirectory(`${SETTINGS}/bgm-musics`)).toBe(true);
		expect(isWebBundledSettingsDirectory(`${ROOT}/work`)).toBe(false);
	});

	it("R32 adds only missing defaults beside OPFS entries", () => {
		const merged = mergeWebBundledSettingsEntries(SETTINGS, [
			{ name: "bgm-musics", kind: "directory" as const },
			{ name: "config.json", kind: "file" as const },
		]);
		expect(merged.filter((e) => e.name === "bgm-musics")).toEqual([
			{ name: "bgm-musics", kind: "directory" },
		]);
		expect(merged.find((e) => e.name === "background")).toMatchObject({
			bundled: true,
		});
	});

	it("R32 limits media import to the selected settings folder and file type", async () => {
		expect(webSettingsImportExtensions(`${SETTINGS}/background`)).toContain(
			".webp",
		);
		expect(webSettingsImportExtensions(`${SETTINGS}/vrm-files`)).toEqual([
			".vrm",
		]);
		expect(webSettingsImportExtensions(`${SETTINGS}/nva-files`)).toEqual([
			".nva",
		]);
		expect(
			webSettingsImportExtensions(`${SETTINGS}/bgm-musics`),
		).toBeUndefined();
		expect(
			webSettingsImportExtensions(`${SETTINGS}/nva-files/naia`),
		).toBeUndefined();
		const request = vi.fn();
		vi.stubGlobal("navigator", { locks: { request } });
		await expect(
			importWebWorkspaceFile(
				{ path: `${SETTINGS}/background`, directory: null },
				new File(["test"], "avatar.vrm"),
			),
		).rejects.toMatchObject({ name: "DataError" });
		expect(request).not.toHaveBeenCalled();
	});

	it("R32 opens the stored file when its name shadows a bundled default", async () => {
		const file = new File(["custom"], "03-OL_Woman.vrm");
		const dir = {
			getFileHandle: vi.fn().mockResolvedValue({ getFile: async () => file }),
			getDirectoryHandle: vi.fn(),
		};
		dir.getDirectoryHandle.mockResolvedValue(dir);
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => dir } });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			getWebWorkspaceFile(`${SETTINGS}/vrm-files/03-OL_Woman.vrm`),
		).resolves.toBe(file);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("R32 reads a bundled default through HTTP when OPFS has no copy", async () => {
		const missing = {
			getDirectoryHandle: vi
				.fn()
				.mockRejectedValue(new DOMException("x", "NotFoundError")),
		};
		const adk = { getDirectoryHandle: vi.fn().mockResolvedValue(missing) };
		const root = { getDirectoryHandle: vi.fn().mockResolvedValue(adk) };
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			blob: async () => new Blob(["img"], { type: "image/webp" }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const file = await getWebWorkspaceFile(
			`${SETTINGS}/background/naia-sunrise-river.webp`,
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"/backgrounds/naia-sunrise-river.webp",
		);
		expect(file.name).toBe("naia-sunrise-river.webp");
		expect(await file.text()).toBe("img");
		await expect(
			getWebWorkspaceFile(`${SETTINGS}/background/unknown.webp`),
		).rejects.toThrow();
	});
});
