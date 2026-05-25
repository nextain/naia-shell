import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NaiaTool } from "./panel-registry";
import type { AgentResponseChunk, ProviderConfig } from "./types";

interface SendChatOptions {
	message: string;
	provider: ProviderConfig;
	history: { role: "user" | "assistant"; content: string }[];
	onChunk: (chunk: AgentResponseChunk) => void;
	requestId: string;
	/** Local session ID — agent uses this to persist the conversation locally. */
	sessionId?: string;
	ttsVoice?: string;
	ttsEngine?: "auto" | "gateway" | "google";
	ttsProvider?: "google" | "edge" | "openai" | "elevenlabs" | "nextain";
	systemPrompt?: string;
	enableTools?: boolean;
	gatewayUrl?: string;
	disabledSkills?: string[];
	routeViaGateway?: boolean;
	// Credentials (provider.apiKey, ttsApiKey, gatewayToken) and webhook
	// URLs are intentionally NOT carried on per-request. They flow ONCE
	// via sendCredsUpdate / sendNotifyConfig at startup + on settings save,
	// and the agent caches them. Adding any credential field back here
	// re-opens the stdio leak #260 closed.
}

export interface NotifyConfig {
	slackWebhookUrl?: string;
	discordWebhookUrl?: string;
	googleChatWebhookUrl?: string;
	discordDefaultUserId?: string;
	discordDefaultTarget?: string;
	discordDmChannelId?: string;
}

/**
 * Send notify config to the agent. Should be called once at app startup
 * and again whenever the user saves settings. Replaces per-request webhook
 * URL transmission (#260) — credentials stay out of chat_request / tool_request
 * stdio frames.
 */
export async function sendNotifyConfig(cfg: NotifyConfig): Promise<void> {
	const request = {
		type: "notify_config",
		...(cfg.slackWebhookUrl !== undefined && {
			slackWebhookUrl: cfg.slackWebhookUrl,
		}),
		...(cfg.discordWebhookUrl !== undefined && {
			discordWebhookUrl: cfg.discordWebhookUrl,
		}),
		...(cfg.googleChatWebhookUrl !== undefined && {
			googleChatWebhookUrl: cfg.googleChatWebhookUrl,
		}),
		...(cfg.discordDefaultUserId !== undefined && {
			discordDefaultUserId: cfg.discordDefaultUserId,
		}),
		...(cfg.discordDefaultTarget !== undefined && {
			discordDefaultTarget: cfg.discordDefaultTarget,
		}),
		...(cfg.discordDmChannelId !== undefined && {
			discordDmChannelId: cfg.discordDmChannelId,
		}),
	};
	await invoke("send_to_agent_command", { message: JSON.stringify(request) });
}

export interface CredsPayload {
	/** LLM provider id → apiKey. Required. Sparse — only configured providers. */
	keys: Record<string, string>;
	/** TTS provider id → apiKey. Optional. Only when TTS keys configured. */
	ttsKeys?: Record<string, string>;
	/** Gateway WebSocket auth token. Optional. Only when gateway configured. */
	gatewayToken?: string;
}

/**
 * Push all per-session credentials to the agent (#260 follow-up).
 *
 * Same one-shot pattern as sendAuthUpdate / sendNotifyConfig. Called at
 * startup and on every settings save. Agent caches per-provider; chat /
 * tool / tts request paths no longer carry credentials at all.
 *
 * Empty string for any entry clears the agent-side cached value (explicit
 * unset when the user removes a key from settings).
 */
export async function sendCredsUpdate(payload: CredsPayload): Promise<void> {
	const request: Record<string, unknown> = {
		type: "creds_update",
		keys: payload.keys,
	};
	if (payload.ttsKeys !== undefined) request.ttsKeys = payload.ttsKeys;
	if (payload.gatewayToken !== undefined)
		request.gatewayToken = payload.gatewayToken;
	await invoke("send_to_agent_command", { message: JSON.stringify(request) });
}

const RESPONSE_TIMEOUT_MS = 120_000; // Safety: clean up listener if no finish/error

