// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn(),
		set: vi.fn(),
		delete: vi.fn(),
	};
	return {
		load: vi.fn().mockResolvedValue(store),
		__mockStore: store,
	};
});

import { loadConfigWithSecrets, saveConfig } from "../config";

describe("loadConfigWithSecrets", () => {
	let mockStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		localStorage.clear();
		const mod = await import("@tauri-apps/plugin-store");
		mockStore = (mod as any).__mockStore;
	});

	it("returns naiaKey from localStorage when secure store is empty", async () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "fresh-key-123",
		});
		mockStore.get.mockResolvedValue(null);

		const config = await loadConfigWithSecrets();
		expect(config?.naiaKey).toBe("fresh-key-123");
	});

	it("returns naiaKey from secure store when localStorage is empty", async () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "",
			// naiaKey not set (simulates post-migration state)
		});
		mockStore.get.mockImplementation(async (name: string) =>
			name === "naiaKey" ? "secure-key-456" : null,
		);

		const config = await loadConfigWithSecrets();
		expect(config?.naiaKey).toBe("secure-key-456");
	});

	it("prefers localStorage naiaKey over stale secure store value", async () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "new-login-key",
		});
		mockStore.get.mockImplementation(async (name: string) =>
			name === "naiaKey" ? "old-stale-key" : null,
		);

		const config = await loadConfigWithSecrets();
		expect(config?.naiaKey).toBe("new-login-key");
	});

	it("syncs localStorage naiaKey to secure store when different", async () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "new-login-key",
		});
		mockStore.get.mockImplementation(async (name: string) =>
			name === "naiaKey" ? "old-stale-key" : null,
		);

		await loadConfigWithSecrets();
		expect(mockStore.set).toHaveBeenCalledWith("naiaKey", "new-login-key");
	});

	it("does not sync when localStorage and secure store match", async () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "same-key",
		});
		mockStore.get.mockImplementation(async (name: string) =>
			name === "naiaKey" ? "same-key" : null,
		);

		await loadConfigWithSecrets();
		expect(mockStore.set).not.toHaveBeenCalledWith("naiaKey", "same-key");
	});
});
