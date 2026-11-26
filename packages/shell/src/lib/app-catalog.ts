/**
 * Unified app store catalog (R3 / R4, 2026-11-20).
 *
 * Single source of truth inside `naia-shell` for:
 *   1. built-in Stage-1 mini-apps (`STAGE1_HOSTED_MINI_APPS`);
 *   2. gateway products (`GET /v1/apps/products`);
 *   3. portal public catalog (`GET {portal}/api/apps` — admin-registered apps
 *      and portal store records);
 *   4. localized product details used by the web app install confirmation.
 *
 * The portal endpoint contract is documented in `docs/app-store-protocol.md`
 * ("Unified web app catalog").
 */

import type { InstalledAppManifest } from "./app-loader";
import { formatWebCredits } from "./credits";
import stage1HostedApps from "./stage1-hosted-apps.json";

const VALID_ID_RE = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/i;
const SHORT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const SHOWN_VISIBILITY = new Set(["public", "listed", "published", "active"]);
const PORTAL_STOREFRONT_PATH_RE =
	/^(?:\/[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)?\/apps\/[^/]+\/?$/i;

export function isValidStoreAppId(appId: string): boolean {
	return (
		typeof appId === "string" &&
		appId.length >= 3 &&
		appId.length <= 128 &&
		VALID_ID_RE.test(appId)
	);
}

export interface StoreProductSummary {
	appId: string;
	version: string;
	priceCredits: number;
	hostedEntryUrl?: string;
	/** Store card picture for admin-registered or portal-listed apps (R3/R4). */
	iconUrl?: string;
	manifest: Omit<
		InstalledAppManifest,
		"htmlEntry" | "store_signature_verified" | "store_signature_issued_at_ms"
	>;
}

export interface RawStoreProduct {
	app_id?: string;
	appId?: string;
	version?: string;
	price_credits?: number | string;
	priceCredits?: number | string;
	hosted_entry_url?: string | null;
	hostedEntryUrl?: string | null;
	manifest?: Partial<InstalledAppManifest> & { status?: string };
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

export interface Stage1HostedAppSpec {
	readonly appId: string;
	readonly hostedSlug: string;
	readonly version: string;
	readonly defaultPriceCredits: number;
	readonly freeWithoutLogin: boolean;
	readonly forceVersion?: boolean;
	readonly manifest: StoreProductSummary["manifest"];
}

export const STAGE1_HOSTED_MINI_APPS: readonly Stage1HostedAppSpec[] = stage1HostedApps;

export const STAGE1_HOSTED_BY_ID = new Map(
	STAGE1_HOSTED_MINI_APPS.map((spec) => [spec.appId, spec]),
);
const STAGE1_SHORT_SLUG_TO_ID = new Map(
	STAGE1_HOSTED_MINI_APPS.map((spec) => [spec.hostedSlug, spec.appId]),
);

export function normalizeCanonicalWebAppId(rawAppId: string): string {
	const trimmed = rawAppId.trim();
	return STAGE1_SHORT_SLUG_TO_ID.get(trimmed) ?? trimmed;
}

export function parsePriceCredits(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, value);
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return Math.max(0, parsed);
	}
	return undefined;
}

export function normalizeGatewayStoreProduct(
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

/** One app as returned by the portal public catalog (`GET /api/apps`). */
export interface PortalCatalogApp {
	id: string;
	name: string;
	icon?: string;
	url?: string;
	description?: string;
	/** Locales the app is offered in, or per-locale name/description. */
	locales?: string[] | Record<string, { name?: string; description?: string }>;
	version?: string;
	visibility?: string;
	source?: "store" | "registry";
	creditPrice?: number | string;
}

/** Normalized portal catalog entry before it becomes a store product. */
export interface AdminCatalogEntry {
	appId: string;
	version: string;
	priceCredits?: number;
	source?: "store" | "registry";
	hostedEntryUrl?: string;
	/** Store card picture (https or same-origin path). */
	iconUrl?: string;
	/** When set, the app is hidden outside these locales. */
	offeredLocales?: string[];
	manifest: Omit<
		InstalledAppManifest,
		"htmlEntry" | "store_signature_verified" | "store_signature_issued_at_ms"
	>;
}

export const PORTAL_CATALOG_PATH = "/api/apps";
export const PORTAL_CATALOG_TIMEOUT_MS = 4000;

function text(value: unknown, max = 400): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
}

function stringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		const v = text(raw);
		if (v && LOCALE_RE.test(key)) out[key] = v;
	}
	return out;
}

