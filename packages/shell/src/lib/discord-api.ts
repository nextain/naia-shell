/** Narrow Discord native bridge. Bot tokens never cross WebView IPC. */
import { invoke } from "@tauri-apps/api/core";
import { Logger } from "./logger";

/** Check if bot token is available. */
export async function isDiscordApiAvailable(): Promise<boolean> {
	try {
		return await invoke<boolean>("discord_bot_token_available");
	} catch {
		return false;
	}
}

/**
 * Open or retrieve a DM channel with a Discord user.
 * The native side owns the only allowed route and validates the recipient id.
 */
export async function openDmChannel(
	recipientUserId: string,
): Promise<string | null> {
	try {
		return await invoke<string>("discord_open_dm_channel", {
			recipientUserId,
		});
	} catch (err) {
		Logger.warn("discord-api", "Open DM channel failed", {
			error: String(err),
		});
		return null;
	}
}

/** Kept for legacy callers; the typed bridge has no WebView-side secret cache. */
export function clearDiscordApiCache(): void {}
