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

/** 검증된 로컬 자원 핸들만 운반한다. raw 경로·URL·base64·provider file id는 금지. */
export interface AttachmentRef {
  readonly id: string;
  readonly kind: "image";
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly sizeBytes: number;
  readonly localRef: string;
  readonly name?: string;
}

export interface ChatMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly attachments?: readonly AttachmentRef[];
}

export type ChannelContext =
  | { readonly kind: "shell" }
  | {
      readonly kind: "discord";
      readonly bindingId: string;
      readonly guildId: string;
      readonly channelId: string;
      readonly userId: string;
    };

export interface GroundingRequest {
  readonly policy: "off" | "available" | "required";
  readonly knowledgeScope: string;
}

export type ProviderSessionRequest =
  | { readonly mode: "new" }
  | { readonly mode: "resume"; readonly providerSessionRef: string };

export interface ProcessingRequest {
  readonly processingProfileRef: string;
}

/**
 * S4 — 환경고유 컨텍스트 세그먼트(naia-os 클라가 코어에 전달). 코어(naia-agent)가 persona+workspace 뒤에 머지.
 * raw systemPrompt 를 굽는 두벌을 제거: persona/locale/honorific/speechStyle/userName 은 코어가 config.json 에서
 * 스스로 조립하므로 셸이 안 보낸다. 셸 고유 = 아바타 감정 태그(avatarEmotion) + 패널 컨텍스트(panel) +
 * 응답 스타일 힌트(responseStyle, 음성 파이프라인=brief)뿐.
 * 폐쇄 union — 코어가 화이트리스트(avatarEmotion|panel|responseStyle) 외 드롭. 자유 system-prompt 텍스트 금지(권한 모델 C2).
 * ⚠️ responseStyle: 음성 STT→채팅 경로가 raw systemPrompt(brevity)로 persona 를 덮던 회귀를 닫는다 — 간결성만
 *    구조화로 보내고 persona 조립은 코어가 보존(어디서든 알파). 문구는 코어 소유(클라는 style enum 만).
 */
export type EnvironmentSegment =
  | { readonly kind: "avatarEmotion" }
  | { readonly kind: "app"; readonly entries: readonly { readonly type: string; readonly data: unknown }[] }
  | { readonly kind: "responseStyle"; readonly style: "brief" | "normal" };

/** UC1 대화 요청 (domain). clientId=다중클라이언트 라우팅. gatewayUrl=도구 gateway(provider.labGatewayUrl 과 별개). */
export interface ChatRequest {
  readonly kind: "chat";
  readonly requestId: string;
  readonly clientId: string;
  readonly sessionId?: string;
  readonly provider: ProviderSelect;
  readonly gatewayUrl?: string;
  readonly messages: readonly ChatMessage[];
  /** S4 종착: 명시 override 만(--system 등). 일반 채팅은 안 보냄 — 코어가 persona+workspace+environmentSegments 조립. */
  readonly systemPrompt?: string;
  /** S4 — 셸 환경고유 컨텍스트(아바타 감정·패널). 코어가 머지. systemPrompt 미전송 시 이게 환경 정보 운반 경로. */
  readonly environmentSegments?: readonly EnvironmentSegment[];
  readonly enableTools?: boolean;
  /** ⚠️ **top-level**(agent 가 req.enableThinking 를 읽어 providerConfig 에 주입 — provider 안에만 두면 무효화). */
  readonly enableThinking?: boolean;
  readonly disabledSkills?: readonly string[];
  readonly channel?: ChannelContext;
  readonly grounding?: GroundingRequest;
  readonly providerSession?: ProviderSessionRequest;
  readonly processing?: ProcessingRequest;
  readonly activityResume?: {
    readonly activityId: string;
    readonly profileGeneration: number;
    readonly yieldGeneration: number;
    readonly resumeToken: string;
  };
}

/**
 * chat-turn chunk 의 domain 표현. 포함기준 권위 = agent writeLine 출력(index.ts) 단일.
 * shell types.ts = 소비측 부분뷰(정보용, 게이트 아님).
 */
