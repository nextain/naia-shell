import { invoke } from "@tauri-apps/api/core";
import { LAB_GATEWAY_URL } from "./config";

export interface AppInstallRequest {
	appId: string;
	storeOrigin: string;
	state: string;
	name?: string;
}

function httpGatewayUrl(raw: string): string {
	return raw.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "");
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
	return invoke<boolean>("app_store_has_entitlement", { appId, gatewayUrl: getStoreGatewayUrl() });
}

interface StoreProductsResponse {
	data?: Array<{
		app_id?: string;
		manifest?: { name?: string; nameKo?: string; nameEn?: string };
	}>;
}

export async function getStoreProductName(appId: string): Promise<string | null> {
	const response = await fetch(`${getStoreGatewayUrl()}/v1/apps/products`);
	if (!response.ok) return null;
	const body = (await response.json()) as StoreProductsResponse;
	const product = body.data?.find((item) => item.app_id === appId);
	return product?.manifest?.nameKo || product?.manifest?.name || product?.manifest?.nameEn || null;
}
