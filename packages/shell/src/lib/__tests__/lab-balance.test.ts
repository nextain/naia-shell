// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	isLabBalanceUnauthorized,
	markNaiaKeyUnauthorized,
	onNaiaKeyUnauthorized,
	parseLabCredits,
} from "../lab-balance";

describe("parseLabCredits", () => {
	it("normalizes direct and nested gateway micro-dollar balances", () => {
		expect(parseLabCredits({ balance: 1_250_000 })).toBe(12.5);
		expect(parseLabCredits({ data: { balance: 250_000 } })).toBe(2.5);
	});

	it("accepts the already-normalized Naia account credits response", () => {
		expect(parseLabCredits({ credits: 10 })).toBe(10);
		expect(parseLabCredits({ data: { credits: 4.25 } })).toBe(4.25);
	});

	it("rejects malformed balances", () => {
		expect(parseLabCredits({ balance: "100" })).toBeNull();
		expect(parseLabCredits(null)).toBeNull();
	});
});

describe("isLabBalanceUnauthorized", () => {
	// #402: a stale/revoked Naia key must be told apart from a transient
	// network failure so the UI can flip to a re-login state instead of a
	// retryable error while still showing "connected".
	it("recognizes the browser fetch 401 error shape", () => {
		expect(isLabBalanceUnauthorized(new Error("HTTP 401"))).toBe(true);
	});

	it("recognizes the Tauri invoke rejection string shape", () => {
		expect(isLabBalanceUnauthorized("Naia balance HTTP 401")).toBe(true);
	});

	it("does not flag other HTTP failures or network errors", () => {
		expect(isLabBalanceUnauthorized(new Error("HTTP 500"))).toBe(false);
		expect(isLabBalanceUnauthorized(new Error("Naia balance HTTP 503"))).toBe(
			false,
		);
		expect(isLabBalanceUnauthorized(new Error("Failed to fetch"))).toBe(false);
		expect(
			isLabBalanceUnauthorized(new DOMException("The operation was aborted")),
		).toBe(false);
	});
});

describe("markNaiaKeyUnauthorized / onNaiaKeyUnauthorized", () => {
	// #402: the balance endpoint and a chat completion both funnel their 401
	// through this same broadcast so every mounted "connected" surface flips
	// to a re-login state together, however the 401 was actually observed.
	it("notifies subscribers when the key is marked unauthorized", () => {
		const handler = vi.fn();
		const unsubscribe = onNaiaKeyUnauthorized(handler);

		markNaiaKeyUnauthorized();

		expect(handler).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("stops notifying once unsubscribed", () => {
		const handler = vi.fn();
		const unsubscribe = onNaiaKeyUnauthorized(handler);
		unsubscribe();

		markNaiaKeyUnauthorized();

		expect(handler).not.toHaveBeenCalled();
	});
});

describe("web balance routing", () => {
	it("uses browser HTTP even when the web runtime installs the Tauri shim", async () => {
		const { setWebAssetsModeForTests } = await import(
			"../web-runtime/web-assets"
		);
		const { fetchLabBalancePayload } = await import("../lab-balance");
		setWebAssetsModeForTests(true);
		const invoke = vi.fn();
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: { invoke },
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, json: async () => ({ balance: 200000 }) });
		vi.stubGlobal("fetch", fetchMock);
		try {
			expect(
				await fetchLabBalancePayload("https://example.test/", "test-key"),
			).toEqual({ balance: 200000 });
			expect(fetchMock).toHaveBeenCalledWith(
				"https://example.test/v1/profile/balance",
				expect.objectContaining({
					headers: { "X-AnyLLM-Key": "Bearer test-key" },
				}),
			);
			expect(invoke).not.toHaveBeenCalled();
		} finally {
			setWebAssetsModeForTests(null);
			Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
			vi.unstubAllGlobals();
		}
	});
});
