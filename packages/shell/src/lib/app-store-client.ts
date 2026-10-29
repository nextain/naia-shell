import { invoke } from "@tauri-apps/api/core";
import { LAB_GATEWAY_URL } from "./config";
import { getLocale } from "./i18n";

export interface AppInstallRequest {
	appId: string;
	storeOrigin: string;
	state: string;
	name?: string;
}

function httpGatewayUrl(raw: string): string {
	return raw
		.replace(/^ws:/, "http:")
		.replace(/^wss:/, "https:")
		.replace(/\/+$/, "");
}

export function getStoreGatewayUrl(): string {
	// The app store is an any-llm gateway concern (/v1/apps/*), so it must use
	// LAB_GATEWAY_URL (canonical instance API from naia-instance-urls) — the
	// same gateway the web storefront purchases against. The earlier
	// fallback to config.gatewayUrl / DEFAULT_GATEWAY_URL pointed at the REMOVED
	// legacy chat WebSocket gateway (ws://localhost:18789), so install hit a dead
	// localhost port ("error sending request for url http://localhost:18789/...",
	// 2026-08-31 rehearsal). config.gatewayUrl (chat gateway) is unrelated here.
	return httpGatewayUrl(LAB_GATEWAY_URL);
}

export function hasStoreEntitlement(appId: string): Promise<boolean> {
	return invoke<boolean>("app_store_has_entitlement", {
		appId,
		gatewayUrl: getStoreGatewayUrl(),
	});
}

interface StoreProductsResponse {
	data?: Array<{
		app_id?: string;
		manifest?: {
			name?: string;
			nameKo?: string;
			nameEn?: string;
			description?: string;
			descriptionKo?: string;
			descriptionEn?: string;
			names?: Record<string, string>;
			descriptions?: Record<string, string>;
			thumbnailUrl?: string;
			thumbnail_url?: string;
		};
	}>;
}

export interface StoreProductMetadata {
	name: string | null;
	description: string | null;
	thumbnailUrl: string | null;
}

function pickLocalized(
	localized: Record<string, string> | undefined,
	locale: string,
	legacy: string | undefined,
	root: string | undefined,
): string | null {
	return localized?.[locale] || legacy || localized?.en || root || null;
}

export async function getStoreProductMetadata(
	appId: string,
	locale = getLocale(),
): Promise<StoreProductMetadata | null> {
	const response = await fetch(`${getStoreGatewayUrl()}/v1/apps/products`);
	if (!response.ok) return null;
	const body = (await response.json()) as StoreProductsResponse;
	const product = body.data?.find((item) => item.app_id === appId);
	const manifest = product?.manifest;
	if (!manifest) return null;
	const legacyName = locale === "ko" ? manifest.nameKo || manifest.nameEn : manifest.nameEn || manifest.nameKo;
	const legacyDescription = locale === "ko" ? manifest.descriptionKo || manifest.descriptionEn : manifest.descriptionEn || manifest.descriptionKo;
	return {
		name: pickLocalized(manifest.names, locale, legacyName, manifest.name),
		description: pickLocalized(
			manifest.descriptions,
			locale,
			legacyDescription,
			manifest.description,
		),
		thumbnailUrl: manifest.thumbnailUrl || manifest.thumbnail_url || null,
	};
}

export async function getStoreProductName(
	appId: string,
	locale = getLocale(),
): Promise<string | null> {
	return (await getStoreProductMetadata(appId, locale))?.name ?? null;
}
