// UC1 수평 계약 테스트 (P02). contract §B.6.
// mock AgentTransport.onMessage 방출 → MessageRouter demux → ChatService.deliverChunk → chunk 라우팅·ChatTurn 종결.
// + send secret 미포함 + ownership 충돌거부/해제/권한 + cancel 비종결 + exhaustive demux(Unknown/Pending).
import { describe, it, expect } from "vitest";
import {
  nextTurnState, isTerminalState, isTerminalChunk,
  type ChatRequest, type ChatChunk, type DomainOutbound,
} from "../main/domain/chat.js";
import { ChatService } from "../main/app/chat/chat-service.js";
import { InMemoryClientSession } from "../main/app/chat/client-session.js";
import { MessageRouter } from "../main/adapters/message-router.js";
import { toAgentOutbound, decodeAgentMessage, encodeWire } from "../main/adapters/tauri/uc1.js";
import type {
  AgentMessage, AgentTransportPort, Unsub,
  PendingRouteSink, DiagnosticSink,
} from "../main/ports/uc1.js";

// ── mock transport: send 기록 + onMessage 수동 방출 ──
class MockTransport implements AgentTransportPort {
  sent: DomainOutbound[] = [];
  private cb: ((m: AgentMessage) => void) | null = null;
  failNext = false;
  async send(out: DomainOutbound): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error("transport down"); }
    this.sent.push(out);
  }
  onMessage(cb: (m: AgentMessage) => void): Unsub { this.cb = cb; return () => { this.cb = null; }; }
  emit(m: AgentMessage): void { this.cb?.(m); }
  subscribed(): boolean { return this.cb !== null; }
}

const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat", requestId: "r1", clientId: "c1",
  provider: { provider: "ollama", model: "gemma4", ollamaHost: "http://h", ollamaNumCtx: 8192 },
  messages: [{ role: "user", content: "hi" }], ...o,
});

function wire() {
  const transport = new MockTransport();
  const sessions = new InMemoryClientSession();
  const chat = new ChatService(transport, sessions);
  const pending: AgentMessage[] = [];
  const diag: { m: AgentMessage; reason: string }[] = [];
  const pendingSink: PendingRouteSink = { pending: (m) => pending.push(m) };
  const diagnosticSink: DiagnosticSink = { diagnose: (m, reason) => diag.push({ m, reason }) };
  const router = new MessageRouter({ transport, chat, sessions, pending: pendingSink, diagnostic: diagnosticSink });
  router.start();
  return { transport, sessions, chat, router, pending, diag };
}

describe("domain 순수 규칙 (UC1 ChatTurn)", () => {
  it("정상 경로: streaming → finish(terminal)", () => {
    expect(nextTurnState("streaming", { type: "chunk", chunk: { kind: "text", text: "a" } })).toBe("streaming");
    expect(nextTurnState("streaming", { type: "chunk", chunk: { kind: "finish" } })).toBe("finished");
    expect(nextTurnState("streaming", { type: "chunk", chunk: { kind: "error", message: "e" } })).toBe("errored");
    expect(isTerminalState("finished")).toBe(true);
    expect(isTerminalState("errored")).toBe(true);
  });
  it("취소 경로: streaming → cancelling(비종결) → finish(terminal)", () => {
    const s = nextTurnState("streaming", { type: "cancelRequested" });
    expect(s).toBe("cancelling");
    expect(isTerminalState(s)).toBe(false); // cancel 은 비종결
    expect(nextTurnState(s, { type: "chunk", chunk: { kind: "finish" } })).toBe("finished");
  });
  it("terminal 후 불변", () => {
    expect(nextTurnState("finished", { type: "chunk", chunk: { kind: "text", text: "x" } })).toBe("finished");
    expect(nextTurnState("errored", { type: "cancelRequested" })).toBe("errored");
  });
  it("isTerminalChunk: finish/error 만", () => {
    expect(isTerminalChunk({ kind: "finish" })).toBe(true);
    expect(isTerminalChunk({ kind: "error", message: "e" })).toBe(true);
    expect(isTerminalChunk({ kind: "text", text: "a" })).toBe(false);
  });
});

