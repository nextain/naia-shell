import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Logger } from "./logger";
import type { NaiaTool } from "./app-registry";
import type { AgentResponseChunk, EnvironmentSegment, ProviderConfig } from "./types";
// ── new-naia 이식 코어 결선 (UC1 텍스트 대화) ──
// VITE_NAIA_NEW_CORE=1 일 때 sendChatMessage/cancelChat 가 새 core(hexagonal os core)를 경유.
// 미설정 시 기존 경로 그대로(voice/tts/gateway 등 보존) — 비파괴·지속가능.
import { makeShellChatService } from "@nextain/naia-os-core/shell-compat";

// 빌드타임 env(prod/dev) OR 런타임 window 플래그(E2E 가 addInitScript 로 주입). ⚠️ *호출 시점*에
// 평가(함수) — 모듈-const 스냅샷은 import 후 주입된 플래그를 놓침(codex 2-clean 지적). 둘 다 없으면 기존 경로.
export function isNewCore(): boolean {
	return (
		import.meta.env?.VITE_NAIA_NEW_CORE === "1" ||
		(typeof window !== "undefined" &&
			(window as { __NAIA_NEW_CORE__?: boolean }).__NAIA_NEW_CORE__ === true)
	);
}
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
	/**
	 * S4 — 명시 systemPrompt override(예: voice-pipeline 의 brevity 지시). 일반 채팅은 **안 보냄**:
	 * 코어가 persona+workspace+environmentSegments 를 스스로 조립한다(naia-os buildSystemPrompt 두벌 제거).
	 */
	systemPrompt?: string;
	/** S4 — 셸 환경고유 세그먼트(아바타 감정·패널). 코어가 머지. persona/locale 등은 코어가 config.json 에서 조립(안 보냄). */
	environmentSegments?: EnvironmentSegment[];
	enableTools?: boolean;
	/** Enable thinking/reasoning output from models that support it. */
	enableThinking?: boolean;
	gatewayUrl?: string;
	disabledSkills?: string[];
	routeViaGateway?: boolean;
	activityResume?: SpeechActivityResume;
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
	// new-core graft: 셸 keys-map({[provider]:apiKey})을 core 의 구조화 객체(ShellCredsPayload{provider,apiKey})로
	// 매핑해 creds_update(structured) 채널로 전송. ttsKeys/gatewayToken 은 새 아키텍처서 agent 미소비
	// (TTS=os→provider WS 직결 / gateway=naiaKey 경유) → 의도적 미전송(Old-Baseline 드리프트 아님, 새 agent 실수요 충실).
	if (isNewCore()) {
		// 셸 keys-map({[provider]:apiKey}) → core 구조화 creds_update(provider+apiKey) 채널.
		// 빈 apiKey 도 그대로 전송 = old-baseline 의 "빈=명시 unset" 시맨틱 보존(agent keychain overlay 가
		// merge + 빈=권위적 unset 으로 처리, 키체인 fallback 차단). ttsKeys/gatewayToken 은 새 agent 미소비
		// (TTS=os→provider WS 직결 / gateway=naiaKey 경유)라 미전송. provider 키는 셸 keyMap 키 그대로
		// (nextain apiKey 는 항상 "" 라 emit 안 됨 — App.tsx; naia 계정 키는 sendAuthUpdate 경유).
		for (const [provider, apiKey] of Object.entries(payload.keys)) {
			if (!provider) continue;
			await coreChat().sendCredsUpdate({ provider, apiKey }).catch(() => {});
		}
		return;
	}
	const request: Record<string, unknown> = {
		type: "creds_update",
		keys: payload.keys,
	};
	if (payload.ttsKeys !== undefined) request.ttsKeys = payload.ttsKeys;
	if (payload.gatewayToken !== undefined)
		request.gatewayToken = payload.gatewayToken;
	await safeSendToAgent(request, "sendCredsUpdate");
}

/**
 * UC13 — 승인 응답 송신. UI 결정(once|always|reject) → wire decision 매핑(once/always→approve).
 * ⚠️ fire-and-forget 안전: 내부 swallow+log(old ChatArea .catch 패리티) — 호출자에게 절대 reject 안 함.
 * NEW_CORE → 새 core transport(approve|reject). else → old 경로 raw(once/always/reject, old agent 호환).
 */
export async function sendApprovalResponse(
	requestId: string,
	toolCallId: string,
	uiDecision: "once" | "always" | "reject",
): Promise<void> {
	const mapped: "approve" | "reject" = uiDecision === "reject" ? "reject" : "approve";
	try {
		if (isNewCore()) {
			await coreChat().sendApprovalResponse(requestId, toolCallId, mapped);
			return;
		}
		await safeSendToAgent(
			{ type: "approval_response", requestId, toolCallId, decision: uiDecision },
			"sendApprovalResponse",
		);
	} catch (err) {
		Logger.warn("ChatService", "sendApprovalResponse swallowed", { error: String(err) });
	}
}

