import { Logger } from "./logger";

export interface UpdateInfo {
	version: string;
	body: string;
	installFn: () => Promise<void>;
}

/**
 * Check for app updates via Tauri updater plugin.
 * Returns null if up-to-date or updater unavailable (e.g. Flatpak).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
	try {
		const { check } = await import("@tauri-apps/plugin-updater");
		const update = await check();
		if (!update) return null;

		return {
			version: update.version,
			body: update.body ?? "",
			installFn: async () => {
				await update.downloadAndInstall();
				const { relaunch } = await import("@tauri-apps/plugin-process");
				await relaunch();
			},
		};
	} catch (err) {
		// Plugin not registered (Flatpak) or network error
		Logger.info("updater", "Update check skipped", { error: String(err) });
		return null;
	}
}
