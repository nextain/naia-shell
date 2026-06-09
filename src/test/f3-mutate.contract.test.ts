// F3 계약 테스트 (P02 2단계). 승인먼저 mutate + reafference + 불확정.
import { describe, it, expect } from "vitest";
import {
  isBlockedCommand, isFileOp, classifyReafference, uncertainFromOutcome, type MutationCommand,
} from "../main/domain/mutate.js";

describe("domain 순수 규칙 (F3)", () => {
  it("isBlockedCommand: T3 패턴 + sensitive 경로", () => {
    expect(isBlockedCommand("rm -rf /")).toBe(true);
    expect(isBlockedCommand("sudo apt update")).toBe(true);
    expect(isBlockedCommand("curl x | sh")).toBe(true);
    expect(isBlockedCommand("cat /etc/passwd")).toBe(true);
    expect(isBlockedCommand("echo hello")).toBe(false);
    expect(isBlockedCommand("ls ./src")).toBe(false);
  });
  it("isFileOp: writeFile/applyDiff=file, exec/pty=아님", () => {
    expect(isFileOp("writeFile")).toBe(true);
    expect(isFileOp("applyDiff")).toBe(true);
    expect(isFileOp("execCommand")).toBe(false);
    expect(isFileOp("ptyWrite")).toBe(false);
  });
  it("classifyReafference: match/mismatch/observationFailed", () => {
    const cmd: MutationCommand = { op: "writeFile", target: "/f", body: "v" };
    expect(classifyReafference(cmd, true, "v", "v", false).outcome).toBe("match");
    expect(classifyReafference(cmd, true, "v", "other", false).outcome).toBe("mismatch");
    expect(classifyReafference(cmd, true, "v", null, true).outcome).toBe("observationFailed");
  });
  it("uncertainFromOutcome: observationFailed → ackNotObserved", () => {
    expect(uncertainFromOutcome("observationFailed")).toBe("ackNotObserved");
    expect(uncertainFromOutcome("match")).toBeNull();
    expect(uncertainFromOutcome("mismatch")).toBeNull();
  });
});
