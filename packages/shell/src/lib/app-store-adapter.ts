import { invoke } from "@tauri-apps/api/core";
import type { InstalledAppManifest } from "./app-loader";
import { getStoreGatewayUrl } from "./app-store-client";
import { loadConfig, saveConfig } from "./config";
import { markNaiaKeyUnauthorized } from "./lab-balance";
import { isWebMode } from "./web-runtime/web-assets";
import {
	WEB_REMOTE_KEY_STORAGE_KEY,
	isValidWebAuthKey,
} from "./web-runtime/web-auth";

export const DEFAULT_WEB_APPS_SANDBOX_ORIGIN = "https://apps-sandbox.naia.land";

const VALID_STORE_APP_ID_RE = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/i;

export type AppStoreErrorCode =
	| "invalid_app_id"
	| "auth_required"
	| "unauthorized"
	| "insufficient_credits"
	| "untrusted_origin"
	| "http_error";

export class AppStoreHttpError extends Error {
	readonly code: AppStoreErrorCode;
	readonly status?: number;

	constructor(code: AppStoreErrorCode, message: string, status?: number) {
		super(message);
		this.name = "AppStoreHttpError";
		this.code = code;
		this.status = status;
	}
}

export function isValidStoreAppId(appId: string): boolean {
	return (
		typeof appId === "string" &&
		appId.length >= 3 &&
		appId.length <= 128 &&
		VALID_STORE_APP_ID_RE.test(appId)
	);
}

export function getWebAppsSandboxOrigin(envOverride?: string): string {
	const raw =
		envOverride ??
		(import.meta.env.VITE_NAIA_APPS_SANDBOX_ORIGIN as string | undefined);
	const trimmed = raw?.trim().replace(/\/+$/, "");
	return trimmed && trimmed.length > 0
		? trimmed
		: DEFAULT_WEB_APPS_SANDBOX_ORIGIN;
}

export interface StoreProductSummary {
	appId: string;
	version: string;
	priceCredits: number;
	hostedEntryUrl?: string;
	manifest: Omit<
		InstalledAppManifest,
		"htmlEntry" | "store_signature_verified" | "store_signature_issued_at_ms"
	>;
}

export interface StoreEntitlementSummary {
	appId: string;
	entitled: boolean;
	grantedAtMs?: number;
}

export interface PlatformAppStoreAdapter {
	readonly kind: "desktop-tauri" | "web-http";
	listCatalog(): Promise<StoreProductSummary[]>;
	listEntitlements(): Promise<StoreEntitlementSummary[]>;
	listInstalledManifests(): Promise<InstalledAppManifest[]>;
	checkEntitlement(appId: string): Promise<boolean>;
	verifyAppTrust(appId: string): Promise<boolean>;
	purchaseApp(appId: string): Promise<void>;
	installApp(appId: string): Promise<void>;
	uninstallApp(appId: string): Promise<void>;
	openStoreSurface(storeUrl: string): Promise<void>;
	resolveFrameSrc(htmlEntry: string): string;
}

export interface WebHttpAppStoreAdapterDeps {
	fetchImpl?: typeof fetch;
	getGatewayUrl?: () => string;
	getAuthKey?: () => string | undefined;
	getSandboxOrigin?: () => string;
	getShellOrigin?: () => string | undefined;
	onUnauthorized?: () => void;
}

interface RawStoreProduct {
	app_id?: string;
	appId?: string;
	version?: string;
	price_credits?: number;
	priceCredits?: number;
	hosted_entry_url?: string;
	hostedEntryUrl?: string;
	manifest?: Partial<InstalledAppManifest>;
}

