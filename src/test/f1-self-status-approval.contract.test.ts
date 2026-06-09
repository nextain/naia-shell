// F1 계약 테스트 (P02). 정직 degradation + 승인 게이트 + context-digest 결속.
import { describe, it, expect } from "vitest";
import { StatusReporter } from "../main/app/control/status.js";
import { ApprovalGate } from "../main/app/control/approval.js";
import { isDegraded } from "../main/domain/degradation.js";
import {
  needsApproval, isBlocked, isAutoBypass, contextDigest, isPreExecDrift,
  type ApprovalRequest, type ApprovalBinding, type ActionScope, type ApprovalDecision,
} from "../main/domain/approval.js";
import type { InteroceptivePort, ApprovalPort, PersistentGrantPort } from "../main/ports/f1.js";

const scope = (o: Partial<ActionScope> = {}): ActionScope => ({ target: "/f", op: "write", body: "x", env: "host", ...o });
const ident = { sessionId: "s1", canonicalRoot: "/w", activeSurface: "panel", configVersion: "v1", clientId: "c1" };

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
    expect(isBlocked("T1")).toBe(false);
  });
  it("auto-bypass 집합", () => {
    expect(isAutoBypass("skill_voicewake")).toBe(true);
    expect(isAutoBypass("write_file")).toBe(false);
  });
  it("contextDigest 결정적 (같은 입력→같은 값)", () => {
    expect(contextDigest(ident)).toBe(contextDigest({ ...ident }));
    expect(contextDigest(ident)).not.toBe(contextDigest({ ...ident, sessionId: "s2" }));
  });
  it("contextDigest headless(activeSurface null) 허용", () => {
    expect(contextDigest({ ...ident, activeSurface: null })).toContain("∅");
  });
  it("isPreExecDrift: digest/scope 불일치 감지", () => {
    const b: ApprovalBinding = { correlationId: "x", digest: contextDigest(ident), scope: scope() };
    expect(isPreExecDrift(b, { digest: b.digest, scope: scope() })).toBe(false);
    expect(isPreExecDrift(b, { digest: contextDigest({ ...ident, sessionId: "s2" }), scope: scope() })).toBe(true);
    expect(isPreExecDrift(b, { digest: b.digest, scope: scope({ target: "/other" }) })).toBe(true);
  });
});

describe("StatusReporter — 정직 보고", () => {
  function mkInteroceptive(degradations: { component: string; configured: boolean; reachable: boolean }[]): InteroceptivePort {
    return {
      systemStatus: () => ({ components: [{ name: "agent", healthy: true }] }),
      diagnostics: () => [],
      devices: () => [],
      degradations: () => degradations,
    };
  }
  it("configured&&!reachable 만 degraded 로 보고 (key-presence 승격 금지)", () => {
    const r = new StatusReporter(mkInteroceptive([
      { component: "llm", configured: true, reachable: false }, // degraded
      { component: "discord", configured: true, reachable: true }, // 정상
      { component: "unset", configured: false, reachable: false }, // 미설정=정상
    ])).report();
    expect(r.degraded.map((d) => d.component)).toEqual(["llm"]);
    expect(r.allClear).toBe(false);
  });
  it("degradation 없으면 allClear", () => {
    expect(new StatusReporter(mkInteroceptive([])).report().allClear).toBe(true);
  });
});

describe("ApprovalGate — 게이트 흐름", () => {
  const binding: ApprovalBinding = { correlationId: "x", digest: contextDigest(ident), scope: scope() };
  function gate(over: { tier?: ApprovalRequest["tier"]; tool?: string; allowed?: boolean; decision?: ApprovalDecision }) {
    let requested = false;
    const approval: ApprovalPort = {
      classify: () => over.tier ?? "T2",
      request: () => { requested = true; return over.decision ?? "reject"; },
    };
    const grant: PersistentGrantPort = { isAllowed: () => over.allowed ?? false, add: () => {} };
    const req: ApprovalRequest = { tool: over.tool ?? "write_file", args: {}, tier: over.tier ?? "T2", toolCallId: "tc1" };
    const out = new ApprovalGate({ approval, grant }).gate(req, binding);
    return { out, requested };
  }
  it("T3 = blocked(tier-T3), request 호출 안 함", () => {
    const { out, requested } = gate({ tier: "T3" });
    expect(out).toEqual({ kind: "blocked", reason: "tier-T3" });
    expect(requested).toBe(false);
  });
  it("auto-bypass 도구 = approved(auto-bypass)", () => {
    expect(gate({ tool: "skill_voicewake", tier: "T1" }).out).toEqual({ kind: "approved", via: "auto-bypass" });
  });
  it("pre-grant(allowedTools) = approved 없이 request", () => {
    const { out, requested } = gate({ tier: "T1", allowed: true });
    expect(out).toEqual({ kind: "approved", via: "pre-grant" });
    expect(requested).toBe(false);
  });
  it("T1 + once = approved(user-once)", () => {
    expect(gate({ tier: "T1", decision: "once" }).out).toEqual({ kind: "approved", via: "user-once" });
  });
  it.each(["reject", "expired", "duplicate"] as ApprovalDecision[])("T1 + %s = blocked(denied)", (d) => {
    expect(gate({ tier: "T1", decision: d }).out).toEqual({ kind: "blocked", reason: "denied" });
  });
  it("pre-exec drift = blocked(drift)", () => {
    const g = new ApprovalGate({ approval: { classify: () => "T1", request: () => "once" }, grant: { isAllowed: () => false, add: () => {} } });
    const drifted = { digest: contextDigest({ ...ident, sessionId: "s2" }), scope: scope() };
    expect(g.checkPreExecDrift(binding, drifted)).toEqual({ kind: "blocked", reason: "drift" });
    expect(g.checkPreExecDrift(binding, { digest: binding.digest, scope: scope() })).toBeNull();
  });
});
