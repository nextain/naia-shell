// UC1 통합 trace (P02 3-tier #3 reafference) — 풀 스택 엔드투엔드 시뮬레이션.
// wireChatUC1({live: mockDeps}) 로 ChatService+MessageRouter+makeLiveStdioTransport 전체를 조립하고,
// mock Tauri invoke/listen 으로 "입력→send_to_agent_command→agent_response chunk→렌더" 1턴을 재현.
// ⚠️ 실 라이브 trace = 이 mockDeps 를 실제 @tauri-apps/api invoke/listen 으로 교체만 하면 동일 경로(앱 무접촉 검증).
import { describe, it, expect } from "vitest";
import { wireChatUC1 } from "../main/composition/index.js";
import type { LiveTransportDeps } from "../main/adapters/tauri/uc1.js";
import type { ChatChunk, ChatRequest } from "../main/domain/chat.js";

/** mock Tauri 경계 — invoke 기록 + agent_response 수동 방출(실 Tauri 대역). */
function mockTauri() {
  const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
  let listener: ((payload: unknown) => void) | null = null;
  const deps: LiveTransportDeps = {
    async invoke(cmd, args) { invokes.push({ cmd, args }); return undefined; },
    async listen(_e, cb) { listener = cb; return () => { listener = null; }; },
  };
  return { deps, invokes, emit: (line: string) => listener?.(line) };
}

const req: ChatRequest = {
  kind: "chat", requestId: "trace-1", clientId: "shell",
  provider: { provider: "ollama", model: "gemma4" },
  messages: [{ role: "user", content: "안녕 나이아" }],
};

describe("UC1 통합 trace — 입력→송신→스트리밍→finish (풀 스택, mock Tauri)", () => {
  it("정상 1턴: send_to_agent_command 송신 → agent_response 스트리밍 → 순서대로 렌더 → finish 해제", async () => {
    const { deps, invokes, emit } = mockTauri();
    const { chat, router, sessions } = wireChatUC1({ live: deps });
    router.start(); // onMessage 단일 구독 개시

    // U1.1~U1.2: 입력 → startTurn → send_to_agent_command
    const rendered: ChatChunk[] = [];
    const { sent } = chat.startTurn(req, (c) => rendered.push(c));
    await sent;
    await Promise.resolve(); // listen resolve
    expect(invokes[0]?.cmd).toBe("send_to_agent_command");
    expect(JSON.parse(invokes[0]!.args["message"] as string).requestId).toBe("trace-1");
    expect(sessions.ownerOf("trace-1")).toBe("shell");

    // U1.3~U1.4: agent 가 agent_response(JSON 문자열) 스트리밍 (text, text, finish)
    emit(JSON.stringify({ type: "text", requestId: "trace-1", text: "안녕" }));
    emit(JSON.stringify({ type: "text", requestId: "trace-1", text: "하세요" }));
    emit(JSON.stringify({ type: "finish", requestId: "trace-1" }));

    // U1.5~U1.6: demux → deliverChunk → 렌더(순서 보존) + finish=terminal 해제
    expect(rendered.map((c) => c.kind)).toEqual(["text", "text", "finish"]);
    expect(rendered.filter((c) => c.kind === "text").map((c) => (c as { text: string }).text)).toEqual(["안녕", "하세요"]);
    expect(sessions.ownerOf("trace-1")).toBeUndefined(); // 정상 종료 해제
  });

  it("취소 trace: cancel → cancel_stream 송신 → 후속 finish 가 해제", async () => {
    const { deps, invokes, emit } = mockTauri();
    const { chat, router } = wireChatUC1({ live: deps });
    router.start();
    const rendered: ChatChunk[] = [];
    const { handle, sent } = chat.startTurn(req, (c) => rendered.push(c));
    await sent; await Promise.resolve();
    emit(JSON.stringify({ type: "text", requestId: "trace-1", text: "부분" }));
    await chat.cancel(handle);
    expect(invokes.some((i) => i.cmd === "cancel_stream" && i.args["requestId"] === "trace-1")).toBe(true);
    expect(chat.turnState("trace-1")).toBe("cancelling"); // 비종결
    emit(JSON.stringify({ type: "finish", requestId: "trace-1" })); // 취소 후 종료
    expect(rendered.map((c) => c.kind)).toEqual(["text", "finish"]);
  });

  it("비-chat variant(panel_control) = PendingRouteSink 보류, chat 턴 오염 없음", async () => {
    const { deps, emit } = mockTauri();
    const pending: string[] = [];
    const { chat, router } = wireChatUC1({ live: deps, pending: { pending: (m) => pending.push(m.type) } });
    router.start();
    const rendered: ChatChunk[] = [];
    const { sent } = chat.startTurn(req, (c) => rendered.push(c));
    await sent; await Promise.resolve();
    emit(JSON.stringify({ type: "panel_control", requestId: "trace-1", action: "x" })); // 비-chat
    emit(JSON.stringify({ type: "text", requestId: "trace-1", text: "ok" }));
    expect(pending).toEqual(["panel_control"]); // 보류
    expect(rendered.map((c) => c.kind)).toEqual(["text"]); // chat 턴엔 panel 안 섞임
  });
});
