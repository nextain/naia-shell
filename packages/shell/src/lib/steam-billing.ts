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

export interface SteamOrderResponse {
	order_id: string;
	status: "CREATED" | "INITIATED" | "INIT_FAILED" | "PAID" | string;
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
	onStatusChange?: (status: string) => void;
	onDelayNotice?: () => void;
	signal?: AbortSignal;
}

export interface FinalizeSteamOrderOptions {
	gatewayUrl?: string;
	maxRetries?: number;
	retryDelaysMs?: number[];
	signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
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

	const sendOrderRequest = async (): Promise<SteamOrderResponse> => {
		const payload = {
			pack_id: packId,
			flow: "client",
			language,
			idempotency_key: idempotencyKey,
		};

		const response = await fetch(`${baseUrl}/v1/billing/steam/orders`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AnyLLM-Key": `Bearer ${naiaKey}`,
			},
			body: JSON.stringify(payload),
			signal: options.signal,
		});

		if (!response.ok) {
			let errorData: unknown;
			try {
				errorData = await response.json();
			} catch {
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

		const data = (await response.json()) as SteamOrderResponse;
		// Ensure order_id is always a string
		data.order_id = String(data.order_id);
		return data;
	};

	let order = await sendOrderRequest();
	options.onStatusChange?.(order.status);

	// If client flow and status is CREATED, poll until INITIATED or INIT_FAILED
	let pollCount = 0;
	while (order.status === "CREATED") {
		pollCount++;
		if (pollCount > maxPoll) {
			Logger.info("SteamBilling", "Order status remained CREATED after 10s, entering delay notice state");
			options.onDelayNotice?.();
			// Continue polling with delay notice active until aborted or status changes
		}

		await sleep(interval, options.signal);
		order = await sendOrderRequest();
		options.onStatusChange?.(order.status);

		if (order.status === "INIT_FAILED") {
			throw new Error("order_init_failed");
		}
		if (order.status === "INITIATED" || order.status === "PAID") {
			break;
		}
	}

	if (order.status === "INIT_FAILED") {
		throw new Error("order_init_failed");
	}

	return order;
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

/**
 * Subscribes to the native steam_microtxn_authorization event.
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
 * Opens a Steam URL (store or checkout) using the native steam_open_url command.
 */
export async function openSteamUrl(url: string): Promise<void> {
	await invoke("steam_open_url", { url });
}