function normalizeStoreProduct(
	raw: RawStoreProduct,
): StoreProductSummary | null {
	const appId = (raw.app_id ?? raw.appId ?? raw.manifest?.id ?? "").trim();
	if (!isValidStoreAppId(appId)) return null;
	const manifest = raw.manifest ?? {};
	const version =
		(raw.version ?? manifest.version ?? "1.0.0").trim() || "1.0.0";
	const priceCredits =
		typeof raw.price_credits === "number"
			? raw.price_credits
			: typeof raw.priceCredits === "number"
				? raw.priceCredits
				: 0;
	const hostedEntryUrl = (raw.hosted_entry_url ?? raw.hostedEntryUrl)?.trim();
	const {
		htmlEntry: _ignoredHtml,
		store_signature_verified: _ignoredVerified,
		store_signature_issued_at_ms: _ignoredIssuedAt,
		...restManifest
	} = manifest;
	return {
		appId,
		version,
		priceCredits,
		...(hostedEntryUrl ? { hostedEntryUrl } : {}),
		manifest: {
			...restManifest,
			id: appId,
			name: restManifest.name || appId,
			version,
		},
	};
}

function defaultReadWebAuthKey(): string | undefined {
	const stored =
		typeof localStorage !== "undefined"
			? localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)?.trim()
			: undefined;
	if (stored && isValidWebAuthKey(stored)) return stored;
	const cfgKey = loadConfig()?.naiaKey?.trim();
	if (cfgKey && isValidWebAuthKey(cfgKey)) return cfgKey;
	return undefined;
}

export class DesktopTauriAppStoreAdapter implements PlatformAppStoreAdapter {
	readonly kind = "desktop-tauri" as const;

	async listCatalog(): Promise<StoreProductSummary[]> {
		const res = await fetch(`${getStoreGatewayUrl()}/v1/apps/products`);
		if (!res.ok) {
			throw new AppStoreHttpError(
				"http_error",
				`Store catalog HTTP ${res.status}`,
				res.status,
			);
		}
		const body = (await res.json()) as { data?: RawStoreProduct[] };
		return (body.data ?? [])
			.map(normalizeStoreProduct)
			.filter((item): item is StoreProductSummary => item !== null);
	}

	async listEntitlements(): Promise<StoreEntitlementSummary[]> {
		const installed = await this.listInstalledManifests();
		const checks = await Promise.all(
			installed.map(async (item) => ({
				appId: item.id,
				entitled: await this.checkEntitlement(item.id),
				grantedAtMs: item.store_signature_issued_at_ms,
			})),
		);
		return checks;
	}

	listInstalledManifests(): Promise<InstalledAppManifest[]> {
		return invoke<InstalledAppManifest[]>("app_list_installed");
	}

	checkEntitlement(appId: string): Promise<boolean> {
		if (!isValidStoreAppId(appId)) {
			return Promise.reject(
				new AppStoreHttpError("invalid_app_id", `Invalid app id: ${appId}`),
			);
		}
		return invoke<boolean>("app_store_has_entitlement", {
			appId,
			gatewayUrl: getStoreGatewayUrl(),
		});
	}

	verifyAppTrust(appId: string): Promise<boolean> {
		if (!isValidStoreAppId(appId)) {
			return Promise.reject(
				new AppStoreHttpError("invalid_app_id", `Invalid app id: ${appId}`),
			);
		}
		return invoke<boolean>("app_verify_installed_store_app", { appId });
	}

	async purchaseApp(appId: string): Promise<void> {
		await this.installApp(appId);
	}

	async installApp(appId: string): Promise<void> {
		if (!isValidStoreAppId(appId)) {
			throw new AppStoreHttpError("invalid_app_id", `Invalid app id: ${appId}`);
		}
		await invoke("app_install_store", {
			appId,
			gatewayUrl: getStoreGatewayUrl(),
		});
	}

	async uninstallApp(appId: string): Promise<void> {
		if (!isValidStoreAppId(appId)) {
			throw new AppStoreHttpError("invalid_app_id", `Invalid app id: ${appId}`);
		}
		await invoke("app_remove_installed", { appId });
	}

	async openStoreSurface(storeUrl: string): Promise<void> {
		await invoke("focus_or_create_app_store_window", { url: storeUrl });
	}

