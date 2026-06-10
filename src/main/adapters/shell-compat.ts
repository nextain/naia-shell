// adapters/shell-compat — 실 shell 편입(Option B B1) seam.
// old shell `lib/chat-service.ts` 의 sendChatMessage/cancelChat/sendCredsUpdate 와 *시그니처 호환* drop-in 을
// 새 core(ChatBridge + makeLiveStdioTransport + MessageRouter) 위에 제공 → shell 은 import 1줄 교체.
// ⚠️ old onChunk 는 wire `AgentResponseChunk` 를 기대 → 새 core domain ChatChunk 를 wire 로 역매핑(chatChunkToWire).
import type { ChatChunk, ProviderSelect, ChatMessage } from "../domain/chat.js";
import type { TurnHandle } from "../ports/uc1.js";
import { makeLiveStdioTransport, type LiveTransportDeps } from "./tauri/uc1.js";
import { ChatBridge } from "./chat-bridge.js";
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
    case "usage": return { type: "usage", requestId, ...(c.raw && typeof c.raw === "object" ? c.raw as object : {}) };
    case "logEntry": return { type: "log_entry", requestId, level: c.level, message: c.message };
    case "tokenWarning": return { type: "token_warning", requestId, ...(c.raw && typeof c.raw === "object" ? c.raw as object : {}) };
    case "finish": return { type: "finish", requestId };
    case "error": return { type: "error", requestId, message: c.message };
  }
}

/**
 * shell-facing chat-service. Tauri invoke/listen 주입(makeLiveStdioTransport).
 * 한 번 wire → 여러 turn. clientId=이 shell 신원. onChunk 별 turn 의 render 로 라우팅.
 */
export function makeShellChatService(deps: { live: LiveTransportDeps; clientId?: string }): {
  sendChatMessage(opts: ShellSendOptions): { handle: TurnHandle; sent: Promise<void> };
  cancelChat(handle: TurnHandle): Promise<void>;
  start(): void;
} {
  const sessions = new InMemoryClientSession();
  const transport = makeLiveStdioTransport(deps.live);
  const chat = new ChatService(transport, sessions);
  const bridge = new ChatBridge({
    chat,
    clientId: deps.clientId ?? "shell",
    newRequestId: () => { throw new Error("requestId 는 opts 에서 제공(아래 submit 에서 직접 사용)"); },
  });
  void bridge; // bridge.submit 은 requestId 자동생성 — shell 은 자체 requestId 사용 → ChatService 직접
  const router = new MessageRouter({
    transport, chat, sessions,
    pending: { pending: (m) => console.warn("[shell-compat pending]", m.type) },
    diagnostic: { diagnose: (m, why) => console.error("[shell-compat diag]", m.type, why) },
  });

  return {
    sendChatMessage(opts: ShellSendOptions) {
      const { apiKey: _a, naiaKey: _n, ...providerSafe } = opts.provider; // secret strip(creds_update 채널)
      const req = {
        kind: "chat" as const,
        requestId: opts.requestId,
        clientId: deps.clientId ?? "shell",
        provider: providerSafe,
        messages: [...opts.history, { role: "user" as const, content: opts.message }],
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
        ...(opts.enableTools !== undefined ? { enableTools: opts.enableTools } : {}),
        ...(opts.enableThinking !== undefined ? { enableThinking: opts.enableThinking } : {}),
        ...(opts.gatewayUrl !== undefined ? { gatewayUrl: opts.gatewayUrl } : {}),
        ...(opts.disabledSkills !== undefined ? { disabledSkills: opts.disabledSkills } : {}),
      };
      // domain ChatChunk → wire → old onChunk
      return chat.startTurn(req, (c) => opts.onChunk(chatChunkToWire(opts.requestId, c)));
    },
    cancelChat(handle: TurnHandle) { return chat.cancel(handle); },
    start() { router.start(); },
  };
}
