// adapters — TauriChatBridge (contract §B.4). **outbound 전용 driving adapter**.
// shell ChatPanel 의 UI 이벤트 → ChatPort.startTurn/cancel 호출 + onChunk→렌더 전달.
// ⚠️ agent stdout(agent_response) 수신은 Bridge 아님 = StdioTransportAdapter+MessageRouter 단일 경로(R15).
// ⚠️ requestId 고유성(§B.4.1 불변식)은 주입된 newRequestId 가 책임(shell=crypto.randomUUID/baseline req-ts-rand).
import type { ChatRequest, ChatChunk, ChatMessage, ProviderSelect } from "../domain/chat.js";
import type { ChatPort, TurnHandle } from "../ports/uc1.js";

export interface ChatBridgeDeps {
  readonly chat: ChatPort;
  /** 이 클라이언트(=이 shell/body) 신원. */
  readonly clientId: string;
  /** turn 마다 *전역 고유* requestId 생성(§B.4.1 불변식 책임). shell 이 주입. */
  readonly newRequestId: () => string;
}

/** ChatPanel 이 넘기는 입력(요청 본문 — requestId/clientId 는 bridge 가 채움). */
export interface ChatSubmitInput {
  readonly provider: ProviderSelect;
  readonly messages: readonly ChatMessage[];
  readonly sessionId?: string;
  readonly gatewayUrl?: string;
  readonly systemPrompt?: string;
  readonly enableTools?: boolean;
  readonly disabledSkills?: readonly string[];
}

export class ChatBridge {
  constructor(private readonly deps: ChatBridgeDeps) {}

  /** ChatPanel 송신 → ChatRequest 조립(고유 requestId + clientId 주입) → ChatPort.startTurn. render=onChunk. */
  submit(input: ChatSubmitInput, render: (c: ChatChunk) => void): { handle: TurnHandle; sent: Promise<void> } {
    const req: ChatRequest = {
      kind: "chat",
      requestId: this.deps.newRequestId(),
      clientId: this.deps.clientId,
      provider: input.provider,
      messages: input.messages,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.gatewayUrl !== undefined ? { gatewayUrl: input.gatewayUrl } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.enableTools !== undefined ? { enableTools: input.enableTools } : {}),
      ...(input.disabledSkills !== undefined ? { disabledSkills: input.disabledSkills } : {}),
    };
    return this.deps.chat.startTurn(req, render);
  }

  /** 중단 — ChatPort.cancel 패스스루(권한·상태는 ChatService 가 판정). */
  cancel(handle: TurnHandle): Promise<void> {
    return this.deps.chat.cancel(handle);
  }
}
