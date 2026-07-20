import { loadConfig, saveConfig } from "./config";
import { openDmChannel } from "./discord-api";
import { Logger } from "./logger";

const LINKED_CHANNELS_API = "https://www.naia.land/api/gateway/linked-channels";

interface LinkedChannel {
	type: string;
	userId: string;
}

interface LinkedChannelsResponse {
	channels: LinkedChannel[];
}

/**
 * Fetch linked messaging channels from www.naia.land BFF.
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

	// Always discover/refresh DM channel ID via Bot API → naia config 에 영속(gateway 없음).
	try {
		const freshChannelId = await openDmChannel(discordUserId);
		if (freshChannelId) {
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

	// (gateway.json sync 제거됨 2026-06-12 — gateway 없음(#201). discord 채널 ID 는 위 saveConfig 로 naia config 에 영속.
	//  discord 메시징 자체 = 미이식 미래 UC(새 agent discord skill). config 만 보존, 죽은 gateway 동기 제거.)
}
