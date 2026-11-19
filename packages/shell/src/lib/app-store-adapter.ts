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
	/**
	 * When true (enabled by default in Official Web Stage 1 runtime), merges the
	 * 4 verified Stage-1 hosted mini-apps (`slides`, `ieumoffice` v0.2.0,
	 * `cafelua-tarot` v0.1.5, `charcard`), activates `ieumoffice` over stale
	 * `coming_soon` gateway metadata, excludes Stage-2 coding/courseware apps
	 * (`blackjack`, `nts-edu-helper`), and defaults missing `hosted_entry_url`
	 * to `${shellOrigin}/hosted-apps/<slug>/index.html`.
	 */
	stage1HostedCatalog?: boolean;
}

/** Stage-2 coding / courseware mini-apps excluded from Stage-1 web launch list. */
export const STAGE1_EXCLUDED_WEB_APP_IDS = new Set([
	"land.naia.blackjack",
	"blackjack",
	"land.naia.nts-edu-helper",
	"nts-edu-helper",
	"land.naia.public-ax",
	"public-ax",
]);

interface Stage1HostedAppSpec {
	readonly appId: string;
	readonly hostedSlug: string;
	readonly version: string;
	readonly defaultPriceCredits: number;
	readonly freeWithoutLogin: boolean;
	readonly forceVersion?: boolean;
	readonly manifest: StoreProductSummary["manifest"];
}

export const STAGE1_HOSTED_MINI_APPS: readonly Stage1HostedAppSpec[] = [
	{
		appId: "land.naia.charcard",
		hostedSlug: "naia-charcard",
		version: "1.0.0",
		defaultPriceCredits: 0,
		freeWithoutLogin: true,
		manifest: {
			id: "land.naia.charcard",
			name: "캐릭터 카드",
			names: { ko: "캐릭터 카드", en: "Character Cards" },
			icon: "🃏",
			description: "SillyTavern V2/V3 PNG·JSON 캐릭터 카드 불러오기·편집·적용",
			descriptions: {
				ko: "실리태번 호환 캐릭터 카드(.png / .json)를 불러오고 나이아 에이전트에 바로 입힙니다.",
				en: "Import, edit, and apply SillyTavern V2/V3 PNG & JSON character cards.",
			},
			version: "1.0.0",
			manifest_version: 2,
			permissions: ["speech", "locale", "model.ask"],
			keepAlive: true,
		},
	},
	{
		appId: "land.naia.slides",
		hostedSlug: "naia-slides",
		version: "0.1.2",
		defaultPriceCredits: 0,
		freeWithoutLogin: true,
		manifest: {
			id: "land.naia.slides",
			name: "슬라이드",
			names: { ko: "슬라이드", en: "Naia Slides" },
			icon: "▣",
			description: "나이아 아바타와 함께하는 슬라이드 발표 미니앱",
			descriptions: {
				ko: "PDF·발표 자료를 열고 나이아 아바타가 한 장씩 발표합니다.",
				en: "Present slide decks together with your Naia avatar.",
			},
			version: "0.1.2",
			manifest_version: 2,
			permissions: ["speech", "locale"],
			keepAlive: true,
		},
	},
	{
		appId: "land.naia.ieumoffice",
		hostedSlug: "ieumoffice",
		version: "0.2.0",
		defaultPriceCredits: 0,
		freeWithoutLogin: true,
		forceVersion: true,
		manifest: {
			id: "land.naia.ieumoffice",
			name: "이음오피스",
			names: { ko: "이음오피스", en: "IeumOffice" },
			icon: "📑",
			description: "이음오피스 v0.2.0 문서·발표 웹 스튜디오",
			descriptions: {
				ko: "이음오피스 v0.2.0 웹 스튜디오에서 문서·슬라이드를 작성하고 나이아와 협업합니다.",
				en: "Author documents and slide decks in IeumOffice v0.2.0 Web Studio.",
			},
			version: "0.2.0",
			manifest_version: 2,
			permissions: ["speech", "locale", "model.ask"],
			keepAlive: true,
		},
	},
	{
		appId: "land.naia.cafelua-tarot",
		hostedSlug: "cafelua-tarot",
		version: "0.1.5",
		defaultPriceCredits: 3000,
		freeWithoutLogin: true,
		forceVersion: true,
		manifest: {
			id: "land.naia.cafelua-tarot",
			name: "카페루아 타로",
			names: { ko: "카페루아 타로", en: "Cafe Lua Tarot" },
			icon: "🔮",
			description: "카페루아 타로 v0.1.5 — 1/3/10장 스프레드 리딩 및 타로 이야기 낭독",
			descriptions: {
				ko: "나이아가 카페루아의 타로 리더가 되어 1/3/10장 카드를 풀어 주고 타로 이야기를 낭독합니다.",
				en: "Cafe Lua Tarot v0.1.5 — 1/3/10-card spreads and narrated tarot stories with Naia.",
			},
			version: "0.1.5",
			manifest_version: 2,
			permissions: ["speech", "locale", "model.ask"],
			keepAlive: true,
		},
	},
];