	resolveFrameSrc(htmlEntry: string): string {
		return htmlEntry;
	}
}

export class WebHttpAppStoreAdapter implements PlatformAppStoreAdapter {
	readonly kind = "web-http" as const;
	private readonly fetchImpl: typeof fetch;
	private readonly getGatewayUrl: () => string;
	private readonly getAuthKey: () => string | undefined;
	private readonly getSandboxOrigin: () => string;
	private readonly getShellOrigin: () => string | undefined;
	private readonly onUnauthorized: () => void;

	constructor(deps: WebHttpAppStoreAdapterDeps = {}) {
		this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
		this.getGatewayUrl = deps.getGatewayUrl ?? getStoreGatewayUrl;
		this.getAuthKey = deps.getAuthKey ?? defaultReadWebAuthKey;
		this.getSandboxOrigin =
			deps.getSandboxOrigin ?? (() => getWebAppsSandboxOrigin());
		this.getShellOrigin =
			deps.getShellOrigin ??
			(() =>
				typeof window !== "undefined" ? window.location.origin : undefined);
		this.onUnauthorized = deps.onUnauthorized ?? markNaiaKeyUnauthorized;
	}

	private requireAuthHeaders(): Record<string, string> {
		const key = this.getAuthKey()?.trim();
		if (!key || !isValidWebAuthKey(key)) {
			throw new AppStoreHttpError(
				"auth_required",
				"Naia account login is required for Web App Store requests",
			);
		}
		return { "X-AnyLLM-Key": `Bearer ${key}` };
	}

	private assertAppId(appId: string): string {
		const trimmed = appId.trim();
		if (!isValidStoreAppId(trimmed)) {
			throw new AppStoreHttpError(
				"invalid_app_id",
				`Invalid Store app id: ${appId}`,
			);
		}
		return trimmed;
	}

	async listCatalog(): Promise<StoreProductSummary[]> {
		const base = this.getGatewayUrl().replace(/\/+$/, "");
		const res = await this.fetchImpl(`${base}/v1/apps/products`);
		if (!res.ok) {
			throw new AppStoreHttpError(
				"http_error",
				`GET /v1/apps/products failed with HTTP ${res.status}`,
				res.status,
			);
		}
		const body = (await res.json()) as { data?: RawStoreProduct[] };
		return (body.data ?? [])
			.map(normalizeStoreProduct)
			.filter((item): item is StoreProductSummary => item !== null);
	}

	async listEntitlements(): Promise<StoreEntitlementSummary[]> {
		const headers = this.requireAuthHeaders();
		const base = this.getGatewayUrl().replace(/\/+$/, "");
		const res = await this.fetchImpl(`${base}/v1/apps/entitlements`, {
			headers,
		});
		if (res.status === 401) {
			this.onUnauthorized();
			throw new AppStoreHttpError(
				"unauthorized",
				"GET /v1/apps/entitlements unauthorized (HTTP 401)",
				401,
			);
		}
		if (!res.ok) {
			throw new AppStoreHttpError(
				"http_error",
				`GET /v1/apps/entitlements failed with HTTP ${res.status}`,
				res.status,
			);
		}
		const body = (await res.json()) as {
			data?: Array<
				| string
				| {
						app_id?: string;
						appId?: string;
						entitled?: boolean;
						active?: boolean;
						granted_at_ms?: number;
						grantedAtMs?: number;
				  }
			>;
		};
		const summaries: StoreEntitlementSummary[] = [];
		for (const item of body.data ?? []) {
			if (typeof item === "string") {
				if (isValidStoreAppId(item)) {
					summaries.push({ appId: item, entitled: true });
				}
				continue;
			}
			const id = (item.app_id ?? item.appId ?? "").trim();
			if (!isValidStoreAppId(id)) continue;
			const entitled =
				item.entitled !== undefined
					? item.entitled === true
					: item.active !== undefined
						? item.active === true
						: true;
			const grantedAtMs = item.granted_at_ms ?? item.grantedAtMs;
			summaries.push({
				appId: id,
				entitled,
				...(typeof grantedAtMs === "number" ? { grantedAtMs } : {}),
			});
		}
		return summaries;
	}