export type ChatChunk =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "toolUse"; readonly toolCallId: string; readonly name: string; readonly args: unknown }
  | { readonly kind: "toolResult"; readonly toolCallId: string; readonly toolName: string; readonly output: string; readonly success: boolean }
  | { readonly kind: "approvalRequest"; readonly toolCallId: string; readonly toolName: string; readonly tier: string; readonly args: unknown; readonly description: string }
  | { readonly kind: "gatewayApprovalRequest"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly kind: "usage"; readonly raw: unknown }
  | { readonly kind: "logEntry"; readonly level: string; readonly message: string }
  | { readonly kind: "tokenWarning"; readonly raw: unknown }
  | { readonly kind: "compacted"; readonly droppedCount: number } // UC-compaction: agent 가 예산 압박 시 head 요약 발생 알림(UI 표시용)
  | { readonly kind: "panelToolCall"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown } // UC-PANEL FR-PANEL-2: 환경 도구 위임(requestId 보유, 비-terminal chat-turn 이벤트 — ChatPanel 이 실행 후 panel_tool_result 회신)
  | {
      readonly kind: "grounding";
      readonly status: "grounded" | "no_evidence" | "uncompiled" | "unavailable";
      readonly sources: readonly { readonly title: string; readonly sourceUris: readonly string[] }[];
    }
  | { readonly kind: "artifact"; readonly artifact: AttachmentRef }
  | {
      readonly kind: "providerSession";
      readonly sessionId: string;
      readonly providerSessionRef: string;
      readonly state: "started" | "resumed" | "closed";
    }
  | {
      readonly kind: "processingDisclosure";
      readonly workload: "main_llm" | "sub_llm" | "memory_llm" | "embedding" | "network_tool";
      readonly destination: "local_device" | "private_managed" | "external_cloud";
      readonly decision: "allowed" | "blocked" | "confirmation_required";
      readonly processingProfileRef: string;
      readonly provider?: string;
      readonly model?: string;
    }
  | { readonly kind: "finish" }
  | { readonly kind: "error"; readonly message: string; readonly code?: WireErrorCode };

export type WireErrorCode =
  | "PROVIDER_NOT_INSTALLED"
  | "PROVIDER_LOGIN_REQUIRED"
  | "PROVIDER_AUTH_EXPIRED"
  | "PROVIDER_NETWORK"
  | "DISCORD_TOKEN_MISSING"
  | "DISCORD_INTENTS_MISSING"
  | "DISCORD_NOT_INSTALLED"
  | "DISCORD_PERMISSION_DENIED"
  | "DISCORD_RATE_LIMITED"
  | "ATTACHMENT_UNSUPPORTED_TYPE"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_INVALID_REF"
  | "KNOWLEDGE_UNCOMPILED"
  | "KNOWLEDGE_UNAVAILABLE"
  | "WIRE_INVALID_ARGUMENT"
  | "WIRE_UNSUPPORTED_ENUM"
  | "WIRE_SCOPE_FORBIDDEN"
  | "PROVIDER_SESSION_MISMATCH"
  | "PROVIDER_SESSION_EXPIRED"
  | "PROVIDER_SESSION_CLOSED"
  | "PROCESSING_PROFILE_REQUIRED"
  | "PROCESSING_DESTINATION_UNKNOWN"
  | "EXTERNAL_PROCESSING_FORBIDDEN"
  | "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED";

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
  // turn-bound 승인(requestId 보유, turn 이 응답 대기 — approval_request 와 동급, ChatPanel chunk 처리). codex S1.
  "gateway_approval_request",
  // UC-compaction(FR-COMPACT): 예산 압박 요약 발생 알림(requestId 보유, 비-terminal chat-turn 이벤트 — ChatPanel 배너).
  "compacted",
  // UC-PANEL FR-PANEL-2: 환경 도구 위임(requestId 보유, 비-terminal — chat onChunk 로 흘러 ChatPanel 이 실행→panel_tool_result 회신).
  "panel_tool_call",
  // UC-WIRE-V1: turn-bound evidence, generated artifact, provider-session handle.
  "grounding", "artifact", "provider_session",
  "processing_disclosure",
] as const;
export const NONCHAT_KNOWN_VARIANTS = [
  "audio", "object", "panel_control", "app_install_result",
  "ready", "skill_list_response", "embedding_progress",
  // shell agent_response 소비자 surface 전체에서 발견(uc1-variant-probe drift) — 비-chat, 해당 UC 에서 배선:
  "config_update",            // 설정 동기화
  "discord_message",          // UC10 discord
  // BgmPlayer 소비(미디어/BGM UC) — 새 아키텍처선 router 단일구독이라 이들도 통과(PendingRouteSink):
  "bgm_youtube_fav_add", "bgm_youtube_fav_remove", "bgm_youtube_next",
  "bgm_youtube_pause", "bgm_youtube_play", "bgm_youtube_prev",
  "bgm_youtube_resume", "bgm_youtube_stop", "bgm_youtube_volume",
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
