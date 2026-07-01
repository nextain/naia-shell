import { ActiveAppBridge } from "./app-registry";

/** Cache of per-panel bridge instances. Each panel gets its own namespace. */
const bridgeCache = new Map<string, ActiveAppBridge>();

/**
 * Return (or create) an ActiveAppBridge for a specific panel.
 * Caches instances so onToolCall handlers survive panel re-renders.
 */
export function getBridgeForPanel(appId: string): ActiveAppBridge {
	if (!bridgeCache.has(appId)) {
		bridgeCache.set(appId, new ActiveAppBridge(appId));
	}
	return bridgeCache.get(appId)!;
}

/** Fallback for contexts where the active panel ID is not known. */
export const activeBridge = new ActiveAppBridge("__builtin__");