describe("adapter 변환 (domain↔protocol↔wire, canon)", () => {
  it("chat_request: provider verbatim passthrough, secret 키 미포함", () => {
    const out = toAgentOutbound(req());
    expect(out.type).toBe("chat_request");
    const o = out as Record<string, unknown>;
    expect((o["provider"] as Record<string, unknown>)["ollamaNumCtx"]).toBe(8192); // 동작필드 보존
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("apiKey");
    expect(flat).not.toContain("naiaKey");
  });
  it("cancel/approval/creds 매핑 + creds 만 secret 운반", () => {
    expect(toAgentOutbound({ kind: "cancel", requestId: "r1", clientId: "c1" }))
      .toEqual({ type: "cancel_stream", requestId: "r1" });
    expect(toAgentOutbound({ kind: "approvalResponse", requestId: "r1", clientId: "c1", toolCallId: "t", decision: "approve" }))
      .toEqual({ type: "approval_response", requestId: "r1", toolCallId: "t", decision: "approve" });
    const creds = toAgentOutbound({ kind: "credsUpdate", provider: "openai", secret: { apiKey: "sk-x" } }) as Record<string, unknown>;
    expect(creds["type"]).toBe("creds_update");
    expect(creds["apiKey"]).toBe("sk-x"); // secret 은 creds 채널로만
  });
  it("encode=flat newline JSON / decode 왕복 + 미지=Unknown", () => {
    const line = encodeWire(toAgentOutbound(req()));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.includes("\n")).toBe(true);
    expect(decodeAgentMessage('{"type":"text","requestId":"r1","text":"hi"}').type).toBe("text");
    expect(decodeAgentMessage("not json").type).toBe("__malformed__");
    expect(decodeAgentMessage('{"text":"no type"}').type).toBe("__malformed__");
  });
});

describe("ChatService + MessageRouter 계약", () => {
  it("startTurn: domain send + ownership 등록, router demux → deliverChunk 라우팅", async () => {
    const { transport, sessions, chat } = wire();
    const got: ChatChunk[] = [];
    const { handle, sent } = chat.startTurn(req(), (c) => got.push(c));
    await sent;
    expect(transport.sent[0]?.kind).toBe("chat"); // domain 그대로(변환은 adapter)
    expect(sessions.ownerOf("r1")).toBe("c1");
    transport.emit({ type: "text", requestId: "r1", text: "안녕" });
    transport.emit({ type: "finish", requestId: "r1" });
    expect(got.map((c) => c.kind)).toEqual(["text", "finish"]);
    expect(handle.requestId).toBe("r1");
  });
  it("finish = terminal → ownership 해제", async () => {
    const { transport, sessions, chat } = wire();
    const { sent } = chat.startTurn(req(), () => {});
    await sent;
    transport.emit({ type: "finish", requestId: "r1" });
    expect(sessions.ownerOf("r1")).toBeUndefined(); // 해제
    expect(chat.turnState("r1")).toBeUndefined();
  });
  it("error = terminal → ownership 해제", async () => {
    const { transport, sessions, chat } = wire();
    const { sent } = chat.startTurn(req(), () => {});
    await sent;
    transport.emit({ type: "error", requestId: "r1", message: "boom" });
    expect(sessions.ownerOf("r1")).toBeUndefined();
  });
  it("ownership 충돌: 중복 requestId 등록 거부(throw)", async () => {
    const { chat } = wire();
    const { sent } = chat.startTurn(req(), () => {});
    await sent;
    expect(() => chat.startTurn(req(), () => {})).toThrow(/충돌/);
  });
  it("초기 send reject → error chunk + ownership 해제 + sent reject 전파", async () => {
    const { transport, sessions, chat } = wire();
    transport.failNext = true;
    const got: ChatChunk[] = [];
    const { sent } = chat.startTurn(req(), (c) => got.push(c));
    await expect(sent).rejects.toThrow("transport down");
    expect(got.some((c) => c.kind === "error")).toBe(true);
    expect(sessions.ownerOf("r1")).toBeUndefined(); // 초기 send reject = 안전 해제
  });
  it("cancel: 권한 인가 + cancel_stream 송신 + cancelling(비종결, 해제 안 함)", async () => {
    const { transport, sessions, chat } = wire();
    const { handle, sent } = chat.startTurn(req(), () => {});
    await sent;
    await chat.cancel(handle);
    expect(transport.sent.some((o) => o.kind === "cancel")).toBe(true);
    expect(chat.turnState("r1")).toBe("cancelling"); // 비종결
    expect(sessions.ownerOf("r1")).toBe("c1"); // cancel 로는 해제 안 함
    // 뒤따르는 finish 가 해제
    transport.emit({ type: "finish", requestId: "r1" });
    expect(sessions.ownerOf("r1")).toBeUndefined();
  });
  it("cancel 권한: 타 client 차단(살아있는 turn)", async () => {
    const { chat } = wire();
    const { handle, sent } = chat.startTurn(req(), () => {});
    await sent;
    await expect(chat.cancel({ ...handle, clientId: "other" })).rejects.toThrow(/권한/);
  });
  it("완료된 turn cancel = 양성 no-op(권한오류 throw 안 함, 코드리뷰5 HIGH)", async () => {
    const { transport, chat } = wire();
    const { handle, sent } = chat.startTurn(req(), () => {});
    await sent;
    transport.emit({ type: "finish", requestId: "r1" }); // 종료+release
    const before = transport.sent.length;
    await expect(chat.cancel(handle)).resolves.toBeUndefined(); // throw 아님
    expect(transport.sent.length).toBe(before); // cancel_stream 미전송
  });
});

