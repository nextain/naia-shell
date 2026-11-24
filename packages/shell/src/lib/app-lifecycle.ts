import { useAppStore } from "../stores/app";
import { appRegistry } from "./app-registry";
import { sendAppSkillsClear } from "./chat-service";
import { Logger } from "./logger";

/**
 * Determine whether a non-built-in mini-app is currently active or mounted in the background.
 */
export function isMiniAppRunning(
	appId: string,
	activeApp: string | null,
	activatedApps: readonly string[] = [],
	closedApps: readonly string[] = [],
): boolean {
	const descriptor = appRegistry.get(appId);
	if (!descriptor || descriptor.builtIn) return false;
	if (activeApp === appId) return true;
	if (descriptor.keepAlive === false) return false;
	if (closedApps.includes(appId)) return false;
	return activatedApps.includes(appId);
}

/**
 * Explicitly close and terminate a running mini-app:
 * 1) Return to Desktop (`setActiveApp(null)`) when this app is currently active
 * 2) Unmount its `keepAlive` instance and increment its mount epoch so reopening starts fresh
 * 3) Clear its active app context and unregister its `skill_*` tools from the Agent
 */
export function closeRunningApp(appId: string): void {
	const state = useAppStore.getState();
	const wasActive = state.activeApp === appId;
	const descriptor = appRegistry.get(appId);
	Logger.info("AppLifecycle", `Closing mini-app: ${appId}`, {
		wasActive,
		keepAlive: descriptor?.keepAlive,
	});
	if (typeof state.closeApp === "function") {
		state.closeApp(appId);
	} else {
		if (wasActive) state.setActiveApp(null);
		state.setActiveAppContext?.(null);
	}
	if (!wasActive && descriptor?.onDeactivate) {
		Logger.debug("AppLifecycle", `Closed background mini-app: ${appId}`);
	}
	appRegistry.updateApi?.(appId, undefined);
	sendAppSkillsClear(appId).catch((error: unknown) => {
		Logger.warn("AppLifecycle", "Failed to clear closed app skills", {
			appId,
			error: String(error),
		});
	});
}
