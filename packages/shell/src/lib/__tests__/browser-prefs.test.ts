// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

let config: Record<string, unknown> | null = null;
let activeAdkPath: string | null = "/adk-a";
let blockReads = false;
let releaseRead: (() => void) | null = null;
let blockNextWrite = false;
let releaseWrite: (() => void) | null = null;
let switchPathDuringWrite = false;
let configHydrationPending = false;
const readPaths: Array<string | null | undefined> = [];
const writtenConfigs: Record<string, unknown>[] = [];

vi.mock("../adk-store", () => ({
	getAdkPath: vi.fn(() => activeAdkPath),
	isNaiaConfigHydrationPending: vi.fn(() => configHydrationPending),
	readNaiaConfig: vi.fn(async (path?: string | null) => {
		readPaths.push(path);
		if (blockReads) {
			await new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
		}
		return config;
	}),
	writeNaiaConfig: vi.fn(async (next: Record<string, unknown>) => {
		writtenConfigs.push(next);
		config = next;
		if (switchPathDuringWrite) activeAdkPath = "/adk-b";
		if (blockNextWrite) {
			blockNextWrite = false;
			await new Promise<void>((resolve) => {
				releaseWrite = resolve;
			});
		}
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
	activeAdkPath = "/adk-a";
	blockReads = false;
	releaseRead = null;
	blockNextWrite = false;
	releaseWrite = null;
	switchPathDuringWrite = false;
	configHydrationPending = false;
	readPaths.length = 0;
	writtenConfigs.length = 0;
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
		expect(config).toMatchObject({
			browserBookmarks: [{ title: "Legacy", url: "https://legacy.example" }],
		});
		expect(localStorage.getItem("naia_browser_bookmarks")).toBeNull();
	});

	it("prefers ADK bookmarks over a stale legacy copy", async () => {
		config = {
			browserBookmarks: [
				{ title: "ADK", url: "https://adk.example" },
			],
		};
		localStorage.setItem(
			"naia_browser_bookmarks",
			JSON.stringify([{ title: "Legacy", url: "https://legacy.example" }]),
		);

		expect(await loadBrowserBookmarks()).toMatchObject([
			{ title: "ADK", url: "https://adk.example" },
		]);
		expect(writtenConfigs).toHaveLength(0);
		expect(localStorage.getItem("naia_browser_bookmarks")).not.toBeNull();
	});

	it("can remove migrated legacy bookmarks", async () => {
		localStorage.setItem(
			"naia_browser_bookmarks",
			JSON.stringify([{ title: "Legacy", url: "https://legacy.example" }]),
		);

		await removeBrowserBookmark("https://legacy.example");

		expect(await loadBrowserBookmarks()).toEqual([]);
		expect(localStorage.getItem("naia_browser_bookmarks")).toBeNull();
	});

	it("updates the local config cache after an ADK browser write", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "openai", model: "gpt-5", stale: "keep" }),
		);

		await addBrowserShortcut("Docs", "https://docs.example.com");

		expect(JSON.parse(localStorage.getItem("naia-config") ?? "{}"))
			.toMatchObject({
				provider: "openai",
				model: "gpt-5",
				stale: "keep",
				browserShortcuts: [
					{ title: "Docs", url: "https://docs.example.com" },
				],
			});
	});

	it("binds a read/modify/write to the captured ADK path", async () => {
		blockReads = true;
		const pending = addBrowserBookmark("A", "https://a.example");

		await vi.waitFor(() => expect(readPaths).toEqual(["/adk-a"]));
		activeAdkPath = "/adk-b";
		releaseRead?.();

		await expect(pending).rejects.toThrow("ADK path changed");
		expect(writtenConfigs).toHaveLength(0);
	});

	it("updates only the browser cache field when the ADK changes during the write", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "openai", model: "gpt-5" }),
		);
		switchPathDuringWrite = true;

		await addBrowserShortcut("Docs", "https://docs.example.com");

		expect(activeAdkPath).toBe("/adk-b");
		expect(JSON.parse(localStorage.getItem("naia-config") ?? "{}"))
			.toMatchObject({
				provider: "openai",
				browserShortcuts: [{ url: "https://docs.example.com" }],
			});
	});

	it("updates the browser cache before a queued full-config save can overwrite it", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "openai", ttsVoice: "old" }),
		);
		blockNextWrite = true;

		const browserWrite = addBrowserBookmark("Docs", "https://docs.example.com");
		await vi.waitFor(() => expect(writtenConfigs).toHaveLength(1));

		// Simulate another setting changing while the browser write is queued.
		const cacheDuringWrite = JSON.parse(
			localStorage.getItem("naia-config") ?? "{}",
		) as Record<string, unknown>;
		cacheDuringWrite.ttsVoice = "new";
		localStorage.setItem("naia-config", JSON.stringify(cacheDuringWrite));

		const adkStore = await import("../adk-store");
		const appSave = vi.mocked(adkStore.writeNaiaConfig)(cacheDuringWrite);
		expect(writtenConfigs[1]).toMatchObject({
			browserBookmarks: [{ url: "https://docs.example.com" }],
			ttsVoice: "new",
		});

		releaseWrite?.();
		await Promise.all([browserWrite, appSave]);
		expect(JSON.parse(localStorage.getItem("naia-config") ?? "{}"))
			.toMatchObject({
				browserBookmarks: [{ url: "https://docs.example.com" }],
				ttsVoice: "new",
			});
	});

	it("keeps the legacy source when migration cannot be written", async () => {
		localStorage.setItem(
			"naia_browser_bookmarks",
			JSON.stringify([{ title: "Legacy", url: "https://legacy.example" }]),
		);
		const write = writtenConfigs;
		// The mock write is replaced only for this case so the migration path
		// exercises its failure preservation contract.
		const adkStore = await import("../adk-store");
		vi.mocked(adkStore.writeNaiaConfig).mockRejectedValueOnce(
			new Error("disk full"),
		);

		expect(await loadBrowserBookmarks()).toMatchObject([
			{ title: "Legacy", url: "https://legacy.example" },
		]);
		expect(localStorage.getItem("naia_browser_bookmarks")).not.toBeNull();
		expect(write).toHaveLength(0);
	});

	it("keeps legacy bookmarks while ADK config hydration is pending", async () => {
		localStorage.setItem(
			"naia_browser_bookmarks",
			JSON.stringify([{ title: "Legacy", url: "https://legacy.example" }]),
		);
		configHydrationPending = true;

		expect(await loadBrowserBookmarks()).toMatchObject([
			{ title: "Legacy", url: "https://legacy.example" },
		]);
		expect(localStorage.getItem("naia_browser_bookmarks")).not.toBeNull();
		expect(writtenConfigs).toHaveLength(0);
	});
});
