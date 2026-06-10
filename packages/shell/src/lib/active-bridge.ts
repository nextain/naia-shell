import { ActivePanelBridge } from "./panel-registry";

/** Cache of per-panel bridge instances. Each panel gets its own namespace. */
const bridgeCache = new Map<string, ActivePanelBridge>();

/**
 * Return (or create) an ActivePanelBridge for a specific panel.
 * Caches instances so onToolCall handlers survive panel re-renders.
 */
export function getBridgeForPanel(panelId: string): ActivePanelBridge {
	if (!bridgeCache.has(panelId)) {
		bridgeCache.set(panelId, new ActivePanelBridge(panelId));
	}
	return bridgeCache.get(panelId)!;
}

/** Fallback for contexts where the active panel ID is not known. */
export const activeBridge = new ActivePanelBridge("__builtin__");
