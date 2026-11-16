/**
 * Apple App Store (StoreKit 2) & Google Play Billing native receipt -> Naia Gateway
 * `StoreOrder` verification bridge, product catalog, and App Store Guideline 3.1.1 /
 * Google Play Payments external web-checkout blocker.
 */

import {
	type CapacitorPluginObject,
	type MobileShellPlatform,
	type PlatformProbeEnv,
	detectMobileShellPlatform,
	getCapacitorPlugin,
} from "./platform";

export type MobileIapStoreProvider = "apple" | "google";
export type MobileStoreProductKind = "pack" | "subscription";

export interface MobileStoreProduct {
	readonly id: string;
	readonly kind: MobileStoreProductKind;
	readonly priceCentsUsd: number;
	readonly webCredits: number;
	/** Integer `Math.floor((webCredits * 4) / 5)` matching `naia-anyllm` `store_catalog.py`. */
	readonly storeCredits: number;
	readonly appleProductId: string;
	readonly googleProductId: string;
	readonly description: string;
}

export const MOBILE_BUNDLE_ID = "land.naia.mobile" as const;

function calcStoreCredits(webCredits: number): number {
	return Math.floor((webCredits * 4) / 5);
}

/**
 * Canonical mobile in-app purchase catalog aligned 1:1 with
 * `naia-anyllm/src/any_llm/gateway/billing/store_catalog.py`.
 */
export const MOBILE_STORE_PRODUCTS: readonly MobileStoreProduct[] = [
	{
		id: "credits-10",
		kind: "pack",
		priceCentsUsd: 1000,
		webCredits: 10_000,
		storeCredits: calcStoreCredits(10_000), // 8,000
		appleProductId: "land.naia.credits.10",
		googleProductId: "land.naia.credits.10",
		description: "Naia Credits 8,000 Pack",
	},
	{
		id: "credits-30",
		kind: "pack",
		priceCentsUsd: 3000,
		webCredits: 30_300,
		storeCredits: calcStoreCredits(30_300), // 24,240
		appleProductId: "land.naia.credits.30",
		googleProductId: "land.naia.credits.30",
		description: "Naia Credits 24,240 Pack",
	},
	{
		id: "credits-60",
		kind: "pack",
		priceCentsUsd: 6000,
		webCredits: 61_200,
		storeCredits: calcStoreCredits(61_200), // 48,960
		appleProductId: "land.naia.credits.60",
		googleProductId: "land.naia.credits.60",
		description: "Naia Credits 48,960 Pack",
	},
	{
		id: "credits-100",
		kind: "pack",
		priceCentsUsd: 10_000,
		webCredits: 103_000,
		storeCredits: calcStoreCredits(103_000), // 82,400
		appleProductId: "land.naia.credits.100",
		googleProductId: "land.naia.credits.100",
		description: "Naia Credits 82,400 Pack",
	},
	{
		id: "sub-basic",
		kind: "subscription",
		priceCentsUsd: 1000,
		webCredits: 10_000,
		storeCredits: calcStoreCredits(10_000), // 8,000
		appleProductId: "land.naia.sub.basic",
		googleProductId: "land.naia.sub.basic",
		description: "Naia Basic Monthly Subscription",
	},
	{
		id: "sub-pro",
		kind: "subscription",
		priceCentsUsd: 3000,
		webCredits: 30_300,
		storeCredits: calcStoreCredits(30_300), // 24,240
		appleProductId: "land.naia.sub.pro",
		googleProductId: "land.naia.sub.pro",
		description: "Naia Pro Monthly Subscription",
	},
] as const;

export function findMobileStoreProduct(
	idOrStoreSku: string,
): MobileStoreProduct | undefined {
	const target = idOrStoreSku.trim().toLowerCase();
	return MOBILE_STORE_PRODUCTS.find(
		(p) =>
			p.id.toLowerCase() === target ||
			p.appleProductId.toLowerCase() === target ||
			p.googleProductId.toLowerCase() === target,
	);
}

export interface MobileBillingPolicy {
	platform: MobileShellPlatform;
	hideExternalWebCheckout: boolean;
	nativeStoreProvider: MobileIapStoreProvider | null;
}

