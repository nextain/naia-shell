import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LAB_GATEWAY_URL } from "./config";
import { Logger } from "./logger";
import { parseGatewayErrorCode } from "./steam-auth";

export interface SteamPack {
	id: string;
	price_cents: number;
	currency: string;
	credits: number;
	title?: string;
	description?: string;
}

export interface SteamOrderPack {
	id: string;
	price_cents: number;
	currency: string;
	credits: number;
}

export type SteamOrderStatus =
	| "CREATED"
	| "INITIATED"
	| "INIT_FAILED"
	| "GRANTED"
	| "FAILED"
	| "MISMATCH"
	| "REVERSED";

export const VALID_STEAM_ORDER_STATUSES: Set<string> = new Set([
	"CREATED",
	"INITIATED",
	"INIT_FAILED",
	"GRANTED",
	"FAILED",
	"MISMATCH",
	"REVERSED",
]);

export interface SteamOrderResponse {
	order_id: string;
	status: SteamOrderStatus | string;
	flow: "client" | "web";
	steamurl: string | null;
	pack: SteamOrderPack;
}

export interface SteamFinalizeResponse {
	status: string; // e.g. "GRANTED"
	granted_now: boolean;
}

export interface SteamMicrotxnAuthEvent {
	app_id: number;
	order_id: string;
	authorized: boolean;
}

export interface CreateSteamOrderOptions {
	gatewayUrl?: string;
	language?: string;
	idempotencyKey?: string;
	maxPollAttempts?: number;
	pollIntervalMs?: number;
	totalTimeoutMs?: number;
	onStatusChange?: (status: string) => void;
	onDelayNotice?: () => void;
	signal?: AbortSignal;
}

export class SteamOrderTimeoutError extends Error {
	readonly isTimeout = true;
	constructor(message = "Steam order creation deadline exceeded (10s)") {
		super(message);
		this.name = "SteamOrderTimeoutError";
	}
}

export function isSteamOrderTimeout(err: unknown): boolean {
	return (
		err instanceof SteamOrderTimeoutError ||
		(err as any)?.isTimeout === true ||
		(err as any)?.name === "SteamOrderTimeoutError"
	);
}

