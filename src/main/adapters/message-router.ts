// adapters — MessageRouter (contract §B.4). AgentTransportPort.onMessage 단일 구독.
// AgentMessage(protocol) demux → chat-turn(requestId)→domain ChatChunk→ChatPort.deliverChunk /
//   비-chat known→PendingRouteSink(UC1 미배선) / Unknown·소유권없음→DiagnosticSink. 미지=error+log(silent drop 금지).
// transport(wire)와 분리된 별 컴포넌트(중복전달·구독주체 모호 제거). app 은 demux/protocol 안 봄.
import type { AttachmentRef, ChatChunk, WireErrorCode } from "../domain/chat.js";
import { classifyVariant } from "../domain/chat.js";
import type {
  AgentMessage, AgentTransportPort, ChatPort, ClientSessionPort,
  PendingRouteSink, DiagnosticSink, Unsub,
} from "../ports/uc1.js";

export interface RouterDeps {
  readonly transport: AgentTransportPort;
  readonly chat: ChatPort;
  readonly sessions: ClientSessionPort;
  readonly pending: PendingRouteSink;
  readonly diagnostic: DiagnosticSink;
}

export class MessageRouter {
  private unsub: Unsub | null = null;
  constructor(private readonly deps: RouterDeps) {}

  /** 단일 구독 시작. */
  start(): void {
    if (this.unsub) return; // 중복 구독 방지
    this.unsub = this.deps.transport.onMessage((m) => this.route(m));
  }
  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** 18 variant + Unknown 전부 분기 도착 = exhaustive 보장(분류 SoT=domain classifyVariant). */
  route(m: AgentMessage): void {
    const type = m.type;
    const lane = classifyVariant(type);
    if (lane === "chat-turn") {
      const r = m as Record<string, unknown>;
      const requestId = typeof r["requestId"] === "string" ? (r["requestId"] as string) : undefined;
      if (!requestId) {
        this.deps.diagnostic.diagnose(m, "chat-turn variant without requestId");
        return;
      }
      const clientId = this.deps.sessions.ownerOf(requestId);
      if (!clientId) {
        // 소유주 없음(종료/미지 turn) — deliverChunk 소유권 필수와 충돌 → DiagnosticSink.
        // ⚠️ requestId 재사용 가드: baseline 은 turn 마다 *unique* requestId 생성(불변식). 해제된 옛 id 의
        //   지연 chunk 는 owner 없음→여기로 진단. 재사용이 없으므로 새 turn 으로 오라우팅되지 않음(MED⑥ 바운드).
        this.deps.diagnostic.diagnose(m, `no owner for requestId=${requestId}`);
        return;
      }
      const chunk = toChatChunk(type, m);
      if (!chunk) {
        // 필수 필드 누락/타입 불일치 = 프로토콜 손상 → 정상 chunk 위장 금지(MED⑤), 진단으로.
        this.deps.diagnostic.diagnose(m, `malformed chat-turn payload: ${type}`);
        return;
      }
      this.deps.chat.deliverChunk(chunk, { requestId, clientId });
      return;
    }
    if (lane === "nonchat-known") {
      this.deps.pending.pending(m); // UC1 미배선 — 해당 UC 에서 실제 포트 배선
      return;
    }
    // unknown (18 외) — silent drop 금지
    this.deps.diagnostic.diagnose(m, `unknown variant: ${type}`);
  }
}

/**
 * protocol chat-turn message → domain ChatChunk (권위=agent index.ts 출력 형상).
 * ⚠️ 필수 string 필드가 없거나 타입 불일치 = null 반환(=프로토콜 손상). 강제변환으로 정상 chunk 위장 금지(MED⑤).
 * 선택/임의(usage·tokenWarning raw, args)만 관대.
 */
