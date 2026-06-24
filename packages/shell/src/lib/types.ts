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
	vllmHost?: string;
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
}

// === Agent Protocol (stdin/stdout JSON lines) ===

export interface AgentRequest {
	type: "chat_request";
	requestId: string;
	provider: ProviderConfig;
	messages: { role: "user" | "assistant"; content: string }[];
	systemPrompt?: string;
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
			/** Agent → Shell: LLM called a panel tool. Shell must execute and reply with panel_tool_result. */
			type: "panel_tool_call";
			requestId: string;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| {
			/** Agent → Shell: panel management action (switch, reload). */
			type: "panel_control";
			requestId: string;
			action: "switch" | "reload";
			panelId?: string;
	  }
	| {
			/** Agent → Shell: result of a panel_install request. */
			type: "panel_install_result";
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
	| { type: "error"; requestId: string; message: string };

// === Skill Manifest (from ~/.naia/skills/{name}/skill.json) ===

export interface SkillManifestInfo {
	name: string;
	description: string;
	type: "gateway" | "command" | "built-in";
	tier: number;
	source: string;
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
