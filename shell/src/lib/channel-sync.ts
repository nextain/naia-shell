import { emit } from "@tauri-apps/api/event";
import {
	agentAuthQuery,
	agentLabProxyRequest,
	resolveAuthMode,
} from "./agent-ipc";
import { sendConfigUpdate } from "./chat-service";
import { loadConfig, saveConfig } from "./config";
import { openDmChannel } from "./discord-api";
import { restartGateway, syncToGateway } from "./gateway-sync";
import { getLocale } from "./i18n";
import { Logger } from "./logger";
import { buildSystemPrompt } from "./persona";

// Phase 6b (#337): these endpoints are now reached via the agent lab proxy
// (`agentLabProxyRequest`). The agent injects `X-AnyLLM-Key` server-side from
// its own encrypted auth store — shell never sees the naiaKey.
const LINKED_CHANNELS_PATH = "/api/gateway/linked-channels";
const DISCORD_BOT_TOKEN_PATH = "/api/discord/bot-token";

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
 *
 * #337 Phase 6b: routed through agent lab proxy — agent injects naiaKey
 * server-side so the shell no longer needs the key in memory.
 */
async function fetchAndRestoreDiscordBotToken(): Promise<void> {
	try {
		const resp = await agentLabProxyRequest({
			mode: resolveAuthMode(),
			method: "GET",
			path: DISCORD_BOT_TOKEN_PATH,
		});
		if (!resp.ok) {
			if (resp.status !== 404) {
				Logger.warn("channel-sync", "discord bot-token API error", {
					status: resp.status,
					error: resp.error,
				});
			}
			return;
		}
		const data = (resp.body ?? {}) as { token?: string };
		if (!data?.token) return;

		await sendConfigUpdate({ secrets: { NAIA_DISCORD_BOT_TOKEN: data.token } });
		Logger.info("channel-sync", "Discord bot token restored via agent");
		await emit("discord_auth_complete", {});
	} catch (err) {
		Logger.warn("channel-sync", "fetchAndRestoreDiscordBotToken failed", {
			error: String(err),
		});
	}
}

/**
 * Fetch linked messaging channels from naia.nextain.io BFF.
 *
 * #337 Phase 6b: routed through agent lab proxy. The BFF still keys channel
 * lookups off the bearer token (X-AnyLLM-Key) — the X-User-Id header is now
 * the only piece the shell forwards explicitly, and X-Desktop-Key is dropped
 * since the agent always sets X-AnyLLM-Key.
 */
async function fetchLinkedChannels(
	naiaUserId: string,
): Promise<LinkedChannel[]> {
	try {
		const resp = await agentLabProxyRequest({
			mode: resolveAuthMode(),
			method: "GET",
			path: LINKED_CHANNELS_PATH,
			headers: { "X-User-Id": naiaUserId },
		});
		if (!resp.ok) {
			Logger.warn("channel-sync", "linked-channels API error", {
				status: resp.status,
				error: resp.error,
			});
			return [];
		}
		const data = (resp.body ?? {}) as LinkedChannelsResponse;
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
	// #337 Phase 10-pre cross-review CRITICAL #2: the gate is now "agent
	// reports logged-in" instead of "shell has naiaKey in localStorage".
	// The userId still comes from `naia-config.naiaUserId` (UI-state copy
	// written by SettingsTab.tsx after `agentAuthQuery`), with a fallback
	// query if it hasn't propagated yet.
	const mode = resolveAuthMode();
	let agentLoggedIn = false;
	let resolvedUserId: string | undefined;
	try {
		const queryResult = await agentAuthQuery(mode);
		agentLoggedIn = queryResult.loggedIn;
		resolvedUserId = queryResult.userId;
	} catch (err) {
		Logger.warn("channel-sync", "agentAuthQuery failed", { error: String(err) });
	}
	if (!agentLoggedIn) {
		Logger.info("channel-sync", "Agent not logged in, skipping channel sync");
		return;
	}
	const config = loadConfig();
	const naiaUserId = resolvedUserId || config?.naiaUserId;
	if (!naiaUserId) {
		Logger.info("channel-sync", "No userId resolved, skipping channel sync");
		return;
	}

	// Always attempt to restore Discord bot token on Lab login
	await fetchAndRestoreDiscordBotToken();

	const channels = await fetchLinkedChannels(naiaUserId);
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
			// #337 Phase 10-pre cross-review CRITICAL #2: shell never sees the
			// raw `naiaKey`. The gateway-sync wrapper accepts `undefined` here
			// — the agent injects auth at the actual gateway hop.
			undefined,
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
