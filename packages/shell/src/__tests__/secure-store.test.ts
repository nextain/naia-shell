// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
}));

// Legacy migration still uses the old app-data store. Canonical ADK secrets
// must go through the native invoke API above.
vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn(),
		set: vi.fn(),
		delete: vi.fn(),
		save: vi.fn(),
		entries: vi.fn(),
	};
	return {
		load: vi.fn().mockResolvedValue(store),
		__mockStore: store,
	};
});

// Import after mock
import {
	SECRET_KEYS,
	deleteSecretKey,
	getSecretKey,
	isSecretKey,
	saveSecretKey,
} from "../lib/secure-store";

describe("secure-store", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		localStorage.clear();
		localStorage.setItem("naia-adk-path", "/adk-a");
	});

	it("saves a key to the store", async () => {
		await saveSecretKey("apiKey", "test-value");
		expect(mockInvoke).toHaveBeenCalledWith("secure_store_set", {
			name: "apiKey",
			value: "test-value",
			expectedStorePath: "/adk-a/data-private/secure-keys.dat",
		});
	});

	it("retrieves a key from the store", async () => {
		mockInvoke.mockResolvedValueOnce("stored-value");
		const result = await getSecretKey("apiKey");
		expect(result).toBe("stored-value");
		expect(mockInvoke).toHaveBeenCalledWith("secure_store_get", {
			name: "apiKey",
			expectedStorePath: "/adk-a/data-private/secure-keys.dat",
		});
	});

	it("returns null for missing key", async () => {
		mockInvoke.mockResolvedValueOnce(null);
		const result = await getSecretKey("nonexistent");
		expect(result).toBeNull();
	});

	it("deletes a key from the store", async () => {
		await deleteSecretKey("apiKey");
		expect(mockInvoke).toHaveBeenCalledWith("secure_store_delete", {
			name: "apiKey",
			expectedStorePath: "/adk-a/data-private/secure-keys.dat",
		});
	});

	it("identifies secret key names", () => {
		expect(isSecretKey("apiKey")).toBe(true);
		expect(isSecretKey("naiaKey")).toBe(true);
		expect(isSecretKey("gatewayToken")).toBe(true);
		expect(isSecretKey("provider")).toBe(false);
		expect(isSecretKey("model")).toBe(false);
	});

	it("SECRET_KEYS includes expected keys", () => {
		expect(SECRET_KEYS).toContain("apiKey");
		expect(SECRET_KEYS).toContain("googleApiKey");
		expect(SECRET_KEYS).toContain("openaiTtsApiKey");
		expect(SECRET_KEYS).toContain("elevenlabsApiKey");
		expect(SECRET_KEYS).toContain("naiaKey");
		expect(SECRET_KEYS).toContain("gatewayToken");
		expect(SECRET_KEYS).toContain("openaiRealtimeApiKey");
		expect(SECRET_KEYS).toContain("subLlmApiKey");
		expect(SECRET_KEYS).toContain("memoryLlmApiKey");
		expect(SECRET_KEYS).toContain("memoryEmbeddingApiKey");
		expect(SECRET_KEYS).toContain("qdrantApiKey");
	});
});
