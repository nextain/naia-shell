/**
 * On-demand retry unit tests — CONTRACT §8.1 T1-T7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ColdStartTimeoutError,
	SoldOutError,
	abandonPod,
	callWithRetry,
} from "../ondemand-retry";

function jsonResponse(status: number, body: Record<string, unknown>) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("callWithRetry — CONTRACT T1-T7", () => {
	it("T1: cold start → 60s later active (3 retries + success)", async () => {
		let call = 0;
		const mockFetch = vi.fn(async () => {
			call++;
			if (call <= 3) {
				return jsonResponse(503, {
					error: "pod-starting",
					retry_after_seconds: 5,
					pod_state: "STARTING",
					elapsed_seconds: call * 20,
				});
			}
			return jsonResponse(200, { choices: [{ message: { content: "hi" } }] });
		});
		vi.stubGlobal("fetch", mockFetch);

		const progressUpdates: number[] = [];
		const promise = callWithRetry("https://gw/v1/chat/completions", {}, (p) =>
			progressUpdates.push(p.elapsedSeconds),
		);

		// Advance through 3 retries (5s each)
		await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(5000);

		const resp = await promise;
		expect(resp.status).toBe(200);
		expect(mockFetch).toHaveBeenCalledTimes(4);
		expect(progressUpdates.length).toBe(3);
	});

	it("T2: sold-out → immediate throw, no retry", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(503, {
					error: "sold-out",
					tier_a_hint: "Use local model",
					retry_after_seconds: 60,
				}),
			),
		);

		await expect(
			callWithRetry("https://gw/v1/chat/completions", {}),
		).rejects.toThrow(SoldOutError);
	});

	it("T3: cold start exceeds 5min cap → ColdStartTimeoutError", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(503, {
					error: "pod-starting",
					retry_after_seconds: 60,
					pod_state: "STARTING",
				}),
			),
		);

		vi.useRealTimers(); // Need real Date.now for cap check
		const start = Date.now();
		// Mock Date.now to simulate 5+ minutes elapsed
		let elapsed = 0;
		const realDateNow = Date.now;
		vi.spyOn(Date, "now").mockImplementation(() => start + elapsed);

		const promise = callWithRetry("https://gw/v1/chat/completions", {});

		// Simulate time passing beyond 5 min cap
		// The function sleeps 60s each iteration; after ~5 iterations it should exceed 5 min
		// We need to make Date.now() return > 5 min from start
		elapsed = 5 * 60 * 1000 + 1;

		await expect(promise).rejects.toThrow(ColdStartTimeoutError);
		Date.now = realDateNow;
	});

	it("T4: auth failure 401 → returns response (caller handles)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(401, { error: "auth" })),
		);

		const resp = await callWithRetry("https://gw/v1/chat/completions", {});
		expect(resp.status).toBe(401);
	});

	it("T5: consent required 409 → returns response (caller handles)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(409, {
					error: "consent-required",
					branches: ["replace", "add"],
				}),
			),
		);

		const resp = await callWithRetry("https://gw/v1/chat/completions", {});
		expect(resp.status).toBe(409);
	});

	it("T6: capacity-exhausted → SoldOutError", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(503, { error: "capacity-exhausted" }),
			),
		);

		await expect(
			callWithRetry("https://gw/v1/chat/completions", {}),
		).rejects.toThrow(SoldOutError);
	});

	it("T7: abandon sends POST to /v1/pods/abandon", async () => {
		const mockFetch = vi.fn(async () => jsonResponse(200, {}));
		vi.stubGlobal("fetch", mockFetch);

		await abandonPod("https://gw", "user1:inst1", "gw-key123");

		expect(mockFetch).toHaveBeenCalledWith("https://gw/v1/pods/abandon", {
			method: "POST",
			headers: {
				Authorization: "Bearer gw-key123",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ instance_id: "user1:inst1" }),
		});
	});

	it("abort signal cancels retry loop", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse(503, {
					error: "pod-starting",
					retry_after_seconds: 5,
				}),
			),
		);

		const ac = new AbortController();
		const promise = callWithRetry(
			"https://gw/v1/chat/completions",
			{},
			undefined,
			ac.signal,
		);

		// Abort after first retry
		await vi.advanceTimersByTimeAsync(1000);
		ac.abort();

		await expect(promise).rejects.toThrow("Aborted");
	});
});