export async function sendChatMessage(opts: SendChatOptions): Promise<void> {
	const {
		message,
		provider,
		history,
		onChunk,
		requestId,
		sessionId,
		ttsVoice,
		ttsEngine,
		ttsProvider,
		systemPrompt,
		enableTools,
		gatewayUrl,
		disabledSkills,
		routeViaGateway,
	} = opts;

	// Sanitize provider — strip credential fields. They flow via creds_update.
	const { apiKey: _apiKey, naiaKey: _naiaKey, ...providerSafe } = provider;

	const request = {
		type: "chat_request",
		requestId,
		...(sessionId && { sessionId }),
		provider: providerSafe,
		messages: [...history, { role: "user", content: message }],
		...(ttsVoice && { ttsVoice }),
		...(ttsEngine && { ttsEngine }),
		...(ttsProvider && { ttsProvider }),
		...(systemPrompt && { systemPrompt }),
		...(enableTools != null && { enableTools }),
		...(gatewayUrl && { gatewayUrl }),
		...(disabledSkills && disabledSkills.length > 0 && { disabledSkills }),
		...(routeViaGateway != null && { routeViaGateway }),
		// Credentials + webhook URLs intentionally NOT included. They flow via
		// sendCredsUpdate (#260 follow-up) and sendNotifyConfig (#260) and live
		// in agent module-scope caches / process.env.
	};

	// Listen for agent responses before sending to avoid race conditions
	const unlisten = await listen<string>("agent_response", (event) => {
		try {
			const raw =
				typeof event.payload === "string"
					? event.payload
					: JSON.stringify(event.payload);
			const chunk = JSON.parse(raw) as AgentResponseChunk;
			if (!("requestId" in chunk) || chunk.requestId !== requestId) return;
			onChunk(chunk);

			if (chunk.type === "finish" || chunk.type === "error") {
				clearTimeout(timeoutId);
				unlisten();
			}
		} catch {
			// Ignore malformed events
		}
	});

	// Safety timeout: clean up listener if agent never sends finish/error
	const timeoutId = setTimeout(() => {
		unlisten();
		onChunk({ type: "error", requestId, message: "Agent response timeout" });
	}, RESPONSE_TIMEOUT_MS);

	try {
		await invoke("send_to_agent_command", {
			message: JSON.stringify(request),
		});
	} catch (err) {
		clearTimeout(timeoutId);
		unlisten();
		throw err;
	}
}

export async function cancelChat(requestId: string): Promise<void> {
	await invoke("cancel_stream", { requestId });
}

/** Pipeline TTS: synthesize a single sentence → returns MP3 base64 via callback */
export async function requestTts(opts: {
	text: string;
	voice?: string;
	ttsProvider?: "edge" | "google" | "openai" | "elevenlabs" | "nextain";
	ttsApiKey?: string;
	requestId: string;
	onAudio: (mp3Base64: string, costUsd?: number) => void;
}): Promise<void> {
	const { text, voice, ttsProvider, ttsApiKey, requestId, onAudio } = opts;

	const request = {
		type: "tts_request",
		requestId,
		text,
		...(voice && { voice }),
		...(ttsProvider && { ttsProvider }),
		...(ttsApiKey && { ttsApiKey }),
	};

	const unlisten = await listen<string>("agent_response", (event) => {
		try {
			const raw =
				typeof event.payload === "string"
					? event.payload
					: JSON.stringify(event.payload);
			const chunk = JSON.parse(raw) as {
				type: string;
				requestId: string;
				data?: string;
				costUsd?: number;
			};
			if (chunk.requestId !== requestId) return;

			if (chunk.type === "audio" && chunk.data) {
				onAudio(chunk.data, chunk.costUsd);
			}
			if (chunk.type === "finish" || chunk.type === "error") {
				clearTimeout(timeoutId);
				unlisten();
			}
		} catch {
			// Ignore malformed events
		}
	});

	const timeoutId = setTimeout(() => {
		unlisten();
	}, 30_000);

	try {
		await invoke("send_to_agent_command", {
			message: JSON.stringify(request),
		});
	} catch {
		clearTimeout(timeoutId);
		unlisten();
	}
}

/** Direct tool call — bypasses LLM, no token cost */
export async function directToolCall(opts: {
	toolName: string;
	args: Record<string, unknown>;
	requestId: string;
	gatewayUrl?: string;
	// Credentials (gatewayToken) + webhook URLs flow via sendCredsUpdate /
	// sendNotifyConfig at startup + on save. Never per-request.
}): Promise<{ success: boolean; output: string }> {
	const { toolName, args, requestId, gatewayUrl } = opts;

	const request = {
		type: "tool_request",
		requestId,
		toolName,
		args,
		...(gatewayUrl && { gatewayUrl }),
	};

	let result = { success: false, output: "" };
	let resolvePromise!: (value: { success: boolean; output: string }) => void;
	let rejectPromise!: (reason: unknown) => void;

	const promise = new Promise<{ success: boolean; output: string }>(
		(resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		},
	);

	const unlisten = await listen<string>("agent_response", (event) => {
		try {
			const raw =
				typeof event.payload === "string"
					? event.payload
					: JSON.stringify(event.payload);
			const chunk = JSON.parse(raw) as AgentResponseChunk;
			if (!("requestId" in chunk) || chunk.requestId !== requestId) return;

			if (chunk.type === "tool_result") {
				result = {
					success: chunk.success,
					output: chunk.output,
				};
			} else if (chunk.type === "finish") {
				clearTimeout(timeoutId);
				unlisten();
				resolvePromise(result);
			} else if (chunk.type === "error") {
				clearTimeout(timeoutId);
				unlisten();
				rejectPromise(new Error(chunk.message));
			}
		} catch {
			// Ignore malformed events
		}
	});

	const timeoutId = setTimeout(() => {
		unlisten();
		rejectPromise(new Error("Tool request timeout"));
	}, RESPONSE_TIMEOUT_MS);

	try {
		await invoke("send_to_agent_command", {
			message: JSON.stringify(request),
		});
	} catch (err) {
		clearTimeout(timeoutId);
		unlisten();
		rejectPromise(err);
	}

	return promise;
}