const RESPONSE_TIMEOUT_MS = 120_000; // Safety: clean up listener if no finish/error

export async function sendChatMessage(opts: SendChatOptions): Promise<void> {
	// new-naia 코어 경유(UC1 텍스트). voice/tts/route 는 미지원(UC2 후속) — 기존 경로가 담당.
	if (isNewCore()) {
		return coreChat().sendChatMessage({
			message: opts.message,
			provider: opts.provider,
			history: opts.history,
			onChunk: opts.onChunk as (c: Record<string, unknown>) => void,
			requestId: opts.requestId,
			...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.environmentSegments !== undefined ? { environmentSegments: opts.environmentSegments } : {}),
			...(opts.enableTools !== undefined ? { enableTools: opts.enableTools } : {}),
			...(opts.enableThinking !== undefined ? { enableThinking: opts.enableThinking } : {}),
			...(opts.gatewayUrl !== undefined ? { gatewayUrl: opts.gatewayUrl } : {}),
			...(opts.disabledSkills !== undefined ? { disabledSkills: opts.disabledSkills } : {}),
			...(opts.activityResume !== undefined ? { activityResume: opts.activityResume } : {}),
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
		environmentSegments,
		enableTools,
		enableThinking,
		gatewayUrl,
		disabledSkills,
		routeViaGateway,
		activityResume,
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
		...(environmentSegments && environmentSegments.length > 0 && { environmentSegments }),
		...(enableTools != null && { enableTools }),
		...(enableThinking != null && { enableThinking }),
		...(gatewayUrl && { gatewayUrl }),
		...(disabledSkills && disabledSkills.length > 0 && { disabledSkills }),
		...(routeViaGateway != null && { routeViaGateway }),
		...(activityResume && { activityResume }),
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

	// sendChatMessage 는 caller (= ChatArea) 가 "naia 계정 chat 사용 불가"
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

export interface SpeechActivityResume {
	sessionId: string;
	activityId: string;
	profileGeneration: number;
	yieldGeneration: number;
	resumeToken: string;
}

export async function configureSpeechProfile(input: {
	profile: "disabled" | "personal_radio_dj" | "exhibition_intro";
	sessionId?: string;
	idleMs?: number;
	djIntervalMs?: number;
	introIntervalMs?: number;
	timezone?: string;
	bgmAutoPlayOptIn?: boolean;
	weatherLatitude?: number;
	weatherLongitude?: number;
	weatherConsented?: boolean;
	knowledgeScope?: string;
}): Promise<boolean> {
	return safeSendToAgent(
		{
			type: "configure_speech_profile",
			requestId: generateControlRequestId(),
			sessionId: input.sessionId ?? "agent:main:main",
			...input,
		},
		"configureSpeechProfile",
	);
}

export async function yieldSpeechActivity(
	activityId: string,
	sessionId = "agent:main:main",
): Promise<SpeechActivityResume | undefined> {
	const requestId = generateControlRequestId();
	return new Promise(async (resolve) => {
		let settled = false;
		const finish = (value?: SpeechActivityResume) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			unlisten?.();
			resolve(value);
		};
		let unlisten: (() => void) | undefined;
		const timeout = setTimeout(() => finish(), 5_000);
		unlisten = await listen<string>("agent_response", (event) => {
			try {
				const raw = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
				const result = JSON.parse(raw) as Record<string, unknown>;
				if (result.requestId !== requestId) return;
				if (result.type !== "speech_activity_yielded" || result.ok !== true) {
					finish();
					return;
				}
				finish({
					sessionId,
					activityId: String(result.activityId),
					profileGeneration: Number(result.profileGeneration),
					yieldGeneration: Number(result.yieldGeneration),
					resumeToken: String(result.resumeToken),
				});
			} catch {
				// unrelated/malformed event
			}
		});
		const sent = await safeSendToAgent(
			{ type: "yield_speech_activity", requestId, sessionId, activityId },
			"yieldSpeechActivity",
		);
		if (!sent) finish();
	});
}

export async function stopSpeechActivity(
	activityId?: string,
	sessionId = "agent:main:main",
): Promise<boolean> {
	return safeSendToAgent(
		{
			type: "stop_speech_activity",
			requestId: generateControlRequestId(),
			sessionId,
			...(activityId ? { activityId } : {}),
		},
		"stopSpeechActivity",
	);
}

export type SpeechActivityControl =
	| "music_only"
	| "talk_less"
	| "talk_more"
	| "change_vibe"
	| "next"
	| "quiet"
	| "resume"
	| "restart"
	| "stop";

export async function controlSpeechActivity(
	action: SpeechActivityControl,
	activityId?: string,
	sessionId = "agent:main:main",
): Promise<boolean> {
	return safeSendToAgent(
		{
			type: "control_speech_activity",
			requestId: generateControlRequestId(),
			sessionId,
			action,
			...(activityId ? { activityId } : {}),
		},
		"controlSpeechActivity",
	);
}

function generateControlRequestId(): string {
	return `speech-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function cancelChat(requestId: string): Promise<void> {
	if (isNewCore()) { await coreChat().cancelChat(requestId).catch(() => {}); return; }
	// cancel_stream 은 별 Tauri command — fire-and-forget swallow.
	try {
		await invoke("cancel_stream", { requestId });
	} catch (err) {
		Logger.warn("ChatService", "cancelChat swallowed — naia-agent unavailable", {
			error: String(err),
		});
	}
}

/**
 * Pipeline / preview TTS is synthesized **shell-side** via
 * `lib/tts/synthesize.ts` (#363) — the new-core agent has no TTS backend, so
 * the old `requestTts` IPC (`tts_request` message) was dropped by the Rust
 * `agent_dispatcher` and every cloud voice went silent. The agent is no longer
 * in the TTS path.
 */

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
		appId?: string;
	}) => void;
}): Promise<{ success: boolean; output: string }> {
	const { toolName, args, requestId, gatewayUrl } = opts;

	// new-core 는 standalone tool_request 를 미지원한다 — 도구는 chat 도구루프(chat_request)로만 실행(UC5).
	// agent 가 어차피 즉시 "미지원" error 를 주지만, 기동 시 여러 directToolCall(skill_sessions·fetch-models·
	// skill_voicewake)이 gRPC 왕복·직렬 대기하며 기동을 ~90초 막는 문제(2026-06-13 실측: agent ingress 는
	// 즉시인데 응답 왕복이 묶임)가 있어, 셸에서 즉시 fail-fast 한다. 호출자(gateway-sessions·SettingsTab 등)는
	// 이 실패를 이미 우아하게 catch→warn 으로 처리. old-core 경로에선 종전대로 agent 로 전송.
	if (isNewCore()) {
		return { success: false, output: "new-core: standalone tool 미지원(chat 도구루프 사용)" };
	}

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
					appId?: string;
				};
				opts.onPanelControl?.({
					requestId: pc.requestId,
					action: pc.action,
					appId: pc.appId,
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
	appId: string,
	tools: NaiaTool[],
): Promise<void> {
	await safeSendToAgent(
		{
			type: "panel_skills",
			appId,
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
export async function sendPanelSkillsClear(appId: string): Promise<void> {
	await safeSendToAgent(
		{ type: "panel_skills_clear", appId },
		"sendPanelSkillsClear",
	);
}

/** Install a panel from a git URL or local zip file path (delegated to agent) */
export async function sendPanelInstall(source: string): Promise<void> {
	await safeSendToAgent(
		{ type: "app_install", source },
		"sendPanelInstall",
	);
}

/** Send panel tool execution result back to the agent */
export async function sendPanelToolResult(
	requestId: string,
	toolCallId: string,
	result: string,
	success: boolean,
	activityId?: string,
): Promise<void> {
	await safeSendToAgent(
		{
			type: "panel_tool_result",
			requestId,
			toolCallId,
			result,
			success,
			...(activityId ? { activityId } : {}),
		},
		"sendPanelToolResult",
	);
}

/** Send naiaKey to the agent (backend). Call on login and on app init if key exists. */
export async function sendAuthUpdate(naiaKey: string): Promise<void> {
	// new-core graft: old auth_update 채널은 새 agent 미지원(protocol=creds_update만) → naia 계정 키를
	// creds_update(structured, provider=nextain[any-llm gateway]·naiaKey secret) 채널로 routing.
	// 새 agent protocol = {provider, apiKey, naiaKey} 라 naiaKey 가 그대로 키체인/resolver 로 적재됨(Old-Baseline 등가).
	if (isNewCore()) {
		await coreChat().sendCredsUpdate({ provider: "nextain", naiaKey }).catch(() => {});
		return;
	}
	await safeSendToAgent({ type: "auth_update", naiaKey }, "sendAuthUpdate");
}

/** Request the agent to pre-download an offline embedding model. */
export async function sendEmbeddingPrefetch(
	model:
		| "all-MiniLM-L6-v2"
		| "all-mpnet-base-v2"
		| "multilingual-e5-large"
		| "paraphrase-multilingual-MiniLM-L12-v2",
): Promise<void> {
	await safeSendToAgent(
		{ type: "embedding_prefetch", model },
		"sendEmbeddingPrefetch",
	);
}
