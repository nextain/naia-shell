import { type AppConfig, loadConfig, saveConfig } from "./config";
import { openDmChannel } from "./discord-api";
import { getDefaultLlmModel } from "./llm";
import { Logger } from "./logger";

export interface DiscordAuthPayload {
	discordUserId?: string | null;
	discordChannelId?: string | null;
	discordTarget?: string | null;
}

function normalizeSnowflake(value?: string | null): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!/^[0-9]{6,32}$/.test(trimmed)) return "";
	return trimmed;
}

function normalizeTarget(value?: string | null): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (/^(user|channel):[0-9]{6,32}$/.test(trimmed)) return trimmed;
	return "";
}

function ensureBaseConfig(existing: AppConfig | null): AppConfig {
	if (existing) return existing;
	return {
		provider: "gemini",
		model: getDefaultLlmModel("gemini"),
		apiKey: "",
	};
}

export function persistDiscordDefaults(
	payload: DiscordAuthPayload,
): AppConfig | null {
	const discordUserId = normalizeSnowflake(payload.discordUserId);
	const discordChannelId = normalizeSnowflake(payload.discordChannelId);
	const explicitTarget = normalizeTarget(payload.discordTarget);
	const fallbackTarget = discordUserId ? `user:${discordUserId}` : "";
	const discordTarget = explicitTarget || fallbackTarget;

	if (!discordUserId && !discordTarget) {
		return null;
	}

	const current = ensureBaseConfig(loadConfig());
	const next: AppConfig = {
		...current,
		discordDefaultUserId: discordUserId || current.discordDefaultUserId,
		discordDefaultTarget: discordTarget || current.discordDefaultTarget,
		...(discordChannelId && { discordDmChannelId: discordChannelId }),
	};
	saveConfig(next);

	// Auto-discover DM channel ID if we have a user ID but no channel ID
	if (
		(discordUserId || next.discordDefaultUserId) &&
		!next.discordDmChannelId
	) {
		const targetUserId = discordUserId || next.discordDefaultUserId!;
		void discoverDmChannelId(targetUserId);
	}

	return next;
}

/**
 * Discover DM channel ID via Discord Bot API and persist it.
 * Fire-and-forget — errors are logged but never block the caller.
 */
async function discoverDmChannelId(userId: string): Promise<void> {
	try {
		const channelId = await openDmChannel(userId);
		if (!channelId) return;

		const current = loadConfig();
		if (!current || current.discordDmChannelId) return;

		saveConfig({ ...current, discordDmChannelId: channelId });
		Logger.info("discord-auth", "Auto-discovered DM channel ID", { channelId });
	} catch (err) {
		Logger.warn("discord-auth", "Failed to auto-discover DM channel", {
			error: String(err),
		});
	}
}
