// adapters — MessageRouter (contract §B.4). AgentTransportPort.onMessage 단일 구독.
// AgentMessage(protocol) demux → chat-turn(requestId)→domain ChatChunk→ChatPort.deliverChunk /
//   비-chat known→PendingRouteSink(UC1 미배선) / Unknown·소유권없음→DiagnosticSink. 미지=error+log(silent drop 금지).
// transport(wire)와 분리된 별 컴포넌트(중복전달·구독주체 모호 제거). app 은 demux/protocol 안 봄.
import type { ChatChunk } from "../domain/chat.js";
import type {
  AgentMessage, AgentTransportPort, ChatPort, ClientSessionPort,
  PendingRouteSink, DiagnosticSink, Unsub,
} from "../ports/uc1.js";

/** chat-turn variant(requestId 보유) — domain ChatChunk 로 매핑. 권위=agent index.ts 출력. */
const CHAT_TURN_TYPES = new Set([
  "text", "thinking", "tool_use", "tool_result", "approval_request",
  "finish", "error", "usage", "log_entry", "token_warning",
]);

/** 비-chat known variant — 목적 semantic port 가 UC1 시점 미배선(UC9/UC5/voice). 보류. */
const NONCHAT_KNOWN_TYPES = new Set([
  "audio", "object", "panel_control", "panel_install_result",
  "panel_tool_call", "ready", "skill_list_response", "embedding_progress",
]);

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

  /** 18 variant + Unknown 전부 분기 도착 = exhaustive 보장. */
  route(m: AgentMessage): void {
    const type = m.type;
    if (CHAT_TURN_TYPES.has(type)) {
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
    if (NONCHAT_KNOWN_TYPES.has(type)) {
      this.deps.pending.pending(m); // UC1 미배선 — 해당 UC 에서 실제 포트 배선
      return;
    }
    // UnknownAgentMessage(18 외) — silent drop 금지
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
      return toolCallId === null || output === null ? null : { kind: "toolResult", toolCallId, output };
    }
    case "approval_request": {
      const toolCallId = reqStr(r["toolCallId"]); const toolName = reqStr(r["toolName"]); const tier = reqStr(r["tier"]);
      return toolCallId === null || toolName === null || tier === null
        ? null : { kind: "approvalRequest", toolCallId, toolName, tier };
    }
    case "usage": return { kind: "usage", raw: m };
    case "log_entry": {
      const level = reqStr(r["level"]); const message = reqStr(r["message"]);
      return level === null || message === null ? null : { kind: "logEntry", level, message };
    }
    case "token_warning": return { kind: "tokenWarning", raw: m };
    case "finish": return { kind: "finish" };
    case "error": { const message = reqStr(r["message"]); return message === null ? null : { kind: "error", message }; }
    default: return null; // CHAT_TURN_TYPES 에 있으나 매핑 없음 = 손상
  }
}

/** 필수 string — 문자열 아니면 null(손상 신호). */
function reqStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
