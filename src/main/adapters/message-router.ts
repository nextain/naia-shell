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
        // 소유주 없음(종료/미지 turn) — deliverChunk 소유권 필수와 충돌 → DiagnosticSink
        this.deps.diagnostic.diagnose(m, `no owner for requestId=${requestId}`);
        return;
      }
      this.deps.chat.deliverChunk(toChatChunk(type, m), { requestId, clientId });
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

/** protocol chat-turn message → domain ChatChunk (권위=agent index.ts 출력 형상). */
function toChatChunk(type: string, m: AgentMessage): ChatChunk {
  const r = m as Record<string, unknown>;
  switch (type) {
    case "text": return { kind: "text", text: str(r["text"]) };
    case "thinking": return { kind: "thinking", text: str(r["text"]) };
    case "tool_use": return { kind: "toolUse", toolCallId: str(r["toolCallId"]), name: str(r["toolName"] ?? r["name"]), args: r["args"] };
    case "tool_result": return { kind: "toolResult", toolCallId: str(r["toolCallId"]), output: str(r["output"]) };
    case "approval_request": return { kind: "approvalRequest", toolCallId: str(r["toolCallId"]), toolName: str(r["toolName"]), tier: str(r["tier"]) };
    case "usage": return { kind: "usage", raw: m };
    case "log_entry": return { kind: "logEntry", level: str(r["level"]), message: str(r["message"]) };
    case "token_warning": return { kind: "tokenWarning", raw: m };
    case "finish": return { kind: "finish" };
    case "error": return { kind: "error", message: str(r["message"]) };
    default: return { kind: "error", message: `unmapped chat-turn type: ${type}` };
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}
