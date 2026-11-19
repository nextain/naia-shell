/**
 * Unified web app catalog (R3 / R4, 2026-11-19).
 *
 * The in-shell mini-app store (`WebAppStoreModal`) and the portal storefront
 * (`naia.land/{locale}/apps`) must show one list.  The shell builds that list
 * from three sources, in this precedence order:
 *
 *   1. built-in Stage-1 mini-apps (`STAGE1_HOSTED_MINI_APPS`, always present);
 *   2. gateway products (`GET /v1/apps/products`);
 *   3. apps registered by a portal admin (`GET {portal}/api/apps`).
 *
 * Any source may fail; the built-in list is always shown.  The contract of
 * the portal endpoint is documented in `docs/app-store-protocol.md`
 * ("Unified web app catalog").
 */

import type { InstalledAppManifest } from "./app-loader";

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
}

/** Normalized admin entry before it becomes a store product. */
export interface AdminCatalogEntry {
	appId: string;
	version: string;
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

const VALID_ID_RE = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/i;
const SHORT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const SHOWN_VISIBILITY = new Set(["public", "listed", "published", "active"]);

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

/**
 * Admin ids may be reverse-DNS (`land.naia.foo`) or a short slug (`foo`);
 * short slugs are placed under `land.naia.` so every catalog id is canonical.
 */
export function canonicalAdminAppId(raw: unknown): string | null {
	const id = text(raw, 128)?.toLowerCase();
	if (!id) return null;
	if (VALID_ID_RE.test(id)) return id;
	if (SHORT_SLUG_RE.test(id)) return `land.naia.${id}`;
	return null;
}

/**
 * Normalize one portal catalog item.  Accepts the R4 contract shape and the
 * legacy portal `AppRecord` shape (`slug`, `nameKo`, `names`, …) so the shell
 * keeps working while the portal migrates.  Returns null for hidden or
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
	// Legacy AppRecord: `id` is a database row id, `slug` is the app id.
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
	const hostedEntryUrl = text(item.url, 2048);
	const description =
		text(item.description) ?? descriptions.en ?? descriptions.ko;
	// An image URL stays a store-only picture; the app bar shows text icons.
	const rawIcon = text(item.icon, 512);
	const iconUrl =
		rawIcon && /^(?:https:\/\/|\/(?!\/))/.test(rawIcon) ? rawIcon : undefined;
	const icon =
		rawIcon && !iconUrl && rawIcon.length <= 16 ? rawIcon : undefined;
	return {
		appId,
		version,
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

export function portalCatalogUrl(portalBase: string): string {
	return `${portalBase.replace(/\/+$/, "")}${PORTAL_CATALOG_PATH}`;
}

/**
 * Fetch admin-registered apps.  Never throws: a missing server, timeout, non
 * 2xx or malformed body returns `[]` so the store falls back to built-ins.
 */
export async function fetchPortalCatalog(
	fetchImpl: typeof fetch,
	portalBase: string,
	timeoutMs = PORTAL_CATALOG_TIMEOUT_MS,
): Promise<AdminCatalogEntry[]> {
	if (!portalBase) return [];
	const controller =
		typeof AbortController !== "undefined" ? new AbortController() : null;
	const timer = controller
		? setTimeout(() => controller.abort(), timeoutMs)
		: null;
	try {
		const res = await fetchImpl(portalCatalogUrl(portalBase), {
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
