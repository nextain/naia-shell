// F1 실배선 어댑터 parity 테스트 (drift-gate, P02).
// devices=list_audio_output_devices 매핑 / grant=isToolAllowed·addAllowedTool / systemStatus·degradation 정직(오보 금지) /
// diagnostics deferred(gRPC Diagnostics 신규계약 전까지 빈 결과).
import { describe, it, expect } from "vitest";
import { makeF1LiveAdapters, agentWireApproval, type F1LiveDeps } from "../main/adapters/tauri/f1.js";
import { StatusReporter } from "../main/app/control/status.js";
import type { ApprovalRequest, ApprovalBinding } from "../main/ports/f1.js";

function makeDeps(over: Partial<F1LiveDeps> = {}): { deps: F1LiveDeps; calls: string[]; added: string[] } {
  const calls: string[] = [];
  const added: string[] = [];
  const deps: F1LiveDeps = {
    invoke: async (cmd) => { calls.push(cmd); if (cmd === "list_audio_output_devices") return [{ id: "a", label: "Speakers" }, { id: "b", label: "HDMI" }]; return undefined; },
    isToolAllowed: (t) => t === "read_file",
    addAllowedTool: (t) => { added.push(t); },
    ...over,
  };
  return { deps, calls, added };
}

describe("F1 live interoceptive — devices parity + 정직 보고", () => {
  it("devices → list_audio_output_devices → DeviceStatus 매핑", async () => {
    const { deps, calls } = makeDeps();
    const r = await makeF1LiveAdapters(deps).interoceptive.devices();
    expect(calls).toContain("list_audio_output_devices");
    expect(r).toEqual([{ kind: "Speakers", available: true }, { kind: "HDMI", available: true }]);
  });

  it("systemStatus: agentReachable 미주입 → 빈 components(모름, false-healthy 오보 금지)", async () => {
    const r = await makeF1LiveAdapters(makeDeps().deps).interoceptive.systemStatus();
    expect(r).toEqual({ components: [] });
  });

  it("systemStatus: agentReachable 주입 → agent 컴포넌트 정직 보고", async () => {
    const r = await makeF1LiveAdapters(makeDeps({ agentReachable: async () => false }).deps).interoceptive.systemStatus();
    expect(r).toEqual({ components: [{ name: "agent", healthy: false }] });
  });

  it("degradations: agentReachable 주입 → configured&&!reachable 정직 신호", async () => {
    const r = await makeF1LiveAdapters(makeDeps({ agentReachable: async () => false, agentConfigured: () => true }).deps).interoceptive.degradations();
    expect(r).toEqual([{ component: "agent", configured: true, reachable: false }]);
  });
  it("degradations: agentReachable 미주입 → 빈(모름)", async () => {
    expect(await makeF1LiveAdapters(makeDeps().deps).interoceptive.degradations()).toEqual([]);
  });

  it("diagnostics: gRPC Diagnostics 신규계약 전까지 빈 결과(deferred, 오보 아님)", async () => {
    expect(await makeF1LiveAdapters(makeDeps().deps).interoceptive.diagnostics()).toEqual([]);
  });
});

describe("F1 live grant — config allowedTools parity", () => {
  it("isAllowed → isToolAllowed", async () => {
    const g = makeF1LiveAdapters(makeDeps().deps).grant;
    expect(await g.isAllowed("read_file")).toBe(true);
    expect(await g.isAllowed("rm")).toBe(false);
  });
  it("add → addAllowedTool", async () => {
    const { deps, added } = makeDeps();
    await makeF1LiveAdapters(deps).grant.add("write_file");
    expect(added).toEqual(["write_file"]);
  });
});

describe("F1 StatusReporter — 빈 components=모름≠healthy (FR-F1.1, 리뷰 fix)", () => {
  it("★ agentReachable 미주입(빈 system) → allClear=false (false-healthy 오보 차단)", async () => {
    const sr = new StatusReporter(makeF1LiveAdapters(makeDeps().deps).interoceptive);
    const r = await sr.report();
    expect(r.system).toEqual({ components: [] });
    expect(r.allClear).toBe(false); // 이전 [].every()=true 오보를 차단
  });
  it("agent healthy → allClear=true", async () => {
    const sr = new StatusReporter(makeF1LiveAdapters(makeDeps({ agentReachable: async () => true }).deps).interoceptive);
    expect((await sr.report()).allClear).toBe(true);
  });
});

describe("F1 approval 잠금 계약 — fail-closed(UC13 라이브 전)", () => {
  it("approval.request 는 throw(silently allow 금지) = fail-closed", async () => {
    await expect(agentWireApproval.request({} as ApprovalRequest, {} as ApprovalBinding)).rejects.toThrow();
  });
});
