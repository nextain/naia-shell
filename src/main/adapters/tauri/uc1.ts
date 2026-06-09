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

/** 라이브 stdio 어댑터 — send/onMessage 는 Tauri invoke/event 배선 대기(주입형 makeLiveStdioTransport 사용 시 실동작). */
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

/**
 * Tauri 경계 주입 — shell-edge 가 `@tauri-apps/api` invoke/listen 을 주입(F0 makeF0LiveAdapters 패턴).
 * 이렇게 어댑터 로직은 실제이되 Tauri 런타임 없이 mock 으로 검증 가능(앱 무접촉).
 */
export interface LiveTransportDeps {
  /** Tauri invoke. rejection 전파(baseline 등가). */
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
  /** Tauri listen — unlisten 함수를 Promise 로 반환(비동기). payload = event.payload. */
  listen(event: string, cb: (payload: unknown) => void): Promise<() => void>;
  /** listen 구독 실패 관측(옵션) — 미주입 시 swallow(unhandled rejection 방지). */
  onListenError?(err: unknown): void;
}

/**
 * 라이브 StdioTransportAdapter. ⚠️ shell→rust hop = **타입별 별도 Tauri command**(baseline 실측):
 *  - chat_request·approval_response·creds_update → `send_to_agent_command`({message: JSON})
 *  - cancel_stream → `cancel_stream`({requestId})  (별 command)
 *  - 수신 `agent_response` payload = JSON 문자열 → decodeAgentMessage.
 */
export function makeLiveStdioTransport(deps: LiveTransportDeps): AgentTransportPort {
  return {
    async send(out: DomainOutbound): Promise<void> {
      const payload = toAgentOutbound(out);
      if (payload.type === "cancel_stream") {
        await deps.invoke("cancel_stream", { requestId: payload.requestId });
        return;
      }
      // chat_request·approval_response·creds_update = stdin JSON-line(send_to_agent_command)
      await deps.invoke("send_to_agent_command", { message: JSON.stringify(payload) });
    },
    onMessage(cb: (m: AgentMessage) => void): Unsub {
      // listen 은 async — unsub 가 listen resolve 전에 호출될 경쟁 처리(즉시 dispose 플래그).
      let unlisten: (() => void) | null = null;
      let disposed = false;
      deps
        .listen("agent_response", (payload) => {
          if (disposed) return; // ⚠️ unlisten 발효 전/resolve 전 도착 이벤트 차단(구독 해제 후 전달 금지)
          const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
          cb(decodeAgentMessage(raw));
        })
        .then((u) => { if (disposed) u(); else unlisten = u; })
        // ⚠️ listen rejection 처리(unhandled 방지). observer 가 throw 해도 catch 핸들러가 재-reject 하지 않게 격리.
        .catch((err) => { try { deps.onListenError?.(err); } catch { /* observer 오류 무시 */ } });
      return () => { disposed = true; unlisten?.(); unlisten = null; };
    },
  };
}
