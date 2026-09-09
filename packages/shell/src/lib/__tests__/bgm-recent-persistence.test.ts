import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
	read: vi.fn<(appId: string, path: string) => Promise<number[]>>(),
	write:
		vi.fn<(appId: string, path: string, bytes: number[]) => Promise<string>>(),
}));

vi.mock("../app-sandbox", () => ({
	readAppSandboxFile: sandbox.read,
	writeAppSandboxFile: sandbox.write,
}));

const config = vi.hoisted(() => ({
	load: vi.fn<() => unknown>(() => null),
	save: vi.fn<(value: unknown) => void>(),
}));

vi.mock("../config", () => ({
	loadConfig: config.load,
	saveConfig: config.save,
}));

import { createEmptyBgmLibrary } from "../bgm-library";
import {
	loadBgmLibraryFromSandbox,
	resetBgmLibraryCache,
} from "../bgm-library-store";
import { createBgmPlaybackPort } from "../bgm-playback";
import {
	BGM_RECENT_KEY,
	executeBgmSkill,
	getBgmRecentTracks,
	recordBgmPlayedTrack,
} from "../bgm-skill";

function encode(value: unknown): number[] {
	return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeState(call: [string, string, number[]] | undefined): {
	history?: Array<Record<string, unknown>>;
} {
	expect(call).toBeDefined();
	return JSON.parse(
		new TextDecoder().decode(Uint8Array.from(call?.[2] ?? [])),
	) as {
		history?: Array<Record<string, unknown>>;
	};
}

let values = new Map<string, string>();

beforeEach(() => {
	values = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
		clear: () => values.clear(),
	});
	resetBgmLibraryCache();
	sandbox.read.mockReset();
	sandbox.write.mockReset();
	config.load.mockReset();
	config.load.mockReturnValue(null);
	config.save.mockReset();
});

describe("BGM recent history ADK persistence", () => {
	it("restores a confirmed play after cache reload and excludes it from radio recommendations", async () => {
		sandbox.read.mockRejectedValue(new Error("sandbox file does not exist"));
		sandbox.write.mockResolvedValue("ok");

		await loadBgmLibraryFromSandbox();
		expect(
			await recordBgmPlayedTrack({ id: "song-1", title: "Focus Song" }, 123),
		).toBe(true);

		const stored = decodeState(sandbox.write.mock.calls.at(-1));
		expect(stored.history).toEqual([
			expect.objectContaining({
				source: "youtube",
				youtubeId: "song-1",
				title: "Focus Song",
				playedAt: 123,
			}),
		]);

		const snapshot = sandbox.write.mock.calls.at(-1)?.[2];
		resetBgmLibraryCache();
		sandbox.read.mockResolvedValue(snapshot ?? []);
		await loadBgmLibraryFromSandbox();
		expect(getBgmRecentTracks()).toEqual([
			{ id: "song-1", title: "Focus Song", playedAt: 123 },
		]);

		const emitted: Record<string, unknown>[] = [];
		const result = JSON.parse(
			await executeBgmSkill(
				{ action: "play", query: "focus", mode: "radio_dj" },
				{
					search: async () => [
						{ id: "song-2", title: "Focus Song (Official Video)" },
					],
					emitBgm: async (payload) => {
						emitted.push(payload);
					},
					playback: createBgmPlaybackPort(),
					recentTracks: getBgmRecentTracks,
				},
			),
		);
		expect(result).toMatchObject({
			ok: false,
			reason: "no_fresh_search_results",
		});
		expect(emitted).toEqual([]);
	});

	it("keeps an existing ADK history record ahead of a legacy localStorage collision", async () => {
		const stored = {
			...createEmptyBgmLibrary(10),
			history: [
				{
					id: "youtube:adk-song",
					source: "youtube" as const,
					youtubeId: "adk-song",
					title: "Focus Song",
					playedAt: 900,
				},
			],
		};
		sandbox.read.mockResolvedValue(encode(stored));
		sandbox.write.mockResolvedValue("ok");
		values.set(
			BGM_RECENT_KEY,
			JSON.stringify([
				{
					id: "legacy-song",
					title: "Focus Song (Official Video)",
					playedAt: 1,
				},
			]),
		);

		await loadBgmLibraryFromSandbox();
		expect(getBgmRecentTracks()).toEqual([
			{ id: "adk-song", title: "Focus Song", playedAt: 900 },
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(values.has(BGM_RECENT_KEY)).toBe(false);
	});

	it("keeps the legacy recent key when the ADK sandbox write fails", async () => {
		sandbox.read.mockRejectedValue(new Error("sandbox file does not exist"));
		sandbox.write.mockRejectedValue(new Error("disk unavailable"));

		await loadBgmLibraryFromSandbox();
		expect(
			await recordBgmPlayedTrack({ id: "song-1", title: "Focus Song" }, 123),
		).toBe(false);
		expect(values.has(BGM_RECENT_KEY)).toBe(true);
	});

	it("writes the ADK history even when localStorage is unavailable", async () => {
		sandbox.read.mockResolvedValue(encode(createEmptyBgmLibrary(1)));
		sandbox.write.mockResolvedValue("ok");
		await loadBgmLibraryFromSandbox();
		vi.stubGlobal("localStorage", undefined);

		expect(
			await recordBgmPlayedTrack({ id: "song-1", title: "Focus Song" }, 123),
		).toBe(true);
		const stored = decodeState(sandbox.write.mock.calls.at(-1));
		expect(stored.history?.[0]).toMatchObject({
			youtubeId: "song-1",
			playedAt: 123,
		});
	});
});
