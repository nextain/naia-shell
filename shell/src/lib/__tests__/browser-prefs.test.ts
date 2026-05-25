// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
	addBrowserBookmark,
	addBrowserShortcut,
	loadBrowserBookmarks,
	loadBrowserShortcuts,
	removeBrowserBookmark,
	removeBrowserShortcut,
} from "../browser-prefs";

beforeEach(() => {
	localStorage.clear();
});

describe("browser-prefs", () => {
	it("stores bookmarks in localStorage and deduplicates by url", async () => {
		await addBrowserBookmark("Example", "https://example.com");
		await addBrowserBookmark("Example 2", "https://example.com");

		expect(await loadBrowserBookmarks()).toMatchObject([
			{ title: "Example 2", url: "https://example.com" },
		]);
	});

	it("removes bookmarks from localStorage", async () => {
		await addBrowserBookmark("Example", "https://example.com");
		await removeBrowserBookmark("https://example.com");

		expect(await loadBrowserBookmarks()).toEqual([]);
	});

	it("stores and removes top-bar shortcuts in localStorage", async () => {
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

	it("migrates legacy localStorage bookmarks when new key is absent", async () => {
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