describe("exhaustive demux (router)", () => {
  it("비-chat known(미배선) → PendingRouteSink", () => {
    const { transport, pending } = wire();
    transport.emit({ type: "panel_control", requestId: "x" });
    transport.emit({ type: "skill_list_response" });
    transport.emit({ type: "audio", requestId: "x" });
    expect(pending.map((m) => m.type)).toEqual(["panel_control", "skill_list_response", "audio"]);
  });
  it("Unknown variant → DiagnosticSink(silent drop 금지)", () => {
    const { transport, diag } = wire();
    transport.emit({ type: "discord_message", raw: {} });
    expect(diag.some((d) => d.reason.includes("unknown variant"))).toBe(true);
  });
  it("chat-turn without requestId → DiagnosticSink", () => {
    const { transport, diag } = wire();
    transport.emit({ type: "text", text: "no rid" });
    expect(diag.some((d) => d.reason.includes("without requestId"))).toBe(true);
  });
  it("소유주 없는 requestId(종료/미지) → DiagnosticSink(소유권 충돌 회피)", () => {
    const { transport, diag } = wire();
    transport.emit({ type: "text", requestId: "ghost", text: "x" });
    expect(diag.some((d) => d.reason.includes("no owner"))).toBe(true);
  });
  it("malformed chat-turn(필수필드 누락) → DiagnosticSink(정상 chunk 위장 금지, codex MED⑤)", () => {
    const { transport, sessions, chat, diag } = wire();
    const got: ChatChunk[] = [];
    const { sent } = chat.startTurn(req(), (c) => got.push(c));
    void sent;
    void sessions;
    transport.emit({ type: "text", requestId: "r1" }); // text 필드 없음 = 손상
    expect(got.length).toBe(0); // 위장 전달 안 됨
    expect(diag.some((d) => d.reason.includes("malformed"))).toBe(true);
  });
});

