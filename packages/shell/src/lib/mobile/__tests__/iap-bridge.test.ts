import { describe, expect, it, vi } from "vitest";
import {
	MOBILE_STORE_PRODUCTS,
	MobileIapGatewayBridge,
	MobileIapVerificationError,
	findMobileStoreProduct,
	guardExternalCheckoutUrl,
	isValidStoreKitJwsFormat,
	resolveMobileBillingPolicy,
	shouldHideExternalWebCheckout,
} from "../iap-bridge";
import type { PlatformProbeEnv } from "../platform";

const IOS_CAP_ENV: PlatformProbeEnv = {
	window: {
		Capacitor: {
			getPlatform: () => "ios",
			isNativePlatform: () => true,
		},
	},
	navigator: { userAgent: "Mozilla/5.0 (iPhone)" },
};

const ANDROID_CAP_ENV: PlatformProbeEnv = {
	window: {
		Capacitor: {
			getPlatform: () => "android",
			isNativePlatform: () => true,
		},
	},
	navigator: { userAgent: "Mozilla/5.0 (Linux; Android 15)" },
};

const DESKTOP_WEB_ENV: PlatformProbeEnv = {
	window: {},
	navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)" },
};

describe("mobile/iap-bridge", () => {
	it("enforces App Store 3.1.1 & Play Billing external web checkout hiding in native Capacitor builds", () => {
		expect(shouldHideExternalWebCheckout(IOS_CAP_ENV)).toBe(true);
		expect(shouldHideExternalWebCheckout(ANDROID_CAP_ENV)).toBe(true);
		expect(shouldHideExternalWebCheckout(DESKTOP_WEB_ENV)).toBe(false);

		expect(resolveMobileBillingPolicy(IOS_CAP_ENV)).toEqual({
			platform: "ios-capacitor",
			hideExternalWebCheckout: true,
			nativeStoreProvider: "apple",
		});
		expect(resolveMobileBillingPolicy(ANDROID_CAP_ENV)).toEqual({
			platform: "android-capacitor",
			hideExternalWebCheckout: true,
			nativeStoreProvider: "google",
		});

		// Blocks external pricing & PG checkout links inside native apps
		expect(
			guardExternalCheckoutUrl("https://www.naia.land/ko/pricing", IOS_CAP_ENV),
		).toBeNull();
		expect(
			guardExternalCheckoutUrl(
				"https://checkout.stripe.com/c/pay/cs_live_123",
				IOS_CAP_ENV,
			),
		).toBeNull();
		expect(
			guardExternalCheckoutUrl("https://pay.toss.im/pay", ANDROID_CAP_ENV),
		).toBeNull();

		// Allows non-payment docs/terms links inside native apps
		expect(
			guardExternalCheckoutUrl("https://www.naia.land/ko/privacy", IOS_CAP_ENV),
		).toBe("https://www.naia.land/ko/privacy");

		// Allows web pricing links on regular desktop/mobile browsers
		expect(
			guardExternalCheckoutUrl(
				"https://www.naia.land/ko/pricing",
				DESKTOP_WEB_ENV,
			),
		).toBe("https://www.naia.land/ko/pricing");
	});

	it("aligns mobile store catalog 1:1 with naia-anyllm integer 4//5 store credit formula", () => {
		expect(MOBILE_STORE_PRODUCTS).toHaveLength(6);
		expect(findMobileStoreProduct("land.naia.credits.10")?.storeCredits).toBe(
			8_000,
		);
		expect(findMobileStoreProduct("credits-30")?.storeCredits).toBe(24_240);
		expect(findMobileStoreProduct("credits-60")?.storeCredits).toBe(48_960);
		expect(findMobileStoreProduct("land.naia.credits.100")?.storeCredits).toBe(
			82_400,
		);
		expect(findMobileStoreProduct("land.naia.sub.pro")?.kind).toBe(
			"subscription",
		);
	});

	it("validates StoreKit 2 JWS payloads, submits strict schema to /v1/billing/apple/transactions, and retries transient 503s", async () => {
		expect(isValidStoreKitJwsFormat("not-a-jws")).toBe(false);
		expect(
			isValidStoreKitJwsFormat(
				"eyJhbGciOiJFUzI1NiJ9.eyJ0eCI6IjEifQ.c2lnbmF0dXJl",
			),
		).toBe(true);

		let postAttempts = 0;
		const capturedBodies: Array<Record<string, unknown>> = [];

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/v1/billing/apple/account-token")) {
					return new Response(
						JSON.stringify({
							app_account_token: "550e8400-e29b-41d4-a716-446655440000",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url.endsWith("/v1/billing/apple/transactions")) {
					postAttempts++;
					capturedBodies.push(JSON.parse(String(init?.body ?? "{}")));
					if (postAttempts === 1) {
						return new Response(
							JSON.stringify({
								detail: { error: "provider_temporarily_busy" },
							}),
							{ status: 503, headers: { "Content-Type": "application/json" } },
						);
					}
					return new Response(
						JSON.stringify({
							status: "granted",
							product_id: "credits-30",
							credits: 24240,
							store_transaction_id: "2000000888999111",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("Not Found", { status: 404 });
			},
		);

		const bridge = new MobileIapGatewayBridge({
			gatewayUrl: "https://gateway.naia.nextain.io/",
			getAuthHeader: () => ({ jwt: "user-jwt-token" }),
			maxRetries: 2,
			baseRetryDelayMs: 10,
			fetchImpl: fetchMock as unknown as typeof fetch,
			env: IOS_CAP_ENV,
		});

		// Rejects malformed JWS locally without hitting network
		await expect(
			bridge.submitAppleTransaction({ signedTransaction: "bad.token" }),
		).rejects.toMatchObject({
			errorCode: "invalid_jws_format",
			retryable: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();

		const appAccountToken = await bridge.fetchAppleAccountToken();
		expect(appAccountToken).toBe("550e8400-e29b-41d4-a716-446655440000");

		const grant = await bridge.submitAppleTransaction({
			signedTransaction:
				"eyJhbGciOiJFUzI1NiJ9.eyJwcm9kdWN0SWQiOiJsYW5kLm5haWEuY3JlZGl0cy4zMCJ9.c2lnbmF0dXJlX2J5dGVz",
		});
		expect(postAttempts).toBe(2);
		// Must send ONLY `signed_transaction` (`ConfigDict(extra="forbid")` on gateway!)
		expect(Object.keys(capturedBodies[0])).toEqual(["signed_transaction"]);
		expect(grant).toEqual({
			status: "granted",
			product_id: "credits-30",
			credits: 24240,
			store_transaction_id: "2000000888999111",
		});
	});

	it("does NOT retry non-retryable 409 transaction_revoked errors and only finishes native transactions after gateway grant", async () => {
		const finishSpy = vi.fn(async () => undefined);
		let shouldFailGateway = true;
		let gatewayCalls = 0;

		const nativeAndroidEnv: PlatformProbeEnv = {
			window: {
				Capacitor: {
					getPlatform: () => "android",
					isNativePlatform: () => true,
					Plugins: {
						NativePurchases: {
							purchaseProduct: vi.fn(async () => ({
								transactionId: "GPA.3311-2233-4455-66778",
								productIdentifier: "land.naia.sub.pro",
								purchaseToken: "play-purchase-token-abc123",
								orderId: "GPA.3311-2233-4455-66778",
							})),
							finishTransaction: finishSpy,
						},
					},
				},
			},
		};

		const bridge = new MobileIapGatewayBridge({
			gatewayUrl: "https://gateway.naia.nextain.io",
			getAuthHeader: () => ({ naiaKey: "nk-mobile-user" }),
			maxRetries: 3,
			baseRetryDelayMs: 10,
			env: nativeAndroidEnv,
			fetchImpl: (async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/v1/billing/google/account-token")) {
					return new Response(
						JSON.stringify({ obfuscated_account_id: "acct_hash_99" }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				gatewayCalls++;
				if (shouldFailGateway) {
					return new Response(
						JSON.stringify({ detail: { error: "transaction_revoked" } }),
						{ status: 409, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({
						status: "already_granted",
						product_id: "sub-pro",
						credits: 24240,
						store_transaction_id: "GPA.3311-2233-4455-66778",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as unknown as typeof fetch,
		});

		// 1. Non-retryable 409 fails immediately (1 call, 0 retries) and NEVER calls finishTransaction!
		await expect(
			bridge.purchaseProductViaNativeBridge("sub-pro"),
		).rejects.toSatisfy(
			(err) =>
				err instanceof MobileIapVerificationError &&
				err.status === 409 &&
				err.errorCode === "transaction_revoked" &&
				err.retryable === false,
		);
		expect(gatewayCalls).toBe(1);
		expect(finishSpy).not.toHaveBeenCalled();

		// 2. When gateway confirms `already_granted`, `finishTransaction` is called cleanly!
		shouldFailGateway = false;
		const res = await bridge.purchaseProductViaNativeBridge("sub-pro");
		expect(res.status).toBe("already_granted");
		expect(finishSpy).toHaveBeenCalledTimes(1);
		expect(finishSpy).toHaveBeenCalledWith({
			transactionId: "GPA.3311-2233-4455-66778",
			purchaseToken: "play-purchase-token-abc123",
		});
	});
});
