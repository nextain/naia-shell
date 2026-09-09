// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
	const states = new Map<string, Map<string, unknown>>();
	const stateFor = (path: string): Map<string, unknown> => {
		let state = states.get(path);
		if (!state) {
			state = new Map<string, unknown>();
			states.set(path, state);
		}
		return state;
	};
	const reset = () => {
		// Keep each existing Map alive because the mocked plugin store caches its
		// object between tests, just like the production legacy-store promise.
		for (const state of states.values()) state.clear();
	};
	const invoke = vi.fn(
		async (
			command: string,
			args: Record<string, unknown> = {},
		): Promise<unknown> => {
			const path = String(args.expectedStorePath ?? "");
			const state = stateFor(path);
			const name = String(args.name ?? "");
			if (command === "secure_store_get") return state.get(name) ?? null;
			if (command === "secure_store_set") {
				state.set(name, args.value);
				return undefined;
			}
			if (command === "secure_store_delete") {
				state.delete(name);
				return undefined;
			}
			return undefined;
		},
	);
	return { invoke, reset, stateFor };
});

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockState.invoke,
}));

vi.mock("@tauri-apps/plugin-store", () => {
	const stores = new Map<string, Record<string, unknown>>();

	const storeFor = (path: string) => {
		const existing = stores.get(path);
		if (existing) return existing;
		const state = mockState.stateFor(path);
		const store = {
			get: vi.fn(async (key: string) => state.get(key)),
			set: vi.fn(async (key: string, value: unknown) => {
				state.set(key, value);
			}),
			delete: vi.fn(async (key: string) => {
				state.delete(key);
			}),
			save: vi.fn().mockResolvedValue(undefined),
			entries: vi.fn(async () => Array.from(state.entries())),
		};
		stores.set(path, store);
		return store;
	};

	return {
		load: vi.fn(async (path: string) => storeFor(path)),
		__stateFor: mockState.stateFor,
	};
});

import {
	loadConfigWithSecrets,
	migrateLabKeyToNaiaKey,
	saveConfig,
	saveConfigSecure,
} from "../config";
import { deleteSecretKey, getSecretKey } from "../secure-store";

const LEGACY_STORE_PATH = "secure-keys.dat";
const adkStorePath = (root: string) =>
	`${root}/data-private/secure-keys.dat`;

const baseConfig = () => ({
	provider: "openai" as const,
	model: "gpt-4o",
	apiKey: "",
});