	async checkEntitlement(appId: string): Promise<boolean> {
		const validId = this.assertAppId(appId);
		const headers = this.requireAuthHeaders();
		const base = this.getGatewayUrl().replace(/\/+$/, "");
		const res = await this.fetchImpl(
			`${base}/v1/apps/entitlements/${encodeURIComponent(validId)}`,
			{ headers },
		);
		if (res.status === 401) {
			this.onUnauthorized();
			throw new AppStoreHttpError(
				"unauthorized",
				`Entitlement check unauthorized for ${validId} (HTTP 401)`,
				401,
			);
		}
		if (res.status === 403 || res.status === 404) {
			return false;
		}
		if (!res.ok) {
			throw new AppStoreHttpError(
				"http_error",
				`Entitlement check failed for ${validId} with HTTP ${res.status}`,
				res.status,
			);
		}
		const payload = (await res.json()) as {
			entitled?: boolean;
			active?: boolean;
			data?: { entitled?: boolean; active?: boolean };
		};
		const record = payload.data ?? payload;
		if (typeof record.entitled === "boolean") return record.entitled;
		if (typeof record.active === "boolean") return record.active;
		return true;
	}

	async verifyAppTrust(appId: string): Promise<boolean> {
		return this.checkEntitlement(appId);
	}

	async purchaseApp(appId: string): Promise<void> {
		const validId = this.assertAppId(appId);
		const headers = {
			...this.requireAuthHeaders(),
			"Content-Type": "application/json",
		};
		const base = this.getGatewayUrl().replace(/\/+$/, "");
		const res = await this.fetchImpl(`${base}/v1/apps/purchases`, {
			method: "POST",
			headers,
			body: JSON.stringify({ app_id: validId }),
		});
		if (res.status === 409) {
			// Already owned — treat purchase as idempotent success.
			return;
		}
		if (res.status === 401) {
			this.onUnauthorized();
			throw new AppStoreHttpError(
				"unauthorized",
				`POST /v1/apps/purchases unauthorized for ${validId} (HTTP 401)`,
				401,
			);
		}
		if (res.status === 402) {
			throw new AppStoreHttpError(
				"insufficient_credits",
				`Insufficient credits to purchase ${validId} (HTTP 402)`,
				402,
			);
		}
		if (!res.ok) {
			throw new AppStoreHttpError(
				"http_error",
				`POST /v1/apps/purchases failed for ${validId} with HTTP ${res.status}`,
				res.status,
			);
		}
	}

	async installApp(appId: string): Promise<void> {
		const validId = this.assertAppId(appId);
		const alreadyEntitled = await this.checkEntitlement(validId);
		if (!alreadyEntitled) {
			await this.purchaseApp(validId);
		}
		const cfg = loadConfig();
		if (cfg) {
			const next = Array.from(
				new Set([...(cfg.installedWebApps ?? []), validId]),
			);
			saveConfig({ ...cfg, installedWebApps: next });
		}
	}

	async uninstallApp(appId: string): Promise<void> {
		const validId = this.assertAppId(appId);
		const cfg = loadConfig();
		if (cfg && Array.isArray(cfg.installedWebApps)) {
			saveConfig({
				...cfg,
				installedWebApps: cfg.installedWebApps.filter((id) => id !== validId),
			});
		}
	}

