import type { ProviderConfig } from "./providers/types.js";

export interface ChatRequest {
	type: "chat_request";
	requestId: string;
	provider: ProviderConfig;
	messages: { role: "user" | "assistant"; content: string }[];
	systemPrompt?: string;
	ttsVoice?: string;
	ttsApiKey?: string;
	ttsEngine?: "auto" | "gateway" | "google";
	ttsProvider?: "google" | "edge" | "openai" | "elevenlabs" | "nextain";
	enableTools?: boolean;
	gatewayUrl?: string;
	gatewayToken?: string;
	disabledSkills?: string[];
	routeViaGateway?: boolean;
	slackWebhookUrl?: string;
	discordWebhookUrl?: string;
	googleChatWebhookUrl?: string;
	discordDefaultUserId?: string;
	discordDefaultTarget?: string;
	discordDmChannelId?: string;
}

export interface CancelRequest {
	type: "cancel_stream";
	requestId: string;
}

export interface ApprovalResponse {
	type: "approval_response";
	requestId: string;
	toolCallId: string;
	decision: "once" | "always" | "reject";
	message?: string;
}

/** Direct tool execution request (bypasses LLM, no token cost) */
export interface ToolRequest {
	type: "tool_request";
	requestId: string;
	toolName: string;
	args: Record<string, unknown>;
	gatewayUrl?: string;
	gatewayToken?: string;
	disabledSkills?: string[];
	slackWebhookUrl?: string;
	discordWebhookUrl?: string;
	googleChatWebhookUrl?: string;
	discordDefaultUserId?: string;
	discordDefaultTarget?: string;
	discordDmChannelId?: string;
}

/** Standalone TTS synthesis request (used by pipeline voice mode) */
export interface TtsRequest {
	type: "tts_request";
	requestId: string;
	text: string;
	voice?: string;
	ttsProvider?: "edge" | "google" | "openai" | "elevenlabs" | "nextain";
	ttsApiKey?: string;
}

// ─── Panel Skill Protocol ────────────────────────────────────────────────────

/**
 * Serializable panel tool descriptor.
 * Sent from Shell to Agent when a panel activates.
 * Agent registers these as proxy stubs — execute is NOT included (Shell-side only).
 */
export interface PanelToolDescriptor {
	/** skill_ prefix required, e.g. "skill_browse_navigate" */
	name: string;
	description: string;
	parameters: Record<string, unknown>; // JSON Schema
	tier?: number;
}

/**
 * Shell → Agent: panel activated, register these tools as LLM-callable proxy stubs.
 */
export interface PanelSkillsRequest {
	type: "panel_skills";
	panelId: string;
	tools: PanelToolDescriptor[];
}

/**
 * Shell → Agent: panel deactivated, remove its proxy stubs from LLM tool list.
 */
export interface PanelSkillsClearRequest {
	type: "panel_skills_clear";
	panelId: string;
}

/**
 * Shell → Agent: install a panel from a git URL or local zip file path.
 * Agent runs git-clone/unzip, validates panel.json, then emits panel_control reload.
 */
export interface PanelInstallRequest {
	type: "panel_install";
	/** git URL (https:// | git@) or absolute path to a .zip file */
	source: string;
}

/**
 * Shell → Agent: result of a panel tool execution (response to panel_tool_call).
 */
export interface PanelToolResult {
	type: "panel_tool_result";
	requestId: string;
	toolCallId: string;
	result: string;
	success: boolean;
}

// ─── Skill List Protocol ────────────────────────────────────────────────────

/**
 * Shell → Agent: request the list of registered skill tool definitions.
 * Used by Omni voice mode to pass built-in skills to the voice session.
 */
export interface SkillListRequest {
	type: "skill_list";
	requestId: string;
}

// ─── Memory Backup Protocol ─────────────────────────────────────────────────

/**
 * Shell → Agent: export encrypted memory backup.
 * Agent calls LocalAdapter.export(password) and responds with memory_export_result.
 */
export interface MemoryExportRequest {
	type: "memory_export";
	requestId: string;
	password: string;
}

/**
 * Shell → Agent: import encrypted memory backup.
 * Agent calls LocalAdapter.import(blob, password) and responds with memory_import_result.
 */
export interface MemoryImportRequest {
	type: "memory_import";
	requestId: string;
	/** Encrypted backup bytes as a number array (JSON-serializable) */
	data: number[];
	password: string;
}

export interface AuthUpdateRequest {
	type: "auth_update";
	naiaKey: string;
}

/**
 * Shell → Agent: webhook URLs + Discord defaults set ONCE at startup
 * and on settings save (#260). Replaces per-chat_request / per-tool_request
 * credential transmission, which leaked webhook URLs into every stdio frame
 * + any log capture. Agent caches into process.env via applyNotifyWebhookEnv.
 *
 * All fields optional — sending the empty object clears env.
 */
export interface NotifyConfigRequest {
	type: "notify_config";
	slackWebhookUrl?: string;
	discordWebhookUrl?: string;
	googleChatWebhookUrl?: string;
	discordDefaultUserId?: string;
	discordDefaultTarget?: string;
	discordDmChannelId?: string;
}

/**
 * Shell → Agent: LLM provider API keys cached per provider (#260 follow-up).
 *
 * Same one-shot pattern as `auth_update` (naiaKey) and `notify_config`
 * (webhooks). Sent at startup and on settings save. Agent caches into
 * factory.ts's `_providerApiKeys` Map. buildProvider reads from the cache
 * first, falls back to legacy per-request `config.apiKey` (backwards
 * compat), then to envVar.
 *
 * Sending an empty string for a provider's key clears the cached entry
 * (explicit unset — e.g. user removed the key from settings).
 *
 * keys[providerId] = apiKey. Sparse: only providers the user has actually
 * configured need to be present. providerId values match LlmProviderMeta.id
 * in shell/src/lib/llm/registry.ts (e.g. "anthropic", "openai", "gemini").
 */
export interface CredsUpdateRequest {
	type: "creds_update";
	keys: Record<string, string>;
}

export type AgentRequest =
	| ChatRequest
	| CancelRequest
	| ApprovalResponse
	| ToolRequest
	| TtsRequest
	| PanelSkillsRequest
	| PanelSkillsClearRequest
	| PanelInstallRequest
	| PanelToolResult
	| SkillListRequest
	| MemoryExportRequest
	| MemoryImportRequest
	| AuthUpdateRequest
	| NotifyConfigRequest
	| CredsUpdateRequest;

export function parseRequest(line: string): AgentRequest | null {
	try {
		const obj = JSON.parse(line);
		if (!obj || typeof obj.type !== "string") return null;
		if (
			obj.type === "chat_request" ||
			obj.type === "cancel_stream" ||
			obj.type === "approval_response" ||
			obj.type === "tool_request" ||
			obj.type === "tts_request" ||
			obj.type === "panel_skills" ||
			obj.type === "panel_skills_clear" ||
			obj.type === "panel_tool_result" ||
			obj.type === "panel_install" ||
			obj.type === "skill_list" ||
			obj.type === "memory_export" ||
			obj.type === "memory_import" ||
			obj.type === "auth_update" ||
			obj.type === "notify_config" ||
			obj.type === "creds_update"
		) {
			return obj as AgentRequest;
		}
		return null;
	} catch {
		return null;
	}
}