function isPortalStorefrontPageUrl(rawUrl: string): boolean {
	if (rawUrl.startsWith("/") && !rawUrl.startsWith("//")) {
		return PORTAL_STOREFRONT_PATH_RE.test(rawUrl);
	}
	try {
		const parsed = new URL(rawUrl);
		return PORTAL_STOREFRONT_PATH_RE.test(parsed.pathname);
	} catch {
		return false;
	}
}

/**
 * Admin ids may be reverse-DNS (`land.naia.foo`) or a short slug (`foo`);
 * short slugs are placed under `land.naia.` so every catalog id is canonical.
 */
export function canonicalAdminAppId(raw: unknown): string | null {
	const rawText = text(raw, 128);
	if (!rawText) return null;
	const mapped = normalizeCanonicalWebAppId(rawText.toLowerCase());
	if (VALID_ID_RE.test(mapped)) return mapped;
	if (SHORT_SLUG_RE.test(mapped)) return `land.naia.${mapped}`;
	return null;
}

/**
 * Normalize one portal catalog item. Accepts the R4 contract shape, the portal
 * `GET /api/apps` merged shape (`source: "store" | "registry"`), and the legacy
 * `AppRecord` shape (`slug`, `nameKo`, `names`, …). Returns null for hidden or
 * malformed items.
 */
export function normalizePortalCatalogApp(
	raw: unknown,
): AdminCatalogEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const visibility = (text(item.visibility) ?? "public").toLowerCase();
	if (!SHOWN_VISIBILITY.has(visibility)) return null;
	if (item.comingSoon === true) return null;
	// Legacy AppRecord: `id` is a database row id when `slug` is present.
	const appId = canonicalAdminAppId(
		typeof item.slug === "string" ? item.slug : item.id,
	);
	if (!appId) return null;

	const names = stringMap(item.names);
	const descriptions = stringMap(item.descriptions);
	let offeredLocales: string[] | undefined;
	if (Array.isArray(item.locales)) {
		offeredLocales = item.locales
			.map((l) => text(l, 16))
			.filter((l): l is string => Boolean(l && LOCALE_RE.test(l)));
		if (offeredLocales.length === 0) offeredLocales = undefined;
	} else if (item.locales && typeof item.locales === "object") {
		for (const [locale, value] of Object.entries(
			item.locales as Record<string, unknown>,
		)) {
			if (!LOCALE_RE.test(locale) || !value || typeof value !== "object") {
				continue;
			}
			const entry = value as Record<string, unknown>;
			const n = text(entry.name);
			const d = text(entry.description);
			if (n) names[locale] = n;
			if (d) descriptions[locale] = d;
		}
	}
	const legacyKo = text(item.nameKo);
	const legacyEn = text(item.nameEn);
	if (legacyKo && !names.ko) names.ko = legacyKo;
	if (legacyEn && !names.en) names.en = legacyEn;
	const legacyDescKo = text(item.descriptionKo);
	const legacyDescEn = text(item.descriptionEn);
	if (legacyDescKo && !descriptions.ko) descriptions.ko = legacyDescKo;
	if (legacyDescEn && !descriptions.en) descriptions.en = legacyDescEn;

	const name = text(item.name) ?? names.en ?? names.ko ?? appId;
	const version = text(item.version, 64) ?? "1.0.0";
	const rawUrl = text(item.url, 2048);
	// Portal `source: "store"` records carry `url: "/apps/<slug>"` (storefront detail page),
	// which is not an iframe bundle URL; clear it so the shell supplies its hosted bundle path.
	const hostedEntryUrl =
		rawUrl && !isPortalStorefrontPageUrl(rawUrl) ? rawUrl : undefined;
	const description =
		text(item.description) ?? descriptions.en ?? descriptions.ko;
	const rawIcon = text(item.icon, 512) ?? text(item.thumbnailUrl, 512);
	const iconUrl =
		rawIcon && /^(?:https:\/\/|\/(?!\/))/.test(rawIcon) ? rawIcon : undefined;
	const icon =
		rawIcon && !iconUrl && rawIcon.length <= 16 ? rawIcon : undefined;
	const priceCredits =
		parsePriceCredits(item.creditPrice) ??
		parsePriceCredits(item.price_credits) ??
		parsePriceCredits(item.priceCredits);
	const source =
		item.source === "store"
			? "store"
			: item.source === "registry"
				? "registry"
				: priceCredits !== undefined && priceCredits > 0
					? "store"
					: undefined;

	return {
		appId,
		version,
		...(priceCredits !== undefined && priceCredits > 0 ? { priceCredits } : {}),
		...(source ? { source } : {}),
		...(hostedEntryUrl ? { hostedEntryUrl } : {}),
		...(iconUrl ? { iconUrl } : {}),
		...(offeredLocales ? { offeredLocales } : {}),
		manifest: {
			id: appId,
			name,
			...(Object.keys(names).length ? { names } : {}),
			...(icon ? { icon } : {}),
			...(description ? { description } : {}),
			...(Object.keys(descriptions).length ? { descriptions } : {}),
			version,
		},
	};
}