describe("ADK-backed credential persistence", () => {
	beforeEach(() => {
		localStorage.clear();
		localStorage.setItem("naia-adk-path", "/adk-a");
		mockState.reset();
		vi.clearAllMocks();
	});

	it("hydrates only from the selected ADK and isolates A from B", async () => {
		const a = mockState.stateFor(adkStorePath("/adk-a"));
		a.set("naiaKey", "adk-a-key");
		saveConfig({ ...baseConfig(), naiaKey: "stale-webview-cache" });

		await expect(loadConfigWithSecrets()).resolves.toMatchObject({
			naiaKey: "adk-a-key",
		});

		localStorage.setItem("naia-adk-path", "/adk-b");
		await expect(loadConfigWithSecrets()).resolves.toMatchObject({
			naiaKey: undefined,
		});

		localStorage.setItem("naia-adk-path", "/adk-a");
		await expect(loadConfigWithSecrets()).resolves.toMatchObject({
			naiaKey: "adk-a-key",
		});
	});

	it("rejects a load when the selected ADK changes during native reads", async () => {
		mockState.invoke.mockImplementationOnce(async () => {
			// Simulate the user selecting B while A's first secure read is pending.
			localStorage.setItem("naia-adk-path", "/adk-b");
			return "adk-a-key";
		});

		await expect(loadConfigWithSecrets()).rejects.toThrow(
			/selected ADK changed during the operation/,
		);
	});

	it("restores a Naia-only config when the public cache is absent", async () => {
		const a = mockState.stateFor(adkStorePath("/adk-a"));
		a.set("naiaKey", "adk-a-key");
		localStorage.removeItem("naia-config");

		await expect(loadConfigWithSecrets()).resolves.toMatchObject({
			provider: "nextain",
			model: "deepseek-v4-flash",
			naiaKey: "adk-a-key",
		});
		expect(localStorage.getItem("naia-remote-key")).toBeNull();

		localStorage.setItem("naia-adk-path", "/adk-b");
		await expect(loadConfigWithSecrets()).resolves.toBeNull();
	});

	it("round-trips secrets through A while B stays empty", async () => {
		await saveConfigSecure({
			...baseConfig(),
			apiKey: "api-a",
			openaiTtsApiKey: "tts-a",
			memoryEmbeddingApiKey: "embedding-a",
		});

		const a = mockState.stateFor(adkStorePath("/adk-a"));
		expect(a.get("apiKey")).toBe("api-a");
		expect(a.get("openaiTtsApiKey")).toBe("tts-a");
		expect(a.get("memoryEmbeddingApiKey")).toBe("embedding-a");
		expect(JSON.parse(localStorage.getItem("naia-config") ?? "{}")).not.toHaveProperty(
			"apiKey",
		);

		localStorage.setItem("naia-adk-path", "/adk-b");
		expect(await getSecretKey("apiKey")).toBeNull();
		localStorage.setItem("naia-adk-path", "/adk-a");
		await expect(loadConfigWithSecrets()).resolves.toMatchObject({
			apiKey: "api-a",
			openaiTtsApiKey: "tts-a",
			memoryEmbeddingApiKey: "embedding-a",
		});
	});

	it("migrates the legacy store once, preserves it, and carries app namespaces", async () => {
		const legacy = mockState.stateFor(LEGACY_STORE_PATH);
		legacy.set("apiKey", "legacy-api");
		legacy.set("labKey", "legacy-lab");
		legacy.set("app:slides:token", "legacy-app-token");
		saveConfig({
			...baseConfig(),
			apiKey: "cached-api",
			naiaKey: "cached-naia",
			...({ labKey: "cached-lab" } as Record<string, string>),
		});

		await migrateLabKeyToNaiaKey();

		const a = mockState.stateFor(adkStorePath("/adk-a"));
		expect(a.get("apiKey")).toBe("legacy-api");
		expect(a.get("naiaKey")).toBe("legacy-lab");
		expect(a.get("app:slides:token")).toBe("legacy-app-token");
		expect(a.has("labKey")).toBe(false);
		expect(legacy.get("apiKey")).toBe("legacy-api");
		expect(legacy.get("labKey")).toBe("legacy-lab");
		expect(legacy.get("app:slides:token")).toBe("legacy-app-token");
		expect(legacy.get("__naia_secure_store_first_adk")).toBe(
			"/adk-a/data-private/secure-keys.dat",
		);
		expect(JSON.parse(localStorage.getItem("naia-config") ?? "{}")).not.toHaveProperty(
			"apiKey",
		);
		expect(JSON.parse(localStorage.getItem("naia-config") ?? "{}")).not.toHaveProperty(
			"naiaKey",
		);

		localStorage.setItem("naia-adk-path", "/adk-b");
		await migrateLabKeyToNaiaKey();
		expect(mockState.stateFor(adkStorePath("/adk-b")).has("apiKey")).toBe(false);
		expect(mockState.stateFor(adkStorePath("/adk-b")).has("naiaKey")).toBe(false);
	});

	it("does not resurrect a deleted credential after restart-style migration", async () => {
		const legacy = mockState.stateFor(LEGACY_STORE_PATH);
		legacy.set("labKey", "legacy-lab");
		await migrateLabKeyToNaiaKey();
		expect(await getSecretKey("naiaKey")).toBe("legacy-lab");

		await deleteSecretKey("naiaKey");
		expect(await getSecretKey("naiaKey")).toBeNull();

		await migrateLabKeyToNaiaKey();
		expect(await getSecretKey("naiaKey")).toBeNull();
	});

	it("allows public config without an ADK but rejects and preserves a secret input", async () => {
		localStorage.removeItem("naia-adk-path");
		await expect(saveConfigSecure({ ...baseConfig() })).resolves.toBeUndefined();
		await expect(
			saveConfigSecure({ ...baseConfig(), apiKey: "must-be-retried" }),
		).rejects.toThrow(/selected ADK workspace/);
		expect(JSON.parse(localStorage.getItem("naia-config") ?? "{}")).not.toHaveProperty(
			"apiKey",
		);
	});

	it("does not publish A's public cache after switching to B mid-save", async () => {
		saveConfig({ ...baseConfig(), model: "cached-before-save" });
		mockState.invoke.mockImplementationOnce(async () => {
			// The secret write is still addressed to A, but the selected workspace
			// changes before saveConfig(publicConfig) would notify the shell.
			localStorage.setItem("naia-adk-path", "/adk-b");
		});

		await expect(
			saveConfigSecure({ ...baseConfig(), apiKey: "adk-a-key", model: "from-a" }),
		).rejects.toThrow(/selected ADK changed during the operation/);
		expect(JSON.parse(localStorage.getItem("naia-config") ?? "{}")).toMatchObject({
			model: "cached-before-save",
		});
	});
});
