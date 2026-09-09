// #499 계약 테스트용 대역 포트. 결정론 — 실제 브라우저도 프로세스도 쓰지 않는다.
import type { BrowserOperationPort, CancellationPort, TerminalOperationPort } from "../../main/ports/env-tool.js";
import type { BrowserEvidence, EnvOperationRequest, TerminalEvidence } from "../../main/domain/env-tool.js";

export const BROWSER_EVIDENCE: BrowserEvidence = {
  snapshotRef: "snap:1",
  screenshotRef: "shot:1",
  url: "https://example.test/a",
  urlRevision: 1,
};
export const TERMINAL_EVIDENCE: TerminalEvidence = { exitCode: 0, outputRef: "out:1", artifactRefs: ["artifact:1"] };

export interface FakeBrowser extends BrowserOperationPort {
  readonly calls: string[];
}

export function fakeBrowser(evidence: Partial<BrowserEvidence> = {}): FakeBrowser {
  const calls: string[] = [];
  const value = { ...BROWSER_EVIDENCE, ...evidence };
  return {
    calls,
    async open() {
      calls.push("open");
      return value;
    },
    async snapshot() {
      calls.push("snapshot");
      return value;
    },
    async click() {
      calls.push("click");
      return value;
    },
    async fill() {
      calls.push("fill");
      return value;
    },
    async close() {
      calls.push("close");
    },
  };
}

export interface FakeTerminal extends TerminalOperationPort {
  readonly execs: { terminalId: string; executable: string; args: readonly string[]; cwd: string }[];
}

export function fakeTerminal(evidence: Partial<TerminalEvidence> = {}): FakeTerminal {
  const execs: FakeTerminal["execs"] = [];
  return {
    execs,
    async exec(_request, terminalId, command) {
      execs.push({ terminalId, executable: command.executable, args: command.args, cwd: command.cwd });
      return { ...TERMINAL_EVIDENCE, ...evidence };
    },
  };
}

export function fakeCancellation(partial: readonly string[] = ["파일 3개 기록됨"]): CancellationPort {
  return {
    async cancel() {
      return partial;
    },
  };
}

export function envRequest(over: Partial<EnvOperationRequest> = {}): EnvOperationRequest {
  return { operationId: "op1", idempotencyKey: "k1", capability: "observe", timeoutMs: 5_000, workspaceId: "ws-1", ...over };
}
