import { Logger } from "./logger";
import {
	UI_PREFERENCE_KEYS,
	getUiPreference,
	patchUiPreferences,
} from "./ui-preferences";

export interface UpdateInfo {
	currentVersion: string;
	version: string;
	body: string;
	installFn: () => Promise<void>;
}

interface UpdatePromptStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

interface UpdatePromptSnooze {
	version: string;
	until: number;
}

export const UPDATE_PROMPT_SNOOZE_KEY = "naia.updatePromptSnooze";
export const UPDATE_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
const UPDATE_PROMPT_SNOOZE_PREFERENCE = UI_PREFERENCE_KEYS.updatePromptSnooze;

function browserStorage(): UpdatePromptStorage | null {
	if (typeof window === "undefined") return null;
	return {
		getItem: (key) => {
			if (key !== UPDATE_PROMPT_SNOOZE_KEY) return null;
			const value = getUiPreference<unknown>(
				UPDATE_PROMPT_SNOOZE_PREFERENCE,
				null,
			);
			return value === null || value === undefined
				? null
				: JSON.stringify(value);
		},
		setItem: (key, value) => {
			if (key !== UPDATE_PROMPT_SNOOZE_KEY) return;
			try {
				const parsed = JSON.parse(value) as unknown;
				void patchUiPreferences({
					[UPDATE_PROMPT_SNOOZE_PREFERENCE]: parsed,
				}).catch((error: unknown) => {
					Logger.warn("Updater", "ADK update snooze persistence failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			} catch (error) {
				Logger.warn("Updater", "ADK update snooze value was not valid JSON", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}

export function shouldShowStartupUpdatePrompt(
	version: string,
	now = Date.now(),
	storage: UpdatePromptStorage | null = browserStorage(),
): boolean {
	if (!storage) return true;

	try {
		const raw = storage.getItem(UPDATE_PROMPT_SNOOZE_KEY);
		if (!raw) return true;
		const snooze = JSON.parse(raw) as Partial<UpdatePromptSnooze>;
		return !(
			snooze.version === version &&
			typeof snooze.until === "number" &&
			Number.isFinite(snooze.until) &&
			snooze.until > now
		);
	} catch (err) {
		Logger.warn("updater", "Ignoring invalid update prompt snooze", {
			error: String(err),
		});
		return true;
	}
}

export function snoozeStartupUpdatePrompt(
	version: string,
	now = Date.now(),
	storage: UpdatePromptStorage | null = browserStorage(),
): void {
	if (!storage) return;

	try {
		storage.setItem(
			UPDATE_PROMPT_SNOOZE_KEY,
			JSON.stringify({ version, until: now + UPDATE_PROMPT_SNOOZE_MS }),
		);
	} catch (err) {
		Logger.warn("updater", "Failed to persist update prompt snooze", {
			error: String(err),
		});
	}
}

/**
 * Check for app updates via Tauri updater plugin.
 * Returns null only when the updater confirms that the app is up to date.
 * Transport, metadata, signature, and plugin errors are surfaced to the caller
 * so the UI cannot misreport a failed check as "latest".
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
	try {
		const { check } = await import("@tauri-apps/plugin-updater");
		const update = await check();
		if (!update) return null;

		return {
			currentVersion: update.currentVersion,
			version: update.version,
			body: update.body ?? "",
			installFn: async () => {
				await update.downloadAndInstall();
				const { relaunch } = await import("@tauri-apps/plugin-process");
				await relaunch();
			},
		};
	} catch (err) {
		Logger.error("updater", "Update check failed", { error: String(err) });
		throw err;
	}
}
