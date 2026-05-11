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
	ttsVoice?: string;
	ttsApiKey?: string;
	ttsEngine?: "auto" | "gateway" | "google";
	ttsProvider?: "google" | "edge" | "openai" | "elevenlabs" | "nextain";
	systemPrompt?: string;
	enableTools?: boolean;
	gatewayUrl?: string;
	gatewayToken?: string;
	disabledSkills?: string[];
	routeViaGateway?: boolean;
	// Webhook URLs / Discord defaults moved to sendNotifyConfig (#260).
	// Do not re-add per-request — credentials must not appear in every
	// chat_request stdio frame.
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

/**
 * Push per-provider LLM API keys to the agent (#260 follow-up).
 * Same one-shot pattern as sendAuthUpdate / sendNotifyConfig. Called at
 * startup and on settings save. Agent caches per-provider; buildProvider
 * reads from the cache first, falls back to legacy ChatRequest.apiKey for
 * backwards compat while we transition.
 *
 * `keys` shape: `{ [providerId]: apiKey }`. Empty string clears that
 * provider's cached entry (explicit unset when user removes the key in UI).
 */
export async function sendCredsUpdate(
	keys: Record<string, string>,
): Promise<void> {
	const request = { type: "creds_update", keys };
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
		ttsVoice,
		ttsApiKey,
		ttsEngine,
		ttsProvider,
		systemPrompt,
		enableTools,
		gatewayUrl,
		gatewayToken,
		disabledSkills,
		routeViaGateway,
	} = opts;

	const request = {
		type: "chat_request",
		requestId,
		provider,
		messages: [...history, { role: "user", content: message }],
		...(ttsVoice && { ttsVoice }),
		...(ttsApiKey && { ttsApiKey }),
		...(ttsEngine && { ttsEngine }),
		...(ttsProvider && { ttsProvider }),
		...(systemPrompt && { systemPrompt }),
		...(enableTools != null && { enableTools }),
		...(gatewayUrl && { gatewayUrl }),
		...(gatewayToken && { gatewayToken }),
		...(disabledSkills && disabledSkills.length > 0 && { disabledSkills }),
		...(routeViaGateway != null && { routeViaGateway }),
		// Webhook URLs and Discord defaults are intentionally NOT included here.
		// They live in the agent's process.env, set once via sendNotifyConfig()
		// at startup and re-sent on settings save (#260).
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
	gatewayToken?: string;
	// Webhook URLs / Discord defaults moved to sendNotifyConfig (#260).
}): Promise<{ success: boolean; output: string }> {
	const { toolName, args, requestId, gatewayUrl, gatewayToken } = opts;

	const request = {
		type: "tool_request",
		requestId,
		toolName,
		args,
		...(gatewayUrl && { gatewayUrl }),
		...(gatewayToken && { gatewayToken }),
		// Webhook URLs and Discord defaults are intentionally NOT included.
		// Source of truth lives in agent process.env via sendNotifyConfig() (#260).
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
