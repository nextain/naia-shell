// === Model Capabilities ===

/**
 * Model capability tags — extensible set describing what a model can do.
 * A model declares all applicable capabilities; UI and runtime logic branch on these.
 *
 * Current values:
 *   "llm"   — text generation (chat, reasoning)
 *   "omni"  — built-in voice I/O (disables separate STT/TTS)
 *   "asr"   — audio → text only (no generation, no TTS)
 *   "stt"   — speech-to-text component (may coexist with other caps)
 *   "tts"   — text-to-speech component
 *   "vlm"   — vision-language (image understanding)
 *   "image" — image generation
 *   "video" — video generation
 *   "avatar"— talking-avatar rendering
 *   "world" — world model (future)
 *
 * Keep in sync with the gateway catalog vocabulary
 * (project-any-llm any_llm/gateway/model_catalog.py CAPABILITIES).
 */
export type ModelCapability =
	| "llm"
	| "omni"
	| "asr"
	| "stt"
	| "tts"
	| "embedding"
	| "vlm"
	| "image"
	| "video"
	| "avatar"
	| "world";

/** Runtime list of all capability tags (for validation / iteration). */
export const MODEL_CAPABILITY_VALUES: readonly ModelCapability[] = [
	"llm",
	"omni",
	"asr",
	"stt",
	"tts",
	"embedding",
	"vlm",
	"image",
	"video",
	"avatar",
	"world",
];

// === Provider ===

/** Provider ID — extensible via LLM registry. */
export type ProviderId = string;

export interface ProviderConfig {
	provider: ProviderId;
	model: string;
	apiKey: string;
	naiaKey?: string;
	ollamaHost?: string;
	ollamaNumGpu?: number;
	vllmHost?: string;
	openaiBaseUrl?: string;
	/** Override URL for lab-proxy (Naia gateway). Used to route to dev vs prod gateway. */
	labGatewayUrl?: string;
	/** Enable thinking/reasoning output from models that support it. */
	enableThinking?: boolean;
}

// === Chat Messages ===

export interface CostEntry {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	provider: ProviderId;
	model: string;
}

export interface ToolCall {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	status: "running" | "success" | "error";
	output?: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	thinking?: string;
	timestamp: number;
	cost?: CostEntry;
	toolCalls?: ToolCall[];
	/**
	 * #572 — 이 턴은 답을 만들지 못했다. 원시 오류 문자열(`provider error:
	 * invalid tool_call index`)을 답변 자리에 흘리는 대신, 이 표시를 단 메시지는
	 * 사용자 말로 된 안내와 재시도 버튼으로 그려진다. `detail` 은 접힌 영역에
	 * 두는 원문이고, `retryText` 는 같은 입력을 다시 보내기 위한 사용자 발화다.
	 */
	failure?: { detail: string; retryText: string };
}

// === Agent Protocol (stdin/stdout JSON lines) ===

/**
 * S4 — 환경고유 컨텍스트 세그먼트(셸 → 코어). 코어(naia-agent)가 persona+workspace 뒤에 머지.
 * 두벌 제거: persona/locale/honorific/speechStyle/userName 은 코어가 config.json 에서 스스로 조립하므로 셸이 안 보낸다.
 * 셸 고유 = 아바타 감정 태그(avatarEmotion, 아바타 전용) + 앱 컨텍스트(app, 런타임 UI) +
 * 응답 스타일 힌트(responseStyle, 음성 파이프라인=brief)뿐. 폐쇄 union(코어가 화이트리스트).
 * ⚠️ 음성(Live)·discord 경로는 코어를 안 거치므로 buildSystemPrompt 를 그대로 쓴다 — 이 세그먼트는 gRPC 채팅 경로 전용.
 * ⚠️ responseStyle: 음성 STT→채팅 파이프라인(코어 경유)이 raw systemPrompt(brevity)로 persona 를 덮던 회귀를 닫는다.
 *    간결성만 구조화로 보내고 persona 조립은 코어가 보존(어디서든 알파). brief=짧은 구어, normal=무영향(문구는 코어 소유).
 */
export type EnvironmentSegment =
	| { kind: "avatarEmotion" }
	| { kind: "app"; entries: { type: string; data: unknown }[] }
	| { kind: "responseStyle"; style: "brief" | "normal" }
	/**
	 * #502 — 사용자의 작업 표면 관측. 손잡이는 불투명하고 pane 어휘는 올라가지 않는다.
	 * ⚠️ 이 union 은 코어 `src/main/domain/chat.ts` 의 세 번째 사본이다.
	 *    갈라지면 `src/test/wire-union-drift.contract.test.ts` 가 깨진다 (FR-ENV-LIVE.6).
	 */
	| {
			kind: "environmentSurfaces";
			// readonly — 코어가 내는 값을 그대로 실어 보낸다(복사하지 않는다).
			surfaces: readonly {
				readonly ref: string;
				readonly label: string;
				readonly activity: string;
				readonly focused: boolean;
			}[];
			omitted: number;
			/** 목록을 일부러 싣지 않았는가 (FR-ENV-ATTENTION.8). 없으면 false. */
			listWithheld?: boolean;
	  };

