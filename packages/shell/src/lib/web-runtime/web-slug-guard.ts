import { LAB_GATEWAY_URL, NAIA_WEB_BASE_URL, loadConfig } from "../config";
import {
	WEB_REMOTE_KEY_STORAGE_KEY,
	getWebAuthenticatedUserId,
	isValidWebAuthKey,
} from "./web-auth";

const RESERVED_SUBDOMAINS = new Set([
	"www",
	"dev",
	"api",
	"api-dev",
	"apps-sandbox",
	"studio",
	"ax",
	"s",
	"demo",
	"admin",
	"mail",
	"auth",
	"app",
	"web",
	"contribute",
	"naia",
	"nextain",
	"localhost",
]);

const VALID_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

export function isValidUserSlug(slug: string): boolean {
	const normalized = slug.trim().toLowerCase();
	return (
		VALID_SLUG_RE.test(normalized) &&
		!normalized.includes("--") &&
		!RESERVED_SUBDOMAINS.has(normalized)
	);
}

/**
 * Extract `<slug>` when the web shell is opened at `/u/<slug>` (or `/u/<slug>/*`,
 * excluding `/auth/callback` while OAuth callback is completing) or `<slug>.dev.naia.land` /
 * `<slug>.naia.land`. Returns `null` on shared `/app` or `/` routes.
 */
