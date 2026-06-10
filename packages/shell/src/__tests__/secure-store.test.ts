import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factory must not reference variables declared in the same scope
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

// Import after mock
import {
	SECRET_KEYS,
	deleteSecretKey,
	getSecretKey,
	isSecretKey,
	saveSecretKey,
} from "../lib/secure-store";

// Get mock store reference
// function getMockStore() {
// 	return (load as unknown as { __mockStore: ReturnType<typeof vi.fn> }).__mockStore ??
// 		// fallback: resolve from the mock module
// 		vi.mocked(load).mock.results[0]?.value;
// }

describe("secure-store", () => {
	let mockStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		// Get the mock store after module loads
		const mod = await import("@tauri-apps/plugin-store");
		mockStore = (mod as any).__mockStore;
	});

	it("saves a key to the store", async () => {
		await saveSecretKey("apiKey", "test-value");
		expect(mockStore.set).toHaveBeenCalledWith("apiKey", "test-value");
	});

	it("retrieves a key from the store", async () => {
		mockStore.get.mockResolvedValueOnce("stored-value");
		const result = await getSecretKey("apiKey");
		expect(result).toBe("stored-value");
	});

	it("returns null for missing key", async () => {
		mockStore.get.mockResolvedValueOnce(undefined);
		const result = await getSecretKey("nonexistent");
		expect(result).toBeNull();
	});

	it("deletes a key from the store", async () => {
		await deleteSecretKey("apiKey");
		expect(mockStore.delete).toHaveBeenCalledWith("apiKey");
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
		expect(SECRET_KEYS).toContain("naiaKey");
		expect(SECRET_KEYS).toContain("gatewayToken");
	});
});
