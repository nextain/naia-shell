// F1 계약 테스트 (P02). 정직 degradation + 승인 게이트 + context-digest 결속.
import { describe, it, expect } from "vitest";
import { StatusReporter } from "../main/app/control/status.js";
import { ApprovalGate, type GateInput } from "../main/app/control/approval.js";
import { isDegraded } from "../main/domain/degradation.js";
import {
  needsApproval, isBlocked, isAutoBypass, contextDigest, isPreExecDrift,
  type ApprovalBinding, type ActionScope, type ApprovalDecision, type ContextIdentity, type Tier,
} from "../main/domain/approval.js";
import type { InteroceptivePort, ApprovalPort, PersistentGrantPort } from "../main/ports/f1.js";

const scope = (o: Partial<ActionScope> = {}): ActionScope => ({ target: "/f", op: "write", body: "x", env: "host", ...o });
const ident: ContextIdentity = { sessionId: "s1", canonicalRoot: "/w", activeSurface: "panel", configVersion: "v1", clientId: "c1" };

describe("domain 순수 규칙 (F1)", () => {
  it("isDegraded: 키 있어도 unreachable = degraded (오보 금지)", () => {
    expect(isDegraded({ component: "llm", configured: true, reachable: false })).toBe(true);
    expect(isDegraded({ component: "llm", configured: true, reachable: true })).toBe(false);
    expect(isDegraded({ component: "llm", configured: false, reachable: false })).toBe(false);
  });
  it("tier 규칙: T1/T2 승인, T3 blocked, T0 auto", () => {
    expect(needsApproval("T1")).toBe(true);
    expect(needsApproval("T2")).toBe(true);
    expect(needsApproval("T0")).toBe(false);
    expect(isBlocked("T3")).toBe(true);
  });
  it("auto-bypass: 인자 조건 포함 (codex HIGH)", () => {
    expect(isAutoBypass("skill_voicewake", {})).toBe(true);
    expect(isAutoBypass("skill_tts", { action: "preview" })).toBe(true);
    expect(isAutoBypass("skill_tts", { action: "speak" })).toBe(false); // preview 아님 → 승인 필요
    expect(isAutoBypass("skill_config", { action: "models" })).toBe(true);
    expect(isAutoBypass("skill_config", { action: "write" })).toBe(false);
    expect(isAutoBypass("write_file", {})).toBe(false);
  });
  it("contextDigest 결정적 + 구분자 충돌 불가 (codex HIGH)", () => {
    expect(contextDigest(ident)).toBe(contextDigest({ ...ident }));
    expect(contextDigest(ident)).not.toBe(contextDigest({ ...ident, sessionId: "s2" }));
    // 구분자(|) 충돌: "a|b","c" vs "a","b|c" — JSON 배열이라 다름
    const d1 = contextDigest({ ...ident, sessionId: "a|b", canonicalRoot: "c" });
    const d2 = contextDigest({ ...ident, sessionId: "a", canonicalRoot: "b|c" });
    expect(d1).not.toBe(d2);
  });
  it("isPreExecDrift: digest/scope 불일치 감지", () => {
    const b: ApprovalBinding = { correlationId: "x", digest: contextDigest(ident), scope: scope() };
    expect(isPreExecDrift(b, { digest: b.digest, scope: scope() })).toBe(false);
    expect(isPreExecDrift(b, { digest: contextDigest({ ...ident, sessionId: "s2" }), scope: scope() })).toBe(true);
    expect(isPreExecDrift(b, { digest: b.digest, scope: scope({ target: "/other" }) })).toBe(true);
  });
});

describe("StatusReporter — 정직 보고 + contain", () => {
  function mkInteroceptive(opts: {
    degradations?: { component: string; configured: boolean; reachable: boolean }[];
    healthy?: boolean;
    throwOn?: "systemStatus" | "degradations";
  }): InteroceptivePort {
    return {
      systemStatus: () => { if (opts.throwOn === "systemStatus") throw new Error("boom"); return { components: [{ name: "agent", healthy: opts.healthy ?? true }] }; },
      diagnostics: () => [],
      devices: () => [],
      degradations: () => { if (opts.throwOn === "degradations") throw new Error("boom"); return opts.degradations ?? []; },
    };
  }
  it("configured&&!reachable 만 degraded (key-presence 승격 금지)", () => {
    const r = new StatusReporter(mkInteroceptive({ degradations: [
      { component: "llm", configured: true, reachable: false },
      { component: "discord", configured: true, reachable: true },
      { component: "unset", configured: false, reachable: false },
    ] })).report();
    expect(r.degraded.map((d) => d.component)).toEqual(["llm"]);
    expect(r.allClear).toBe(false);
  });
  it("degradation 0 + healthy → allClear", () => {
    expect(new StatusReporter(mkInteroceptive({})).report().allClear).toBe(true);
  });
  it("component unhealthy → allClear=false (codex MED)", () => {
    expect(new StatusReporter(mkInteroceptive({ healthy: false })).report().allClear).toBe(false);
  });
  it("포트 예외 contain — throw 안 하고 probeErrors 표면화 (codex MED)", () => {
    const r = new StatusReporter(mkInteroceptive({ throwOn: "degradations" }));
    expect(() => r.report()).not.toThrow();
    const out = r.report();
    expect(out.probeErrors.length).toBeGreaterThan(0);
    expect(out.allClear).toBe(false);
  });
});

