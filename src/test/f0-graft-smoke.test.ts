// graft-smoke 검증 테스트 — new vs old 부팅 결정 등가 (drift-gate 시작). mock LiveDeps.
import { describe, it, expect } from "vitest";
import { graftBootDecisionSmoke } from "../main/app/control/graft-smoke.js";
import type { LiveDeps } from "../main/adapters/tauri/live.js";

const deps = (over: { adkPath?: string | null; onboarding?: boolean }): LiveDeps => ({
  invoke: async () => [],
  loadConfig: () => null, saveConfig: () => {}, loadConfigWithSecrets: async () => null,
  getAdkPath: () => over.adkPath ?? null,
  setAdkPath: () => {},
  isOnboardingComplete: () => over.onboarding ?? false,
});

describe("graft 부팅 결정 등가 (P02 1단계: Old-Baseline drift-gate)", () => {
  it("adk 없음 → 양쪽 SetupRequired, match", async () => {
    const r = await graftBootDecisionSmoke(deps({ adkPath: null }));
    expect(r.newDecision).toBe("SetupRequired");
    expect(r.match).toBe(true);
  });
  it("adk 有 + onboarding 완료 → Main, match", async () => {
    const r = await graftBootDecisionSmoke(deps({ adkPath: "/w", onboarding: true }));
    expect(r.newDecision).toBe("Main");
    expect(r.match).toBe(true);
  });
  it("adk 有 + onboarding 미완 → OnboardingOverlay, match", async () => {
    const r = await graftBootDecisionSmoke(deps({ adkPath: "/w", onboarding: false }));
    expect(r.newDecision).toBe("OnboardingOverlay");
    expect(r.match).toBe(true);
  });
  it("panel_list_installed 실패해도 non-fatal (결정 계산됨)", async () => {
    const d = { ...deps({ adkPath: "/w", onboarding: true }), invoke: async () => { throw new Error("boom"); } };
    await expect(graftBootDecisionSmoke(d)).resolves.toMatchObject({ newDecision: "Main" });
  });
});
