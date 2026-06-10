/**
 * Discord REST API client.
 * All HTTP calls go through Rust (`discord_api` command) to bypass CORS.
 * Bot token is read from Naia Gateway config on the Rust side.
 */
import { invoke } from "@tauri-apps/api/core";
import { Logger } from "./logger";

export interface DiscordMessage {
	id: string;
	content: string;
	author: {
		id: string;
		username: string;
		bot?: boolean;
	};
	timestamp: string;
}

let cachedBotId: string | null = null;

/** Call Discord REST API via Rust proxy. */
async function discordApi<T>(
	endpoint: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	const result = await invoke<string>("discord_api", {
		endpoint,
		method,
		body: body ? JSON.stringify(body) : null,
	});
	return JSON.parse(result) as T;
}

/** Check if bot token is available. */
export async function isDiscordApiAvailable(): Promise<boolean> {
	try {
		await invoke<string>("read_discord_bot_token");
		return true;
	} catch {
		return false;
	}
}

/** Get the bot's own user ID (cached). */
export async function getBotUserId(): Promise<string | null> {
	if (cachedBotId) return cachedBotId;
	try {
		const data = await discordApi<{ id: string }>("/users/@me");
		cachedBotId = data.id;
		return data.id;
	} catch {
		return null;
	}
}

/** Send a message to a Discord DM channel. */
export async function sendDiscordMessage(
	channelId: string,
	content: string,
): Promise<DiscordMessage | null> {
	try {
		return await discordApi<DiscordMessage>(
			`/channels/${channelId}/messages`,
			"POST",
			{ content },
		);
	} catch (err) {
		Logger.warn("discord-api", "Send failed", { error: String(err) });
		return null;
	}
}

/** Fetch message history from a Discord DM channel. */
export async function fetchDiscordMessages(
	channelId: string,
	limit = 50,
	after?: string,
): Promise<DiscordMessage[]> {
	try {
		let url = `/channels/${channelId}/messages?limit=${limit}`;
		if (after) url += `&after=${after}`;
		const messages = await discordApi<DiscordMessage[]>(url);
		// Discord returns newest first — reverse for chronological order
		return messages.reverse();
	} catch (err) {
		Logger.warn("discord-api", "Fetch failed", { error: String(err) });
		return [];
	}
}

/**
 * Open or retrieve a DM channel with a Discord user.
 * Discord API: POST /users/@me/channels { recipient_id }
 */
export async function openDmChannel(
	recipientUserId: string,
): Promise<string | null> {
	try {
		const data = await discordApi<{ id: string }>(
			"/users/@me/channels",
			"POST",
			{ recipient_id: recipientUserId },
		);
		return data.id;
	} catch (err) {
		Logger.warn("discord-api", "Open DM channel failed", {
			error: String(err),
		});
		return null;
	}
}

/** Clear cached data. */
export function clearDiscordApiCache(): void {
	cachedBotId = null;
}
