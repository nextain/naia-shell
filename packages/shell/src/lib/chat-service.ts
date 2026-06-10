import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Logger } from "./logger";
import type { NaiaTool } from "./panel-registry";
import type { AgentResponseChunk, ProviderConfig } from "./types";
// ── new-naia 이식 코어 결선 (UC1 텍스트 대화) ──
// VITE_NAIA_NEW_CORE=1 일 때 sendChatMessage/cancelChat 가 새 core(hexagonal os core)를 경유.
// 미설정 시 기존 경로 그대로(voice/tts/gateway 등 보존) — 비파괴·지속가능.
import { makeShellChatService } from "@nextain/naia-os-core/shell-compat";

// 빌드타임 env(prod/dev) OR 런타임 window 플래그(E2E 가 addInitScript 로 주입 — dev 서버
// env 없이도 통합테스트가 새 경로를 강제·검증). 둘 다 없으면 기존 경로 그대로.
const NEW_CORE =
	import.meta.env?.VITE_NAIA_NEW_CORE === "1" ||
	(typeof window !== "undefined" &&
		(window as { __NAIA_NEW_CORE__?: boolean }).__NAIA_NEW_CORE__ === true);
let _coreChat: ReturnType<typeof makeShellChatService> | null = null;
function coreChat() {
	if (!_coreChat)
		_coreChat = makeShellChatService({
			// ⚠️ @tauri listen 은 콜백에 Event 객체({event,payload})를 준다. 새 core transport(LiveTransportDeps)
			// 는 인자를 payload 로 간주 → 여기서 .payload 를 풀어 넘긴다(안 풀면 agent_response 가 unknown 으로
			// 드롭돼 스트리밍이 영원히 ▌ 에 멈춤 — UC1 E2E 가 잡은 실 버그). invoke 는 시그니처 동일이라 그대로.
			live: { invoke, listen: (event, cb) => listen(event, (e) => cb((e as { payload: unknown }).payload)) },
			clientId: "shell",
		});
	return _coreChat;
}

/**
 * Invoke `send_to_agent_command` but swallow errors when naia-agent is
 * unavailable (W2 — 사용자 명시 "naia-agent / naia-memory 의존성 제외").
 *
 * Returns `true` on successful invoke, `false` on caught error (naia-agent
 * down / not spawned / IPC dropped). Callers that depend on the request
 * actually landing should check the return value; fire-and-forget callers
 * (auth_update, notify_config, creds_update, panel_*) can ignore it.
 *
 * Logged with `Logger.warn` so the operator sees it in dev console without
 * the main flow throwing. Main flow degrades gracefully:
 *   - F2 Gemini Live direct (googleApiKey 모드) — 영향 없음
 *   - F2 naia 계정 chat — sendChatMessage 실패 → caller 가 안내 표시
 *   - F4 자체 스킬 (directToolCall) — caller 가 안내 표시
 */
async function safeSendToAgent(
	message: object,
	opName: string,
): Promise<boolean> {
	try {
		await invoke("send_to_agent_command", {
			message: JSON.stringify(message),
		});
		return true;
	} catch (err) {
		Logger.warn("ChatService", `${opName} swallowed — naia-agent unavailable`, {
			error: String(err),
		});
		return false;
	}
}

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
	/** Enable thinking/reasoning output from models that support it. */
	enableThinking?: boolean;
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
	await safeSendToAgent(request, "sendNotifyConfig");
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
	await safeSendToAgent(request, "sendCredsUpdate");
}

const RESPONSE_TIMEOUT_MS = 120_000; // Safety: clean up listener if no finish/error

export async function sendChatMessage(opts: SendChatOptions): Promise<void> {
	// new-naia 코어 경유(UC1 텍스트). voice/tts/route 는 미지원(UC2 후속) — 기존 경로가 담당.
	if (NEW_CORE) {
		return coreChat().sendChatMessage({
			message: opts.message,
			provider: opts.provider,
			history: opts.history,
			onChunk: opts.onChunk as (c: Record<string, unknown>) => void,
			requestId: opts.requestId,
			...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.enableTools !== undefined ? { enableTools: opts.enableTools } : {}),
			...(opts.enableThinking !== undefined ? { enableThinking: opts.enableThinking } : {}),
			...(opts.gatewayUrl !== undefined ? { gatewayUrl: opts.gatewayUrl } : {}),
			...(opts.disabledSkills !== undefined ? { disabledSkills: opts.disabledSkills } : {}),
		});
	}
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
		enableThinking,
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
		...(enableThinking != null && { enableThinking }),
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

	// sendChatMessage 는 caller (= ChatPanel) 가 "naia 계정 chat 사용 불가"
	// UI 안내 하도록 fail 시 throw 유지 — safeSendToAgent 사용 X. Logger.warn
	// 은 helper 가 처리하지 않고 caller 의 catch 가 surface.
	try {
		await invoke("send_to_agent_command", {
			message: JSON.stringify(request),
		});
	} catch (err) {
		clearTimeout(timeoutId);
		unlisten();
		Logger.warn("ChatService", "sendChatMessage failed — naia-agent unavailable", {
			error: String(err),
		});
		throw err;
	}
}