/** Fetch all registered skill tool definitions from the Agent.
 *  Used by Omni voice mode to include built-in skills in the voice session. */
export async function fetchAgentSkills(): Promise<
	{ name: string; description: string; parameters: Record<string, unknown> }[]
> {
	const requestId = `skill-list-${Date.now()}`;

	let resolvePromise!: (
		value: {
			name: string;
			description: string;
			parameters: Record<string, unknown>;
		}[],
	) => void;
	let rejectPromise!: (reason: unknown) => void;

	const promise = new Promise<
		{ name: string; description: string; parameters: Record<string, unknown> }[]
	>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});

	const unlisten = await listen<string>("agent_response", (event) => {
		try {
			const raw =
				typeof event.payload === "string"
					? event.payload
					: JSON.stringify(event.payload);
			const chunk = JSON.parse(raw) as AgentResponseChunk;
			if (!("requestId" in chunk) || chunk.requestId !== requestId) return;

			if (chunk.type === "skill_list_response") {
				clearTimeout(timeoutId);
				unlisten();
				resolvePromise(chunk.tools);
			} else if (chunk.type === "error") {
				clearTimeout(timeoutId);
				unlisten();
				rejectPromise(new Error(chunk.message));
			}
		} catch {
			// Ignore malformed events
		}
	});

	const timeoutId = setTimeout(() => {
		unlisten();
		rejectPromise(new Error("Skill list request timeout"));
	}, 10_000);

	try {
		await invoke("send_to_agent_command", {
			message: JSON.stringify({ type: "skill_list", requestId }),
		});
	} catch (err) {
		clearTimeout(timeoutId);
		unlisten();
		rejectPromise(err);
	}

	return promise;
}

/** Send panel skill descriptors to the agent (on panel activate) */
export async function sendPanelSkills(
	panelId: string,
	tools: NaiaTool[],
): Promise<void> {
	await invoke("send_to_agent_command", {
		message: JSON.stringify({
			type: "panel_skills",
			panelId,
			tools: tools.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters ?? { type: "object", properties: {} },
				...(t.tier != null && { tier: t.tier }),
			})),
		}),
	});
}

/** Tell the agent to remove panel's proxy skills (on panel deactivate) */
export async function sendPanelSkillsClear(panelId: string): Promise<void> {
	await invoke("send_to_agent_command", {
		message: JSON.stringify({ type: "panel_skills_clear", panelId }),
	});
}

/** Install a panel from a git URL or local zip file path (delegated to agent) */
export async function sendPanelInstall(source: string): Promise<void> {
	await invoke("send_to_agent_command", {
		message: JSON.stringify({ type: "panel_install", source }),
	});
}

/** Send panel tool execution result back to the agent */
export async function sendPanelToolResult(
	requestId: string,
	toolCallId: string,
	result: string,
	success: boolean,
): Promise<void> {
	await invoke("send_to_agent_command", {
		message: JSON.stringify({
			type: "panel_tool_result",
			requestId,
			toolCallId,
			result,
			success,
		}),
	});
}

/** Send naiaKey to the agent (backend). Call on login and on app init if key exists. */
export async function sendAuthUpdate(naiaKey: string): Promise<void> {
	await invoke("send_to_agent_command", {
		message: JSON.stringify({ type: "auth_update", naiaKey }),
	});
}

/** Request the agent to pre-download an offline embedding model. */
export async function sendEmbeddingPrefetch(
	model: "all-MiniLM-L6-v2" | "all-mpnet-base-v2",
): Promise<void> {
	await invoke("send_to_agent_command", {
		message: JSON.stringify({ type: "embedding_prefetch", model }),
	});
}

export interface ConfigUpdatePayload {
	config?: Record<string, unknown>;
	secrets?: Record<string, string>;
}

export async function sendConfigUpdate(
	payload: ConfigUpdatePayload,
): Promise<void> {
	const request: Record<string, unknown> = {
		type: "config_update",
		id: `cfg-${Date.now()}`,
		config: payload.config,
	};
	if (payload.secrets && Object.keys(payload.secrets).length > 0) {
		request.secrets = payload.secrets;
	}
	await invoke("send_to_agent_command", {
		message: JSON.stringify(request),
	});
}

export async function sendFactoryReset(): Promise<void> {
	await invoke("send_to_agent_command", {
		message: JSON.stringify({ type: "factory_reset", id: `fr-${Date.now()}` }),
	});
}

/** Request the agent to push its currently loaded config via config_sync. */
export async function sendGetConfig(): Promise<void> {
	await invoke("send_to_agent_command", {
		message: JSON.stringify({ type: "get_config" }),
	});
}
