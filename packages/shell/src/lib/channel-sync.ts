import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { loadConfig, saveConfig } from "./config";
import { openDmChannel } from "./discord-api";
import { restartGateway, syncToGateway } from "./gateway-sync";
import { getLocale } from "./i18n";
import { Logger } from "./logger";
import { buildSystemPrompt } from "./persona";

const LINKED_CHANNELS_API =
	"https://naia.nextain.io/api/gateway/linked-channels";
const DISCORD_BOT_TOKEN_API = "https://naia.nextain.io/api/discord/bot-token";

interface LinkedChannel {
	type: string;
	userId: string;
}

interface LinkedChannelsResponse {
	channels: LinkedChannel[];
}

/**
 * Fetch the Discord bot token from naia.nextain.io and save it to naia-discord.json.
 * Called after Lab auth succeeds. Fails silently if the endpoint is unavailable.
 */
async function fetchAndRestoreDiscordBotToken(naiaKey: string): Promise<void> {
	try {
		const res = await fetch(DISCORD_BOT_TOKEN_API, {
			headers: { Authorization: `Bearer ${naiaKey}` },
		});
		if (!res.ok) {
			if (res.status !== 404) {
				Logger.warn("channel-sync", "discord bot-token API error", {
					status: res.status,
				});
			}
			return;
		}
		const data = (await res.json()) as { token?: string };
		if (!data?.token) return;

		await invoke("write_discord_bot_token", { token: data.token });
		Logger.info("channel-sync", "Discord bot token restored");
		await emit("discord_auth_complete", {});
	} catch (err) {
		Logger.warn("channel-sync", "fetchAndRestoreDiscordBotToken failed", {
			error: String(err),
		});
	}
}

/**
 * Fetch linked messaging channels from naia.nextain.io BFF.
 * Uses desktop key + user id for authentication.
 */
async function fetchLinkedChannels(
	naiaKey: string,
	naiaUserId: string,
): Promise<LinkedChannel[]> {
	try {
		const res = await fetch(LINKED_CHANNELS_API, {
			headers: {
				"X-Desktop-Key": naiaKey,
				"X-User-Id": naiaUserId,
			},
		});
		if (!res.ok) {
			Logger.warn("channel-sync", "linked-channels API error", {
				status: res.status,
			});
			return [];
		}
		const data = (await res.json()) as LinkedChannelsResponse;
		return data?.channels ?? [];
	} catch (err) {
		Logger.warn("channel-sync", "fetchLinkedChannels failed", {
			error: String(err),
		});
		return [];
	}
}

/**
 * Sync linked channels after login.
 * Called from naia_auth_complete handler in App.tsx / SettingsTab.
 *
 * Flow:
 * 1. Fetch linked channels from BFF
 * 2. If discord channel found → discover DM channel ID (always refresh)
 * 3. Persist to config + sync to Naia Gateway + restart
 */
export async function syncLinkedChannels(): Promise<void> {
	const config = loadConfig();
	if (!config?.naiaKey || !config?.naiaUserId) {
		Logger.info("channel-sync", "No lab credentials, skipping channel sync");
		return;
	}

	// Always attempt to restore Discord bot token on Lab login
	await fetchAndRestoreDiscordBotToken(config.naiaKey);

	const channels = await fetchLinkedChannels(config.naiaKey, config.naiaUserId);
	if (channels.length === 0) {
		Logger.info("channel-sync", "No linked channels found");
		return;
	}

	const discordChannel = channels.find((ch) => ch.type === "discord");
	if (!discordChannel) {
		Logger.info("channel-sync", "No discord channel linked");
		return;
	}

	const discordUserId = discordChannel.userId;
	Logger.info("channel-sync", "Found linked Discord account", {
		discordUserId,
	});

	// Persist discord user ID to config
	const current = loadConfig();
	if (!current) return;

	saveConfig({
		...current,
		discordDefaultUserId: discordUserId,
		discordDefaultTarget:
			current.discordDefaultTarget || `user:${discordUserId}`,
	});

	// Always discover/refresh DM channel ID via Bot API
	let dmChannelId = current.discordDmChannelId;
	try {
		const freshChannelId = await openDmChannel(discordUserId);
		if (freshChannelId) {
			dmChannelId = freshChannelId;
			const updated = loadConfig();
			if (updated) {
				saveConfig({ ...updated, discordDmChannelId: freshChannelId });
			}
			Logger.info("channel-sync", "DM channel ID resolved", {
				channelId: freshChannelId,
				wasNew: !current.discordDmChannelId,
			});
		}
	} catch (err) {
		Logger.warn("channel-sync", "Failed to discover DM channel", {
			error: String(err),
		});
	}

	// Sync to gateway.json + restart so Gateway picks up the channel ID
	if (dmChannelId) {
		await syncGatewayChannels(discordUserId, dmChannelId);
	}
}

/**
 * Sync discord channel IDs to gateway.json and restart Gateway.
 * This ensures the persistent config includes the DM channel ID
 * so it survives Gateway restarts.
 */
async function syncGatewayChannels(
	discordUserId: string,
	dmChannelId: string,
): Promise<void> {
	try {
		const config = loadConfig();
		if (!config) return;

		const fullPrompt = buildSystemPrompt(config.persona, {
			agentName: config.agentName,
			userName: config.userName,
			honorific: config.honorific,
			speechStyle: config.speechStyle,
			locale: config.locale || getLocale(),
			discordDefaultUserId: discordUserId,
			discordDmChannelId: dmChannelId,
		});

		await syncToGateway(
			config.provider ?? "gemini",
			config.model ?? "",
			config.apiKey,
			config.persona,
			config.agentName,
			config.userName,
			fullPrompt,
			config.locale || getLocale(),
			dmChannelId,
			discordUserId,
			config.ttsProvider,
			config.ttsVoice,
			config.ttsEnabled ? "always" : "off",
			undefined,
			config.naiaKey,
			config.ollamaHost,
		);
		await restartGateway();
		Logger.info("channel-sync", "Gateway config updated with channel IDs", {
			discordUserId,
			dmChannelId,
		});
	} catch (err) {
		Logger.warn("channel-sync", "Failed to sync channels to Gateway", {
			error: String(err),
		});
	}
}