export async function cancelChat(requestId: string): Promise<void> {
	if (NEW_CORE) { await coreChat().cancelChat(requestId).catch(() => {}); return; }
	// cancel_stream 은 별 Tauri command — fire-and-forget swallow.
	try {
		await invoke("cancel_stream", { requestId });
	} catch (err) {
		Logger.warn("ChatService", "cancelChat swallowed — naia-agent unavailable", {
			error: String(err),
		});
	}
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

	const sent = await safeSendToAgent(request, "requestTts");
	if (!sent) {
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
	/**
	 * Called when the agent emits an `approval_request` for a Tier>0 tool.
	 * The voice tool path has no streaming-chat UI loop (which normally
	 * handles approvals in handleChunk), so without this the agent waits for
	 * an approval that never comes → RESPONSE_TIMEOUT_MS hang. The caller
	 * decides how to resolve it (voice mode auto-approves — the user spoke
	 * the request, which is implicit consent).
	 */
	onApprovalRequest?: (req: {
		requestId: string;
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
		tier?: number;
		description?: string;
	}) => void;
	/**
	 * Called when the agent emits `panel_tool_call` (a panel-owned tool like
	 * skill_browser_*). The voice path has no chat UI loop, so without this the
	 * panel tool never runs and the agent hangs. The caller routes it to the
	 * owning panel's bridge and replies via `sendPanelToolResult`.
	 */
	onPanelToolCall?: (req: {
		requestId: string;
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
	}) => void;
	/**
	 * Called when the agent emits `panel_control` (e.g. skill_panel switch).
	 * The caller performs the panel switch/reload. Without this, voice mode
	 * reports "switched" but the panel never actually changes.
	 */
	onPanelControl?: (req: {
		requestId: string;
		action: string;
		panelId?: string;
	}) => void;
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
			} else if (chunk.type === "approval_request") {
				// Tier>0 tool needs approval. The voice path has no chat UI loop
				// to handle it, so delegate to the caller (voice mode auto-
				// approves). Without this the agent waits → timeout hang.
				const ar = chunk as unknown as {
					requestId: string;
					toolCallId: string;
					toolName: string;
					args: Record<string, unknown>;
					tier?: number;
					description?: string;
				};
				opts.onApprovalRequest?.({
					requestId: ar.requestId,
					toolCallId: ar.toolCallId,
					toolName: ar.toolName,
					args: ar.args,
					tier: ar.tier,
					description: ar.description,
				});
			} else if (chunk.type === "panel_tool_call") {
				// Panel-owned tool (skill_browser_* etc.). Route to the panel
				// bridge via the caller; the bridge replies with sendPanelToolResult,
				// after which the agent emits tool_result/finish.
				const pc = chunk as unknown as {
					requestId: string;
					toolCallId: string;
					toolName: string;
					args: Record<string, unknown>;
				};
				opts.onPanelToolCall?.({
					requestId: pc.requestId,
					toolCallId: pc.toolCallId,
					toolName: pc.toolName,
					args: pc.args,
				});
			} else if (chunk.type === "panel_control") {
				const pc = chunk as unknown as {
					requestId: string;
					action: string;
					panelId?: string;
				};
				opts.onPanelControl?.({
					requestId: pc.requestId,
					action: pc.action,
					panelId: pc.panelId,
				});
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

	const sent = await safeSendToAgent(request, "directToolCall");
	if (!sent) {
		clearTimeout(timeoutId);
		unlisten();
		rejectPromise(new Error("naia-agent unavailable"));
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

	const sent = await safeSendToAgent(
		{ type: "skill_list", requestId },
		"fetchAgentSkills",
	);
	if (!sent) {
		clearTimeout(timeoutId);
		unlisten();
		rejectPromise(new Error("naia-agent unavailable"));
	}

	return promise;
}

/** Send panel skill descriptors to the agent (on panel activate) */
export async function sendPanelSkills(
	panelId: string,
	tools: NaiaTool[],
): Promise<void> {
	await safeSendToAgent(
		{
			type: "panel_skills",
			panelId,
			tools: tools.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters ?? { type: "object", properties: {} },
				...(t.tier != null && { tier: t.tier }),
			})),
		},
		"sendPanelSkills",
	);
}

/** Tell the agent to remove panel's proxy skills (on panel deactivate) */
export async function sendPanelSkillsClear(panelId: string): Promise<void> {
	await safeSendToAgent(
		{ type: "panel_skills_clear", panelId },
		"sendPanelSkillsClear",
	);
}

/** Install a panel from a git URL or local zip file path (delegated to agent) */
export async function sendPanelInstall(source: string): Promise<void> {
	await safeSendToAgent(
		{ type: "panel_install", source },
		"sendPanelInstall",
	);
}

/** Send panel tool execution result back to the agent */
export async function sendPanelToolResult(
	requestId: string,
	toolCallId: string,
	result: string,
	success: boolean,
): Promise<void> {
	await safeSendToAgent(
		{
			type: "panel_tool_result",
			requestId,
			toolCallId,
			result,
			success,
		},
		"sendPanelToolResult",
	);
}

/** Send naiaKey to the agent (backend). Call on login and on app init if key exists. */
export async function sendAuthUpdate(naiaKey: string): Promise<void> {
	await safeSendToAgent({ type: "auth_update", naiaKey }, "sendAuthUpdate");
}

/** Request the agent to pre-download an offline embedding model. */
export async function sendEmbeddingPrefetch(
	model: "all-MiniLM-L6-v2" | "all-mpnet-base-v2",
): Promise<void> {
	await safeSendToAgent(
		{ type: "embedding_prefetch", model },
		"sendEmbeddingPrefetch",
	);
}
