import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #337 Phase 6b: lab-sync now reaches the BFF via the agent lab proxy
// (`agentLabProxyRequest`). Mock the agent-ipc wrappers instead of `fetch`.
vi.mock("../agent-ipc", () => ({
	agentLabProxyRequest: vi.fn(),
	resolveAuthMode: vi.fn().mockReturnValue("prod"),
}));

import { agentLabProxyRequest } from "../agent-ipc";
import {
	clearLabConfig,
	diffConfigs,
	fetchLabConfig,
	pushConfigToLab,
} from "../lab-sync";

const mockedLabProxy = agentLabProxyRequest as unknown as ReturnType<
	typeof vi.fn
>;

describe("lab-sync", () => {
	beforeEach(() => {
		mockedLabProxy.mockReset();
	});

	afterEach(() => {
		mockedLabProxy.mockReset();
	});

	describe("fetchLabConfig", () => {
		it("returns sync fields from Lab response", async () => {
			mockedLabProxy.mockResolvedValue({
				ok: true,
				status: 200,
				body: {
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
				},
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

			// Verify proxy invocation — path is route-only; X-User-Id forwarded;
			// auth header is injected by the agent (not asserted here).
			expect(mockedLabProxy).toHaveBeenCalledWith({
				mode: "prod",
				method: "GET",
				path: "/api/gateway/config",
				headers: { "X-User-Id": "user-123" },
			});
		});

		it("never forwards naiaKey through the proxy headers", async () => {
			// Regression — Phase 6b SoT: shell must not stamp the key into any
			// header it sends to the agent. The agent owns X-AnyLLM-Key.
			mockedLabProxy.mockResolvedValue({
				ok: true,
				status: 200,
				body: { config: {} },
			});

			await fetchLabConfig("gw-secret-key", "user-123");

			const call = mockedLabProxy.mock.calls[0][0] as {
				headers?: Record<string, string>;
			};
			const headers = call.headers ?? {};
			for (const value of Object.values(headers)) {
				expect(value).not.toContain("gw-secret-key");
			}
			expect(headers["X-AnyLLM-Key"]).toBeUndefined();
			expect(headers["X-Desktop-Key"]).toBeUndefined();
			expect(headers.Authorization).toBeUndefined();
		});

		it("returns null on HTTP error", async () => {
			mockedLabProxy.mockResolvedValue({
				ok: false,
				status: 404,
				body: null,
			});
			const result = await fetchLabConfig("bad-key", "user-123");
			expect(result).toBeNull();
		});

		it("returns null when config is missing", async () => {
			mockedLabProxy.mockResolvedValue({
				ok: true,
				status: 200,
				body: { config: null },
			});
			const result = await fetchLabConfig("key", "user-123");
			expect(result).toBeNull();
		});

		it("returns null on network error", async () => {
			mockedLabProxy.mockRejectedValue(new Error("network error"));
			const result = await fetchLabConfig("key", "user-123");
			expect(result).toBeNull();
		});

		it("returns null when agent reports 401 (not_logged_in)", async () => {
			// Surfaces cleanly to the caller — no infinite retry, no throw.
			mockedLabProxy.mockResolvedValue({
				ok: false,
				status: 401,
				body: null,
				error: "not_logged_in",
			});
			const result = await fetchLabConfig("key", "user-123");
			expect(result).toBeNull();
		});

		it("returns null on transport status 0 (offline)", async () => {
			mockedLabProxy.mockResolvedValue({
				ok: false,
				status: 0,
				body: null,
				error: "network",
			});
			const result = await fetchLabConfig("key", "user-123");
			expect(result).toBeNull();
		});
	});

	describe("pushConfigToLab", () => {
		it("sends PATCH with sync fields only", () => {
			mockedLabProxy.mockResolvedValue({
				ok: true,
				status: 200,
				body: null,
			});
			pushConfigToLab("test-key", "user-123", {
				provider: "nextain",
				model: "gemini-3-flash-preview",
				apiKey: "secret-key",
				userName: "Luke",
				honorific: "님",
				speechStyle: "formal",
			});

			expect(mockedLabProxy).toHaveBeenCalledTimes(1);
			const call = mockedLabProxy.mock.calls[0][0] as {
				method: string;
				path: string;
				headers?: Record<string, string>;
				body: { config: Record<string, unknown> };
			};
			expect(call.method).toBe("PATCH");
			expect(call.path).toBe("/api/gateway/config");
			expect(call.headers).toEqual({ "X-User-Id": "user-123" });

			expect(call.body.config.userName).toBe("Luke");
			expect(call.body.config.honorific).toBe("님");
			expect(call.body.config.speechStyle).toBe("formal");
			// apiKey should NOT be in sync data
			expect(call.body.config.apiKey).toBeUndefined();
		});
	});

	describe("clearLabConfig", () => {
		it("issues PATCH with empty config", async () => {
			mockedLabProxy.mockResolvedValue({
				ok: true,
				status: 200,
				body: null,
			});
			await clearLabConfig("k", "user-123");
			expect(mockedLabProxy).toHaveBeenCalledWith({
				mode: "prod",
				method: "PATCH",
				path: "/api/gateway/config",
				headers: { "X-User-Id": "user-123" },
				body: { config: {} },
			});
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
