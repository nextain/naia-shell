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

import { loadConfigWithSecrets, saveConfig, saveConfigSecure } from "../config";

// #337 Phase 10-pre cross-review CRITICAL #2: `naiaKey` is no longer in
// SECRET_KEYS — generic hydrate (`loadConfigWithSecrets`) and persist
// (`saveConfigSecure`) skip the slot entirely. These tests pin the new
// contract so we don't regress back to the dual-SoT design.
describe("loadConfigWithSecrets — post-#337 naiaKey contract", () => {
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

	it("returns naiaKey from localStorage AppConfig (legacy field still readable)", async () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "fresh-key-123",
		});
		mockStore.get.mockResolvedValue(null);

		const config = await loadConfigWithSecrets();
		// The field is still present on AppConfig and saveConfig still writes
		// it to localStorage — only the generic secure-store iteration was
		// removed. (Legacy AppConfig field exists for type-shape compatibility
		// and is only populated via the explicit lab-auth tests.)
		expect(config?.naiaKey).toBe("fresh-key-123");
	});

	it("does NOT hydrate naiaKey from the secure store (slot is no longer iterated)", async () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "",
			// naiaKey not set
		});
		mockStore.get.mockImplementation(async (name: string) =>
			name === "naiaKey" ? "secure-key-456" : null,
		);

		const config = await loadConfigWithSecrets();
		// Post-#337: only the agent (via agentAuthQuery/agentLabProxyRequest)
		// is allowed to surface naiaKey. The shell secure-store slot is
		// untouched by the generic hydrate path.
		expect(config?.naiaKey).toBeUndefined();
	});

	it("does NOT issue a generic getSecretKey('naiaKey') during loadConfigWithSecrets", async () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "direct-key",
		});
		mockStore.get.mockResolvedValue(null);

		await loadConfigWithSecrets();
		// SECRET_KEYS still hydrates apiKey/googleApiKey/gatewayToken/
		// openaiRealtimeApiKey, but never `naiaKey`.
		const naiaKeyCalls = mockStore.get.mock.calls.filter(
			(args) => args[0] === "naiaKey",
		);
		expect(naiaKeyCalls).toHaveLength(0);
	});
});

describe("saveConfigSecure — post-#337 naiaKey contract", () => {
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

	it("does NOT persist naiaKey to the secure store", async () => {
		// Caller passes naiaKey (e.g. from a pre-#337 codepath that hasn't
		// been pruned yet) — saveConfigSecure must silently skip the slot.
		await saveConfigSecure({
			provider: "nextain",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "should-never-be-persisted",
		});

		const naiaKeySets = mockStore.set.mock.calls.filter(
			(args) => args[0] === "naiaKey",
		);
		expect(naiaKeySets).toHaveLength(0);
	});

	it("still persists generic secrets (apiKey, googleApiKey, etc.)", async () => {
		await saveConfigSecure({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "real-api-key",
			googleApiKey: "google-key",
		});

		expect(mockStore.set).toHaveBeenCalledWith("apiKey", "real-api-key");
		expect(mockStore.set).toHaveBeenCalledWith("googleApiKey", "google-key");
	});
});
