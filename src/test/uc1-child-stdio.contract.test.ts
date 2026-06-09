// UC1 child-stdio transport 계약 테스트(Option C 헤드리스 trace 어댑터, mock LineIO).
import { describe, it, expect } from "vitest";
import { makeChildStdioTransport, type LineIO } from "../main/adapters/child-stdio.js";
import type { AgentMessage } from "../main/ports/uc1.js";
import type { ChatRequest } from "../main/domain/chat.js";

function mockIo() {
  const written: string[] = [];
  let cb: ((line: string) => void) | null = null;
  let unsubbed = false;
  const io: LineIO = {
    writeLine: (l) => { written.push(l); },
    onLine: (c) => { cb = c; return () => { unsubbed = true; cb = null; }; },
  };
  return { io, written, emit: (l: string) => cb?.(l), unsubbed: () => unsubbed };
}

const req: ChatRequest = {
  kind: "chat", requestId: "r1", clientId: "c1",
  provider: { provider: "ollama", model: "gemma4" },
  messages: [{ role: "user", content: "hi" }],
};

describe("makeChildStdioTransport (직접 agent stdin/stdout)", () => {
  it("send: 모든 outbound = stdin 한 줄 JSON(command 분리 없음)", async () => {
    const { io, written } = mockIo();
    const t = makeChildStdioTransport(io);
    await t.send(req);
    await t.send({ kind: "cancel", requestId: "r1", clientId: "c1" });
    const chat = JSON.parse(written[0]!); const cancel = JSON.parse(written[1]!);
    expect(chat.type).toBe("chat_request");
    expect(chat.requestId).toBe("r1");
    expect("clientId" in chat).toBe(false);          // wire 미포함(baseline 등가)
    expect(cancel).toEqual({ type: "cancel_stream", requestId: "r1" }); // Tauri 와 달리 같은 stdin 채널
  });
  it("send: 동기 write throw → rejection 전파(EPIPE 등)", async () => {
    const io: LineIO = { writeLine: () => { throw new Error("EPIPE"); }, onLine: () => () => {} };
    await expect(makeChildStdioTransport(io).send(req)).rejects.toThrow("EPIPE");
  });
  it("send: *비동기* write reject(콜백 오류) → rejection 전파(거짓 성공 방지, SEV-1)", async () => {
    const io: LineIO = { writeLine: () => Promise.reject(new Error("async EPIPE")), onLine: () => () => {} };
    await expect(makeChildStdioTransport(io).send(req)).rejects.toThrow("async EPIPE");
  });
  it("onMessage: stdout 줄 → decodeAgentMessage → cb", () => {
    const { io, emit } = mockIo();
    const got: AgentMessage[] = [];
    makeChildStdioTransport(io).onMessage((m) => got.push(m));
    emit('{"type":"text","requestId":"r1","text":"안녕"}');
    emit('{"type":"finish","requestId":"r1"}');
    emit("not json"); // malformed → __malformed__
    expect(got.map((m) => m.type)).toEqual(["text", "finish", "__malformed__"]);
  });
  it("onMessage unsubscribe", () => {
    const { io, emit, unsubbed } = mockIo();
    const got: AgentMessage[] = [];
    const unsub = makeChildStdioTransport(io).onMessage((m) => got.push(m));
    unsub();
    expect(unsubbed()).toBe(true);
    emit('{"type":"text","requestId":"r1","text":"x"}'); // 구독 해제 후
    expect(got.length).toBe(0);
  });
});
