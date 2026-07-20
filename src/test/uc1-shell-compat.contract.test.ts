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
    const got: Record<string, unknown>[] = [];
    await svc.sendChatMessage({
      message: "안녕", provider: { provider: "ollama", model: "gemma4", apiKey: "sk-secret" },
      history: [], onChunk: (c) => got.push(c), requestId: "r1", enableThinking: true,
    });
    await Promise.resolve();
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
    await svc.sendChatMessage({ message: "x", provider: { provider: "o", model: "m" }, history: [], onChunk: () => {}, requestId: "r1" });
    await svc.cancelChat("r1");
    expect(invokes.some((i) => i.cmd === "cancel_stream" && i.args["requestId"] === "r1")).toBe(true);
  });
  it("UC-WIRE-V1 실제 shell seam이 attachment/channel/grounding/provider session을 보존", async () => {
    const { live, invokes } = mockTauri();
    const svc = makeShellChatService({ live });
    await svc.sendChatMessage({
      message: "화면 설명", provider: { provider: "codex", model: "main" },
      history: [], onChunk: () => {}, requestId: "wire-r1", sessionId: "s1",
      attachments: [{ id: "a1", kind: "image", mimeType: "image/png", sizeBytes: 10, localRef: "img_1" }],
      channel: { kind: "shell" },
      grounding: { policy: "required", knowledgeScope: "workshop" },
      providerSession: { mode: "resume", providerSessionRef: "opaque-ref" },
      processing: { processingProfileRef: "profile-local-cloud-001" },
    });
    const msg = JSON.parse(invokes[0]!.args["message"] as string);
    expect(msg.messages[0].attachments[0].localRef).toBe("img_1");
    expect(msg.channel).toEqual({ kind: "shell" });
    expect(msg.grounding).toEqual({ policy: "required", knowledgeScope: "workshop" });
    expect(msg.providerSession).toEqual({ mode: "resume", providerSessionRef: "opaque-ref" });
    expect(msg.processing).toEqual({ processingProfileRef: "profile-local-cloud-001" });
  });
  it("UC-WIRE-V1 processing disclosure를 public onChunk wire 형상으로 보존", async () => {
    const { live, emit } = mockTauri();
    const svc = makeShellChatService({ live });
    const got: Record<string, unknown>[] = [];
    await svc.sendChatMessage({
      message: "x", provider: { provider: "o", model: "m" }, history: [],
      onChunk: (chunk) => got.push(chunk), requestId: "processing-r1",
    });
    await Promise.resolve();
    emit(JSON.stringify({
      type: "processing_disclosure", requestId: "processing-r1",
      workload: "embedding", destination: "external_cloud", decision: "allowed",
      processingProfileRef: "profile-local-cloud-001",
      provider: "openai", model: "text-embedding-3-small",
    }));
    expect(got).toEqual([{
      type: "processing_disclosure", requestId: "processing-r1",
      workload: "embedding", destination: "external_cloud", decision: "allowed",
      processingProfileRef: "profile-local-cloud-001",
      provider: "openai", model: "text-embedding-3-small",
    }]);
  });
  it("sendCredsUpdate: creds_update wire(secret 채널)", async () => {
    const { live, invokes } = mockTauri();
    const svc = makeShellChatService({ live });
    await svc.sendCredsUpdate({ provider: "openai", apiKey: "sk-x" });
    const msg = JSON.parse(invokes[0]!.args["message"] as string);
    expect(msg.type).toBe("creds_update"); expect(msg.apiKey).toBe("sk-x");
  });
});