describe("런타임 누수/예외 격리 (codex 코드리뷰 HIGH)", () => {
  it("unsubscribe → ownership 까지 해제(누수 방지, HIGH②)", async () => {
    const { sessions, chat } = wire();
    const { handle, sent } = chat.startTurn(req(), () => {});
    await sent;
    expect(sessions.ownerOf("r1")).toBe("c1");
    handle.unsubscribe();
    expect(sessions.ownerOf("r1")).toBeUndefined(); // ownership 해제됨
    expect(chat.turnState("r1")).toBeUndefined();
  });
  it("onChunk 예외가 상태전이·해제·라우팅을 깨지 않음(HIGH③)", async () => {
    const { transport, sessions, chat } = wire();
    const { sent } = chat.startTurn(req(), () => { throw new Error("render boom"); });
    await sent;
    // 예외 콜백이어도 router.route 가 throw 하지 않아야(전파 차단)
    expect(() => transport.emit({ type: "text", requestId: "r1", text: "x" })).not.toThrow();
    // finish = terminal → 예외와 무관하게 해제 보장
    expect(() => transport.emit({ type: "finish", requestId: "r1" })).not.toThrow();
    expect(sessions.ownerOf("r1")).toBeUndefined();
  });
  it("send 동기 throw → catch cleanup(turn/ownership 누수 없음, 코드리뷰4 HIGH)", async () => {
    const transport = new MockTransport();
    // send 가 동기 throw 하도록 패치
    transport.send = () => { throw new Error("sync send fail"); };
    const sessions = new InMemoryClientSession();
    const chat = new ChatService(transport, sessions);
    const { sent } = chat.startTurn(req(), () => {});
    await expect(sent).rejects.toThrow("sync send fail");
    expect(sessions.ownerOf("r1")).toBeUndefined(); // 동기 throw 여도 해제됨
    expect(chat.turnState("r1")).toBeUndefined();
  });
  it("deliverChunk: owner.clientId 불일치 = 거부(타 client turn 보호, 코드리뷰4 HIGH)", async () => {
    const { sessions, chat } = wire();
    const got: ChatChunk[] = [];
    const { sent } = chat.startTurn(req(), (c) => got.push(c));
    await sent;
    // 잘못된 clientId 로 직접 deliver 시도
    chat.deliverChunk({ kind: "finish" }, { requestId: "r1", clientId: "WRONG" });
    expect(got.length).toBe(0); // 전달 안 됨
    expect(sessions.ownerOf("r1")).toBe("c1"); // 종결/해제 안 됨
    expect(chat.turnState("r1")).toBe("streaming");
  });
  it("재진입 cancel: finish 콜백 내 cancel(handle) = terminal no-op(불필요 cancel_stream 전송 안 함, 코드리뷰4 MED)", async () => {
    const { transport, chat } = wire();
    let h: { requestId: string; clientId: string } | null = null;
    const r = chat.startTurn(req(), (c) => {
      // 상태전이 먼저(MED) → 콜백이 finished 상태 관측 → reentrant cancel 은 no-op
      if (c.kind === "finish" && h) void chat.cancel(h as never);
    });
    h = r.handle;
    await r.sent;
    const before = transport.sent.length;
    transport.emit({ type: "finish", requestId: "r1" }); // finish 콜백 안에서 cancel 시도
    expect(transport.sent.length).toBe(before); // cancel_stream 미전송(terminal no-op)
  });
  it("재진입 ABA: terminal chunk 콜백이 unsubscribe+동일 id 재등록 → 옛 turn 의 무조건 release 가 새 turn 삭제 안 함(코드리뷰2 HIGH)", async () => {
    const { transport, sessions, chat } = wire();
    let h1: { unsubscribe: () => void } | null = null;
    let reentered = false;
    const r1 = chat.startTurn(req(), () => {
      // 옛 turn 의 finish 콜백 *안에서* unsubscribe + 동일 requestId 로 새 turn 재등록(재진입).
      if (reentered) return;
      reentered = true;
      h1?.unsubscribe();
      chat.startTurn(req(), () => {}); // 새 turn (requestId r1, clientId c1)
    });
    h1 = r1.handle;
    await r1.sent;
    // 옛 turn 기준 terminal(finish) → safeOnChunk 재진입 후, 가드 없으면 releaseTurn(r1) 이 *새* turn 을 삭제.
    transport.emit({ type: "finish", requestId: "r1" });
    // 가드 덕에 새 turn 의 ownership·상태가 살아있어야 함.
    expect(sessions.ownerOf("r1")).toBe("c1");
    expect(chat.turnState("r1")).toBe("streaming"); // 새 turn 은 아직 진행(옛 finish 가 종료시키면 안 됨)
  });
});
