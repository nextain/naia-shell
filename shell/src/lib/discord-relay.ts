/**
 * Discord relay service — polls Discord REST API for new messages,
 * routes them through the local LLM pipeline, and sends responses
 * back via the Cloud Run relay bot.
 *
 * Core principle: Cloud Run is PURE RELAY. All LLM processing happens locally.
 * See: .agents/context/channels-discord.yaml
 */

import { sendChatMessage } from "./chat-service";
import {
	LAB_GATEWAY_URL,
	// eslint-disable-next-line @typescript-eslint/no-deprecated -- Discord
	// Cloud Run relay still authenticates via raw `naiaKey` Bearer; tracked
	// for migration to an agent-mediated relay in #338.
	getNaiaKeySecure,
	loadConfig,
	resolveConfiguredGatewayUrl,
	saveConfig,
} from "./config";
import {
	type DiscordMessage,
	fetchDiscordMessages,
	getBotUserId,
} from "./discord-api";
import { getLocale } from "./i18n";
import { Logger } from "./logger";
import { buildSystemPrompt } from "./persona";
import type { AgentResponseChunk } from "./types";

const POLL_INTERVAL_MS = 5_000;

/** Per-channel conversation history for LLM context */
const channelHistories = new Map<
	string,
	{ role: "user" | "assistant"; content: string }[]
>();

/** Subscribers for new messages (used by ChannelsTab) */
type MessageCallback = (messages: DiscordMessage[]) => void;
const subscribers = new Set<MessageCallback>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let botId: string | null = null;

/** Subscribe to new Discord messages (for ChannelsTab). */
export function onDiscordMessages(cb: MessageCallback): () => void {
	subscribers.add(cb);
	return () => subscribers.delete(cb);
}

/** Get the relay URL from config or default. */
function getRelayUrl(): string | null {
	const config = loadConfig();
	return config?.discordRelayUrl ?? null;
}

/**
 * Send LLM response to Cloud Run relay for Discord delivery.
 * Auth: naiaKey is sent as Bearer token. Cloud Run's NAIA_RELAY_KEY env var
 * must be set to the same naiaKey value for authentication to succeed.
 */
