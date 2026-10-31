import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type StorageManagerLike,
	formatWebStorageSummaryLine,
	getWebStoragePersistState,
	requestWebPersistentStorage,
	resetWebStoragePersistStateForTests,
} from "../web-storage-persist";

describe("web-storage-persist (item 6)", () => {
	beforeEach(() => {
		resetWebStoragePersistStateForTests();
	});

	it("skips persist() call when storage is already persisted and records usage estimate", async () => {
		const persist = vi.fn(async () => true);
		const storage: StorageManagerLike = {
			persisted: vi.fn(async () => true),
			persist,
			estimate: vi.fn(async () => ({
				usage: 125 * 1024 * 1024,
				quota: 2048 * 1024 * 1024,
			})),
		};

		const state = await requestWebPersistentStorage(storage);
		expect(persist).not.toHaveBeenCalled();
		expect(state).toEqual({
			phase: "persisted",
			usageBytes: 125 * 1024 * 1024,
			quotaBytes: 2048 * 1024 * 1024,
		});
		expect(formatWebStorageSummaryLine(state)).toContain("영구 보존 허용됨");
		expect(formatWebStorageSummaryLine(state)).toContain("125.0 MB");
	});

	it("requests persist() when not yet persisted and reports denied message when browser refuses", async () => {
		const persist = vi.fn(async () => false);
		const storage: StorageManagerLike = {
			persisted: vi.fn(async () => false),
			persist,
			estimate: vi.fn(async () => ({
				usage: 10 * 1024 * 1024,
				quota: 500 * 1024 * 1024,
			})),
		};

		const state = await requestWebPersistentStorage(storage);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(state.phase).toBe("denied");
		expect(getWebStoragePersistState().phase).toBe("denied");
		expect(formatWebStorageSummaryLine(state)).toContain(
			"브라우저가 저장소 보존을 허용하지 않음",
		);
		expect(formatWebStorageSummaryLine(state)).toContain("10.0 MB");
	});

	it("handles missing navigator.storage gracefully", async () => {
		const state = await requestWebPersistentStorage(null);
		expect(state.phase).toBe("unsupported");
		expect(formatWebStorageSummaryLine(state)).toContain(
			"브라우저가 저장소 보존을 지원하지 않음",
		);
	});
});
