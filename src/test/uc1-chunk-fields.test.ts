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
});