/**
 * Mandatory App Store Review Guideline 3.1.1 & Google Play Payments Policy guard:
 * Returns `true` inside packaged Capacitor iOS/Android apps so external web
 * payment links (Stripe / Toss / `naia.land/pricing` checkout) are hidden.
 */
export function shouldHideExternalWebCheckout(env?: PlatformProbeEnv): boolean {
	const platform = detectMobileShellPlatform(env);
	return platform === "ios-capacitor" || platform === "android-capacitor";
}

export function resolveMobileBillingPolicy(
	env?: PlatformProbeEnv,
): MobileBillingPolicy {
	const platform = detectMobileShellPlatform(env);
	if (platform === "ios-capacitor") {
		return {
			platform,
			hideExternalWebCheckout: true,
			nativeStoreProvider: "apple",
		};
	}
	if (platform === "android-capacitor") {
		return {
			platform,
			hideExternalWebCheckout: true,
			nativeStoreProvider: "google",
		};
	}
	return {
		platform,
		hideExternalWebCheckout: false,
		nativeStoreProvider: null,
	};
}

const EXTERNAL_CHECKOUT_PATH_RE =
	/(?:^|\/)(?:pricing|checkout|billing|subscribe|topup|credits\/buy)(?:\/|$|\?|#)/i;
const EXTERNAL_PG_HOST_RE =
	/(?:checkout\.stripe\.com|buy\.stripe\.com|pay\.toss\.im|portone\.io|paypal\.com)$/i;

/**
 * Sanitize outbound URLs in native mobile shells: returns `null` if `url` points
 * to an external web payment / subscription checkout screen while running inside
 * an App Store / Play Store Capacitor build.
 */
export function guardExternalCheckoutUrl(
	url: string,
	env?: PlatformProbeEnv,
): string | null {
	const trimmed = url.trim();
	if (!trimmed) return null;
	if (!shouldHideExternalWebCheckout(env)) {
		return trimmed;
	}
	try {
		const parsed = new URL(trimmed, "https://www.naia.land");
		if (EXTERNAL_PG_HOST_RE.test(parsed.hostname)) {
			return null;
		}
		if (
			/(?:^|\.)naia\.land$/i.test(parsed.hostname) &&
			EXTERNAL_CHECKOUT_PATH_RE.test(parsed.pathname)
		) {
			return null;
		}
		return trimmed;
	} catch {
		return EXTERNAL_CHECKOUT_PATH_RE.test(trimmed) ? null : trimmed;
	}
}

export class MobileIapVerificationError extends Error {
	readonly status: number;
	readonly errorCode: string;
	readonly retryable: boolean;

	constructor(params: {
		message: string;
		status: number;
		errorCode: string;
		retryable: boolean;
	}) {
		super(params.message);
		this.name = "MobileIapVerificationError";
		this.status = params.status;
		this.errorCode = params.errorCode;
		this.retryable = params.retryable;
	}
}

const JWS_COMPACT_RE =
	/^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate StoreKit 2 JWS compact serialization (`header.payload.signature`) locally. */
export function isValidStoreKitJwsFormat(jws: string): boolean {
	return JWS_COMPACT_RE.test(jws.trim());
}

export interface StoreOrderGrantResponse {
	status: "granted" | "already_granted";
	product_id: string;
	credits: number;
	store_transaction_id: string;
}

export interface SubmitAppleTransactionInput {
	/** JWS-signed transaction string emitted by StoreKit 2 (`Transaction.jwsRepresentation`). */
	signedTransaction: string;
	signal?: AbortSignal;
}

export interface SubmitGooglePurchaseInput {
	packageName?: string;
	productId: string;
	purchaseToken: string;
	orderId?: string;
	obfuscatedAccountId?: string;
	signal?: AbortSignal;
}

export interface MobileIapBridgeConfig {
	gatewayUrl: string;
	/** User session JWT (`Authorization: Bearer <jwt>`) or Naia API key (`X-AnyLLM-Key`). */
	getAuthHeader: () =>
		| Promise<{ jwt?: string; naiaKey?: string }>
		| { jwt?: string; naiaKey?: string };
	packageName?: string;
	/** Maximum retry attempts on transient network / 5xx / 429 failures (default `3`). */
	maxRetries?: number;
	/** Base backoff delay in ms between retries (default `400`). */
	baseRetryDelayMs?: number;
	fetchImpl?: typeof fetch;
	env?: PlatformProbeEnv;
}

export interface NativePurchaseTransaction {
	provider: MobileIapStoreProvider;
	productId: string;
	transactionId: string;
	/** StoreKit 2 JWS string (iOS). */
	jwsRepresentation?: string;
	/** Google Play purchaseToken (Android). */
	purchaseToken?: string;
	/** Finish/acknowledge transaction on device ONLY after gateway `StoreOrder` commit. */
	finish?: () => Promise<void>;
}

interface CapacitorNativePurchasesPlugin extends CapacitorPluginObject {
	purchaseProduct?: (opts: {
		productIdentifier: string;
		productType?: "inapp" | "subs";
		appAccountToken?: string;
		quantity?: number;
	}) => Promise<{
		transactionId?: string;
		productIdentifier?: string;
		jwsRepresentation?: string;
		purchaseToken?: string;
		orderId?: string;
	}>;
	finishTransaction?: (opts: {
		transactionId?: string;
		purchaseToken?: string;
	}) => Promise<void>;
	getPurchases?: () => Promise<{
		purchases?: Array<{
			transactionId?: string;
			productIdentifier?: string;
			jwsRepresentation?: string;
			purchaseToken?: string;
			orderId?: string;
		}>;
	}>;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

async function parseGatewayErrorCode(response: Response): Promise<{
	errorCode: string;
	detailMessage: string;
}> {
	try {
		const body = (await response.json()) as {
			detail?: { error?: string; message?: string } | string;
			error?: string;
		};
		if (body.detail && typeof body.detail === "object") {
			return {
				errorCode: body.detail.error ?? `http_${response.status}`,
				detailMessage:
					body.detail.message ?? body.detail.error ?? response.statusText,
			};
		}
		if (typeof body.detail === "string") {
			return { errorCode: body.detail, detailMessage: body.detail };
		}
		if (typeof body.error === "string") {
			return { errorCode: body.error, detailMessage: body.error };
		}
	} catch {
		/* Ignore non-JSON error body */
	}
	return {
		errorCode: `http_${response.status}`,
		detailMessage: response.statusText || `HTTP ${response.status}`,
	};
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Production adapter linking StoreKit 2 / Google Play Billing receipts to
 * `naia-anyllm` Gateway `StoreOrder` endpoints (`/v1/billing/apple/*`, `/v1/billing/google/*`).
 */
export class MobileIapGatewayBridge {
	private readonly gatewayBase: string;
	private readonly getAuthHeader: MobileIapBridgeConfig["getAuthHeader"];
	private readonly packageName: string;
	private readonly maxRetries: number;
	private readonly baseRetryDelayMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly env?: PlatformProbeEnv;

	constructor(config: MobileIapBridgeConfig) {
		const base = config.gatewayUrl.trim().replace(/\/+$/, "");
		if (!base) {
			throw new Error("MobileIapGatewayBridge requires a non-empty gatewayUrl");
		}
		this.gatewayBase = base;
		this.getAuthHeader = config.getAuthHeader;
		this.packageName = config.packageName?.trim() || MOBILE_BUNDLE_ID;
		this.maxRetries = Math.max(0, config.maxRetries ?? 3);
		this.baseRetryDelayMs = Math.max(10, config.baseRetryDelayMs ?? 400);
		this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.env = config.env;
	}

	/**
	 * Fetch deterministic UUID `app_account_token` (`GET /v1/billing/apple/account-token`)
	 * to bind StoreKit 2 purchases and Server Notifications v2 to the user's Naia account.
	 */
	async fetchAppleAccountToken(signal?: AbortSignal): Promise<string> {
		const data = await this.requestJson<{ app_account_token?: string }>(
			"/v1/billing/apple/account-token",
			{ method: "GET", signal },
		);
		const token = (data.app_account_token ?? "").trim();
		if (!UUID_RE.test(token)) {
			throw new MobileIapVerificationError({
				message: "Gateway returned an invalid Apple app_account_token UUID",
				status: 502,
				errorCode: "invalid_account_token",
				retryable: false,
			});
		}
		return token;
	}

	/**
	 * Fetch obfuscated account token for Google Play Billing (`GET /v1/billing/google/account-token`).
	 */
	async fetchGoogleAccountToken(signal?: AbortSignal): Promise<string> {
		const data = await this.requestJson<{ obfuscated_account_id?: string }>(
			"/v1/billing/google/account-token",
			{ method: "GET", signal },
		);
		const id = (data.obfuscated_account_id ?? "").trim();
		if (!id) {
			throw new MobileIapVerificationError({
				message: "Gateway returned an empty Google obfuscated_account_id",
				status: 502,
				errorCode: "invalid_account_token",
				retryable: false,
			});
		}
		return id;
	}

	/**
	 * Submit a StoreKit 2 signed JWS transaction to `POST /v1/billing/apple/transactions`.
	 * Strictly sends `{ signed_transaction }` only (`ConfigDict(extra="forbid")` compliant).
	 */
	async submitAppleTransaction(
		input: SubmitAppleTransactionInput,
	): Promise<StoreOrderGrantResponse> {
		const jws = input.signedTransaction.trim();
		if (!isValidStoreKitJwsFormat(jws)) {
			throw new MobileIapVerificationError({
				message:
					"Invalid StoreKit 2 signed_transaction JWS compact serialization format",
				status: 400,
				errorCode: "invalid_jws_format",
				retryable: false,
			});
		}

		return await this.requestJson<StoreOrderGrantResponse>(
			"/v1/billing/apple/transactions",
			{
				method: "POST",
				body: JSON.stringify({ signed_transaction: jws }),
				signal: input.signal,
			},
		);
	}

	/**
	 * Submit a Google Play Billing purchase token to `POST /v1/billing/google/transactions`.
	 */
	async submitGooglePurchase(
		input: SubmitGooglePurchaseInput,
	): Promise<StoreOrderGrantResponse> {
		const productId = input.productId.trim();
		const purchaseToken = input.purchaseToken.trim();
		const packageName = (input.packageName ?? this.packageName).trim();

		if (!productId || !purchaseToken || !packageName) {
			throw new MobileIapVerificationError({
				message:
					"Google Play receipt requires non-empty packageName, productId, and purchaseToken",
				status: 400,
				errorCode: "invalid_google_receipt_payload",
				retryable: false,
			});
		}

		const payload: Record<string, string> = {
			package_name: packageName,
			product_id: productId,
			purchase_token: purchaseToken,
		};
		if (input.orderId?.trim()) {
			payload.order_id = input.orderId.trim();
		}
		if (input.obfuscatedAccountId?.trim()) {
			payload.obfuscated_account_id = input.obfuscatedAccountId.trim();
		}

		return await this.requestJson<StoreOrderGrantResponse>(
			"/v1/billing/google/transactions",
			{
				method: "POST",
				body: JSON.stringify(payload),
				signal: input.signal,
			},
		);
	}

	/**
	 * End-to-end native store purchase flow via Capacitor `NativePurchases` plugin:
	 *  1.Enforces native mobile platform policy (`ios-capacitor` or `android-capacitor`)
	 *  2. Fetches deterministic account token (`appAccountToken` / `obfuscatedAccountId`)
	 *  3. Invokes native StoreKit 2 / Play Billing sheet
	 *  4. Submits receipt to Naia Gateway `StoreOrder` (with idempotent backoff retries)
	 *  5. Calls `finishTransaction` ONLY after Gateway grants/confirms the order!
	 */
	async purchaseProductViaNativeBridge(
		productOrId: string | MobileStoreProduct,
		signal?: AbortSignal,
	): Promise<StoreOrderGrantResponse> {
		const policy = resolveMobileBillingPolicy(this.env);
		if (!policy.nativeStoreProvider) {
			throw new MobileIapVerificationError({
				message: `Native in-app purchase is unavailable on platform "${policy.platform}"`,
				status: 400,
				errorCode: "unsupported_platform",
				retryable: false,
			});
		}

		const product =
			typeof productOrId === "string"
				? findMobileStoreProduct(productOrId)
				: productOrId;
		if (!product) {
			throw new MobileIapVerificationError({
				message: `Unknown mobile store product "${String(productOrId)}"`,
				status: 422,
				errorCode: "unknown_product",
				retryable: false,
			});
		}

		const plugin = getCapacitorPlugin<CapacitorNativePurchasesPlugin>(
			"NativePurchases",
			this.env,
		);
		if (!plugin || typeof plugin.purchaseProduct !== "function") {
			throw new MobileIapVerificationError({
				message: "Capacitor NativePurchases plugin is not registered",
				status: 503,
				errorCode: "native_plugin_unavailable",
				retryable: false,
			});
		}

		const isApple = policy.nativeStoreProvider === "apple";
		const sku = isApple ? product.appleProductId : product.googleProductId;
		const accountToken = isApple
			? await this.fetchAppleAccountToken(signal)
			: await this.fetchGoogleAccountToken(signal).catch(() => undefined);

		const tx = await plugin.purchaseProduct({
			productIdentifier: sku,
			productType: product.kind === "subscription" ? "subs" : "inapp",
			appAccountToken: accountToken,
			quantity: 1,
		});

		let grant: StoreOrderGrantResponse;
		if (isApple) {
			grant = await this.submitAppleTransaction({
				signedTransaction: tx.jwsRepresentation ?? "",
				signal,
			});
		} else {
			grant = await this.submitGooglePurchase({
				productId: tx.productIdentifier ?? sku,
				purchaseToken: tx.purchaseToken ?? "",
				orderId: tx.orderId ?? tx.transactionId,
				obfuscatedAccountId: accountToken,
				signal,
			});
		}

		// Acknowledge/finish native transaction ONLY after Gateway StoreOrder commits!
		if (typeof plugin.finishTransaction === "function") {
			await plugin.finishTransaction({
				transactionId: tx.transactionId,
				purchaseToken: tx.purchaseToken,
			});
		}

		return grant;
	}

	private async buildAuthHeaders(): Promise<Record<string, string>> {
		const auth = await this.getAuthHeader();
		const jwt = auth?.jwt?.trim();
		const naiaKey = auth?.naiaKey?.trim();
		if (!jwt && !naiaKey) {
			throw new MobileIapVerificationError({
				message: "Missing authentication credentials for IAP verification",
				status: 401,
				errorCode: "unauthorized",
				retryable: false,
			});
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (jwt) {
			headers.Authorization = `Bearer ${jwt}`;
		} else if (naiaKey) {
			headers["X-AnyLLM-Key"] = `Bearer ${naiaKey}`;
		}
		return headers;
	}

	private async requestJson<T>(
		path: string,
		init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal },
	): Promise<T> {
		const headers = await this.buildAuthHeaders();
		const url = `${this.gatewayBase}${path}`;

		let lastErr: unknown = null;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			if (init.signal?.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}

			try {
				const resp = await this.fetchImpl(url, {
					method: init.method,
					headers,
					body: init.body,
					signal: init.signal,
				});

				if (resp.ok) {
					return (await resp.json()) as T;
				}

				const { errorCode, detailMessage } = await parseGatewayErrorCode(resp);
				const retryable = isRetryableStatus(resp.status);
				const iapErr = new MobileIapVerificationError({
					message: `Gateway IAP error (${resp.status} ${errorCode}): ${detailMessage}`,
					status: resp.status,
					errorCode,
					retryable,
				});

				if (!retryable || attempt >= this.maxRetries) {
					throw iapErr;
				}
				lastErr = iapErr;
			} catch (err) {
				if ((err as { name?: string })?.name === "AbortError") {
					throw err;
				}
				if (err instanceof MobileIapVerificationError && !err.retryable) {
					throw err;
				}
				lastErr = err;
				if (attempt >= this.maxRetries) {
					if (err instanceof MobileIapVerificationError) throw err;
					throw new MobileIapVerificationError({
						message:
							err instanceof Error
								? `Gateway IAP network error: ${err.message}`
								: "Gateway IAP network error",
						status: 0,
						errorCode: "network_error",
						retryable: true,
					});
				}
			}

			const delayMs = this.baseRetryDelayMs * 2 ** attempt;
			await sleepWithAbort(delayMs, init.signal);
		}

		throw lastErr instanceof Error
			? lastErr
			: new Error("Gateway IAP request failed");
	}
}