function toChatChunk(type: string, m: AgentMessage): ChatChunk | null {
  const r = m as Record<string, unknown>;
  switch (type) {
    case "text": { const text = reqStr(r["text"]); return text === null ? null : { kind: "text", text }; }
    case "thinking": { const text = reqStr(r["text"]); return text === null ? null : { kind: "thinking", text }; }
    case "tool_use": {
      const toolCallId = reqStr(r["toolCallId"]); const name = reqStr(r["toolName"] ?? r["name"]);
      return toolCallId === null || name === null ? null : { kind: "toolUse", toolCallId, name, args: r["args"] };
    }
    case "tool_result": {
      const toolCallId = reqStr(r["toolCallId"]); const output = reqStr(r["output"]);
      // UC1 리뷰 fix: toolName/success 보존(live ChatPanel 이 chunk.success 읽음 — 유실 시 undefined).
      return toolCallId === null || output === null ? null
        : { kind: "toolResult", toolCallId, toolName: reqStr(r["toolName"]) ?? "", output, success: r["success"] === true };
    }
    case "approval_request": {
      const toolCallId = reqStr(r["toolCallId"]); const toolName = reqStr(r["toolName"]); const tier = reqStr(r["tier"]);
      // UC1 리뷰 fix(보안): args/description 보존(승인 다이얼로그가 인자 보여야 — blind approval 방지).
      return toolCallId === null || toolName === null || tier === null
        ? null : { kind: "approvalRequest", toolCallId, toolName, tier, args: r["args"], description: reqStr(r["description"]) ?? "" };
    }
    case "gateway_approval_request": {
      const toolCallId = reqStr(r["toolCallId"]); const toolName = reqStr(r["toolName"]);
      return toolCallId === null || toolName === null
        ? null : { kind: "gatewayApprovalRequest", toolCallId, toolName, args: r["args"] };
    }
    case "usage": return { kind: "usage", raw: m };
    case "log_entry": {
      const level = reqStr(r["level"]); const message = reqStr(r["message"]);
      return level === null || message === null ? null : { kind: "logEntry", level, message };
    }
    case "token_warning": return { kind: "tokenWarning", raw: m };
    case "compacted": { const dc = r["droppedCount"]; return { kind: "compacted", droppedCount: typeof dc === "number" ? dc : 0 }; }
    case "panel_tool_call": { // UC-PANEL FR-PANEL-2: 환경 도구 위임 → chat onChunk → ChatPanel 실행
      const toolCallId = reqStr(r["toolCallId"]); const toolName = reqStr(r["toolName"]);
      return toolCallId === null || toolName === null ? null : { kind: "panelToolCall", toolCallId, toolName, args: r["args"] };
    }
    case "grounding": {
      const status = r["status"];
      const rawSources = r["sources"];
      if (!GROUNDING_STATUSES.has(status as ChatChunkGroundingStatus) || !Array.isArray(rawSources)) return null;
      const sources = rawSources.map((source) => {
        if (!isRecord(source) || reqStr(source["title"]) === null || !Array.isArray(source["sourceUris"])) return null;
        const sourceUris = source["sourceUris"].filter((uri): uri is string => typeof uri === "string");
        if (sourceUris.length !== source["sourceUris"].length) return null;
        return { title: source["title"] as string, sourceUris };
      });
      return sources.some((source) => source === null)
        ? null
        : { kind: "grounding", status: status as ChatChunkGroundingStatus, sources: sources as { title: string; sourceUris: string[] }[] };
    }
    case "artifact": {
      const artifact = r["artifact"];
      if (!isRecord(artifact)) return null;
      const id = reqStr(artifact["id"]);
      const mimeType = reqStr(artifact["mimeType"]);
      const localRef = reqStr(artifact["localRef"]);
      const sizeBytes = artifact["sizeBytes"];
      if (id === null || artifact["kind"] !== "image"
        || !(IMAGE_MIME_TYPES as ReadonlySet<string>).has(mimeType ?? "") || localRef === null
        || typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes)) return null;
      const value: AttachmentRef = {
        id, kind: "image", mimeType: mimeType as AttachmentRef["mimeType"], sizeBytes, localRef,
        ...(typeof artifact["name"] === "string" ? { name: artifact["name"] } : {}),
      };
      return { kind: "artifact", artifact: value };
    }
    case "provider_session": {
      const sessionId = reqStr(r["sessionId"]); const providerSessionRef = reqStr(r["providerSessionRef"]);
      const state = r["state"];
      return sessionId === null || providerSessionRef === null || !PROVIDER_SESSION_STATES.has(state as ProviderSessionState)
        ? null : { kind: "providerSession", sessionId, providerSessionRef, state: state as ProviderSessionState };
    }
    case "processing_disclosure": {
      const workload = r["workload"]; const destination = r["destination"]; const decision = r["decision"];
      const processingProfileRef = reqStr(r["processingProfileRef"]);
      if (!PROCESSING_WORKLOADS.has(workload as ProcessingWorkload)
        || !PROCESSING_DESTINATIONS.has(destination as ProcessingDestination)
        || !PROCESSING_DECISIONS.has(decision as ProcessingDecision)
        || processingProfileRef === null) return null;
      return {
        kind: "processingDisclosure",
        workload: workload as ProcessingWorkload,
        destination: destination as ProcessingDestination,
        decision: decision as ProcessingDecision,
        processingProfileRef,
        ...(typeof r["provider"] === "string" ? { provider: r["provider"] } : {}),
        ...(typeof r["model"] === "string" ? { model: r["model"] } : {}),
      };
    }
    case "finish": return { kind: "finish" };
    case "error": {
      const message = reqStr(r["message"]);
      const code = r["code"];
      if (message === null || (code !== undefined && !WIRE_ERROR_CODES.has(code as WireErrorCode))) return null;
      return { kind: "error", message, ...(code !== undefined ? { code: code as WireErrorCode } : {}) };
    }
    default: return null; // CHAT_TURN_TYPES 에 있으나 매핑 없음 = 손상
  }
}