export async function sendRelayReply(
	channelId: string,
	content: string,
	replyToMessageId?: string,
): Promise<boolean> {
	const relayUrl = getRelayUrl();
	if (!relayUrl) {
		Logger.warn("discord-relay", "No relay URL configured");
		return false;
	}

	// #337 Phase 10-pre cross-review CRITICAL #2: read the legacy slot
	// directly (the @deprecated escape hatch) — `loadConfig().naiaKey` is no
	// longer populated. Tracked for migration to an agent-mediated relay in
	// #338.
	// eslint-disable-next-line @typescript-eslint/no-deprecated -- #338
	const naiaKey = await getNaiaKeySecure();
	if (!naiaKey) {
		Logger.warn("discord-relay", "No naiaKey for relay auth");
		return false;
	}

	try {
		const res = await fetch(`${relayUrl}/relay/reply`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${naiaKey}`,
			},
			body: JSON.stringify({ channelId, content, replyToMessageId }),
		});

		if (!res.ok) {
			const body = await res.text();
			Logger.warn("discord-relay", "Relay reply failed", {
				status: res.status,
				body: body.slice(0, 200),
			});
			return false;
		}
		return true;
	} catch (err) {
		Logger.warn("discord-relay", "Relay reply error", { error: String(err) });
		return false;
	}
}

/** Process a new Discord message through the LLM pipeline. */
async function processMessage(
	msg: DiscordMessage,
	channelId: string,
): Promise<void> {
	const config = loadConfig();
	if (!config) return;

	// Build per-channel history
	let history = channelHistories.get(channelId);
	if (!history) {
		history = [];
		channelHistories.set(channelId, history);
	}
	history.push({ role: "user", content: msg.content });

	// Keep history bounded
	if (history.length > 40) {
		history.splice(0, history.length - 40);
	}

	const systemPrompt = buildSystemPrompt(config.persona, {
		agentName: config.agentName,
		userName: msg.author.username,
		locale: config.locale || getLocale(),
		honorific: config.honorific,
		speechStyle: config.speechStyle,
	});

	const requestId = `discord-${channelId}-${Date.now()}`;
	let fullText = "";

	try {
		// sendChatMessage resolves after invoke, NOT after streaming completes.
		// We need to wait for the "finish" event via onChunk callback.
		await new Promise<void>((resolve, reject) => {
			sendChatMessage({
				message: msg.content,
				provider: {
					provider: config.provider,
					model: config.model,
					apiKey: config.apiKey,
					labGatewayUrl:
						config.provider === "nextain" ? LAB_GATEWAY_URL : undefined,
				},
				history: history.slice(0, -1),
				onChunk: (chunk: AgentResponseChunk) => {
					if (chunk.type === "text") {
						fullText += chunk.text;
					} else if (chunk.type === "finish") {
						resolve();
					} else if (chunk.type === "error") {
						reject(
							new Error(
								("message" in chunk ? chunk.message : "LLM error") as string,
							),
						);
					}
				},
				requestId,
				systemPrompt,
				enableTools: config.enableTools,
				gatewayUrl: resolveConfiguredGatewayUrl(config),
				disabledSkills: config.disabledSkills,
			}).catch(reject);
		});

		if (fullText.trim()) {
			history.push({ role: "assistant", content: fullText });
			const sent = await sendRelayReply(channelId, fullText, msg.id);
			Logger.info("discord-relay", sent ? "Sent reply" : "Reply send failed", {
				channelId,
				length: fullText.length,
			});
		}
	} catch (err) {
		Logger.warn("discord-relay", "LLM processing failed", {
			error: String(err),
		});
	}
}

/** Poll Discord REST API for new messages and process them. */
async function pollOnce(channelId: string): Promise<void> {
	const config = loadConfig();
	const lastId = config?.lastProcessedDiscordMessageId;

	try {
		const messages = await fetchDiscordMessages(channelId, 10, lastId);

		if (messages.length === 0) return;

		// Notify subscribers (ChannelsTab)
		for (const cb of subscribers) {
			try {
				cb(messages);
			} catch {
				// subscriber error doesn't block processing
			}
		}

		// Filter to only new user messages (not bot's own)
		const newUserMessages = messages.filter(
			(m) => !m.author.bot && m.author.id !== botId,
		);

		// Process each new user message through LLM FIRST
		for (const msg of newUserMessages) {
			await processMessage(msg, channelId);
		}

		// Update last processed ID AFTER successful processing
		const latest = messages[messages.length - 1];
		if (latest && latest.id !== lastId) {
			const current = loadConfig();
			if (current) {
				saveConfig({
					...current,
					lastProcessedDiscordMessageId: latest.id,
				});
			}
		}
	} catch (err) {
		Logger.warn("discord-relay", "Poll failed", { error: String(err) });
	}
}

/** Start Discord relay polling. */
export async function startDiscordRelay(): Promise<void> {
	if (pollTimer) return; // already running

	const config = loadConfig();
	const channelId = config?.discordDmChannelId;
	if (!channelId) {
		Logger.info("discord-relay", "No DM channel ID, relay not started");
		return;
	}

	botId = await getBotUserId();

	Logger.info("discord-relay", "Starting relay polling", {
		channelId,
		interval: POLL_INTERVAL_MS,
	});

	// Initial poll
	await pollOnce(channelId);

	pollTimer = setInterval(() => {
		pollOnce(channelId).catch((err) => {
			Logger.warn("discord-relay", "Poll error", { error: String(err) });
		});
	}, POLL_INTERVAL_MS);
}

/** Stop Discord relay polling. */
export function stopDiscordRelay(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
		Logger.info("discord-relay", "Relay polling stopped");
	}
}

/** Reset relay state (for testing or reconfig). */
export function resetDiscordRelay(): void {
	stopDiscordRelay();
	channelHistories.clear();
	subscribers.clear();
	botId = null;
}
