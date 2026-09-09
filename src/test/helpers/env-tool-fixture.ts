// #499·#582 계약 테스트용 대역 포트. 결정론 — 실제 브라우저도 프로세스도 쓰지 않는다.
import type {
  BrowserOperationPort,
  BrowserWorkspacePort,
  CancellationPort,
  TerminalOperationPort,
} from "../../main/ports/env-tool.js";
import type { BrowserEvidence, BrowserWorkspace, EnvOperationRequest, TerminalEvidence } from "../../main/domain/env-tool.js";
import { createHeadlessWorkspace } from "../../main/domain/env-tool.js";

export const BROWSER_EVIDENCE: BrowserEvidence = {
  snapshotRef: "snap:1",
  screenshotRef: "shot:1",
  url: "https://example.test/a",
  urlRevision: 1,
};
export const TERMINAL_EVIDENCE: TerminalEvidence = { exitCode: 0, outputRef: "out:1", artifactRefs: ["artifact:1"] };

export interface FakeBrowser extends BrowserOperationPort {
  readonly calls: string[];
  /** 포트가 받은 중단 신호. 취소·상한이 실제로 내려갔는지 여기서 본다. */
  readonly signals: (AbortSignal | undefined)[];
}

export function fakeBrowser(evidence: Partial<BrowserEvidence> = {}): FakeBrowser {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const value = { ...BROWSER_EVIDENCE, ...evidence };
  const note = (name: string, signal?: AbortSignal) => {
    calls.push(name);
    signals.push(signal);
  };
  return {
    calls,
    signals,
    async open(_request, _url, signal) {
      note("open", signal);
      return value;
    },
    async navigate(_request, _url, signal) {
      note("navigate", signal);
      return value;
    },
    async snapshot(_request, signal) {
      note("snapshot", signal);
      return value;
    },
    async click(_request, _target, signal) {
      note("click", signal);
      return value;
    },
    async fill(_request, _target, _value, signal) {
      note("fill", signal);
      return value;
    },
    async evaluate(_request, script, signal) {
      note("evaluate", signal);
      return { evidence: value, result: `평가됨:${script.expression}` };
    },
    async screenshot(_request, signal) {
      note("screenshot", signal);
      return value;
    },
    async close(_request, signal) {
      note("close", signal);
    },
  };
}

export interface FakeWorkspaces extends BrowserWorkspacePort {
  readonly calls: string[];
  readonly created: BrowserWorkspace[];
}

/** 작업 공간 대역. 공간은 작업과 수명이 다르므로 목록이 실행 사이에 남는다 (#582 4.4). */
export function fakeWorkspaces(): FakeWorkspaces {
  const calls: string[] = [];
  const created: BrowserWorkspace[] = [];
  return {
    calls,
    created,
    async create() {
      calls.push("create");
      const workspace = createHeadlessWorkspace(`ws-${created.length + 1}`);
      created.push(workspace);
      return workspace;
    },
    async list() {
      calls.push("list");
      return [...created];
    },
    async close(_request, workspaceId) {
      calls.push(`close:${workspaceId}`);
      const at = created.findIndex((w) => w.id === workspaceId);
      if (at >= 0) created.splice(at, 1);
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