const STAGE1_HOSTED_BY_ID = new Map(
	STAGE1_HOSTED_MINI_APPS.map((spec) => [spec.appId, spec]),
);
const STAGE1_SHORT_SLUG_TO_ID = new Map(
	STAGE1_HOSTED_MINI_APPS.map((spec) => [spec.hostedSlug, spec.appId]),
);

export function normalizeCanonicalWebAppId(rawAppId: string): string {
	const trimmed = rawAppId.trim();
	return STAGE1_SHORT_SLUG_TO_ID.get(trimmed) ?? trimmed;
}

const PACKAGE_ICON_MAX_CHARS = 512 * 1024;
const SVG_DOCUMENT_START =
	/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i;

/**
 * R6: desktop inlines the package `app.json` `iconUrl` SVG (Rust
 * `app_list_installed`). A hosted bundle is the same package, so read the same
 * files next to its entry. Returns undefined on any mismatch so the manifest
 * emoji stays as the fallback.
 */
export async function readPackageIconSvg(
	fetchImpl: typeof fetch,
	entryUrl: string,
): Promise<string | undefined> {
	const base = new URL("./", entryUrl);
	const res = await fetchImpl(new URL("app.json", base).toString(), {
		credentials: "omit",
	});
	if (!res.ok) return undefined;
	const meta = (await res.json()) as { iconUrl?: unknown } | null;
	const iconPath = typeof meta?.iconUrl === "string" ? meta.iconUrl.trim() : "";
	if (!iconPath || iconPath.includes("..") || !/\.svg$/i.test(iconPath)) {
		return undefined;
	}
	const iconUrl = new URL(iconPath, base);
	if (
		iconUrl.origin !== base.origin ||
		!iconUrl.pathname.startsWith(base.pathname)
	) {
		return undefined;
	}
	const iconRes = await fetchImpl(iconUrl.toString(), { credentials: "omit" });
	if (!iconRes.ok) return undefined;
	const svg = await iconRes.text();
	if (svg.length > PACKAGE_ICON_MAX_CHARS || !SVG_DOCUMENT_START.test(svg)) {
		return undefined;
	}
	return svg;
}

function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]"
	);
}

function parsePriceCredits(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, value);
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return Math.max(0, parsed);
	}
	return undefined;
}

interface RawStoreProduct {
	app_id?: string;
	appId?: string;
	version?: string;
	price_credits?: number | string;
	priceCredits?: number | string;
	hosted_entry_url?: string | null;
	hostedEntryUrl?: string | null;
	manifest?: Partial<InstalledAppManifest> & { status?: string };
}

