// F3 실배선 mutate 어댑터 parity 테스트 (drift-gate, P02). 고위험 mutating — op별 old 명령 라우팅 검증.
import { describe, it, expect } from "vitest";
import { makeF3LiveMutate, type F3LiveDeps } from "../main/adapters/tauri/f3.js";
import type { MutationCommand } from "../main/ports/f3.js";

function makeDeps(over: { exec?: { success: boolean; output: string; exit_code: number }; reject?: string } = {}): {
  deps: F3LiveDeps; calls: Array<{ cmd: string; args?: Record<string, unknown> }>;
} {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const deps: F3LiveDeps = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (over.reject) throw over.reject;
      if (cmd === "pty_execute_sync") return over.exec ?? { success: true, output: "ok", exit_code: 0 };
      return undefined;
    },
  };
  return { deps, calls };
}

describe("F3 live mutate — op별 old 명령 parity", () => {
  it("writeFile → workspace_write_file{path,content}, Ack accepted", async () => {
    const { deps, calls } = makeDeps();
    const ack = await makeF3LiveMutate(deps).apply({ op: "writeFile", target: "/ws/f.ts", body: "code" } as MutationCommand);
    expect(calls).toEqual([{ cmd: "workspace_write_file", args: { path: "/ws/f.ts", content: "code" } }]);
    expect(ack).toEqual({ accepted: true });
  });

  it("writeFile 실패(경계 밖 등) → throw 전파(MutationGate 가 abort)", async () => {
    const { deps } = makeDeps({ reject: "Access denied: path is outside workspace root" });
    await expect(makeF3LiveMutate(deps).apply({ op: "writeFile", target: "/etc/x", body: "y" } as MutationCommand)).rejects.toBeTruthy();
  });

  it("★ execCommand → 보안 fail-closed throw(arbitrary bash 우회가능 blocklist 라이브 금지, B-1), invoke 안 함", async () => {
    const { deps, calls } = makeDeps();
    await expect(makeF3LiveMutate(deps).apply({ op: "execCommand", target: "rm -rf /*", body: "/ws" } as MutationCommand)).rejects.toThrow(/fail-closed|보안/);
    expect(calls).toEqual([]); // pty_execute_sync 호출 안 함(신규 보안계약 전까지)
  });

  it("★ ptyWrite → pty_write{pty_id,data} (snake — Tauri 미변환, old 정합)", async () => {
    const { deps, calls } = makeDeps();
    await makeF3LiveMutate(deps).apply({ op: "ptyWrite", target: "pty-7", body: "ls\n" } as MutationCommand);
    expect(calls).toEqual([{ cmd: "pty_write", args: { pty_id: "pty-7", data: "ls\n" } }]);
  });

  it("★ applyDiff → os 명령 없음(agent-side tool) 정직 거부(throw), invoke 안 함", async () => {
    const { deps, calls } = makeDeps();
    await expect(makeF3LiveMutate(deps).apply({ op: "applyDiff", target: "/ws/f", body: "@@diff@@" } as MutationCommand)).rejects.toThrow(/agent-side/);
    expect(calls).toEqual([]); // os mutate 명령 호출 안 함
  });
});
