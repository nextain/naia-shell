// adapters/shell-compat — 실 shell 편입(Option B B1) seam.
// old shell `lib/chat-service.ts` 의 sendChatMessage/cancelChat/sendCredsUpdate 와 *시그니처 호환* drop-in 을
// 새 core(ChatBridge + makeLiveStdioTransport + MessageRouter) 위에 제공 → shell 은 import 1줄 교체.
// ⚠️ old onChunk 는 wire `AgentResponseChunk` 를 기대 → 새 core domain ChatChunk 를 wire 로 역매핑(chatChunkToWire).
import type { ChatChunk, ProviderSelect, ChatMessage, EnvironmentSegment, ChatRequest } from "../domain/chat.js";
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
  /** S4 — 셸 환경고유 세그먼트(아바타 감정·패널). 코어가 persona+workspace 뒤 머지. */
  environmentSegments?: readonly EnvironmentSegment[];
  enableTools?: boolean;
  enableThinking?: boolean;
  gatewayUrl?: string;
  disabledSkills?: readonly string[];
  activityResume?: ChatRequest["activityResume"];
}

/** domain ChatChunk → wire AgentResponseChunk(old onChunk 기대형). os router toChatChunk 의 역. requestId 결속. */
export function chatChunkToWire(requestId: string, c: ChatChunk): Record<string, unknown> {
  switch (c.kind) {
    case "text": return { type: "text", requestId, text: c.text };
    case "thinking": return { type: "thinking", requestId, text: c.text };
    case "toolUse": return { type: "tool_use", requestId, toolCallId: c.toolCallId, toolName: c.name, args: c.args };
    case "toolResult": return { type: "tool_result", requestId, toolCallId: c.toolCallId, toolName: c.toolName, output: c.output, success: c.success };
    case "approvalRequest": return { type: "approval_request", requestId, toolCallId: c.toolCallId, toolName: c.toolName, tier: c.tier, args: c.args, description: c.description };
    case "gatewayApprovalRequest": return { type: "gateway_approval_request", requestId, toolCallId: c.toolCallId, toolName: c.toolName, args: c.args };
    // ⚠️ raw 를 *먼저* 펼치고 type/requestId 로 덮음(raw 가 type/requestId 오염 못 하게, R1 MED)
    case "usage": return { ...(c.raw && typeof c.raw === "object" ? c.raw as object : {}), type: "usage", requestId };
    case "logEntry": return { type: "log_entry", requestId, level: c.level, message: c.message };
    case "tokenWarning": return { ...(c.raw && typeof c.raw === "object" ? c.raw as object : {}), type: "token_warning", requestId };
    case "compacted": return { type: "compacted", requestId, droppedCount: c.droppedCount };
    case "panelToolCall": return { type: "panel_tool_call", requestId, toolCallId: c.toolCallId, toolName: c.toolName, args: c.args }; // UC-PANEL FR-PANEL-2 → ChatPanel handleChunk
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
  sendApprovalResponse(requestId: string, toolCallId: string, decision: "approve" | "reject"): Promise<void>;
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
  // ⚠️ handle Map 없음(누수 원천 제거, R4) — cancelChat 은 최소 handle{requestId,clientId} 재구성(ChatService.cancel 인가=레지스트리 requestId→clientId, unsubscribe 미사용).

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
        ...(opts.environmentSegments !== undefined ? { environmentSegments: opts.environmentSegments } : {}),
        ...(opts.enableTools !== undefined ? { enableTools: opts.enableTools } : {}),
        ...(opts.enableThinking !== undefined ? { enableThinking: opts.enableThinking } : {}),
        ...(opts.gatewayUrl !== undefined ? { gatewayUrl: opts.gatewayUrl } : {}),
        ...(opts.disabledSkills !== undefined ? { disabledSkills: opts.disabledSkills } : {}),
        ...(opts.activityResume !== undefined ? { activityResume: opts.activityResume } : {}),
      };
      const { sent } = chat.startTurn(req, (c) => opts.onChunk(chatChunkToWire(opts.requestId, c)));
      await sent; // send reject 시 throw(old await/throw 호환). 상태/레지스트리 해제는 ChatService 가(terminal/reject).
    },
    // old cancelChat(requestId): 최소 handle 재구성(권한=ChatService 가 레지스트리 requestId→clientId 대조; unsubscribe 미사용).
    cancelChat(requestId: string): Promise<void> {
      const handle: TurnHandle = { requestId, clientId, unsubscribe: () => {} };
      return chat.cancel(handle);
    },
    sendCredsUpdate(payload: ShellCredsPayload): Promise<void> {
      const secret: { apiKey?: string; naiaKey?: string } = {};
      if (payload.apiKey !== undefined) secret.apiKey = payload.apiKey;
      if (payload.naiaKey !== undefined) secret.naiaKey = payload.naiaKey;
      return transport.send({ kind: "credsUpdate", provider: payload.provider, secret });
    },
    // UC13 — 승인 응답 송신(approval_response wire). decision=approve|reject(매핑은 shell chat-service). send reject 전파.
    sendApprovalResponse(requestId: string, toolCallId: string, decision: "approve" | "reject"): Promise<void> {
      return transport.send({ kind: "approvalResponse", requestId, clientId, toolCallId, decision });
    },
  };
}

// ── UC12 온보딩/설정 graft seam ──
import { wireOnboardingLive } from "../composition/index.js";
import type { LiveDeps } from "./tauri/live.js";
import type { UC12LiveDeps } from "./tauri/uc12.js";
import type { OnboardingController } from "../app/control/onboarding.js";

/** old shell OnboardingWizard/SettingsTab 이 새 core 온보딩/설정을 경유하게 하는 seam.
 *  shell 이 F0 LiveDeps(invoke/config/adk-store) + UC12 deps(invoke/openUrl/convertFileSrc/loginUrl) 주입 →
 *  OnboardingFlowPort + SettingsPort 구현(OnboardingController) 반환. UC1 makeShellChatService 와 동일 seam 패턴. */
export function makeShellOnboarding(deps: { f0: LiveDeps; uc12: UC12LiveDeps }): OnboardingController {
  return wireOnboardingLive(deps.f0, deps.uc12);
}

// 셸 graft 가 flat(old localStorage 형태) config 를 NaiaConfig 로 categorize 할 때 동일 변환기(F0 어댑터와 공유) 사용.
// re-export 로 셸이 core 내부 경로를 모르게 한다(직교).
export { toNaiaConfig } from "./tauri/config-map.js";

// step-flow graft(step2): 셸이 단계 전이를 ctrl.submit 으로 구동할 때 쓰는 입력 타입(type-only, 런타임 결합 0).
export type { StepInput } from "../domain/onboarding.js";

// ── UC2(V2 음성) os-local graft seam ──
// 셸 voice-core 가 makeV2Expression(표현 포트=재생/avatar)을 셸 audio-player 주입으로 wire(live=재생 한정).
// makeV2Sensory 도 re-export 하나 현재 test-only/dormant(mic graft 보류 — createMicStream 의 create-then-start
// +try/catch 가 SensoryPort.startMicCapture 의 create+start+swallow 와 lifecycle 불일치, STT=streaming vs
// one-shot 불일치 → 포트설계 결정/루크-머신 잔여).
export { makeV2Expression, makeV2Sensory } from "./tauri/v2.js";
export type { V2LiveDeps } from "./tauri/v2.js";
