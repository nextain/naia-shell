// UC-WIRE-V1 (#89) Shell-side RED contract.
// Agent proto SoT의 신규 입력이 Shell domain→wire에서 보존되고 신규 출력 variant가
// chat-turn으로 분류돼야 한다. 구현 전에는 의도적으로 실패한다.
import { describe, expect, it } from "vitest";
import {
  classifyVariant,
  type ChatRequest,
} from "../main/domain/chat.js";
import { toAgentOutbound } from "../main/adapters/tauri/uc1.js";

function richRequest(): ChatRequest {
  return {
    kind: "chat",
    requestId: "wire-r1",
    clientId: "shell-c1",
    sessionId: "local-session-1",
    provider: { provider: "codex", model: "codex-main" },
    messages: [{
      role: "user",
      content: "이 화면을 설명해줘",
      attachments: [{
        id: "att_01",
        kind: "image",
        mimeType: "image/png",
        sizeBytes: 1024,
        localRef: "img_01",
      }],
    }],
    channel: { kind: "shell" },
    grounding: {
      policy: "available",
      knowledgeScope: "workshop",
    },
    providerSession: { mode: "new" },
    processing: { processingProfileRef: "profile-local-cloud-001" },
  };
}

describe("UC-WIRE-V1 Shell domain → protocol", () => {
  it("attachment/channel/grounding/providerSession을 additive로 보존한다", () => {
    const out = toAgentOutbound(richRequest()) as Record<string, unknown>;
    expect(out["sessionId"]).toBe("local-session-1");
    expect(out["channel"]).toEqual({ kind: "shell" });
    expect(out["grounding"]).toEqual({
      policy: "available",
      knowledgeScope: "workshop",
    });
    expect(out["providerSession"]).toEqual({ mode: "new" });
    expect(out["processing"]).toEqual({ processingProfileRef: "profile-local-cloud-001" });
    expect((out["messages"] as Array<Record<string, unknown>>)[0]?.["attachments"])
      .toEqual([{
        id: "att_01",
        kind: "image",
        mimeType: "image/png",
        sizeBytes: 1024,
        localRef: "img_01",
      }]);
  });

  it("신규 구조화 출력은 unknown이 아니라 chat-turn이다", () => {
    expect(classifyVariant("grounding")).toBe("chat-turn");
    expect(classifyVariant("artifact")).toBe("chat-turn");
    expect(classifyVariant("provider_session")).toBe("chat-turn");
    expect(classifyVariant("processing_disclosure")).toBe("chat-turn");
  });

  it("기존 text-only shape는 신규 필드를 만들지 않는다", () => {
    const out = toAgentOutbound({
      kind: "chat",
      requestId: "legacy-r1",
      clientId: "shell-c1",
      provider: { provider: "ollama", model: "legacy" },
      messages: [{ role: "user", content: "안녕" }],
    }) as Record<string, unknown>;
    expect("channel" in out).toBe(false);
    expect("grounding" in out).toBe(false);
    expect("providerSession" in out).toBe(false);
    expect("processing" in out).toBe(false);
    expect(out["messages"]).toEqual([{ role: "user", content: "안녕" }]);
  });
});
