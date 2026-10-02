// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, ...args: unknown[]) => {
		if (cmd === "frontend_log") return Promise.resolve();
		return invokeMock(cmd, ...args);
	}),
}));

let eventListeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
		eventListeners.set(eventName, handler);
		return () => {
			eventListeners.delete(eventName);
		};
	}),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
	VALID_STEAM_ORDER_STATUSES,
	SteamOrderTimeoutError,
	isSteamOrderTimeout,
	createSteamAuthListener,
	createSteamOrder,
	fetchSteamPacks,
	finalizeSteamOrder,
	isAllowedSteamUrl,
	listenToSteamAuthorization,
	openSteamUrl,
} from "../steam-billing";

describe("steam-billing client (#729)", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		fetchMock.mockReset();
		eventListeners.clear();
	});

	describe("VALID_STEAM_ORDER_STATUSES", () => {
		it("contains exactly the 7 expected order statuses and excludes PAID", () => {
			expect(VALID_STEAM_ORDER_STATUSES.has("CREATED")).toBe(true);
			expect(VALID_STEAM_ORDER_STATUSES.has("INITIATED")).toBe(true);
			expect(VALID_STEAM_ORDER_STATUSES.has("INIT_FAILED")).toBe(true);
			expect(VALID_STEAM_ORDER_STATUSES.has("GRANTED")).toBe(true);
			expect(VALID_STEAM_ORDER_STATUSES.has("FAILED")).toBe(true);
			expect(VALID_STEAM_ORDER_STATUSES.has("MISMATCH")).toBe(true);
			expect(VALID_STEAM_ORDER_STATUSES.has("REVERSED")).toBe(true);
			expect(VALID_STEAM_ORDER_STATUSES.has("PAID")).toBe(false);
			expect(VALID_STEAM_ORDER_STATUSES.size).toBe(7);
		});
	});

	describe("fetchSteamPacks", () => {
		it("fetches packs list successfully from array response", async () => {
			const mockPacks = [
				{ id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
				{ id: "pack-2", price_cents: 1999, currency: "USD", credits: 2500 },
			];
			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => mockPacks,
			});

			const packs = await fetchSteamPacks("https://api.naia.test");
			expect(packs).toEqual(mockPacks);
			expect(fetchMock).toHaveBeenCalledWith(
				"https://api.naia.test/v1/billing/steam/packs",
				expect.objectContaining({ method: "GET" }),
			);
		});

		it("fetches packs list successfully from { packs: [...] } response", async () => {
			const mockPacks = [
				{ id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
			];
			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ packs: mockPacks }),
			});

			const packs = await fetchSteamPacks("https://api.naia.test");
			expect(packs).toEqual(mockPacks);
		});

		it("throws gateway error on non-200", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 503,
				json: async () => ({ detail: { error: "provider_not_configured" } }),
			});

			await expect(
				fetchSteamPacks("https://api.naia.test"),
			).rejects.toThrow("Failed to fetch Steam packs: provider_not_configured");
		});
	});

	describe("createSteamOrder", () => {
		it("creates order directly when returned status is INITIATED", async () => {
			const mockOrder = {
				order_id: "987654321012345678",
				status: "INITIATED",
				flow: "client",
				steamurl: null,
				pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
			};
			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => mockOrder,
			});

			const order = await createSteamOrder("gw-key", "pack-1", {
				gatewayUrl: "https://api.naia.test",
				idempotencyKey: "idem-key-1",
				language: "english",
			});

			expect(order.order_id).toBe("987654321012345678");
			expect(order.status).toBe("INITIATED");

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, req] = fetchMock.mock.calls[0];
			expect(url).toBe("https://api.naia.test/v1/billing/steam/orders");
			expect(req.headers["X-AnyLLM-Key"]).toBe("Bearer gw-key");
			expect(JSON.parse(req.body)).toEqual({
				pack_id: "pack-1",
				flow: "client",
				language: "english",
				idempotency_key: "idem-key-1",
			});
		});

		it("preserves idempotencyKey and packId across retry calls when supplied (#729 지적 2)", async () => {
			const mockOrder = {
				order_id: "112233",
				status: "INITIATED",
				flow: "client",
				steamurl: null,
				pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
			};
			fetchMock.mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => mockOrder,
			});

			// Retry call with preserved attempt (fixed key and fixed packId)
			await createSteamOrder("gw-key", "pack-1", {
				gatewayUrl: "https://api.naia.test",
				idempotencyKey: "fixed-key-42",
			});
			const [, req1] = fetchMock.mock.calls[0];
			expect(JSON.parse(req1.body)).toMatchObject({
				idempotency_key: "fixed-key-42",
				pack_id: "pack-1",
			});

			// Second retry call retains both key and packId
			await createSteamOrder("gw-key", "pack-1", {
				gatewayUrl: "https://api.naia.test",
				idempotencyKey: "fixed-key-42",
			});
			const [, req2] = fetchMock.mock.calls[1];
			expect(JSON.parse(req2.body)).toMatchObject({
				idempotency_key: "fixed-key-42",
				pack_id: "pack-1",
			});

			// Brand-new purchase uses new packId and new key
			await createSteamOrder("gw-key", "pack-2", {
				gatewayUrl: "https://api.naia.test",
				idempotencyKey: "new-key-99",
			});
			const [, req3] = fetchMock.mock.calls[2];
			expect(JSON.parse(req3.body)).toMatchObject({
				idempotency_key: "new-key-99",
				pack_id: "pack-2",
			});
		});

		it("returns order directly when returned status is GRANTED", async () => {
			const mockOrder = {
				order_id: "order-granted-1",
				status: "GRANTED",
				flow: "client",
				steamurl: null,
				pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
			};
			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => mockOrder,
			});

			const order = await createSteamOrder("gw-key", "pack-1", {
				gatewayUrl: "https://api.naia.test",
			});

			expect(order.status).toBe("GRANTED");
			expect(order.order_id).toBe("order-granted-1");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("polls when initial status is CREATED until it becomes INITIATED", async () => {
			fetchMock
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "123456",
						status: "CREATED",
						flow: "client",
						steamurl: null,
						pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
					}),
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "123456",
						status: "INITIATED",
						flow: "client",
						steamurl: null,
						pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
					}),
				});

			const onStatusChange = vi.fn();
			const order = await createSteamOrder("gw-key", "pack-1", {
				gatewayUrl: "https://api.naia.test",
				pollIntervalMs: 10,
				onStatusChange,
			});

			expect(order.status).toBe("INITIATED");
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(onStatusChange).toHaveBeenCalledWith("CREATED");
			expect(onStatusChange).toHaveBeenCalledWith("INITIATED");
		});

		it("stops polling and returns order when status transitions from CREATED to INIT_FAILED", async () => {
			fetchMock
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "123456",
						status: "CREATED",
						flow: "client",
						steamurl: null,
						pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
					}),
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						order_id: "123456",
						status: "INIT_FAILED",
						flow: "client",
						steamurl: null,
						pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
					}),
				});

			const order = await createSteamOrder("gw-key", "pack-1", {
				gatewayUrl: "https://api.naia.test",
				pollIntervalMs: 10,
			});
			expect(order.status).toBe("INIT_FAILED");
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it("stops polling and returns order with CREATED when maxPollAttempts is reached (#729 P1 지적 8)", async () => {
			fetchMock.mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					order_id: "123456",
					status: "CREATED",
					flow: "client",
					steamurl: null,
					pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
				}),
			});

			const onDelayNotice = vi.fn();
			const order = await createSteamOrder("gw-key", "pack-1", {
				gatewayUrl: "https://api.naia.test",
				maxPollAttempts: 2,
				pollIntervalMs: 10,
				onDelayNotice,
			});

			expect(onDelayNotice).toHaveBeenCalledTimes(1);
			expect(order.status).toBe("CREATED");
			// Initial fetch + 2 poll iterations = 3 fetches
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});

		it("handles gateway error codes on order creation", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 409,
				json: async () => ({ detail: { error: "steam_not_linked" } }),
			});

			await expect(
				createSteamOrder("gw-key", "pack-1", { gatewayUrl: "https://api.naia.test" }),
			).rejects.toThrow("steam_not_linked");
		});

		it("aborts initial request and rejects with SteamOrderTimeoutError after 10s deadline (#729 지적 7)", async () => {
			vi.useFakeTimers();
			try {
				let capturedSignal: AbortSignal | null | undefined;
				fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
					capturedSignal = init?.signal;
					return new Promise((_resolve, reject) => {
						if (init?.signal?.aborted) {
							return reject(new DOMException("The operation was aborted.", "AbortError"));
						}
						init?.signal?.addEventListener("abort", () => {
							reject(new DOMException("The operation was aborted.", "AbortError"));
						});
					});
				});

				const promise = createSteamOrder("gw-key", "pack-1", {
					gatewayUrl: "https://api.naia.test",
					totalTimeoutMs: 10000,
				});
				const assertion = expect(promise).rejects.toThrow(SteamOrderTimeoutError);

				// Initially not aborted
				expect(capturedSignal?.aborted).toBe(false);

				// Fast forward to 10s deadline
				await vi.advanceTimersByTimeAsync(10000);

				await assertion;
				expect(capturedSignal?.aborted).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("aborts slow re-request during CREATED polling and rejects with SteamOrderTimeoutError after 10s deadline (#729 지적 7)", async () => {
			vi.useFakeTimers();
			try {
				let reRequestSignal: AbortSignal | null | undefined;
				let callCount = 0;
				fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
					callCount++;
					if (callCount === 1) {
						// Initial request returns CREATED immediately
						return Promise.resolve({
							ok: true,
							status: 200,
							json: async () => ({
								order_id: "order-poll-timeout",
								status: "CREATED",
								flow: "client",
								steamurl: null,
								pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
							}),
						});
					}
					// Second request hangs
					reRequestSignal = init?.signal;
					return new Promise((_resolve, reject) => {
						if (init?.signal?.aborted) {
							return reject(new DOMException("The operation was aborted.", "AbortError"));
						}
						init?.signal?.addEventListener("abort", () => {
							reject(new DOMException("The operation was aborted.", "AbortError"));
						});
					});
				});

				const promise = createSteamOrder("gw-key", "pack-1", {
					gatewayUrl: "https://api.naia.test",
					pollIntervalMs: 1000,
					totalTimeoutMs: 10000,
				});
				const assertion = expect(promise).rejects.toThrow(SteamOrderTimeoutError);

				// Advance past initial response and first poll interval (1000ms)
				await vi.advanceTimersByTimeAsync(1000);
				expect(callCount).toBe(2);
				expect(reRequestSignal?.aborted).toBe(false);

				// Advance remaining time to 10s total deadline
				await vi.advanceTimersByTimeAsync(9000);

				await assertion;
				expect(reRequestSignal?.aborted).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("initial response timeout after 10s deadline preserves idempotencyKey and packId on subsequent retry (#729 지적 4)", async () => {
			vi.useFakeTimers();
			try {
				const orderBodies: any[] = [];
				let callCount = 0;
				fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
					callCount++;
					if (init?.body) {
						orderBodies.push(JSON.parse(String(init.body)));
					}
					if (callCount === 1) {
						return new Promise((_resolve, reject) => {
							init?.signal?.addEventListener("abort", () => {
								reject(new DOMException("The operation was aborted.", "AbortError"));
							});
						});
					}
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-retry-initial-timeout",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: { id: "pack-1", price_cents: 999, currency: "USD", credits: 1000 },
						}),
					});
				});

				const key = "fixed-key-initial-timeout";
				const firstPromise = createSteamOrder("gw-key", "pack-1", {
					gatewayUrl: "https://api.naia.test",
					idempotencyKey: key,
					totalTimeoutMs: 10000,
				});
				const assertion = expect(firstPromise).rejects.toThrow(SteamOrderTimeoutError);

				await vi.advanceTimersByTimeAsync(10000);
				await assertion;

				expect(orderBodies.length).toBe(1);
				expect(orderBodies[0].idempotency_key).toBe(key);
				expect(orderBodies[0].pack_id).toBe("pack-1");

				// Retry request with preserved key and packId
				const retryResult = await createSteamOrder("gw-key", "pack-1", {
					gatewayUrl: "https://api.naia.test",
					idempotencyKey: key,
				});

				expect(orderBodies.length).toBe(2);
				expect(orderBodies[1].idempotency_key).toBe(key);
				expect(orderBodies[1].pack_id).toBe("pack-1");
				expect(retryResult.order_id).toBe("order-retry-initial-timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("slow re-request during CREATED polling timeout after 10s deadline preserves idempotencyKey and packId on subsequent retry (#729 지적 4)", async () => {
			vi.useFakeTimers();
			try {
				const orderBodies: any[] = [];
				let callCount = 0;
				fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
					callCount++;
					if (init?.body) {
						orderBodies.push(JSON.parse(String(init.body)));
					}
					if (callCount === 1) {
						return Promise.resolve({
							ok: true,
							status: 200,
							json: async () => ({
								order_id: "order-poll-1",
								status: "CREATED",
								flow: "client",
								steamurl: null,
								pack: { id: "pack-2", price_cents: 1999, currency: "USD", credits: 2500 },
							}),
						});
					}
					if (callCount === 2) {
						return new Promise((_resolve, reject) => {
							init?.signal?.addEventListener("abort", () => {
								reject(new DOMException("The operation was aborted.", "AbortError"));
							});
						});
					}
					return Promise.resolve({
						ok: true,
						status: 200,
						json: async () => ({
							order_id: "order-retry-created-timeout",
							status: "INITIATED",
							flow: "client",
							steamurl: null,
							pack: { id: "pack-2", price_cents: 1999, currency: "USD", credits: 2500 },
						}),
					});
				});

				const key = "fixed-key-created-timeout";
				const firstPromise = createSteamOrder("gw-key", "pack-2", {
					gatewayUrl: "https://api.naia.test",
					idempotencyKey: key,
					pollIntervalMs: 1000,
					totalTimeoutMs: 10000,
				});
				const assertion = expect(firstPromise).rejects.toThrow(SteamOrderTimeoutError);

				await vi.advanceTimersByTimeAsync(1000);
				await vi.advanceTimersByTimeAsync(9000);
				await assertion;

				expect(orderBodies.length).toBe(2);
				expect(orderBodies[0].idempotency_key).toBe(key);
				expect(orderBodies[0].pack_id).toBe("pack-2");
				expect(orderBodies[1].idempotency_key).toBe(key);
				expect(orderBodies[1].pack_id).toBe("pack-2");

				// Retry request with preserved key and packId
				const retryResult = await createSteamOrder("gw-key", "pack-2", {
					gatewayUrl: "https://api.naia.test",
					idempotencyKey: key,
				});

				expect(orderBodies.length).toBe(3);
				expect(orderBodies[2].idempotency_key).toBe(key);
				expect(orderBodies[2].pack_id).toBe("pack-2");
				expect(retryResult.order_id).toBe("order-retry-created-timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("distinguishes user cancellation from deadline timeout (#729 지적 7)", async () => {
			const controller = new AbortController();
			fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted.", "AbortError"));
					});
				});
			});

			const promise = createSteamOrder("gw-key", "pack-1", {
				gatewayUrl: "https://api.naia.test",
				signal: controller.signal,
				totalTimeoutMs: 10000,
			});

			controller.abort();

			await expect(promise).rejects.toThrow();
			try {
				await promise;
			} catch (err) {
				expect(isSteamOrderTimeout(err)).toBe(false);
			}
		});
	});

	describe("finalizeSteamOrder", () => {
		it("finalizes successfully on first attempt", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					status: "GRANTED",
					granted_now: true,
				}),
			});

			const res = await finalizeSteamOrder("gw-key", "order-999", {
				gatewayUrl: "https://api.naia.test",
			});

			expect(res).toEqual({ status: "GRANTED", granted_now: true });
			expect(fetchMock).toHaveBeenCalledWith(
				"https://api.naia.test/v1/billing/steam/orders/order-999/finalize",
				expect.objectContaining({
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-AnyLLM-Key": "Bearer gw-key",
					},
				}),
			);
		});

		it("handles granted_now: false for already finalized orders", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					status: "GRANTED",
					granted_now: false,
				}),
			});

			const res = await finalizeSteamOrder("gw-key", "order-999", {
				gatewayUrl: "https://api.naia.test",
			});

			expect(res).toEqual({ status: "GRANTED", granted_now: false });
		});

		it("retries on 409 not_approved with backoff and succeeds", async () => {
			fetchMock
				.mockResolvedValueOnce({
					ok: false,
					status: 409,
					json: async () => ({ detail: { error: "not_approved" } }),
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						status: "GRANTED",
						granted_now: true,
					}),
				});

			const res = await finalizeSteamOrder("gw-key", "order-999", {
				gatewayUrl: "https://api.naia.test",
				retryDelaysMs: [10, 20, 40],
			});

			expect(res.status).toBe("GRANTED");
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it("exhausts retries and throws not_approved", async () => {
			fetchMock.mockResolvedValue({
				ok: false,
				status: 409,
				json: async () => ({ detail: { error: "not_approved" } }),
			});

			await expect(
				finalizeSteamOrder("gw-key", "order-999", {
					gatewayUrl: "https://api.naia.test",
					maxRetries: 2,
					retryDelaysMs: [5, 10],
				}),
			).rejects.toThrow("not_approved");

			expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
		});

		it("does not retry on fatal 409 errors (steam_failed, order_init_failed, order_reversed)", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 409,
				json: async () => ({ detail: { error: "steam_failed" } }),
			});

			await expect(
				finalizeSteamOrder("gw-key", "order-999", {
					gatewayUrl: "https://api.naia.test",
				}),
			).rejects.toThrow("steam_failed");

			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	describe("createSteamAuthListener (#729 P1 지적 9)", () => {
		it("buffers event arriving BEFORE waitForOrder is called (race condition test)", async () => {
			const listener = await createSteamAuthListener();
			const handler = eventListeners.get("steam_microtxn_authorization");
			expect(handler).toBeDefined();

			// Microtransaction event arrives early from Steam SDK before order creation HTTP response
			handler!({
				payload: {
					app_id: 5354630,
					order_id: "order-early-123",
					authorized: true,
				},
			});

			// Now order creation finishes and waitForOrder is called
			const onAuthorized = vi.fn();
			const onCancelled = vi.fn();
			listener.waitForOrder("order-early-123", { onAuthorized, onCancelled });

			expect(onAuthorized).toHaveBeenCalledTimes(1);
			expect(onCancelled).not.toHaveBeenCalled();

			listener.unlisten();
		});

		it("handles early event with authorized: false", async () => {
			const listener = await createSteamAuthListener();
			const handler = eventListeners.get("steam_microtxn_authorization");

			handler!({
				payload: {
					app_id: 5354630,
					order_id: "order-cancel-456",
					authorized: false,
				},
			});

			const onAuthorized = vi.fn();
			const onCancelled = vi.fn();
			listener.waitForOrder("order-cancel-456", { onAuthorized, onCancelled });

			expect(onAuthorized).not.toHaveBeenCalled();
			expect(onCancelled).toHaveBeenCalledTimes(1);

			listener.unlisten();
		});

		it("handles event arriving AFTER waitForOrder is called", async () => {
			const listener = await createSteamAuthListener();
			const onAuthorized = vi.fn();
			const onCancelled = vi.fn();

			listener.waitForOrder("order-late-789", { onAuthorized, onCancelled });

			const handler = eventListeners.get("steam_microtxn_authorization");
			handler!({
				payload: {
					app_id: 5354630,
					order_id: "order-late-789",
					authorized: true,
				},
			});

			expect(onAuthorized).toHaveBeenCalledTimes(1);
			expect(onCancelled).not.toHaveBeenCalled();

			listener.unlisten();
		});

		it("cleans up listener and buffers on unlisten()", async () => {
			const listener = await createSteamAuthListener();
			expect(eventListeners.has("steam_microtxn_authorization")).toBe(true);
			listener.unlisten();
			expect(eventListeners.has("steam_microtxn_authorization")).toBe(false);
		});
	});

	describe("listenToSteamAuthorization", () => {
		it("triggers onAuthorized when order_id matches and authorized is true", async () => {
			const onAuthorized = vi.fn();
			const onCancelled = vi.fn();

			const unlisten = await listenToSteamAuthorization("998877", {
				onAuthorized,
				onCancelled,
			});

			const handler = eventListeners.get("steam_microtxn_authorization");
			expect(handler).toBeDefined();

			// Event for different order_id -> ignored
			handler!({
				payload: {
					app_id: 5354630,
					order_id: "112233",
					authorized: true,
				},
			});
			expect(onAuthorized).not.toHaveBeenCalled();

			// Event for matching order_id with authorized: true
			handler!({
				payload: {
					app_id: 5354630,
					order_id: "998877",
					authorized: true,
				},
			});
			expect(onAuthorized).toHaveBeenCalledTimes(1);
			expect(onCancelled).not.toHaveBeenCalled();

			unlisten();
		});

		it("triggers onCancelled when order_id matches and authorized is false", async () => {
			const onAuthorized = vi.fn();
			const onCancelled = vi.fn();

			await listenToSteamAuthorization("998877", {
				onAuthorized,
				onCancelled,
			});

			const handler = eventListeners.get("steam_microtxn_authorization");
			handler!({
				payload: {
					app_id: 5354630,
					order_id: "998877",
					authorized: false,
				},
			});

			expect(onAuthorized).not.toHaveBeenCalled();
			expect(onCancelled).toHaveBeenCalledTimes(1);
		});
	});

	describe("isAllowedSteamUrl (#729 P2 지적 10, 지적 1)", () => {
		it("accepts valid Steam store and checkout URLs", () => {
			expect(
				isAllowedSteamUrl("https://store.steampowered.com/checkout/order-123"),
			).toBe(true);
			expect(
				isAllowedSteamUrl("https://checkout.steampowered.com/pay/order-456"),
			).toBe(true);
			expect(
				isAllowedSteamUrl("https://store.steampowered.com:443/app/5354630"),
			).toBe(true);
			expect(
				isAllowedSteamUrl("HTTPS://STORE.STEAMPOWERED.COM/"),
			).toBe(true);
			expect(
				isAllowedSteamUrl("https://CHECKOUT.STEAMPOWERED.COM/checkout/order/12345"),
			).toBe(true);
		});

		it("rejects non-https, external domains, userinfo, non-443 ports, and malformed strings", () => {
			expect(isAllowedSteamUrl("http://store.steampowered.com/checkout")).toBe(false);
			expect(isAllowedSteamUrl("https://evil.com/store.steampowered.com")).toBe(false);
			expect(isAllowedSteamUrl("javascript:alert(1)")).toBe(false);
			expect(isAllowedSteamUrl("not-a-url")).toBe(false);
			// #729 지적 1 회귀 테스트
			expect(
				isAllowedSteamUrl("https://store.steampowered.com:443@evil.example/path"),
			).toBe(false);
			expect(
				isAllowedSteamUrl("https://store.steampowered.com.evil.example/"),
			).toBe(false);
			expect(
				isAllowedSteamUrl("https://evil.example/?u=https://store.steampowered.com"),
			).toBe(false);
			expect(
				isAllowedSteamUrl("https://user:pass@store.steampowered.com/"),
			).toBe(false);
			expect(
				isAllowedSteamUrl("https://store.steampowered.com:8080/checkout"),
			).toBe(false);
		});
	});

	describe("openSteamUrl", () => {
		it("invokes native steam_open_url on allowed URL", async () => {
			invokeMock.mockResolvedValueOnce(undefined);
			await openSteamUrl("https://store.steampowered.com/checkout");
			expect(invokeMock).toHaveBeenCalledWith("steam_open_url", {
				url: "https://store.steampowered.com/checkout",
			});
		});

		it("rejects disallowed URL without invoking steam_open_url", async () => {
			await expect(openSteamUrl("https://malicious-site.example/pay")).rejects.toThrow(
				"Invalid or disallowed Steam payment URL",
			);
			expect(invokeMock).not.toHaveBeenCalled();
		});
	});
});