/** 필수 string — 문자열 아니면 null(손상 신호). */
function reqStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const WIRE_ERROR_CODES = new Set<WireErrorCode>([
  "PROVIDER_NOT_INSTALLED", "PROVIDER_LOGIN_REQUIRED", "PROVIDER_AUTH_EXPIRED", "PROVIDER_NETWORK",
  "DISCORD_TOKEN_MISSING", "DISCORD_INTENTS_MISSING", "DISCORD_NOT_INSTALLED",
  "DISCORD_PERMISSION_DENIED", "DISCORD_RATE_LIMITED",
  "ATTACHMENT_UNSUPPORTED_TYPE", "ATTACHMENT_TOO_LARGE", "ATTACHMENT_INVALID_REF",
  "KNOWLEDGE_UNCOMPILED", "KNOWLEDGE_UNAVAILABLE", "WIRE_INVALID_ARGUMENT",
  "WIRE_UNSUPPORTED_ENUM", "WIRE_SCOPE_FORBIDDEN", "PROVIDER_SESSION_MISMATCH",
  "PROVIDER_SESSION_EXPIRED", "PROVIDER_SESSION_CLOSED",
  "PROCESSING_PROFILE_REQUIRED", "PROCESSING_DESTINATION_UNKNOWN",
  "EXTERNAL_PROCESSING_FORBIDDEN", "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED",
]);
type ChatChunkGroundingStatus = Extract<ChatChunk, { kind: "grounding" }>["status"];
type ProviderSessionState = Extract<ChatChunk, { kind: "providerSession" }>["state"];
const GROUNDING_STATUSES = new Set<ChatChunkGroundingStatus>(["grounded", "no_evidence", "uncompiled", "unavailable"]);
const PROVIDER_SESSION_STATES = new Set<ProviderSessionState>(["started", "resumed", "closed"]);
const IMAGE_MIME_TYPES = new Set<AttachmentRef["mimeType"]>(["image/png", "image/jpeg", "image/webp"]);
type ProcessingDisclosure = Extract<ChatChunk, { kind: "processingDisclosure" }>;
type ProcessingWorkload = ProcessingDisclosure["workload"];
type ProcessingDestination = ProcessingDisclosure["destination"];
type ProcessingDecision = ProcessingDisclosure["decision"];
const PROCESSING_WORKLOADS = new Set<ProcessingWorkload>(["main_llm", "sub_llm", "memory_llm", "embedding", "network_tool"]);
const PROCESSING_DESTINATIONS = new Set<ProcessingDestination>(["local_device", "private_managed", "external_cloud"]);
const PROCESSING_DECISIONS = new Set<ProcessingDecision>(["allowed", "blocked", "confirmation_required"]);