export interface FinalizeSteamOrderOptions {
	gatewayUrl?: string;
	maxRetries?: number;
	retryDelaysMs?: number[];
	signal?: AbortSignal;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			return reject(new Error("Aborted"));
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(new Error("Aborted"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/**
 * Fetches available Steam credit packs from the Naia Gateway.
 * Endpoint: GET /v1/billing/steam/packs (no auth required)
 */
export async function fetchSteamPacks(gatewayUrl?: string): Promise<SteamPack[]> {
	const baseUrl = (gatewayUrl || LAB_GATEWAY_URL).replace(/\/+$/, "");
	const response = await fetch(`${baseUrl}/v1/billing/steam/packs`, {
		method: "GET",
		headers: { Accept: "application/json" },
	});

	if (!response.ok) {
		let errorData: unknown;
		try {
			errorData = await response.json();
		} catch {
			throw new Error(`Failed to fetch Steam packs: HTTP ${response.status}`);
		}
		const code = parseGatewayErrorCode(errorData);
		throw new Error(
			code ? `Failed to fetch Steam packs: ${code}` : `HTTP ${response.status}`,
		);
	}

	const data = (await response.json()) as unknown;
	if (Array.isArray(data)) {
		return data as SteamPack[];
	}
	if (
		data &&
		typeof data === "object" &&
		"packs" in data &&
		Array.isArray((data as { packs: unknown }).packs)
	) {
		return (data as { packs: SteamPack[] }).packs;
	}
	return [];
}

/**
 * Creates or polls a Steam billing order.
 * Endpoint: POST /v1/billing/steam/orders (requires auth)
 * Request body strictly contains ONLY: { pack_id, flow: "client" | "web", language, idempotency_key }.
 */
export async function createSteamOrder(
	naiaKey: string,
	packId: string,
	options: CreateSteamOrderOptions = {},
): Promise<SteamOrderResponse> {
	const baseUrl = (options.gatewayUrl || LAB_GATEWAY_URL).replace(/\/+$/, "");
	const language = options.language || "korean";
	const idempotencyKey =
		options.idempotencyKey ||
		(typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `naia-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

	const maxPoll = options.maxPollAttempts ?? 10;
	const interval = options.pollIntervalMs ?? 1000;
	const totalTimeoutMs = options.totalTimeoutMs ?? 10000;

	// Total deadline begins BEFORE the first POST (#729 지적 7)
	const internalController = new AbortController();
	let timedOut = false;

	const onExternalAbort = () => {
		internalController.abort(options.signal?.reason ?? new Error("Aborted"));
	};

	if (options.signal) {
		if (options.signal.aborted) {
			throw options.signal.reason ?? new Error("Aborted");
		}
		options.signal.addEventListener("abort", onExternalAbort, { once: true });
	}

	const timeoutTimer = setTimeout(() => {
		timedOut = true;
		internalController.abort(new SteamOrderTimeoutError());
	}, totalTimeoutMs);

	const cleanup = () => {
		clearTimeout(timeoutTimer);
		if (options.signal) {
			options.signal.removeEventListener("abort", onExternalAbort);
		}
	};

	try {
		const sendOrderRequest = async (): Promise<SteamOrderResponse> => {
			const payload = {
				pack_id: packId,
				flow: "client",
				language,
				idempotency_key: idempotencyKey,
			};

			let response: Response;
			try {
				response = await fetch(`${baseUrl}/v1/billing/steam/orders`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-AnyLLM-Key": `Bearer ${naiaKey}`,
					},
					body: JSON.stringify(payload),
					signal: internalController.signal,
				});
			} catch (fetchErr: any) {
				if (timedOut) {
					throw new SteamOrderTimeoutError();
				}
				throw fetchErr;
			}

			if (!response.ok) {
				let errorData: unknown;
				try {
					errorData = await response.json();
				} catch {
					if (timedOut) {
						throw new SteamOrderTimeoutError();
					}
					throw new Error(`Order creation failed: HTTP ${response.status}`);
				}
				const code = parseGatewayErrorCode(errorData);
				if (response.status === 404 && code === "pack_not_found") {
					throw new Error("pack_not_found");
				}
				if (response.status === 409 && code === "steam_not_linked") {
					throw new Error("steam_not_linked");
				}
				if (response.status === 409 && code === "idempotency_key_reused") {
					throw new Error("idempotency_key_reused");
				}
				if (response.status === 503 && code === "provider_not_configured") {
					throw new Error("provider_not_configured");
				}
				throw new Error(
					code ? `Order creation failed: ${code}` : `HTTP ${response.status}`,
				);
			}

			let data: SteamOrderResponse;
			try {
				data = (await response.json()) as SteamOrderResponse;
			} catch (jsonErr) {
				if (timedOut) {
					throw new SteamOrderTimeoutError();
				}
				throw jsonErr;
			}
			// Ensure order_id is always a string
			data.order_id = String(data.order_id);
			return data;
		};

		let order = await sendOrderRequest();
		options.onStatusChange?.(order.status);

		// If client flow and status is CREATED, poll until INITIATED or non-CREATED up to maxPoll times
		let pollCount = 0;
		while (order.status === "CREATED") {
			pollCount++;
			if (pollCount > maxPoll || timedOut) {
				Logger.info(
					"SteamBilling",
					"Order status remained CREATED after limit, stopping poll",
				);
				options.onDelayNotice?.();
				break;
			}

			try {
				await sleep(interval, internalController.signal);
			} catch (sleepErr) {
				if (timedOut) {
					options.onDelayNotice?.();
					throw new SteamOrderTimeoutError();
				}
				throw sleepErr;
			}

			order = await sendOrderRequest();
			options.onStatusChange?.(order.status);

			if (order.status !== "CREATED") {
				break;
			}
		}

		return order;
	} catch (err) {
		if (timedOut) {
			throw new SteamOrderTimeoutError();
		}
		throw err;
	} finally {
		cleanup();
	}
}

/**
 * Finalizes an authorized Steam order to grant credits.
 * Endpoint: POST /v1/billing/steam/orders/{order_id}/finalize (requires auth)
 * Retries on 409 not_approved with exponential backoff (1s, 2s, 4s; max 3 retries).
 */
export async function finalizeSteamOrder(
	naiaKey: string,
	orderId: string,
	options: FinalizeSteamOrderOptions = {},
): Promise<SteamFinalizeResponse> {
	const baseUrl = (options.gatewayUrl || LAB_GATEWAY_URL).replace(/\/+$/, "");
	const maxRetries = options.maxRetries ?? 3;
	const retryDelays = options.retryDelaysMs ?? [1000, 2000, 4000];

	let attempt = 0;
	while (attempt <= maxRetries) {
		const response = await fetch(
			`${baseUrl}/v1/billing/steam/orders/${encodeURIComponent(orderId)}/finalize`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AnyLLM-Key": `Bearer ${naiaKey}`,
				},
				signal: options.signal,
			},
		);

		if (response.ok) {
			const data = (await response.json()) as SteamFinalizeResponse;
			Logger.info("SteamBilling", "Steam order finalized successfully", {
				orderId,
				grantedNow: data.granted_now,
			});
			return data;
		}

		let errorData: unknown;
		try {
			errorData = await response.json();
		} catch {
			throw new Error(`Order finalization failed: HTTP ${response.status}`);
		}
		const code = parseGatewayErrorCode(errorData);

		if (response.status === 409 && code === "not_approved") {
			if (attempt < maxRetries) {
				const delay = retryDelays[attempt] ?? 1000 * 2 ** attempt;
				Logger.info(
					"SteamBilling",
					`Order ${orderId} not approved yet, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
				);
				await sleep(delay, options.signal);
				attempt++;
				continue;
			}
			throw new Error("not_approved");
		}

		if (response.status === 409) {
			if (code === "order_init_failed") throw new Error("order_init_failed");
			if (code === "steam_failed") throw new Error("steam_failed");
			if (code === "order_reversed") throw new Error("order_reversed");
			throw new Error(code ? `Order finalize failed: ${code}` : "Order finalize failed (409)");
		}

		throw new Error(
			code ? `Order finalize failed: ${code}` : `HTTP ${response.status}`,
		);
	}

