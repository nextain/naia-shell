// 통합 테스트 (P02 3단계). 인지흐름 관통: 승인(F1)→host-system mutate(F3)→observed(F2)→reafference.
// + negative path(blocked·denied·drift) + 불확정(observationFailed/mismatch) + contamination 격리.
import { describe, it, expect } from "vitest";
import { ApprovalGate, type GateInput } from "../main/app/control/approval.js";
import { MutationGate } from "../main/app/control/mutate.js";
import type { ActionScope, ContextIdentity, ApprovalDecision, Tier } from "../main/domain/approval.js";
import type { MutationCommand, Ack } from "../main/domain/mutate.js";
import type { ApprovalPort, PersistentGrantPort } from "../main/ports/f1.js";
import type { EnvironmentMutatePort } from "../main/ports/f3.js";
import type { EnvironmentObservePort, FileChangeEvent } from "../main/ports/f2.js";
import type { ObservedState } from "../main/domain/observe.js";

const ident: ContextIdentity = { sessionId: "s1", canonicalRoot: "/w", activeSurface: "panel", configVersion: "v1", clientId: "c1" };
// ⚠️ 승인 scope 는 *실제 cmd* 에 결속돼야 함(UC13 fix): op 는 MutateOp 어휘(writeFile), target/body=cmd 일치.
const scope = (o: Partial<ActionScope> = {}): ActionScope => ({ target: "/w/f", op: "writeFile", body: "v", env: "host", ...o });
const gi = (o: Partial<GateInput> = {}): GateInput => ({
  tool: "write_file", args: {}, toolCallId: "tc1", sessionId: "s1", context: ident, scope: scope(), correlationId: "c", ...o,
});

// ── in-memory adapters (인지흐름 전체 배선) ──
function rig(over: {
  tier?: Tier; decision?: ApprovalDecision;
  mutateThrows?: boolean; observeThrows?: boolean; observedValue?: string | null; ackOutput?: string;
} = {}) {
  const log: string[] = [];
  const approval: ApprovalPort = {
    classify: async () => over.tier ?? "T1",
    request: async () => over.decision ?? "once",
  };
  const grant: PersistentGrantPort = { isAllowed: async () => false, add: async () => {} };
  const approvalGate = new ApprovalGate({ approval, grant });
  const mutate: EnvironmentMutatePort = {
    apply: async (cmd: MutationCommand): Promise<Ack> => {
      log.push(`mutate:${cmd.op}`);
      if (over.mutateThrows) throw new Error("mutate boom");
      return { accepted: true, exit: 0, output: over.ackOutput };
    },
  };
  const observe: EnvironmentObservePort = {
    fileStatus: async (p): Promise<ObservedState> => { log.push("observe"); if (over.observeThrows) throw new Error("observe boom"); return { key: p, value: over.observedValue ?? null }; },
    listDir: async () => [],
    readFile: async () => "",
    sessions: async () => [], processStatus: async () => [], worktrees: async () => [],
    subscribeChanges: (_cb: (e: FileChangeEvent) => void) => () => {},
  };
  return { gate: new MutationGate({ approvalGate, mutate, observe }), log };
}

const cmd: MutationCommand = { op: "writeFile", target: "/w/f", body: "v" };

