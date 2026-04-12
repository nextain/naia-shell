import { invoke } from "@tauri-apps/api/core";
import { LAB_GATEWAY_URL, loadConfig } from "./config";
import { getLocale } from "./i18n";
import { Logger } from "./logger";
import { buildSystemPrompt } from "./persona";

/**
 * Best-effort sync of Shell provider settings to Naia Gateway config.
 * Errors are logged but never block the UI.
 *
 * Builds the full system prompt with persona/locale context.
 * User facts are handled by Agent MemorySystem (sessionRecall) — not included here.
 */
export interface MemorySyncParams {
	memoryAdapter?: string;
	memoryEmbeddingProvider?: string;
	memoryOfflineModel?: string;
	memoryEmbeddingBaseUrl?: string;
	memoryEmbeddingApiKey?: string;
	memoryEmbeddingModel?: string;
	qdrantUrl?: string;
	qdrantApiKey?: string;
}

export async function syncToGateway(
	provider: string,
	model: string,
	apiKey?: string,
	persona?: string,
	agentName?: string,
	userName?: string,
	_systemPrompt?: string,
	locale?: string,
	discordDmChannelId?: string,
	discordDefaultUserId?: string,
	_ttsProvider?: string,
	_ttsVoice?: string,
	_ttsAuto?: string,
	_ttsMode?: string,
	naiaKey?: string,
	ollamaHost?: string,
	memory?: MemorySyncParams,
): Promise<void> {
	try {
		const cfg = loadConfig();
		const fullPrompt = buildSystemPrompt(persona || cfg?.persona || undefined, {
			agentName: agentName || cfg?.agentName || undefined,
			userName: userName || cfg?.userName || undefined,
			locale: locale || cfg?.locale || getLocale(),
			honorific: cfg?.honorific,
			speechStyle: cfg?.speechStyle,
			discordDefaultUserId: discordDefaultUserId || cfg?.discordDefaultUserId,
			discordDmChannelId: discordDmChannelId || cfg?.discordDmChannelId,
		});

		await invoke("sync_gateway_config", {
			params: {
				provider,
				model,
				api_key: apiKey || null,
				persona: fullPrompt,
				agent_name: agentName || null,
				user_name: userName || null,
				locale: locale || null,
				discord_dm_channel_id: discordDmChannelId || null,
				discord_default_user_id: discordDefaultUserId || null,
				tts_provider: null,
				tts_voice: null,
				tts_auto: null,
				tts_mode: null,
				naia_key: naiaKey || null,
				ollama_host: ollamaHost || null,
				lab_gateway_url: LAB_GATEWAY_URL,
				// Memory settings
				memory_adapter: memory?.memoryAdapter || null,
				memory_embedding_provider: memory?.memoryEmbeddingProvider || null,
				memory_offline_model: memory?.memoryOfflineModel || null,
				memory_embedding_base_url: memory?.memoryEmbeddingBaseUrl || null,
				memory_embedding_api_key: memory?.memoryEmbeddingApiKey || null,
				memory_embedding_model: memory?.memoryEmbeddingModel || null,
				qdrant_url: memory?.qdrantUrl || null,
				qdrant_api_key: memory?.qdrantApiKey || null,
			},
		});
	} catch (err) {
		Logger.warn("gateway-sync", "Failed to sync gateway config", {
			error: String(err),
		});
	}
}

/**
 * Restart the Naia Gateway so it reads fresh config from gateway.json.
 * Best-effort — errors are logged but never block the UI.
 *
 * Debounced: multiple calls within 2s collapse to a single restart.
 * If a restart is already in flight, returns the existing promise.
 */
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const restartResolvers: Array<() => void> = [];
let inflightRestart: Promise<void> | null = null;

export function restartGateway(): Promise<void> {
	// If invoke is already in-flight, return the existing promise
	if (inflightRestart) return inflightRestart;

	// Debounce: reset timer on each call, all callers share one promise
	if (restartTimer) clearTimeout(restartTimer);

	const promise = new Promise<void>((resolve) => {
		restartResolvers.push(resolve);
		restartTimer = setTimeout(async () => {
			restartTimer = null;
			const resolvers = restartResolvers.splice(0);
			inflightRestart = (async () => {
				try {
					await invoke("restart_gateway");
				} catch (err) {
					Logger.warn("gateway-sync", "Failed to restart gateway", {
						error: String(err),
					});
				} finally {
					inflightRestart = null;
					for (const r of resolvers) r();
				}
			})();
		}, 2000);
	});

	return promise;
}
