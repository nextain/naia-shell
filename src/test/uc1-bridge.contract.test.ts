// UC1 ChatBridge 계약 테스트 — outbound 전용 driving adapter(입력측).
import { describe, it, expect } from "vitest";
import { ChatBridge } from "../main/adapters/chat-bridge.js";
import type { ChatPort, TurnHandle } from "../main/ports/uc1.js";
import type { ChatChunk, ChatRequest } from "../main/domain/chat.js";

class MockChatPort implements ChatPort {
  started: ChatRequest[] = [];
  cancelled: TurnHandle[] = [];
  lastOnChunk: ((c: ChatChunk) => void) | null = null;
  startTurn(req: ChatRequest, onChunk: (c: ChatChunk) => void): { handle: TurnHandle; sent: Promise<void> } {
    this.started.push(req);
    this.lastOnChunk = onChunk;
    return { handle: { requestId: req.requestId, clientId: req.clientId, unsubscribe: () => {} }, sent: Promise.resolve() };
  }
  async cancel(handle: TurnHandle): Promise<void> { this.cancelled.push(handle); }
  deliverChunk(): void {}
}

const input = {
  provider: { provider: "ollama", model: "gemma4" },
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("ChatBridge (outbound driving adapter)", () => {
  it("submit: 고유 requestId + clientId 주입 → ChatPort.startTurn 호출", () => {
    const chat = new MockChatPort();
    let seq = 0;
    const bridge = new ChatBridge({ chat, clientId: "shell-A", newRequestId: () => `rid-${++seq}` });
    bridge.submit(input, () => {});
    bridge.submit(input, () => {});
    expect(chat.started.map((r) => r.requestId)).toEqual(["rid-1", "rid-2"]); // 매 턴 고유
    expect(chat.started[0]?.clientId).toBe("shell-A");
    expect(chat.started[0]?.kind).toBe("chat");
    expect(chat.started[0]?.provider.model).toBe("gemma4");
  });
  it("submit: render 콜백이 onChunk 로 연결", () => {
    const chat = new MockChatPort();
    const bridge = new ChatBridge({ chat, clientId: "s", newRequestId: () => "r1" });
    const got: ChatChunk[] = [];
    bridge.submit(input, (c) => got.push(c));
    chat.lastOnChunk?.({ kind: "text", text: "응답" });
    chat.lastOnChunk?.({ kind: "finish" });
    expect(got.map((c) => c.kind)).toEqual(["text", "finish"]);
  });
  it("선택 필드(sessionId/gatewayUrl/enableTools)만 있을 때 전달, 없으면 생략", () => {
    const chat = new MockChatPort();
    const bridge = new ChatBridge({ chat, clientId: "s", newRequestId: () => "r1" });
    bridge.submit({ ...input, gatewayUrl: "http://gw", enableTools: true }, () => {});
    const r = chat.started[0]!;
    expect(r.gatewayUrl).toBe("http://gw");
    expect(r.enableTools).toBe(true);
    expect("sessionId" in r).toBe(false); // 미지정 = 생략
  });
  it("cancel: ChatPort.cancel 패스스루", async () => {
    const chat = new MockChatPort();
    const bridge = new ChatBridge({ chat, clientId: "s", newRequestId: () => "r1" });
    const { handle } = bridge.submit(input, () => {});
    await bridge.cancel(handle);
    expect(chat.cancelled[0]?.requestId).toBe("r1");
  });
});
