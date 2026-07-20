// UC1 리뷰 fix lock: chatChunkToWire 가 live ChatPanel 이 읽는 필드를 보존하는지(유실=undefined 버그).
import { describe, it, expect } from "vitest";
import { chatChunkToWire } from "../main/adapters/shell-compat.js";

describe("UC1 chunk 필드 보존 (2-AI 리뷰 HIGH fix)", () => {
  it("★ toolResult: toolName+success 보존 (live ChatPanel chunk.success 읽음 — 유실 시 undefined)", () => {
    const w = chatChunkToWire("r1", { kind: "toolResult", toolCallId: "t", toolName: "write_file", output: "ok", success: false });
    expect(w).toMatchObject({ type: "tool_result", requestId: "r1", toolCallId: "t", toolName: "write_file", output: "ok", success: false });
  });

  it("★ approvalRequest: args+description 보존 (승인 다이얼로그 인자 표시 — blind approval 방지, 보안)", () => {
    const w = chatChunkToWire("r1", {
      kind: "approvalRequest", toolCallId: "t", toolName: "execute_command", tier: "T2",
      args: { command: "rm x" }, description: "파일 삭제",
    });
    expect(w).toMatchObject({ type: "approval_request", toolName: "execute_command", tier: "T2", args: { command: "rm x" }, description: "파일 삭제" });
  });

  it("UC-WIRE-V1 구조화 결과와 오류 코드를 wire 형상으로 보존한다", () => {
    expect(chatChunkToWire("r1", {
      kind: "grounding", status: "grounded",
      sources: [{ title: "수업 안내", sourceUris: ["kb://workshop"] }],
    })).toMatchObject({ type: "grounding", status: "grounded" });
    expect(chatChunkToWire("r1", {
      kind: "artifact",
      artifact: { id: "a1", kind: "image", mimeType: "image/png", sizeBytes: 2, localRef: "img_1" },
    })).toMatchObject({ type: "artifact", artifact: { localRef: "img_1" } });
    expect(chatChunkToWire("r1", {
      kind: "error", message: "invalid", code: "ATTACHMENT_INVALID_REF",
    })).toMatchObject({ type: "error", code: "ATTACHMENT_INVALID_REF" });
    expect(chatChunkToWire("r1", {
      kind: "processingDisclosure", workload: "embedding", destination: "external_cloud",
      decision: "allowed", processingProfileRef: "profile-local-cloud-001",
      provider: "openai", model: "text-embedding-3-small",
    })).toEqual({
      type: "processing_disclosure", requestId: "r1", workload: "embedding",
      destination: "external_cloud", decision: "allowed",
      processingProfileRef: "profile-local-cloud-001",
      provider: "openai", model: "text-embedding-3-small",
    });
  });
});
