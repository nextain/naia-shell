// adapters/tauri/uc1 — UC1 transport (contract §B.4). StdioTransportAdapter.
// 변환 전담(canon): domain outbound→AgentOutbound(protocol)→wire JSON-line encode / wire→AgentMessage decode.
// ⚠️ flat newline JSON 만(agent 는 한 줄 곧바로 parseRequest). protocol-bridge StdioFrame v1=미사용 scaffold라 안 보냄.
// stdin/stdout 실배선은 라이브 trace 대기(NotWired). encode/decode 매핑은 순수 함수로 노출(테스트 가능).
import type { DomainOutbound } from "../../domain/chat.js";
import type { AgentOutbound, AgentMessage, AgentTransportPort, Unsub } from "../../ports/uc1.js";

class NotWired extends Error {
  constructor(cmd: string) { super(`Tauri transport not wired (라이브 trace 대기): ${cmd}`); }
}

/**
 * domain DomainOutbound → AgentOutbound(protocol). AgentOutbound 4 variant 와 1:1.
 * ⚠️ chat provider 는 verbatim passthrough(domain ProviderSelect 에 secret 키 없음 — 타입상 strip 보장).
 * secret 은 오직 CredsUpdate→creds_update 채널.
 */
export function toAgentOutbound(out: DomainOutbound): AgentOutbound {
  switch (out.kind) {
    case "chat":
      return {
        type: "chat_request",
        requestId: out.requestId,
        clientId: out.clientId,
        ...(out.sessionId !== undefined ? { sessionId: out.sessionId } : {}),
        provider: { ...out.provider }, // verbatim(secret 없음)
        ...(out.gatewayUrl !== undefined ? { gatewayUrl: out.gatewayUrl } : {}),
        messages: out.messages,
        ...(out.systemPrompt !== undefined ? { systemPrompt: out.systemPrompt } : {}),
        ...(out.enableTools !== undefined ? { enableTools: out.enableTools } : {}),
        ...(out.disabledSkills !== undefined ? { disabledSkills: out.disabledSkills } : {}),
      };
    case "cancel":
      return { type: "cancel_stream", requestId: out.requestId };
    case "approvalResponse":
      return { type: "approval_response", requestId: out.requestId, toolCallId: out.toolCallId, decision: out.decision };
    case "credsUpdate":
      return { type: "creds_update", provider: out.provider, ...out.secret };
  }
}

/** AgentOutbound(protocol) → wire JSON-line (flat newline JSON, framing=newline). */
export function encodeWire(payload: AgentOutbound): string {
  return JSON.stringify(payload) + "\n";
}

/** wire line → AgentMessage(protocol). 파싱 실패/type 없음 = UnknownAgentMessage. */
export function decodeAgentMessage(line: string): AgentMessage {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const type = typeof obj["type"] === "string" ? (obj["type"] as string) : undefined;
    if (!type) return { type: "__malformed__", raw: line };
    return obj as AgentMessage;
  } catch {
    return { type: "__malformed__", raw: line };
  }
}

/** 라이브 stdio 어댑터 — send/onMessage 는 Tauri invoke/event 배선 대기. */
export const stdioTransport: AgentTransportPort = {
  async send(out: DomainOutbound): Promise<void> {
    const _wire = encodeWire(toAgentOutbound(out)); // 변환은 준비됨; 전송 배선 대기
    void _wire;
    throw new NotWired("send_to_agent_command (stdin write)");
  },
  onMessage(_cb: (m: AgentMessage) => void): Unsub {
    throw new NotWired("listen('agent_response')");
  },
};
