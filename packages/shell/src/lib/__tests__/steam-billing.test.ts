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
	createSteamOrder,
	fetchSteamPacks,
	finalizeSteamOrder,
	listenToSteamAuthorization,
	openSteamUrl,
} from "../steam-billing";

describe("steam-billing client (#729)", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		fetchMock.mockReset();
		eventListeners.clear();
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

		it("throws order_init_failed if polling encounters INIT_FAILED", async () => {
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

			await expect(
				createSteamOrder("gw-key", "pack-1", {
					gatewayUrl: "https://api.naia.test",
					pollIntervalMs: 10,
				}),
			).rejects.toThrow("order_init_failed");
		});

		it("triggers onDelayNotice if CREATED persists beyond maxPollAttempts", async () => {
			// Returns CREATED 3 times, then INITIATED on 4th
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

			const onDelayNotice = vi.fn();
			const order = await createSteamOrder("gw-key", "pack-1", {
				gatewayUrl: "https://api.naia.test",
				maxPollAttempts: 1, // trigger delay notice after 1 poll
				pollIntervalMs: 10,
				onDelayNotice,
			});

			expect(onDelayNotice).toHaveBeenCalledTimes(1);
			expect(order.status).toBe("INITIATED");
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

		it("does not retry on fatal 409 errors (steam_failed, order_init_failed)", async () => {
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

	describe("openSteamUrl", () => {
		it("invokes native steam_open_url", async () => {
			invokeMock.mockResolvedValueOnce(undefined);
			await openSteamUrl("https://store.steampowered.com/checkout");
			expect(invokeMock).toHaveBeenCalledWith("steam_open_url", {
				url: "https://store.steampowered.com/checkout",
			});
		});
	});
});
