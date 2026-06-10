import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffConfigs, fetchLabConfig, pushConfigToLab } from "../lab-sync";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("lab-sync", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	afterEach(() => {
		mockFetch.mockReset();
	});

	describe("fetchLabConfig", () => {
		it("returns sync fields from Lab response", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({
					config: {
						provider: "nextain",
						model: "gemini-3-flash-preview",
						userName: "Luke",
						agentName: "Naia",
						honorific: "오빠",
						speechStyle: "반말",
						apiKey: "should-be-excluded",
						gatewayUrl: "should-be-excluded",
					},
				}),
			});

			const result = await fetchLabConfig("test-key", "user-123");
			expect(result).not.toBeNull();
			expect(result?.userName).toBe("Luke");
			expect(result?.agentName).toBe("Naia");
			expect(result?.honorific).toBe("오빠");
			// Legacy "반말" normalized to "casual" by fetchLabConfig
			expect(result?.speechStyle).toBe("casual");
			expect(result?.provider).toBe("nextain");
			// Excluded fields should not be present
			expect((result as Record<string, unknown>).apiKey).toBeUndefined();
			expect((result as Record<string, unknown>).gatewayUrl).toBeUndefined();

			// Verify BFF API URL and headers
			const [url, opts] = mockFetch.mock.calls[0];
			expect(url).toContain("/api/gateway/config");
			expect(opts.headers["X-Desktop-Key"]).toBe("test-key");
			expect(opts.headers["X-User-Id"]).toBe("user-123");
		});

		it("returns null on HTTP error", async () => {
			mockFetch.mockResolvedValue({ ok: false, status: 404 });
			const result = await fetchLabConfig("bad-key", "user-123");
			expect(result).toBeNull();
		});

		it("returns null when config is missing", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({ config: null }),
			});
			const result = await fetchLabConfig("key", "user-123");
			expect(result).toBeNull();
		});

		it("returns null on network error", async () => {
			mockFetch.mockRejectedValue(new Error("network error"));
			const result = await fetchLabConfig("key", "user-123");
			expect(result).toBeNull();
		});
	});

	describe("pushConfigToLab", () => {
		it("sends PATCH with sync fields only", () => {
			mockFetch.mockResolvedValue({ ok: true });
			pushConfigToLab("test-key", "user-123", {
				provider: "nextain",
				model: "gemini-3-flash-preview",
				apiKey: "secret-key",
				userName: "Luke",
				honorific: "님",
				speechStyle: "formal",
			});

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, opts] = mockFetch.mock.calls[0];
			expect(url).toContain("/api/gateway/config");
			expect(opts.method).toBe("PATCH");
			expect(opts.headers["X-Desktop-Key"]).toBe("test-key");
			expect(opts.headers["X-User-Id"]).toBe("user-123");

			const body = JSON.parse(opts.body);
			expect(body.config.userName).toBe("Luke");
			expect(body.config.honorific).toBe("님");
			expect(body.config.speechStyle).toBe("formal");
			// apiKey should NOT be in sync data
			expect(body.config.apiKey).toBeUndefined();
		});
	});

	describe("diffConfigs", () => {
		it("returns empty array when configs match", () => {
			const local = { userName: "Luke", speechStyle: "casual" };
			const online = { userName: "Luke", speechStyle: "casual" };
			expect(diffConfigs(local, online)).toEqual([]);
		});

		it("detects differing fields", () => {
			const local = {
				userName: "Luke",
				agentName: "Naia",
				speechStyle: "casual",
				honorific: "",
			};
			const online = {
				userName: "Luke",
				agentName: "Mochi",
				speechStyle: "formal",
				honorific: "오빠",
			};
			const diffs = diffConfigs(local, online);
			expect(diffs).toContain("agentName");
			expect(diffs).toContain("speechStyle");
			expect(diffs).toContain("honorific");
			expect(diffs).not.toContain("userName");
		});

		it("ignores fields not in online config", () => {
			const local = { userName: "Luke", agentName: "Naia" };
			const online = { userName: "Luke" };
			// agentName is undefined in online → not counted as diff
			expect(diffConfigs(local, online)).toEqual([]);
		});
	});
});