function normalizeStoreProduct(
	raw: RawStoreProduct,
): StoreProductSummary | null {
	const appId = normalizeCanonicalWebAppId(
		raw.app_id ?? raw.appId ?? raw.manifest?.id ?? "",
	);
	if (!isValidStoreAppId(appId)) return null;
	const manifest = raw.manifest ?? {};
	const version =
		(raw.version ?? manifest.version ?? "1.0.0").trim() || "1.0.0";
	const priceCredits =
		parsePriceCredits(raw.price_credits) ??
		parsePriceCredits(raw.priceCredits) ??
		0;
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
	private readonly getAuthKey: () => string;
	private readonly hasCustomSandboxOrigin: boolean;
	private readonly getSandboxOrigin: () => string;
	private readonly getShellOrigin: () => string | undefined;
	private readonly onUnauthorized: () => void;
	private readonly stage1HostedCatalog: boolean;
	private readonly packageIconCache = new Map<string, Promise<string | undefined>>();

	constructor(deps: WebHttpAppStoreAdapterDeps = {}) {
		this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
		this.getGatewayUrl = deps.getGatewayUrl ?? getStoreGatewayUrl;
		this.getAuthKey = () => (deps.getAuthKey ?? defaultReadWebAuthKey)() ?? "";
		this.hasCustomSandboxOrigin = Boolean(
			deps.getSandboxOrigin ||
				(import.meta.env.VITE_NAIA_APPS_SANDBOX_ORIGIN as string | undefined)?.trim(),
		);
		this.getSandboxOrigin =
			deps.getSandboxOrigin ?? (() => getWebAppsSandboxOrigin());
		this.getShellOrigin =
			deps.getShellOrigin ??
			(() =>
				typeof window !== "undefined" ? window.location.origin : undefined);
		this.onUnauthorized = deps.onUnauthorized ?? markNaiaKeyUnauthorized;
		this.stage1HostedCatalog = deps.stage1HostedCatalog === true;
	}

	private requireAuthHeaders(): Record<string, string> {
		const key = this.getAuthKey().trim();
		if (!key || !isValidWebAuthKey(key)) {
			throw new AppStoreHttpError(
				"auth_required",
				"Naia account login is required for Web App Store requests",
			);
		}
		return { "X-AnyLLM-Key": `Bearer ${key}` };
	}

	private assertAppId(appId: string): string {
		const canonical = normalizeCanonicalWebAppId(appId);
		if (!isValidStoreAppId(canonical)) {
			throw new AppStoreHttpError(
				"invalid_app_id",
				`Invalid Store app id: ${appId}`,
			);
		}
		return canonical;
	}

	private resolveDefaultHostedEntryUrl(
		appId: string,
		version: string,
	): string {
		const stage1Spec = STAGE1_HOSTED_BY_ID.get(appId);
		const shellOrigin = this.getShellOrigin()?.replace(/\/+$/, "");
		if (this.stage1HostedCatalog && !this.hasCustomSandboxOrigin && shellOrigin) {
			const slug = stage1Spec?.hostedSlug ?? appId;
			return `${shellOrigin}/hosted-apps/${encodeURIComponent(slug)}/index.html`;
		}
		const sandboxOrigin = this.getSandboxOrigin().replace(/\/+$/, "");
		if (sandboxOrigin.endsWith("/hosted-apps")) {
			const slug = stage1Spec?.hostedSlug ?? appId;
			return `${sandboxOrigin}/${encodeURIComponent(slug)}/index.html`;
		}
		return `${sandboxOrigin}/${encodeURIComponent(appId)}/${encodeURIComponent(version)}/index.html`;
	}

	private mergeStage1Catalog(
		remoteItems: StoreProductSummary[],
	): StoreProductSummary[] {
		const filtered = remoteItems.filter(
			(item) => !STAGE1_EXCLUDED_WEB_APP_IDS.has(item.appId),
		);
		const byId = new Map<string, StoreProductSummary>();
		for (const item of filtered) {
			const manifestStatus = (
				item.manifest as InstalledAppManifest & { status?: string }
			).status;
			// Non-Stage1 items marked coming_soon stay hidden in Stage 1.
			if (
				manifestStatus === "coming_soon" &&
				!STAGE1_HOSTED_BY_ID.has(item.appId)
			) {
				continue;
			}
			byId.set(item.appId, item);
		}

		for (const spec of STAGE1_HOSTED_MINI_APPS) {
			const existing = byId.get(spec.appId);
			const version =
				spec.forceVersion || !existing ? spec.version : existing.version;
			const mergedManifest = {
				...(existing?.manifest ?? {}),
				...spec.manifest,
				id: spec.appId,
				version,
				status: "active",
				tools: existing?.manifest.tools?.length
					? existing.manifest.tools
					: spec.manifest.tools,
			} as StoreProductSummary["manifest"];
			const hostedEntryUrl =
				existing?.hostedEntryUrl ||
				this.resolveDefaultHostedEntryUrl(spec.appId, version);
			byId.set(spec.appId, {
				appId: spec.appId,
				version,
				priceCredits: existing ? existing.priceCredits : spec.defaultPriceCredits,
				hostedEntryUrl,
				manifest: mergedManifest,
			});
		}

		// Preserve Stage-1 canonical order first, then any extra active products.
		const ordered: StoreProductSummary[] = [];
		for (const spec of STAGE1_HOSTED_MINI_APPS) {
			const item = byId.get(spec.appId);
			if (item) {
				ordered.push(item);
				byId.delete(spec.appId);
			}
		}
		for (const rest of byId.values()) {
			ordered.push(rest);
		}
		return ordered;
	}

	async listCatalog(): Promise<StoreProductSummary[]> {
		const base = this.getGatewayUrl().replace(/\/+$/, "");
		let remoteItems: StoreProductSummary[] = [];
		try {
			const res = await this.fetchImpl(`${base}/v1/apps/products`);
			if (!res.ok) {
				if (!this.stage1HostedCatalog) {
					throw new AppStoreHttpError(
						"http_error",
						`GET /v1/apps/products failed with HTTP ${res.status}`,
						res.status,
					);
				}
			} else {
				const body = (await res.json()) as { data?: RawStoreProduct[] };
				remoteItems = (body.data ?? [])
					.map(normalizeStoreProduct)
					.filter((item): item is StoreProductSummary => item !== null);
			}
		} catch (err) {
			if (!this.stage1HostedCatalog) throw err;
		}
		return this.stage1HostedCatalog
			? this.mergeStage1Catalog(remoteItems)
			: remoteItems;
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
		const stage1Spec = this.stage1HostedCatalog
			? STAGE1_HOSTED_BY_ID.get(validId)
			: undefined;
		const key = this.getAuthKey().trim();
		if (stage1Spec && (!key || !isValidWebAuthKey(key))) {
			return stage1Spec.freeWithoutLogin;
		}
		const headers = this.requireAuthHeaders();
		const base = this.getGatewayUrl().replace(/\/+$/, "");
		const res = await this.fetchImpl(
			`${base}/v1/apps/entitlements/${encodeURIComponent(validId)}`,
			{ headers },
		);
		if (res.status === 401) {
			this.onUnauthorized();
			if (stage1Spec?.freeWithoutLogin) return true;
			throw new AppStoreHttpError(
				"unauthorized",
				`Entitlement check unauthorized for ${validId} (HTTP 401)`,
				401,
			);
		}
		if (res.status === 403 || res.status === 404) {
			// Stage-1 bundled hosted mini-apps (`charcard`, `slides`, `ieumoffice`, `cafelua-tarot`)
			// may not yet have a purchase receipt row in `api-dev` DB (e.g. `charcard` or `coming_soon` `ieumoffice`).
			return stage1Spec ? stage1Spec.freeWithoutLogin : false;
		}
		if (!res.ok) {
			if (stage1Spec?.freeWithoutLogin) return true;
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
		if (typeof record.entitled === "boolean") {
			return record.entitled || Boolean(stage1Spec?.freeWithoutLogin);
		}
		if (typeof record.active === "boolean") {
			return record.active || Boolean(stage1Spec?.freeWithoutLogin);
		}
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
		if (
			this.stage1HostedCatalog &&
			STAGE1_EXCLUDED_WEB_APP_IDS.has(validId)
		) {
			throw new AppStoreHttpError(
				"invalid_app_id",
				`App ${validId} is scheduled for Stage 2`,
			);
		}
		const isStage1BundledApp =
			this.stage1HostedCatalog && STAGE1_HOSTED_BY_ID.has(validId);
		if (isStage1BundledApp) {
			// Best-effort entitlement sync when logged in; never fail Stage-1 hosted launch
			// when api-dev omits charcard or marks ieumoffice coming_soon.
			if (this.getAuthKey().trim()) {
				try {
					const alreadyEntitled = await this.checkEntitlement(validId);
					if (!alreadyEntitled) {
						await this.purchaseApp(validId);
					}
				} catch {
					// Hosted Stage-1 bundle remains runnable from /hosted-apps/<slug>/index.html
				}
			}
		} else {
			const alreadyEntitled = await this.checkEntitlement(validId);
			if (!alreadyEntitled) {
				await this.purchaseApp(validId);
			}
		}
		const cfg = loadConfig() ?? {
			provider: "nextain" as const,
			model: "gpt-6.1-terra",
			apiKey: "",
		};
		const next = Array.from(
			new Set([...(cfg.installedWebApps ?? []), validId]),
		);
		const cleanedDeleted = Array.isArray(cfg.deletedApps)
			? cfg.deletedApps.filter((id) => id !== validId)
			: undefined;
		saveConfig({
			...cfg,
			installedWebApps: next,
			...(cleanedDeleted !== undefined ? { deletedApps: cleanedDeleted } : {}),
		});
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
			candidateIds = cfg.installedWebApps
				.map(normalizeCanonicalWebAppId)
				.filter(isValidStoreAppId);
		} else if (this.stage1HostedCatalog) {
			// Default Stage-1 web shell pins all 4 official hosted mini-apps out of the box
			// (excluding any explicitly removed via deletedApps).
			const deleted = new Set(cfg?.deletedApps ?? []);
			candidateIds = STAGE1_HOSTED_MINI_APPS.map((s) => s.appId).filter(
				(id) => !deleted.has(id),
			);
		} else {
			const entitlements = await this.listEntitlements();
			const active = entitlements.filter((e) => e.entitled);
			candidateIds = active.map((e) => e.appId);
			grantedById = new Map(active.map((e) => [e.appId, e.grantedAtMs]));
		}

		if (this.stage1HostedCatalog) {
			candidateIds = candidateIds.filter(
				(id) => !STAGE1_EXCLUDED_WEB_APP_IDS.has(id),
			);
		}

		if (candidateIds.length === 0) return [];

		const catalog = await this.listCatalog();
		const byId = new Map(catalog.map((item) => [item.appId, item]));

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
					this.resolveDefaultHostedEntryUrl(appId, product.version);
				const verifiedFrameSrc = this.resolveFrameSrc(candidateEntry);
				const iconSvg = product.manifest.iconSvg
					? undefined
					: await this.loadPackageIconSvg(verifiedFrameSrc);
				return {
					...product.manifest,
					...(iconSvg ? { iconSvg } : {}),
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

	private loadPackageIconSvg(entryUrl: string): Promise<string | undefined> {
		const cached = this.packageIconCache.get(entryUrl);
		if (cached) return cached;
		const pending = readPackageIconSvg(this.fetchImpl, entryUrl).catch(
			() => undefined,
		);
		this.packageIconCache.set(entryUrl, pending);
		return pending;
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
		const shellOrigin = this.getShellOrigin();
		const isAllowedProtocol =
			parsed.protocol === "https:" ||
			(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname));

		// Portal Stage-1 contract: `${shellOrigin}/hosted-apps/<appId>/index.html`
		// is allowed ONLY under `/hosted-apps/` and MUST be mounted with an opaque
		// iframe sandbox (no `allow-same-origin` — enforced in GenericInstalledApp).
		if (
			isAllowedProtocol &&
			shellOrigin &&
			parsed.origin === shellOrigin &&
			parsed.pathname.startsWith("/hosted-apps/") &&
			!parsed.pathname.includes("..")
		) {
			return parsed.toString();
		}

		const expectedSandboxUrl = new URL(this.getSandboxOrigin());
		const expectedSandboxOrigin = expectedSandboxUrl.origin;
		const expectedPathPrefix = expectedSandboxUrl.pathname.replace(/\/+$/, "");
		const pathMatchesPrefix =
			!expectedPathPrefix ||
			expectedPathPrefix === "/" ||
			parsed.pathname.startsWith(`${expectedPathPrefix}/`);
		if (
			parsed.protocol !== "https:" ||
			parsed.origin !== expectedSandboxOrigin ||
			!pathMatchesPrefix ||
			(shellOrigin && parsed.origin === shellOrigin)
		) {
			throw new AppStoreHttpError(
				"untrusted_origin",
				`Untrusted web mini-app origin: ${parsed.origin} (expected isolated sandbox ${expectedSandboxOrigin} or ${shellOrigin ?? "<shell>"}/hosted-apps/*)`,
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
		? new WebHttpAppStoreAdapter({
				stage1HostedCatalog: true,
				...webDeps,
			})
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