describe("통합 reafference (P02 3단계) — 인지흐름 관통", () => {
  it("happy: 승인→mutate→observe match → done", async () => {
    const { gate, log } = rig({ decision: "once", observedValue: "v" });
    const r = await gate.execute(cmd, gi(), "v");
    expect(r.kind).toBe("done");
    expect(log).toEqual(["mutate:writeFile", "observe"]); // 승인 후 mutate, 그 후 관측
  });

  it("negative: blocked 명령 → 승인·mutate 전혀 안 함", async () => {
    const { gate, log } = rig();
    const r = await gate.execute({ op: "execCommand", target: "", body: "rm -rf /" }, gi({ tool: "execute_command" }), null);
    expect(r.kind).toBe("blocked");
    expect(log).toEqual([]); // mutate 호출 0 (미실행)
  });

  it("negative: 승인 거부 → mutate 안 함", async () => {
    const { gate, log } = rig({ decision: "reject" });
    const r = await gate.execute(cmd, gi(), "v");
    expect(r).toMatchObject({ kind: "blocked", reason: "denied" });
    expect(log).not.toContain("mutate:writeFile");
  });

  it("negative: pre-exec drift(실행시점 context 변화) → mutate 안 함", async () => {
    const { gate, log } = rig({ decision: "once" });
    // 승인=ident, 실행시점 context 가 다름(sessionId 변경) → drift 차단, mutate 미실행
    const r = await gate.execute(cmd, gi(), "v", { context: { ...ident, sessionId: "s2" }, scope: scope() });
    expect(r).toMatchObject({ kind: "blocked", reason: "drift" });
    expect(log).not.toContain("mutate:writeFile");
  });
  it("atomic(exec 생략) → 동일 context = drift 없음 → done", async () => {
    const { gate, log } = rig({ decision: "once", observedValue: "v" });
    const r = await gate.execute(cmd, gi(), "v");
    expect(r.kind).toBe("done");
    expect(log).toContain("mutate:writeFile");
  });

  it("불확정: mutate ack 했으나 observe 실패 → aborted + ackNotObserved", async () => {
    const { gate } = rig({ decision: "once", observeThrows: true });
    const r = await gate.execute(cmd, gi(), "v");
    expect(r).toMatchObject({ kind: "aborted", uncertain: "ackNotObserved", disposition: "abort" });
  });

  it("불확정: observed≠expected(mismatch) → aborted", async () => {
    const { gate } = rig({ decision: "once", observedValue: "other" });
    const r = await gate.execute(cmd, gi(), "v");
    expect(r).toMatchObject({ kind: "aborted" });
    if (r.kind === "aborted") expect(r.reafference.outcome).toBe("mismatch");
  });

  it("불확정: mutate 자체 throw → aborted (contain, 전파 X)", async () => {
    const { gate } = rig({ decision: "once", mutateThrows: true });
    await expect(gate.execute(cmd, gi(), "v")).resolves.toMatchObject({ kind: "aborted" }); // throw 전파 X = contamination 격리
  });

  it("exec: observed=ack.output (file 재read 아님)", async () => {
    const { gate, log } = rig({ decision: "once", ackOutput: "done" });
    // 승인 scope 가 exec cmd 에 결속(target/op/body 일치)돼야 통과
    const r = await gate.execute({ op: "execCommand", target: "echo", body: "echo done" },
      gi({ tool: "execute_command", scope: scope({ target: "echo", op: "execCommand", body: "echo done" }) }), "done");
    expect(r.kind).toBe("done");
    expect(log).not.toContain("observe"); // exec 는 observe.fileStatus 안 부름
  });

  it("★ 승인-결속(UC13 fix): 승인 scope ≠ 실제 cmd → scope-mismatch 차단(승인A→행위B 금지)", async () => {
    const { gate, log } = rig({ decision: "once" });
    // 승인은 /w/f writeFile "v" 에 대해 났는데, 실제 cmd 는 다른 파일 /w/OTHER 를 씀
    const r = await gate.execute({ op: "writeFile", target: "/w/OTHER", body: "evil" }, gi(), "v");
    expect(r).toMatchObject({ kind: "blocked", reason: "scope-mismatch" });
    expect(log).not.toContain("mutate:writeFile"); // 행위 실행 안 됨
  });

  it("file-op 경로 안전(defense-in-depth): `..` traversal → blocked unsafe(승인 전 차단)", async () => {
    const { gate, log } = rig({ decision: "once" });
    const r = await gate.execute({ op: "writeFile", target: "/w/../etc/passwd", body: "x" },
      gi({ scope: scope({ target: "/w/../etc/passwd" }) }), "x");
    expect(r).toMatchObject({ kind: "blocked", reason: "unsafe" });
    expect(log).not.toContain("mutate:writeFile");
  });
});
