// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AppStoreHttpError,
	DEFAULT_WEB_APPS_SANDBOX_ORIGIN,
	DesktopTauriAppStoreAdapter,
	WebHttpAppStoreAdapter,
	getPlatformAppStoreAdapter,
	getWebAppsSandboxOrigin,
	isValidStoreAppId,
	setPlatformAppStoreAdapterForTests,
} from "../app-store-adapter";
import { hasStoreEntitlement } from "../app-store-client";
import { loadConfig, saveConfig } from "../config";
import { onNaiaKeyUnauthorized } from "../lab-balance";
import { setWebAssetsModeForTests } from "../web-runtime/web-assets";
import { WEB_REMOTE_KEY_STORAGE_KEY } from "../web-runtime/web-auth";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

describe("PlatformAppStoreAdapter & WebHttpAppStoreAdapter", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		setWebAssetsModeForTests(true);
		setPlatformAppStoreAdapterForTests(null);
		vi.clearAllMocks();
	});

	afterEach(() => {
		setPlatformAppStoreAdapterForTests(null);
		setWebAssetsModeForTests(null);
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("validates Store app IDs and resolves isolated sandbox origin", () => {
		expect(isValidStoreAppId("land.naia.slides")).toBe(true);
		expect(isValidStoreAppId("land.naia.cafelua-tarot")).toBe(true);
		expect(isValidStoreAppId("../etc/passwd")).toBe(false);
		expect(isValidStoreAppId("singleword")).toBe(false);
		expect(isValidStoreAppId("")).toBe(false);

		expect(getWebAppsSandboxOrigin()).toBe(DEFAULT_WEB_APPS_SANDBOX_ORIGIN);
		expect(getWebAppsSandboxOrigin("https://sandbox.naia.land/")).toBe(
			"https://sandbox.naia.land",
		);
	});

	it("fetches catalog (GET /v1/apps/products), entitlements (GET /v1/apps/entitlements), and purchases (POST /v1/apps/purchases) without Tauri invoke", async () => {
		localStorage.setItem(
			WEB_REMOTE_KEY_STORAGE_KEY,
			"gw-official-web-session-token",
		);
		saveConfig({
			provider: "nextain",
			model: "gpt-6.1-terra",
			apiKey: "",
		});

		const calls: Array<{
			url: string;
			method: string;
			auth?: string;
			body?: string;
		}> = [];
		let slidesPurchased = false;

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				const headers = (init?.headers ?? {}) as Record<string, string>;
				const auth = headers["X-AnyLLM-Key"];
				const body = typeof init?.body === "string" ? init.body : undefined;
				calls.push({ url, method, auth, body });

				if (url === "https://api.naia.land/v1/apps/products") {
					return jsonResponse(200, {
						data: [
							{
								app_id: "land.naia.slides",
								version: "1.4.2",
								price_credits: 0,
								manifest: {
									name: "Naia Slides",
									names: { ko: "나이아 슬라이드", en: "Naia Slides" },
									icon: "📊",
									tools: [
										{
											name: "skill_slides_jump",
											description: "Jump to slide",
											parameters: { type: "object", properties: {} },
										},
									],
								},
							},
						],
					});
				}

				if (
					url === "https://api.naia.land/v1/apps/entitlements/land.naia.slides"
				) {
					return slidesPurchased
						? jsonResponse(200, { entitled: true })
						: jsonResponse(404, { detail: "Not entitled" });
				}

				if (
					url === "https://api.naia.land/v1/apps/purchases" &&
					method === "POST"
				) {
					slidesPurchased = true;
					return jsonResponse(201, { ok: true, app_id: "land.naia.slides" });
				}

				if (url === "https://api.naia.land/v1/apps/entitlements") {
					return jsonResponse(200, {
						data: [
							{
								app_id: "land.naia.slides",
								entitled: slidesPurchased,
								granted_at_ms: 1_763_000_000_000,
							},
						],
					});
				}

				return jsonResponse(500, { error: "unexpected route" });
			},
		);

		const adapter = new WebHttpAppStoreAdapter({
			fetchImpl: fetchMock as unknown as typeof fetch,
			getGatewayUrl: () => "https://api.naia.land/",
			getShellOrigin: () => "https://app.naia.land",
		});

		const catalog = await adapter.listCatalog();
		expect(catalog).toHaveLength(1);
		expect(catalog[0]).toMatchObject({
			appId: "land.naia.slides",
			version: "1.4.2",
			priceCredits: 0,
		});

		expect(await adapter.checkEntitlement("land.naia.slides")).toBe(false);

		// Install triggers POST /v1/apps/purchases and records installedWebApps in config
		await adapter.installApp("land.naia.slides");
		expect(slidesPurchased).toBe(true);
		expect(loadConfig()?.installedWebApps).toEqual(["land.naia.slides"]);

		const purchaseCall = calls.find((c) => c.method === "POST");
		expect(purchaseCall).toEqual({
			url: "https://api.naia.land/v1/apps/purchases",
			method: "POST",
			auth: "Bearer gw-official-web-session-token",
			body: JSON.stringify({ app_id: "land.naia.slides" }),
		});

		// Installed manifests resolve to isolated sandbox origin with store_signature_verified
		const manifests = await adapter.listInstalledManifests();
		expect(manifests).toHaveLength(1);
		expect(manifests[0]).toMatchObject({
			id: "land.naia.slides",
			version: "1.4.2",
			htmlEntry:
				"https://apps-sandbox.naia.land/land.naia.slides/1.4.2/index.html",
			store_signature_verified: true,
		});

		// Batch listEntitlements also works when installedWebApps is unset
		saveConfig({
			provider: "nextain",
			model: "gpt-6.1-terra",
			apiKey: "",
		});
		const fromServerEntitlements = await adapter.listInstalledManifests();
		expect(fromServerEntitlements.map((m) => m.id)).toEqual([
			"land.naia.slides",
		]);

		// Uninstall removes from pinned installedWebApps
		await adapter.installApp("land.naia.slides");
		await adapter.uninstallApp("land.naia.slides");
		expect(loadConfig()?.installedWebApps).toEqual([]);

		// Zero Tauri IPC calls throughout web mode
		expect(invoke).not.toHaveBeenCalled();
	});

	it("broadcasts unauthorized event on HTTP 401, surfaces insufficient_credits on 402, and treats 409 as idempotent owned", async () => {
		localStorage.setItem(
			WEB_REMOTE_KEY_STORAGE_KEY,
			"gw-expired-web-token-123",
		);
		let unauthorizedFired = 0;
		const off = onNaiaKeyUnauthorized(() => {
			unauthorizedFired += 1;
		});

		try {
			const adapter401 = new WebHttpAppStoreAdapter({
				fetchImpl: vi.fn(async () =>
					jsonResponse(401, { detail: "Token expired" }),
				) as unknown as typeof fetch,
				getGatewayUrl: () => "https://api.naia.land",
			});
			await expect(
				adapter401.checkEntitlement("land.naia.slides"),
			).rejects.toMatchObject({
				code: "unauthorized",
				status: 401,
			});
			expect(unauthorizedFired).toBe(1);

			const adapter402 = new WebHttpAppStoreAdapter({
				fetchImpl: vi.fn(async () =>
					jsonResponse(402, { detail: "Insufficient credits" }),
				) as unknown as typeof fetch,
				getGatewayUrl: () => "https://api.naia.land",
			});
			await expect(
				adapter402.purchaseApp("land.naia.cafelua-tarot"),
			).rejects.toMatchObject({
				code: "insufficient_credits",
				status: 402,
			});

			const adapter409 = new WebHttpAppStoreAdapter({
				fetchImpl: vi.fn(async () =>
					jsonResponse(409, { detail: "Already owned" }),
				) as unknown as typeof fetch,
				getGatewayUrl: () => "https://api.naia.land",
			});
			await expect(
				adapter409.purchaseApp("land.naia.slides"),
			).resolves.toBeUndefined();
		} finally {
			off();
		}
	});

	it("enforces cross-origin HTTPS sandbox isolation in resolveFrameSrc and blocks shell-origin mounting", () => {
		const adapter = new WebHttpAppStoreAdapter({
			getSandboxOrigin: () => "https://apps-sandbox.naia.land",
			getShellOrigin: () => "https://app.naia.land",
		});

		expect(
			adapter.resolveFrameSrc(
				"https://apps-sandbox.naia.land/land.naia.slides/1.0.0/index.html",
			),
		).toBe("https://apps-sandbox.naia.land/land.naia.slides/1.0.0/index.html");

		// Rejects shell same-origin (prevents localStorage token exfiltration)
		expect(() =>
			adapter.resolveFrameSrc("https://app.naia.land/apps/slides/index.html"),
		).toThrow(AppStoreHttpError);

		// Rejects plaintext HTTP even on sandbox host
		expect(() =>
			adapter.resolveFrameSrc(
				"http://apps-sandbox.naia.land/land.naia.slides/1.0.0/index.html",
			),
		).toThrow(AppStoreHttpError);
	});

	it("routes hasStoreEntitlement to WebHttpAppStoreAdapter in web mode and DesktopTauriAppStoreAdapter in desktop mode", async () => {
		const customWebAdapter = new WebHttpAppStoreAdapter({
			fetchImpl: vi.fn(async () =>
				jsonResponse(200, { entitled: true }),
			) as unknown as typeof fetch,
			getGatewayUrl: () => "https://api.naia.land",
			getAuthKey: () => "gw-web-entitlement-key",
		});
		setPlatformAppStoreAdapterForTests(customWebAdapter);

		expect(await hasStoreEntitlement("land.naia.slides")).toBe(true);
		expect(invoke).not.toHaveBeenCalled();

		// Switch to desktop mode -> uses DesktopTauriAppStoreAdapter
		setPlatformAppStoreAdapterForTests(null);
		setWebAssetsModeForTests(false);
		vi.mocked(invoke).mockResolvedValueOnce(true);
		expect(getPlatformAppStoreAdapter()).toBeInstanceOf(
			DesktopTauriAppStoreAdapter,
		);
		expect(await hasStoreEntitlement("land.naia.slides")).toBe(true);
		expect(invoke).toHaveBeenCalledWith(
			"app_store_has_entitlement",
			expect.objectContaining({ appId: "land.naia.slides" }),
		);
	});

	it("dispatches cancelable naia-open-web-store-drawer event and falls back to window.open when unhandled", async () => {
		const adapter = new WebHttpAppStoreAdapter();
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

		// 1) In-app drawer listener handles & cancels default -> no new tab opened
		const drawerHandler = (e: Event) => {
			e.preventDefault();
		};
		window.addEventListener("naia-open-web-store-drawer", drawerHandler);
		await adapter.openStoreSurface("https://naia.land/ko/apps");
		expect(openSpy).not.toHaveBeenCalled();
		window.removeEventListener("naia-open-web-store-drawer", drawerHandler);

		// 2) No drawer listener -> opens new tab with target=web
		await adapter.openStoreSurface("https://naia.land/ko/apps");
		expect(openSpy).toHaveBeenCalledWith(
			"https://naia.land/ko/apps?target=web",
			"_blank",
			"noopener,noreferrer",
		);
	});
});
