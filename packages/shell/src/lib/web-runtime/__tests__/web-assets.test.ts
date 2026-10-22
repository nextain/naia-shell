import { afterEach, describe, expect, it } from "vitest";
import {
	WEB_BACKGROUND_ASSETS,
	WEB_DEFAULT_BACKGROUND,
	WEB_DEFAULT_BACKGROUND_URL,
	WEB_DEFAULT_VRM,
	WEB_VRM_ASSETS,
	isWebBundledAssetUrl,
	isWebMode,
	setWebAssetsModeForTests,
} from "../web-assets";

afterEach(() => {
	setWebAssetsModeForTests(null);
});

describe("isWebMode", () => {
	it("follows the test override when set", () => {
		setWebAssetsModeForTests(true);
		expect(isWebMode()).toBe(true);
		setWebAssetsModeForTests(false);
		expect(isWebMode()).toBe(false);
	});

	it("falls back to the build mode when the override is cleared", () => {
		// vitest runs with MODE=test, never "web".
		expect(import.meta.env.MODE).not.toBe("web");
		expect(isWebMode()).toBe(false);
	});
});

describe("web bundled catalogs", () => {
	it("exposes 4 VRM entries with absolute dist URLs", () => {
		expect(WEB_VRM_ASSETS).toHaveLength(4);
		for (const asset of WEB_VRM_ASSETS) {
			expect(asset.filename).toMatch(/\.vrm$/);
			expect(asset.url).toBe(`/avatars/${asset.filename}`);
			expect(asset.label.length).toBeGreaterThan(0);
		}
	});

	it("exposes at least 2 background entries with absolute dist URLs", () => {
		expect(WEB_BACKGROUND_ASSETS.length).toBeGreaterThanOrEqual(2);
		for (const asset of WEB_BACKGROUND_ASSETS) {
			expect(asset.url).toBe(`/backgrounds/${asset.filename}`);
		}
	});

	it("defaults point at the first catalog entries", () => {
		expect(WEB_DEFAULT_VRM).toBe(WEB_VRM_ASSETS[0].url);
		expect(WEB_DEFAULT_BACKGROUND).toBe(WEB_BACKGROUND_ASSETS[0].filename);
		expect(WEB_DEFAULT_BACKGROUND_URL).toBe(
			`/backgrounds/${WEB_DEFAULT_BACKGROUND}`,
		);
	});
});

describe("isWebBundledAssetUrl", () => {
	it("accepts dist asset URLs", () => {
		expect(isWebBundledAssetUrl("/avatars/03-OL_Woman.vrm")).toBe(true);
		expect(isWebBundledAssetUrl("/backgrounds/ol-woman-dusk.webp")).toBe(
			true,
		);
		expect(isWebBundledAssetUrl("avatars/03-OL_Woman.vrm")).toBe(true);
	});

	it("rejects workspace absolute paths and remote URLs", () => {
		expect(isWebBundledAssetUrl("/home/user/naia-adk/naia-settings")).toBe(
			false,
		);
		expect(isWebBundledAssetUrl("https://example.com/a.vrm")).toBe(false);
		expect(isWebBundledAssetUrl("blob:https://x/y")).toBe(false);
	});
});