	async listInstalledManifests(): Promise<InstalledAppManifest[]> {
		const cfg = loadConfig();
		let candidateIds: string[];
		let grantedById = new Map<string, number | undefined>();

		if (Array.isArray(cfg?.installedWebApps)) {
			candidateIds = cfg.installedWebApps.filter(isValidStoreAppId);
		} else {
			const entitlements = await this.listEntitlements();
			const active = entitlements.filter((e) => e.entitled);
			candidateIds = active.map((e) => e.appId);
			grantedById = new Map(active.map((e) => [e.appId, e.grantedAtMs]));
		}

		if (candidateIds.length === 0) return [];

		const catalog = await this.listCatalog();
		const byId = new Map(catalog.map((item) => [item.appId, item]));
		const sandboxOrigin = this.getSandboxOrigin().replace(/\/+$/, "");

		const checked = await Promise.all(
			candidateIds.map(async (appId) => {
				const product = byId.get(appId);
				if (!product) return null;
				const entitled = grantedById.has(appId)
					? true
					: await this.checkEntitlement(appId).catch(() => false);
				if (!entitled) return null;
				const candidateEntry =
					product.hostedEntryUrl ??
					`${sandboxOrigin}/${encodeURIComponent(appId)}/${encodeURIComponent(product.version)}/index.html`;
				const verifiedFrameSrc = this.resolveFrameSrc(candidateEntry);
				return {
					...product.manifest,
					id: appId,
					version: product.version,
					htmlEntry: verifiedFrameSrc,
					store_signature_verified: true,
					store_signature_issued_at_ms: grantedById.get(appId) ?? Date.now(),
				} satisfies InstalledAppManifest;
			}),
		);

		const manifests: InstalledAppManifest[] = [];
		for (const item of checked) {
			if (item !== null) manifests.push(item);
		}
		return manifests;
	}

	async openStoreSurface(storeUrl: string): Promise<void> {
		if (typeof window === "undefined") return;
		const event = new CustomEvent("naia-open-web-store-drawer", {
			cancelable: true,
			detail: { storeUrl },
		});
		const notCancelled = window.dispatchEvent(event);
		if (notCancelled && typeof window.open === "function") {
			const target = new URL(storeUrl);
			target.searchParams.set("target", "web");
			window.open(target.toString(), "_blank", "noopener,noreferrer");
		}
	}

	resolveFrameSrc(htmlEntry: string): string {
		let parsed: URL;
		try {
			parsed = new URL(htmlEntry);
		} catch {
			throw new AppStoreHttpError(
				"untrusted_origin",
				`Invalid web mini-app entry URL: ${htmlEntry}`,
			);
		}
		const expectedSandboxOrigin = new URL(this.getSandboxOrigin()).origin;
		const shellOrigin = this.getShellOrigin();
		if (
			parsed.protocol !== "https:" ||
			parsed.origin !== expectedSandboxOrigin ||
			(shellOrigin && parsed.origin === shellOrigin)
		) {
			throw new AppStoreHttpError(
				"untrusted_origin",
				`Untrusted web mini-app origin: ${parsed.origin} (expected isolated sandbox ${expectedSandboxOrigin})`,
			);
		}
		return parsed.toString();
	}
}

let cachedAdapter: PlatformAppStoreAdapter | null = null;
let cachedAdapterMode: "desktop-tauri" | "web-http" | null = null;

export function createPlatformAppStoreAdapter(
	webDeps?: WebHttpAppStoreAdapterDeps,
): PlatformAppStoreAdapter {
	return isWebMode()
		? new WebHttpAppStoreAdapter(webDeps)
		: new DesktopTauriAppStoreAdapter();
}

export function getPlatformAppStoreAdapter(): PlatformAppStoreAdapter {
	const desiredKind = isWebMode() ? "web-http" : "desktop-tauri";
	if (!cachedAdapter || cachedAdapterMode !== desiredKind) {
		cachedAdapter = createPlatformAppStoreAdapter();
		cachedAdapterMode = desiredKind;
	}
	return cachedAdapter;
}

export function setPlatformAppStoreAdapterForTests(
	adapter: PlatformAppStoreAdapter | null,
): void {
	cachedAdapter = adapter;
	cachedAdapterMode = adapter ? adapter.kind : null;
}
