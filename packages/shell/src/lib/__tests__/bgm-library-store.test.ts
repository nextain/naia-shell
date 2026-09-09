import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
	read: vi.fn<(appId: string, path: string) => Promise<number[]>>(),
	write: vi.fn<(
		appId: string,
		path: string,
		bytes: number[],
		explicitAdkPath?: string | null,
	) => Promise<string>>(),
}));

vi.mock("../app-sandbox", () => ({
	readAppSandboxFile: sandbox.read,
	writeAppSandboxFile: sandbox.write,
}));

const adk = vi.hoisted(() => ({
	getPath: vi.fn<() => string | null>(() => null),
}));
vi.mock("../adk-store", () => ({ getAdkPath: adk.getPath }));

const config = vi.hoisted(() => ({
	load: vi.fn<() => unknown>(() => null),
	save: vi.fn<(value: unknown) => void>(),
}));
vi.mock("../config", () => ({ loadConfig: config.load, saveConfig: config.save }));

import { createEmptyBgmLibrary } from "../bgm-library";
import {
	bgmLibraryCache,
	loadBgmLibraryFromSandbox,
	persistBgmLibrary,
	resetBgmLibraryCache,
} from "../bgm-library-store";

function encode(value: unknown): number[] {
	return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}

describe("bgm-library-store", () => {
	beforeEach(() => {
		resetBgmLibraryCache();
		sandbox.read.mockReset();
		sandbox.write.mockReset();
		adk.getPath.mockReset();
		adk.getPath.mockReturnValue(null);
		config.load.mockReset();
		config.load.mockReturnValue(null);
		config.save.mockReset();
	});

	it("loads the sandbox file as the source of truth and primes the cache", async () => {
		const stored = {
			...createEmptyBgmLibrary(1),
			playlists: [
				{ id: "p1", name: "드라이브", tracks: [], createdAt: 1, updatedAt: 1 },
			],
			activePlaylistId: "p1",
		};
		sandbox.read.mockResolvedValue(encode(stored));

		const loaded = await loadBgmLibraryFromSandbox();

		expect(loaded.playlists.map((p) => p.name)).toEqual(["드라이브"]);
		expect(bgmLibraryCache()?.activePlaylistId).toBe("p1");
		expect(sandbox.write).not.toHaveBeenCalled();
	});

	it("migrates once to the sandbox when the file is missing", async () => {
		sandbox.read.mockRejectedValue(new Error("sandbox file does not exist"));
		sandbox.write.mockResolvedValue("ok");

		const loaded = await loadBgmLibraryFromSandbox();

		expect(loaded.playlists.length).toBeGreaterThan(0); // 기본 플레이리스트
		expect(sandbox.write).toHaveBeenCalledTimes(1);
		const [appId, path] = sandbox.write.mock.calls[0];
		expect(appId).toBe("land.naia.shell");
		expect(path).toBe("bgm/library.json");
	});

	it("persist writes the sandbox and updates the cache", async () => {
		sandbox.write.mockResolvedValue("ok");
		const state = createEmptyBgmLibrary(2);

		await persistBgmLibrary(state);

		expect(bgmLibraryCache()).toBe(state);
		expect(sandbox.write).toHaveBeenCalledTimes(1);
	});

	it("adopts config over a stale sandbox when config is newer, then heals the sandbox", async () => {
		sandbox.read.mockResolvedValue(encode({ ...createEmptyBgmLibrary(1), updatedAt: 1 }));
		sandbox.write.mockResolvedValue("ok");
		config.load.mockReturnValue({ bgmLibrary: { ...createEmptyBgmLibrary(5), updatedAt: 5, activePlaylistId: "default" } });

		const loaded = await loadBgmLibraryFromSandbox();

		expect(loaded.updatedAt).toBe(5);
		expect(sandbox.write).toHaveBeenCalledTimes(1); // stale sandbox healed
	});

	it("keeps the sandbox when it is at least as new as config", async () => {
		sandbox.read.mockResolvedValue(encode({ ...createEmptyBgmLibrary(9), updatedAt: 9 }));
		config.load.mockReturnValue({ bgmLibrary: { ...createEmptyBgmLibrary(3), updatedAt: 3 } });

		const loaded = await loadBgmLibraryFromSandbox();

		expect(loaded.updatedAt).toBe(9);
		expect(sandbox.write).not.toHaveBeenCalled();
	});

	it("keeps the sandbox when config has no updatedAt (legacy copy must not clobber)", async () => {
		sandbox.read.mockResolvedValue(encode({ ...createEmptyBgmLibrary(7), updatedAt: 7 }));
		config.load.mockReturnValue({
			bgmLibrary: {
				schemaVersion: 1,
				likes: [],
				playlists: [{ id: "x", name: "X", tracks: [], createdAt: 1, updatedAt: 1 }],
				activePlaylistId: "x",
				currentIndex: -1,
				shuffle: false,
				repeat: "off",
				queue: [],
				history: [],
			},
		});

		const loaded = await loadBgmLibraryFromSandbox();

		expect(loaded.updatedAt).toBe(7); // sandbox kept; fieldless config coalesces to 0
		expect(sandbox.write).not.toHaveBeenCalled();
	});

	it("captures the ADK path when each queued write is accepted", async () => {
		adk.getPath.mockReturnValue("/workspace-a");
		let releaseFirst!: (value: string) => void;
		sandbox.write.mockImplementationOnce(
			() => new Promise((resolve) => { releaseFirst = resolve; }),
		);
		sandbox.write.mockResolvedValue("ok");

		const first = persistBgmLibrary(createEmptyBgmLibrary(1));
		await Promise.resolve();
		adk.getPath.mockReturnValue("/workspace-b");
		const second = persistBgmLibrary(createEmptyBgmLibrary(2));
		releaseFirst("ok");

		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(true);
		expect(sandbox.write.mock.calls.map((call) => call[3])).toEqual([
			"/workspace-a",
			"/workspace-b",
		]);
	});

	it("does not write a failed queued request into a newly selected workspace", async () => {
		adk.getPath.mockReturnValue("/workspace-a");
		let rejectWrite!: (error: Error) => void;
		sandbox.write.mockImplementationOnce(
			() => new Promise((_resolve, reject) => { rejectWrite = reject; }),
		);

		const pending = persistBgmLibrary(createEmptyBgmLibrary(1));
		await Promise.resolve();
		adk.getPath.mockReturnValue("/workspace-b");
		rejectWrite(new Error("workspace a unavailable"));

		await expect(pending).resolves.toBe(false);
		expect(config.save).not.toHaveBeenCalled();
	});
});
