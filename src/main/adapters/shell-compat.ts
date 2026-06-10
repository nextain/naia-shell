// adapters/shell-compat — 실 shell 편입(Option B B1) seam.
// old shell `lib/chat-service.ts` 의 sendChatMessage/cancelChat/sendCredsUpdate 와 *시그니처 호환* drop-in 을
// 새 core(ChatBridge + makeLiveStdioTransport + MessageRouter) 위에 제공 → shell 은 import 1줄 교체.
// ⚠️ old onChunk 는 wire `AgentResponseChunk` 를 기대 → 새 core domain ChatChunk 를 wire 로 역매핑(chatChunkToWire).
import type { ChatChunk, ProviderSelect, ChatMessage } from "../domain/chat.js";
import type { TurnHandle } from "../ports/uc1.js";
import { makeLiveStdioTransport, type LiveTransportDeps } from "./tauri/uc1.js";
import { ChatService } from "../app/chat/chat-service.js";
import { InMemoryClientSession } from "../app/chat/client-session.js";
import { MessageRouter } from "./message-router.js";

/** old shell SendChatOptions 호환(필요 필드만; tts/webhook 은 후속 UC). */
export interface ShellSendOptions {
  message: string;
  provider: ProviderSelect & { apiKey?: string; naiaKey?: string };
  history: readonly ChatMessage[];
  onChunk: (chunk: Record<string, unknown>) => void; // wire AgentResponseChunk
  requestId: string;
  sessionId?: string;
  systemPrompt?: string;
  enableTools?: boolean;
  enableThinking?: boolean;
  gatewayUrl?: string;
  disabledSkills?: readonly string[];
}

/** domain ChatChunk → wire AgentResponseChunk(old onChunk 기대형). os router toChatChunk 의 역. requestId 결속. */
export function chatChunkToWire(requestId: string, c: ChatChunk): Record<string, unknown> {
  switch (c.kind) {
    case "text": return { type: "text", requestId, text: c.text };
    case "thinking": return { type: "thinking", requestId, text: c.text };
    case "toolUse": return { type: "tool_use", requestId, toolCallId: c.toolCallId, toolName: c.name, args: c.args };
    case "toolResult": return { type: "tool_result", requestId, toolCallId: c.toolCallId, output: c.output };
    case "approvalRequest": return { type: "approval_request", requestId, toolCallId: c.toolCallId, toolName: c.toolName, tier: c.tier };
    case "gatewayApprovalRequest": return { type: "gateway_approval_request", requestId, toolCallId: c.toolCallId, toolName: c.toolName, args: c.args };
    // ⚠️ raw 를 *먼저* 펼치고 type/requestId 로 덮음(raw 가 type/requestId 오염 못 하게, R1 MED)
    case "usage": return { ...(c.raw && typeof c.raw === "object" ? c.raw as object : {}), type: "usage", requestId };
    case "logEntry": return { type: "log_entry", requestId, level: c.level, message: c.message };
    case "tokenWarning": return { ...(c.raw && typeof c.raw === "object" ? c.raw as object : {}), type: "token_warning", requestId };
    case "finish": return { type: "finish", requestId };
    case "error": return { type: "error", requestId, message: c.message };
  }
}

/**
 * shell-facing chat-service. Tauri invoke/listen 주입(makeLiveStdioTransport).
 * 한 번 wire → 여러 turn. clientId=이 shell 신원. onChunk 별 turn 의 render 로 라우팅.
 */
/** creds_update drop-in payload(old sendCredsUpdate). */
export interface ShellCredsPayload { provider: string; apiKey?: string; naiaKey?: string; }

export function makeShellChatService(deps: { live: LiveTransportDeps; clientId?: string }): {
  sendChatMessage(opts: ShellSendOptions): Promise<void>;
  cancelChat(requestId: string): Promise<void>;
  sendCredsUpdate(payload: ShellCredsPayload): Promise<void>;
} {
  const clientId = deps.clientId ?? "shell";
  const sessions = new InMemoryClientSession();
  const transport = makeLiveStdioTransport(deps.live);
  const chat = new ChatService(transport, sessions);
  const router = new MessageRouter({
    transport, chat, sessions,
    pending: { pending: (m) => console.warn("[shell-compat pending]", m.type) },
    diagnostic: { diagnose: (m, why) => console.error("[shell-compat diag]", m.type, why) },
  });
  router.start(); // ⚠️ 즉시 구독(별도 start 불요 — 미구독 시 chunk 미전달 방지, R1)
  const handles = new Map<string, TurnHandle>(); // requestId→handle(cancelChat by requestId, old API)

  return {
    // ⚠️ old 와 동일: Promise<void> 반환, send 실패 시 throw(await 호출자 표면화, R1)
    async sendChatMessage(opts: ShellSendOptions): Promise<void> {
      const { apiKey: _a, naiaKey: _n, ...providerSafe } = opts.provider; // secret strip(creds_update 채널)
      const req = {
        kind: "chat" as const,
        requestId: opts.requestId,
        clientId,
        provider: providerSafe,
        messages: [...opts.history, { role: "user" as const, content: opts.message }],
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
        ...(opts.enableTools !== undefined ? { enableTools: opts.enableTools } : {}),
        ...(opts.enableThinking !== undefined ? { enableThinking: opts.enableThinking } : {}),
        ...(opts.gatewayUrl !== undefined ? { gatewayUrl: opts.gatewayUrl } : {}),
        ...(opts.disabledSkills !== undefined ? { disabledSkills: opts.disabledSkills } : {}),
      };
      const { handle, sent } = chat.startTurn(req, (c) => opts.onChunk(chatChunkToWire(opts.requestId, c)));
      handles.set(opts.requestId, handle);
      try { await sent; } finally { /* handle 은 cancel 위해 유지; turn 종결 시 ChatService 가 레지스트리 해제 */ }
    },
    // old cancelChat(requestId): handle 조회(없으면 최소 handle 로 — 권한=레지스트리 requestId→clientId 대조).
    async cancelChat(requestId: string): Promise<void> {
      const h = handles.get(requestId) ?? { requestId, clientId, unsubscribe: () => {} };
      try { await chat.cancel(h); } finally { handles.delete(requestId); }
    },
    sendCredsUpdate(payload: ShellCredsPayload): Promise<void> {
      const secret: { apiKey?: string; naiaKey?: string } = {};
      if (payload.apiKey !== undefined) secret.apiKey = payload.apiKey;
      if (payload.naiaKey !== undefined) secret.naiaKey = payload.naiaKey;
      return transport.send({ kind: "credsUpdate", provider: payload.provider, secret });
    },
  };
}