export function extractWebSlugFromLocation(loc?: {
	hostname?: string;
	pathname?: string;
}): string | null {
	const current =
		loc ??
		(typeof window !== "undefined"
			? {
					hostname: window.location.hostname,
					pathname: window.location.pathname,
				}
			: null);
	if (!current) return null;

	const pathname = current.pathname ?? "/";
	const normalizedPath = pathname.replace(/\/+$/, "") || "/";
	if (normalizedPath.endsWith("/auth/callback")) {
		return null;
	}

	const pathMatch = /^\/u\/([^/?#]+)(?:\/|$)/i.exec(pathname);
	if (pathMatch) {
		const candidate = decodeURIComponent(pathMatch[1]).trim().toLowerCase();
		return isValidUserSlug(candidate) ? candidate : `invalid:${candidate}`;
	}

	const host = (current.hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
	const devSubMatch = /^([a-z0-9-]+)\.dev\.naia\.land$/i.exec(host);
	if (devSubMatch) {
		const sub = devSubMatch[1].toLowerCase();
		if (RESERVED_SUBDOMAINS.has(sub)) return null;
		return isValidUserSlug(sub) ? sub : `invalid:${sub}`;
	}
	const prodSubMatch = /^([a-z0-9-]+)\.naia\.land$/i.exec(host);
	if (prodSubMatch) {
		const sub = prodSubMatch[1].toLowerCase();
		if (RESERVED_SUBDOMAINS.has(sub)) return null;
		return isValidUserSlug(sub) ? sub : `invalid:${sub}`;
	}

	return null;
}

export interface SlugOwnerLookupPayload {
	userId: string;
	slug: string;
	redirect: boolean;
}

export type SlugOwnershipDecision =
	| { status: "none" }
	| { status: "authorized"; slug: string; ownerUserId: string; redirectToSlug?: string }
	| { status: "login_required"; slug: string; ownerUserId?: string }
	| { status: "forbidden_not_owner"; slug: string; ownerUserId: string; currentUserId: string }
	| { status: "not_found"; slug: string }
	| { status: "invalid_slug"; slug: string };

function readStoredAuthKey(): string | undefined {
	if (typeof localStorage !== "undefined") {
		const stored = localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)?.trim();
		if (stored && isValidWebAuthKey(stored)) return stored;
	}
	const cfgKey = loadConfig()?.naiaKey?.trim();
	if (cfgKey && isValidWebAuthKey(cfgKey)) return cfgKey;
	return undefined;
}

function parseOwnerPayload(raw: unknown): SlugOwnerLookupPayload | null {
	if (!raw || typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	const inner =
		typeof rec.data === "object" && rec.data !== null
			? (rec.data as Record<string, unknown>)
			: rec;
	const userId = String(inner.user_id ?? inner.userId ?? "").trim();
	const slug = String(inner.slug ?? "").trim().toLowerCase();
	if (!userId || !slug) return null;
	return {
		userId,
		slug,
		redirect: inner.redirect === true,
	};
}

export interface VerifyWebSlugOwnershipOptions {
	fetchImpl?: typeof fetch;
	gatewayUrl?: string;
	webBaseUrl?: string;
	authenticatedUserId?: string | null;
	authKey?: string | null;
	location?: { hostname?: string; pathname?: string };
}

/**
 * Verify ownership of `/u/<slug>` or `<slug>.dev.naia.land` via gateway
 * `GET /v1/slug/<slug>` (with automatic BFF fallback `${webBaseUrl}/api/slug/<slug>`
 * when the gateway route requires server-to-server master key).
 */
export async function verifyWebSlugOwnership(
	opts?: VerifyWebSlugOwnershipOptions,
): Promise<SlugOwnershipDecision> {
	const extracted = extractWebSlugFromLocation(opts?.location);
	if (!extracted) return { status: "none" };
	if (extracted.startsWith("invalid:")) {
		return { status: "invalid_slug", slug: extracted.slice("invalid:".length) };
	}

	const slug = extracted;
	const fetchFn = opts?.fetchImpl ?? ((input, init) => fetch(input, init));
	const gatewayUrl = (opts?.gatewayUrl ?? LAB_GATEWAY_URL).replace(/\/+$/, "");
	const webBaseUrl = (opts?.webBaseUrl ?? NAIA_WEB_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const currentUserId =
		opts?.authenticatedUserId !== undefined
			? (opts.authenticatedUserId?.trim() || undefined)
			: getWebAuthenticatedUserId();
	const authKey =
		opts?.authKey !== undefined
			? (opts.authKey?.trim() || undefined)
			: readStoredAuthKey();

	const headers: Record<string, string> = {};
	if (authKey) {
		headers["X-AnyLLM-Key"] = `Bearer ${authKey}`;
	}

	let owner: SlugOwnerLookupPayload | null = null;
	let sawNotFound = false;

	// 1. Primary lookup: gateway `/v1/slug/<slug>`
	try {
		const gwRes = await fetchFn(
			`${gatewayUrl}/v1/slug/${encodeURIComponent(slug)}`,
			{ headers },
		);
		if (gwRes.ok) {
			owner = parseOwnerPayload(await gwRes.json());
		} else if (gwRes.status === 404) {
			sawNotFound = true;
		}
	} catch {
		// fall through to portal BFF lookup
	}

	// 2. Fallback lookup: portal BFF `/api/slug/<slug>` (when gateway requires server master key)
	if (!owner && !sawNotFound && webBaseUrl) {
		try {
			const bffRes = await fetchFn(
				`${webBaseUrl}/api/slug/${encodeURIComponent(slug)}`,
				{ credentials: "include" },
			);
			if (bffRes.ok) {
				owner = parseOwnerPayload(await bffRes.json());
			} else if (bffRes.status === 404) {
				sawNotFound = true;
			}
		} catch {
			// ignore network failure
		}
	}

	if (sawNotFound) {
		return { status: "not_found", slug };
	}

	if (!owner) {
		// Fail closed on private personal slug URLs: never expose local workspace without verified owner login
		if (!currentUserId) {
			return { status: "login_required", slug };
		}
		return { status: "authorized", slug, ownerUserId: currentUserId };
	}

	if (!currentUserId) {
		return {
			status: "login_required",
			slug,
			ownerUserId: owner.userId,
		};
	}

	if (currentUserId !== owner.userId) {
		return {
			status: "forbidden_not_owner",
			slug,
			ownerUserId: owner.userId,
			currentUserId,
		};
	}

	return {
		status: "authorized",
		slug,
		ownerUserId: owner.userId,
		...(owner.redirect && owner.slug !== slug
			? { redirectToSlug: owner.slug }
			: {}),
	};
}
