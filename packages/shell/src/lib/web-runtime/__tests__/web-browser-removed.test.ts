// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncBrowserAppRegistration } from "../../../apps/browser";
import { useAppStore } from "../../../stores/app";
import { appRegistry } from "../../app-registry";
import { browserHostTools } from "../../browser-host-skill";
import { openKnowledgeSource } from "../../knowledge-source-open";
import { setWebAssetsModeForTests } from "../web-assets";

describe("web browser tab removal (item 3)", () => {
	beforeEach(() => {
		setWebAssetsModeForTests(true);
		syncBrowserAppRegistration();
		useAppStore.setState({ activeApp: null });
	});

	afterEach(() => {
		setWebAssetsModeForTests(false);
		syncBrowserAppRegistration();
		setWebAssetsModeForTests(null);
		useAppStore.setState({ activeApp: null });
		vi.restoreAllMocks();
	});

	it("unregisters the browser app from appRegistry in web mode and restores it in desktop mode", () => {
		expect(appRegistry.get("browser")).toBeUndefined();
		expect(appRegistry.list().some((a) => a.id === "browser")).toBe(false);

		setWebAssetsModeForTests(false);
		syncBrowserAppRegistration();
		expect(appRegistry.get("browser")).toBeDefined();
	});

	it("blocks setActiveApp('browser') in web mode", () => {
		useAppStore.getState().setActiveApp("browser");
		expect(useAppStore.getState().activeApp).toBeNull();

		useAppStore.getState().setActiveApp("settings");
		expect(useAppStore.getState().activeApp).toBe("settings");

		useAppStore.getState().setActiveApp("browser");
		expect(useAppStore.getState().activeApp).toBe("settings");
	});

	it("returns no browser host tools in web mode", () => {
		expect(browserHostTools()).toEqual([]);
	});

	it("opens http/https knowledge sources in a new browser tab instead of activating the shell browser app", async () => {
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
		await openKnowledgeSource("https://example.com/docs");
		expect(openSpy).toHaveBeenCalledWith(
			"https://example.com/docs",
			"_blank",
			"noopener,noreferrer",
		);
		expect(useAppStore.getState().activeApp).toBeNull();
	});
});