export interface AgentRequest {
	type: "chat_request";
	requestId: string;
	provider: ProviderConfig;
	messages: { role: "user" | "assistant"; content: string }[];
	systemPrompt?: string;
	environmentSegments?: EnvironmentSegment[];
	ttsVoice?: string;
	ttsApiKey?: string;
	ttsEngine?: "auto" | "gateway" | "google";
	enableTools?: boolean;
	gatewayUrl?: string;
	gatewayToken?: string;
	disabledSkills?: string[];
	routeViaGateway?: boolean;
	discordDefaultUserId?: string;
	discordDefaultTarget?: string;
	discordDmChannelId?: string;
}

export type AgentResponseChunk =
	| { type: "text"; requestId: string; text: string }
	| { type: "thinking"; requestId: string; text: string }
	| { type: "audio"; requestId: string; data: string; costUsd?: number }
	| {
			type: "tool_use";
			requestId: string;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			activityId?: string;
	  }
	| {
			type: "tool_result";
			requestId: string;
			toolCallId: string;
			toolName: string;
			output: string;
			success: boolean;
	  }
	| {
			type: "usage";
			requestId: string;
			inputTokens: number;
			outputTokens: number;
			cost: number;
			model: string;
	  }
	| {
			type: "approval_request";
			requestId: string;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			tier: number;
			description: string;
	  }
	| {
			type: "config_update";
			requestId: string;
			action: "enable_skill" | "disable_skill";
			skillName: string;
	  }
	| {
			type: "gateway_approval_request";
			requestId: string;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			activityId?: string;
	  }
	| {
			type: "log_entry";
			requestId: string;
			level: string;
			message: string;
			timestamp: string;
	  }
	| {
			type: "compacted";
			requestId: string;
			droppedCount: number;
	  }
	| {
			type: "discord_message";
			requestId: string;
			from: string;
			content: string;
			timestamp?: string;
	  }
	| {
			/** Agent → Shell: LLM called a app tool. Shell must execute and reply with app_tool_result. */
			type: "app_tool_call";
			requestId: string;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			activityId?: string;
	  }
	| {
			/** Agent → Shell: app management action (switch, reload). */
			type: "app_control";
			requestId: string;
			action: "switch" | "reload";
			appId?: string;
	  }
	| {
			/** Agent → Shell: result of a app_install request. */
			type: "app_install_result";
			success: boolean;
			output: string;
			error?: string;
	  }
	| {
			/** Agent → Shell: response to skill_list request with all registered skill tool definitions. */
			type: "skill_list_response";
			requestId: string;
			tools: {
				name: string;
				description: string;
				parameters: Record<string, unknown>;
			}[];
	  }
	| { type: "finish"; requestId: string }
	| {
			type: "grounding";
			requestId: string;
			status: "grounded" | "no_evidence" | "uncompiled" | "unavailable";
			sources: { title: string; sourceUris: string[] }[];
	  }
	| {
			type: "artifact";
			requestId: string;
			artifact: {
				id: string;
				kind: "image";
				mimeType: string;
				sizeBytes: number;
				localRef: string;
				name?: string;
			};
	  }
	| {
			type: "provider_session";
			requestId: string;
			sessionId: string;
			providerSessionRef: string;
			state: "started" | "resumed" | "closed";
	  }
	| {
			type: "processing_disclosure";
			requestId: string;
			workload:
				| "main_llm"
				| "sub_llm"
				| "memory_llm"
				| "embedding"
				| "network_tool";
			destination: "local_device" | "private_managed" | "external_cloud";
			decision: "allowed" | "blocked" | "confirmation_required";
			processingProfileRef: string;
			provider?: string;
			model?: string;
	  }
	| {
			type: "error";
			requestId: string;
			message: string;
			code?: import("./wire-errors").WireErrorCode;
	  };

// === Skill Manifest (from ~/.naia/skills/{name}/skill.json) ===

export interface SkillManifestInfo {
	name: string;
	description: string;
	type: "gateway" | "command" | "built-in" | "agent";
	/** Tier/source are available for legacy manifest rows only. Agent ToolSpecs do not carry them. */
	tier?: number;
	source?: string;
	gatewaySkill?: string;
}

// === Audit (matches Rust structs in audit.rs) ===

export interface AuditEvent {
	id: number;
	timestamp: string;
	request_id: string;
	event_type: string;
	tool_name: string | null;
	tool_call_id: string | null;
	tier: number | null;
	success: boolean | null;
	payload: string | null;
}

export interface AuditFilter {
	request_id?: string;
	event_type?: string;
	tool_name?: string;
	from?: string;
	to?: string;
	limit?: number;
	offset?: number;
}

// === Channels ===

export interface ChannelAccountInfo {
	accountId: string;
	name?: string;
	connected: boolean;
	enabled: boolean;
	lastError?: string;
}

export interface ChannelInfo {
	id: string;
	label: string;
	accounts: ChannelAccountInfo[];
}

export interface AuditStats {
	total_events: number;
	by_event_type: [string, number][];
	by_tool_name: [string, number][];
	total_cost: number;
}

// === Device Pairing ===

export interface DeviceInfo {
	deviceId: string;
	name: string;
	platform?: string;
	lastSeen?: string;
}

export interface PairRequest {
	requestId: string;
	nodeId: string;
	status: "pending" | "approved" | "rejected";
	createdAt?: string;
}

// === Gateway Status ===

export interface GatewayStatus {
	ok?: boolean;
	status?: string;
	version?: string;
	uptime?: number;
	methods?: string[];
}

// === Log Entry ===

export interface LogEntry {
	level: string;
	message: string;
	timestamp: string;
}
