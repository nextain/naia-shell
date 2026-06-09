// domain/chat — UC1 수평 (contract §B.1). 순수 규칙. I/O·protocol·wire 0.
// 진실=UC1 시나리오. ChatRequest/ChatChunk/ChatTurn/DomainOutbound = 도메인 값객체.

/**
 * provider *선택* — baseline ProviderConfig(providers/types.ts) 형상 verbatim passthrough.
 * 키 재명명 없음. secret(apiKey/naiaKey)은 도메인 송신 시 strip(creds_update 별채널).
 */
export interface ProviderSelect {
  readonly provider: string;
  readonly model: string;
  readonly ollamaHost?: string;
  readonly vllmHost?: string;
  /** lab-proxy(Naia gateway) override — provider 라우팅용(ProviderConfig 소속). */
  readonly labGatewayUrl?: string;
  readonly enableThinking?: boolean;
  readonly ollamaNumCtx?: number;
}

/** secret 키 — 도메인이 보유하되 송신 채널만 creds_update 로 분리(F0 stripForAgent 정합). */
export const SECRET_PROVIDER_KEYS = ["apiKey", "naiaKey"] as const;

export interface ChatMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
}

/** UC1 대화 요청 (domain). clientId=다중클라이언트 라우팅. gatewayUrl=도구 gateway(provider.labGatewayUrl 과 별개). */
export interface ChatRequest {
  readonly kind: "chat";
  readonly requestId: string;
  readonly clientId: string;
  readonly sessionId?: string;
  readonly provider: ProviderSelect;
  readonly gatewayUrl?: string;
  readonly messages: readonly ChatMessage[];
  readonly systemPrompt?: string;
  readonly enableTools?: boolean;
  readonly disabledSkills?: readonly string[];
}

/**
 * chat-turn chunk 의 domain 표현. 포함기준 권위 = agent writeLine 출력(index.ts) 단일.
 * shell types.ts = 소비측 부분뷰(정보용, 게이트 아님).
 */
export type ChatChunk =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "toolUse"; readonly toolCallId: string; readonly name: string; readonly args: unknown }
  | { readonly kind: "toolResult"; readonly toolCallId: string; readonly output: string }
  | { readonly kind: "approvalRequest"; readonly toolCallId: string; readonly toolName: string; readonly tier: string }
  | { readonly kind: "usage"; readonly raw: unknown }
  | { readonly kind: "logEntry"; readonly level: string; readonly message: string }
  | { readonly kind: "tokenWarning"; readonly raw: unknown }
  | { readonly kind: "finish" }
  | { readonly kind: "error"; readonly message: string };

/** chat-turn chunk 의 소유권(라우팅 키). */
export interface ChunkOwnership {
  readonly requestId: string;
  readonly clientId: string;
}

/** finish/error = terminal(=ownership 해제). */
export function isTerminalChunk(c: ChatChunk): boolean {
  return c.kind === "finish" || c.kind === "error";
}

// ── ChatTurn 상태기계 (순수) ──
// 정상: streaming → finish/error(terminal)
// 취소: streaming →(cancel 요청)→ cancelling → finish/error(terminal)
// cancel 은 비종결 요청. finish/error 만 종결(ownership 해제, B.2 일치).
export type ChatTurnState = "streaming" | "cancelling" | "finished" | "errored";

export type ChatTurnEvent =
  | { readonly type: "chunk"; readonly chunk: ChatChunk }
  | { readonly type: "cancelRequested" };

export function isTerminalState(s: ChatTurnState): boolean {
  return s === "finished" || s === "errored";
}

/** 상태 전이. terminal 도달 후엔 불변(추가 이벤트 무시). */
export function nextTurnState(state: ChatTurnState, event: ChatTurnEvent): ChatTurnState {
  if (isTerminalState(state)) return state;
  if (event.type === "cancelRequested") {
    return state === "streaming" ? "cancelling" : state;
  }
  // chunk: finish/error = terminal (streaming·cancelling 양쪽에서)
  if (event.chunk.kind === "finish") return "finished";
  if (event.chunk.kind === "error") return "errored";
  return state; // 일반 chunk = 상태 유지
}

// ── DomainOutbound — app→agent 송신 domain 의도 폐쇄 union (AgentTransportPort.send 경계) ──
// adapter 가 이를 AgentOutbound(protocol)→wire 로 변환. AgentOutbound 4 variant 와 1:1.
export interface CancelTurn {
  readonly kind: "cancel";
  readonly requestId: string;
  readonly clientId: string;
}
export interface ApprovalResponseIntent {
  readonly kind: "approvalResponse";
  readonly requestId: string;
  readonly clientId: string;
  readonly toolCallId: string;
  readonly decision: "approve" | "reject";
}
export interface CredsUpdate {
  readonly kind: "credsUpdate";
  readonly provider: string;
  readonly secret: { readonly apiKey?: string; readonly naiaKey?: string };
}

export type DomainOutbound = ChatRequest | CancelTurn | ApprovalResponseIntent | CredsUpdate;

// ── wire variant 분류 (단일 SoT — router·관측 스니펫 공유, 드리프트 방지) ──
// 권위 = agent writeLine 출력(index.ts). chat-turn(requestId 보유)=ChatChunk / 비-chat known=타 포트(UC1 보류) / 그 외=Unknown.
export const CHAT_TURN_VARIANTS = [
  "text", "thinking", "tool_use", "tool_result", "approval_request",
  "finish", "error", "usage", "log_entry", "token_warning",
] as const;
export const NONCHAT_KNOWN_VARIANTS = [
  "audio", "object", "panel_control", "panel_install_result",
  "panel_tool_call", "ready", "skill_list_response", "embedding_progress",
  // shell AgentResponseChunk 소비자 집합에서 발견(uc1-variant-probe drift) — 비-chat, 해당 UC 에서 배선:
  "config_update",            // 설정 동기화
  "discord_message",          // UC10 discord
  "gateway_approval_request", // gateway 레벨 승인(chat approval_request 와 별개)
] as const;

export type VariantLane = "chat-turn" | "nonchat-known" | "unknown";

/** wire 메시지 type → 처리 lane. exhaustive: chat-turn / nonchat-known / unknown. */
export function classifyVariant(type: string): VariantLane {
  if ((CHAT_TURN_VARIANTS as readonly string[]).includes(type)) return "chat-turn";
  if ((NONCHAT_KNOWN_VARIANTS as readonly string[]).includes(type)) return "nonchat-known";
  return "unknown";
}

/** DomainOutbound → shell→rust Tauri command (baseline 실측: cancel 만 별 command). */
export function outboundCommandOf(kind: DomainOutbound["kind"]): "send_to_agent_command" | "cancel_stream" {
  return kind === "cancel" ? "cancel_stream" : "send_to_agent_command";
}