describe("ApprovalGate — classify 신뢰 X, 게이트-author binding (codex HIGH)", () => {
  const input = (o: Partial<GateInput> = {}): GateInput => ({
    tool: "write_file", args: {}, toolCallId: "tc1", sessionId: "s1",
    context: ident, scope: scope(), correlationId: "corr1", ...o,
  });
  function mk(over: { classifyTier?: Tier; allowed?: boolean; decision?: ApprovalDecision }) {
    const log: string[] = [];
    const approval: ApprovalPort = {
      classify: (t) => { log.push(`classify:${t}`); return over.classifyTier ?? "T2"; },
      request: () => { log.push("request"); return over.decision ?? "reject"; },
    };
    const grant: PersistentGrantPort = { isAllowed: () => over.allowed ?? false, add: (t) => log.push(`grant.add:${t}`) };
    return { gate: new ApprovalGate({ approval, grant }), log };
  }
  it("classify() 항상 호출 — 호출자 tier 신뢰 안 함 (T0 위조 차단)", () => {
    const { gate, log } = mk({ classifyTier: "T2", decision: "once" });
    // 호출자가 args 로 T0 위조 시도해도 classify 가 T2 반환 → request 거침
    gate.gate(input({ tool: "execute_command" }));
    expect(log).toContain("classify:execute_command");
    expect(log).toContain("request");
  });
  it("classify=T3 → blocked, request 호출 안 함", () => {
    const { gate, log } = mk({ classifyTier: "T3" });
    const r = gate.gate(input({ tool: "execute_command" }));
    expect(r.outcome).toEqual({ kind: "blocked", reason: "tier-T3" });
    expect(log).not.toContain("request");
  });
  it("auto-bypass(인자조건) → approved", () => {
    const { gate } = mk({ classifyTier: "T1" });
    expect(gate.gate(input({ tool: "skill_tts", args: { action: "preview" } })).outcome).toEqual({ kind: "approved", via: "auto-bypass" });
  });
  it("auto-bypass 인자 불충족 → 승인 경로 (request)", () => {
    const { gate, log } = mk({ classifyTier: "T1", decision: "once" });
    gate.gate(input({ tool: "skill_tts", args: { action: "speak" } }));
    expect(log).toContain("request");
  });
  it("pre-grant → request 없이 approved", () => {
    const { gate, log } = mk({ classifyTier: "T1", allowed: true });
    expect(gate.gate(input()).outcome).toEqual({ kind: "approved", via: "pre-grant" });
    expect(log).not.toContain("request");
  });
  it("once → approved", () => {
    expect(mk({ classifyTier: "T1", decision: "once" }).gate.gate(input()).outcome).toEqual({ kind: "approved", via: "user-once" });
  });
  it("always → grant.add 호출 (영구 grant 저장, codex MED)", () => {
    const { gate, log } = mk({ classifyTier: "T1", decision: "always" });
    const r = gate.gate(input({ tool: "write_file" }));
    expect(r.outcome.kind).toBe("approved");
    expect(log).toContain("grant.add:write_file");
  });
  it.each(["reject", "expired", "duplicate"] as ApprovalDecision[])("%s → blocked(denied)", (d) => {
    expect(mk({ classifyTier: "T1", decision: d }).gate.gate(input()).outcome).toEqual({ kind: "blocked", reason: "denied" });
  });
  it("binding 은 게이트가 author (외부 위조 불가) — digest=context 기반", () => {
    const { gate } = mk({ classifyTier: "T1", decision: "once" });
    const r = gate.gate(input());
    expect(r.binding.digest).toBe(contextDigest(ident));
    expect(r.binding.correlationId).toBe("corr1");
  });
});

describe("ApprovalGate.authorizeExecution — 필수 pre-exec drift (codex HIGH)", () => {
  const gate = new ApprovalGate({ approval: { classify: () => "T1", request: () => "once" }, grant: { isAllowed: () => false, add: () => {} } });
  const binding: ApprovalBinding = { correlationId: "x", digest: contextDigest(ident), scope: scope() };
  it("drift → blocked(drift)", () => {
    expect(gate.authorizeExecution(binding, { context: { ...ident, sessionId: "s2" }, scope: scope() })).toEqual({ kind: "blocked", reason: "drift" });
  });
  it("일치 → approved", () => {
    expect(gate.authorizeExecution(binding, { context: ident, scope: scope() }).kind).toBe("approved");
  });
});