/** Parse the body of `GET /api/apps`; unknown shapes yield an empty list. */
export function parsePortalCatalog(body: unknown): AdminCatalogEntry[] {
	if (!body || typeof body !== "object") return [];
	const apps = (body as { apps?: unknown }).apps;
	if (!Array.isArray(apps)) return [];
	const seen = new Set<string>();
	const out: AdminCatalogEntry[] = [];
	for (const raw of apps.slice(0, 200)) {
		const entry = normalizePortalCatalogApp(raw);
		if (!entry || seen.has(entry.appId)) continue;
		seen.add(entry.appId);
		out.push(entry);
	}
	return out;
}

export function portalCatalogUrl(portalBase: string, locale?: string): string {
	const base = `${portalBase.replace(/\/+$/, "")}${PORTAL_CATALOG_PATH}`;
	const trimmedLocale = locale?.trim();
	return trimmedLocale && LOCALE_RE.test(trimmedLocale)
		? `${base}?lang=${encodeURIComponent(trimmedLocale)}`
		: base;
}

/**
 * Fetch portal catalog items. Never throws: a missing server, timeout, non-2xx
 * or malformed body returns `[]` so the store falls back to built-ins.
 */
export async function fetchPortalCatalog(
	fetchImpl: typeof fetch,
	portalBase: string,
	timeoutMs = PORTAL_CATALOG_TIMEOUT_MS,
	locale?: string,
): Promise<AdminCatalogEntry[]> {
	if (!portalBase) return [];
	const controller =
		typeof AbortController !== "undefined" ? new AbortController() : null;
	const timer = controller
		? setTimeout(() => controller.abort(), timeoutMs)
		: null;
	try {
		const res = await fetchImpl(portalCatalogUrl(portalBase, locale), {
			headers: { Accept: "application/json" },
			credentials: "omit",
			...(controller ? { signal: controller.signal } : {}),
		});
		if (!res.ok) return [];
		return parsePortalCatalog(await res.json());
	} catch {
		return [];
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function isOfferedInLocale(
	entry: Pick<AdminCatalogEntry, "offeredLocales">,
	locale: string,
): boolean {
	if (!entry.offeredLocales) return true;
	const base = locale.split("-")[0];
	return entry.offeredLocales.some(
		(l) => l === locale || l.split("-")[0] === base,
	);
}

/**
 * Normalize portal-provided `/hosted-apps/<rest>` URLs (either site-relative
 * `/hosted-apps/...` or portal-origin `https://naia.land/hosted-apps/...`) onto
 * the shell's mounted hosted-apps prefix (e.g. `/app/hosted-apps/...`).
 */
export function resolvePortalHostedEntryUrl(
	rawUrl: string,
	options: {
		shellOrigin?: string;
		portalOrigin?: string;
		hostedAppsPrefix: string;
	},
): string {
	const shellOrigin = options.shellOrigin?.replace(/\/+$/, "");
	const portalOrigin = options.portalOrigin?.replace(/\/+$/, "");
	const baseOrigin = shellOrigin || portalOrigin;
	const prefix = options.hostedAppsPrefix.startsWith("/")
		? options.hostedAppsPrefix
		: `/${options.hostedAppsPrefix}`;
	const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;

	if (rawUrl.startsWith("/") && !rawUrl.startsWith("//")) {
		if (!baseOrigin || rawUrl.includes("..")) return rawUrl;
		if (rawUrl.startsWith(normalizedPrefix)) {
			return `${shellOrigin ?? baseOrigin}${rawUrl}`;
		}
		if (rawUrl.startsWith("/hosted-apps/")) {
			const rest = rawUrl.slice("/hosted-apps/".length);
			return `${shellOrigin ?? baseOrigin}${normalizedPrefix}${rest}`;
		}
		return `${baseOrigin}${rawUrl}`;
	}

	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return rawUrl;
	}
	if (parsed.pathname.includes("..")) return rawUrl;
	const isSameHost =
		(shellOrigin !== undefined && parsed.origin === shellOrigin) ||
		(portalOrigin !== undefined && parsed.origin === portalOrigin);
	if (isSameHost && parsed.pathname.startsWith("/hosted-apps/")) {
		const rest = parsed.pathname.slice("/hosted-apps/".length);
		const targetOrigin = shellOrigin ?? parsed.origin;
		return `${targetOrigin}${normalizedPrefix}${rest}${parsed.search}${parsed.hash}`;
	}
	return rawUrl;
}

export interface BuildUnifiedAppCatalogOptions {
	gatewayItems: readonly StoreProductSummary[];
	portalItems?: readonly AdminCatalogEntry[];
	stage1HostedCatalog: boolean;
	hasCustomSandboxOrigin?: boolean;
	locale?: string;
	shellOrigin?: string;
	portalOrigin?: string;
	hostedAppsPrefix?: string;
	resolveDefaultHostedEntryUrl: (appId: string, version: string) => string;
	validateFrameSrc?: (entryUrl: string) => string;
}

export interface UnifiedAppCatalogResult {
	items: StoreProductSummary[];
	/** Free admin-registered app ids that launch without gateway purchase. */
	adminAppIds: Set<string>;
}

/**
 * Build one unified store catalog shared by adapters and UI surfaces (R3 / R4).
 */
export function buildUnifiedAppCatalog(
	options: BuildUnifiedAppCatalogOptions,
): UnifiedAppCatalogResult {
	const adminAppIds = new Set<string>();
	if (!options.stage1HostedCatalog) {
		return { items: [...options.gatewayItems], adminAppIds };
	}

	const filtered = options.gatewayItems.filter(
		(item) => !STAGE1_EXCLUDED_WEB_APP_IDS.has(item.appId),
	);
	const byId = new Map<string, StoreProductSummary>();
	for (const item of filtered) {
		const manifestStatus = (
			item.manifest as InstalledAppManifest & { status?: string }
		).status;
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
		const bundledCharacterCard =
			spec.appId === "land.naia.charcard" && !options.hasCustomSandboxOrigin;
		const hostedEntryUrl =
			(!bundledCharacterCard && existing?.hostedEntryUrl) ||
			options.resolveDefaultHostedEntryUrl(spec.appId, version);
		byId.set(spec.appId, {
			appId: spec.appId,
			version,
			priceCredits: existing ? existing.priceCredits : spec.defaultPriceCredits,
			hostedEntryUrl,
			manifest: mergedManifest,
		});
	}

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

	const portalItems = options.portalItems ?? [];
	if (portalItems.length === 0) {
		return { items: ordered, adminAppIds };
	}

	const known = new Set(ordered.map((item) => item.appId));
	const locale = options.locale ?? "ko";
	const hostedAppsPrefix = options.hostedAppsPrefix ?? "/hosted-apps/";
	for (const entry of portalItems) {
		if (known.has(entry.appId)) continue;
		if (STAGE1_EXCLUDED_WEB_APP_IDS.has(entry.appId)) continue;
		if (!isOfferedInLocale(entry, locale)) continue;
		const rawEntryUrl = entry.hostedEntryUrl
			? resolvePortalHostedEntryUrl(entry.hostedEntryUrl, {
					shellOrigin: options.shellOrigin,
					portalOrigin: options.portalOrigin,
					hostedAppsPrefix,
				})
			: options.resolveDefaultHostedEntryUrl(entry.appId, entry.version);
		if (options.validateFrameSrc) {
			try {
				options.validateFrameSrc(rawEntryUrl);
			} catch {
				continue;
			}
		}
		const priceCredits = entry.priceCredits ?? 0;
		const isFreeAdminEntry = entry.source !== "store" && priceCredits === 0;
		known.add(entry.appId);
		if (isFreeAdminEntry) {
			adminAppIds.add(entry.appId);
		}
		ordered.push({
			appId: entry.appId,
			version: entry.version,
			priceCredits,
			hostedEntryUrl: rawEntryUrl,
			...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
			manifest: entry.manifest,
		});
	}

	return { items: ordered, adminAppIds };
}

/**
 * Shared localization rule matching the portal storefront (`apps-catalog.ts`):
 * Exact locale -> base language -> English -> Korean -> manifest default.
 */
export function localizeStoreProduct(
	item: Pick<StoreProductSummary, "appId" | "manifest">,
	locale: string,
): { title: string; description: string } {
	const base = locale.split("-")[0]?.toLowerCase() || "en";
	const names = item.manifest.names;
	const descriptions = item.manifest.descriptions;

	const title =
		names?.[locale] ??
		names?.[base] ??
		names?.en ??
		names?.ko ??
		(item.manifest.name || item.appId);

	const description =
		descriptions?.[locale] ??
		descriptions?.[base] ??
		descriptions?.en ??
		descriptions?.ko ??
		item.manifest.description ??
		"";

	return { title, description };
}

/** Format store card price using the canonical R42 credit unit or localized Free label. */
export function formatStoreProductPrice(
	priceCredits: number,
	freeLabel: string,
): string {
	if (Number.isFinite(priceCredits) && priceCredits > 0) {
		return formatWebCredits(priceCredits);
	}
	return freeLabel;
}
