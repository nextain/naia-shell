// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

let config: Record<string, unknown> | null = null;

vi.mock("../adk-store", () => ({
	readNaiaConfig: vi.fn(async () => config),
	writeNaiaConfig: vi.fn(async (next: Record<string, unknown>) => {
		config = next;
	}),
}));

import {
	addBrowserBookmark,
	addBrowserShortcut,
	loadBrowserBookmarks,
	loadBrowserShortcuts,
	removeBrowserBookmark,
	removeBrowserShortcut,
} from "../browser-prefs";

beforeEach(() => {
	config = {};
	localStorage.clear();
});

describe("browser-prefs", () => {
	it("stores bookmarks in naia config and deduplicates by url", async () => {
		await addBrowserBookmark("Example", "https://example.com");
		await addBrowserBookmark("Example 2", "https://example.com");

		expect(await loadBrowserBookmarks()).toMatchObject([
			{ title: "Example 2", url: "https://example.com" },
		]);
	});

	it("removes bookmarks from naia config", async () => {
		await addBrowserBookmark("Example", "https://example.com");
		await removeBrowserBookmark("https://example.com");

		expect(await loadBrowserBookmarks()).toEqual([]);
	});

	it("stores and removes top-bar shortcuts in naia config", async () => {
		await addBrowserShortcut(
			"Docs",
			"https://docs.example.com",
			"https://docs.example.com/favicon.ico",
		);
		expect(await loadBrowserShortcuts()).toMatchObject([
			{
				title: "Docs",
				url: "https://docs.example.com",
				iconUrl: "https://docs.example.com/favicon.ico",
			},
		]);

		await removeBrowserShortcut("https://docs.example.com");
		expect(await loadBrowserShortcuts()).toEqual([]);
	});

	it("migrates legacy localStorage bookmarks when config is empty", async () => {
		localStorage.setItem(
			"naia_browser_bookmarks",
			JSON.stringify([{ title: "Legacy", url: "https://legacy.example" }]),
		);

		expect(await loadBrowserBookmarks()).toMatchObject([
			{ title: "Legacy", url: "https://legacy.example" },
		]);
	});

	it("can remove migrated legacy bookmarks", async () => {
		localStorage.setItem(
			"naia_browser_bookmarks",
			JSON.stringify([{ title: "Legacy", url: "https://legacy.example" }]),
		);

		await removeBrowserBookmark("https://legacy.example");

		expect(await loadBrowserBookmarks()).toEqual([]);
	});
});
