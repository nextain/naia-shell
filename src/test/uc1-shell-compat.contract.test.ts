// UC1 shell-compat 계약 테스트 (Option B B1 seam) — old shell sendChatMessage drop-in, mock Tauri.
import { describe, it, expect } from "vitest";
import { makeShellChatService, chatChunkToWire } from "../main/adapters/shell-compat.js";
import type { LiveTransportDeps } from "../main/adapters/tauri/uc1.js";

function mockTauri() {
  const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
  let listener: ((p: unknown) => void) | null = null;
  const live: LiveTransportDeps = {
    async invoke(cmd, args) { invokes.push({ cmd, args }); return undefined; },
    async listen(_e, cb) { listener = cb; return () => { listener = null; }; },
  };
  return { live, invokes, emit: (l: string) => listener?.(l) };
}

describe("chatChunkToWire (domain→wire 역매핑)", () => {
  it("kind→type(snake), requestId 결속", () => {
    expect(chatChunkToWire("r1", { kind: "text", text: "hi" })).toEqual({ type: "text", requestId: "r1", text: "hi" });
    expect(chatChunkToWire("r1", { kind: "toolUse", toolCallId: "t", name: "n", args: {} })).toEqual({ type: "tool_use", requestId: "r1", toolCallId: "t", toolName: "n", args: {} });
    expect(chatChunkToWire("r1", { kind: "finish" })).toEqual({ type: "finish", requestId: "r1" });
    expect(chatChunkToWire("r1", { kind: "error", message: "e" })).toEqual({ type: "error", requestId: "r1", message: "e" });
  });
});

describe("makeShellChatService (drop-in seam)", () => {
  it("sendChatMessage: secret strip + send_to_agent_command + onChunk 가 wire 받음", async () => {
    const { live, invokes, emit } = mockTauri();
    const svc = makeShellChatService({ live, clientId: "shell" });
    svc.start();
    const got: Record<string, unknown>[] = [];
    const { sent } = svc.sendChatMessage({
      message: "안녕", provider: { provider: "ollama", model: "gemma4", apiKey: "sk-secret" },
      history: [], onChunk: (c) => got.push(c), requestId: "r1", enableThinking: true,
    });
    await sent; await Promise.resolve();
    // 송신: send_to_agent_command, secret 미포함, enableThinking top-level
    const msg = JSON.parse(invokes[0]!.args["message"] as string);
    expect(invokes[0]!.cmd).toBe("send_to_agent_command");
    expect(JSON.stringify(msg)).not.toContain("sk-secret");
    expect(msg.enableThinking).toBe(true);
    expect("clientId" in msg).toBe(false); // wire 미포함
    // 수신: agent_response → onChunk 가 wire AgentResponseChunk 받음
    emit('{"type":"text","requestId":"r1","text":"응답"}');
    emit('{"type":"finish","requestId":"r1"}');
    expect(got.map((c) => c["type"])).toEqual(["text", "finish"]);
    expect(got[0]).toEqual({ type: "text", requestId: "r1", text: "응답" });
  });
  it("cancelChat: cancel_stream 송신", async () => {
    const { live, invokes } = mockTauri();
    const svc = makeShellChatService({ live });
    svc.start();
    const { handle, sent } = svc.sendChatMessage({ message: "x", provider: { provider: "o", model: "m" }, history: [], onChunk: () => {}, requestId: "r1" });
    await sent;
    await svc.cancelChat(handle);
    expect(invokes.some((i) => i.cmd === "cancel_stream" && i.args["requestId"] === "r1")).toBe(true);
  });
});