	throw new Error("not_approved");
}

export interface SteamAuthListener {
	unlisten: () => void;
	waitForOrder: (
		orderId: string,
		callbacks: {
			onAuthorized: () => void;
			onCancelled: () => void;
		},
	) => void;
}

/**
 * Creates an early listener for steam_microtxn_authorization events (#729).
 * Buffers any event arriving before order_id is known to prevent race conditions.
 */
export async function createSteamAuthListener(): Promise<SteamAuthListener> {
	const receivedEvents = new Map<string, SteamMicrotxnAuthEvent>();
	let pendingWaiter: {
		orderId: string;
		onAuthorized: () => void;
		onCancelled: () => void;
	} | null = null;

	const unlisten = await listen<SteamMicrotxnAuthEvent>(
		"steam_microtxn_authorization",
		(event) => {
			const receivedOrderId = String(event.payload.order_id);
			Logger.info("SteamBilling", "Received steam_microtxn_authorization", {
				orderId: receivedOrderId,
				authorized: event.payload.authorized,
			});

			if (pendingWaiter && pendingWaiter.orderId === receivedOrderId) {
				if (event.payload.authorized) {
					pendingWaiter.onAuthorized();
				} else {
					pendingWaiter.onCancelled();
				}
				pendingWaiter = null;
			} else {
				receivedEvents.set(receivedOrderId, event.payload);
			}
		},
	);

	return {
		unlisten: () => {
			unlisten();
			receivedEvents.clear();
			pendingWaiter = null;
		},
		waitForOrder: (orderId, callbacks) => {
			const targetId = String(orderId);
			if (receivedEvents.has(targetId)) {
				const event = receivedEvents.get(targetId)!;
				receivedEvents.delete(targetId);
				if (event.authorized) {
					callbacks.onAuthorized();
				} else {
					callbacks.onCancelled();
				}
			} else {
				pendingWaiter = {
					orderId: targetId,
					onAuthorized: callbacks.onAuthorized,
					onCancelled: callbacks.onCancelled,
				};
			}
		},
	};
}

/**
 * Subscribes to the native steam_microtxn_authorization event for a specific order.
 * Matches order_id as string.
 */
export async function listenToSteamAuthorization(
	orderId: string,
	callbacks: {
		onAuthorized: () => void;
		onCancelled: () => void;
	},
): Promise<UnlistenFn> {
	const targetOrderId = String(orderId);
	return await listen<SteamMicrotxnAuthEvent>(
		"steam_microtxn_authorization",
		(event) => {
			const receivedOrderId = String(event.payload.order_id);
			if (receivedOrderId !== targetOrderId) {
				return;
			}

			Logger.info("SteamBilling", "Received steam_microtxn_authorization", {
				orderId: receivedOrderId,
				authorized: event.payload.authorized,
			});

			if (event.payload.authorized) {
				callbacks.onAuthorized();
			} else {
				callbacks.onCancelled();
			}
		},
	);
}

/**
 * Checks if a given Steam checkout/store URL is allowed according to design specs.
 */
export function isAllowedSteamUrl(urlStr: string): boolean {
	try {
		const parsed = new URL(urlStr.trim());
		if (parsed.protocol !== "https:") return false;
		if (parsed.username !== "" || parsed.password !== "") return false;
		if (parsed.port !== "" && parsed.port !== "443") return false;
		const host = parsed.hostname.toLowerCase();
		return (
			host === "store.steampowered.com" ||
			host === "checkout.steampowered.com"
		);
	} catch {
		return false;
	}
}

/**
 * Opens a Steam URL (store or checkout) using the native steam_open_url command.
 */
export async function openSteamUrl(url: string): Promise<void> {
	if (!isAllowedSteamUrl(url)) {
		throw new Error("Invalid or disallowed Steam payment URL");
	}
	await invoke("steam_open_url", { url });
}
