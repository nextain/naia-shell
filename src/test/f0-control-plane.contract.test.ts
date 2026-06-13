// F0 control-plane 계약 테스트 (P02 drift-gate). 포트 async — orchestration await.
import { describe, it, expect } from "vitest";
import { ControlPlaneBoot, type ControlPlanePorts } from "../main/app/control/boot.js";
import { forAgent } from "../main/domain/config.js";
import { decideBoot, AdkDirNeedsDecisionError, type AdkDirStatus } from "../main/domain/boot.js";
import { startupMessagesToSend } from "../main/domain/startup.js";
import type { NaiaConfig } from "../main/ports/index.js";

function mkPorts(over: {
  adk?: { present: boolean; path?: string };
  onboardingComplete?: boolean;
  localConfig?: NaiaConfig | null;
  localConfigWithSecrets?: NaiaConfig | null;
  fileConfig?: NaiaConfig | null;
  setRootOk?: boolean;
  panelThrows?: boolean;
  adkDirStatus?: AdkDirStatus;
} = {}) {
  const calls: string[] = [];
  const rec = (s: string) => calls.push(s);
  const adk = over.adk ?? { present: false };
  const ports: ControlPlanePorts = {
    config: {
      read: async (a) => { rec(`config.read:${a}`); return over.fileConfig ?? null; },
      write: async (a) => { rec(`config.write:${a}`); },
    },
    bootState: {
      mergeFromFile: async () => { rec("mergeFromFile"); },
      isOnboardingComplete: async () => over.onboardingComplete ?? false,
      loadLocalConfig: async () => over.localConfig ?? null,
      loadLocalConfigWithSecrets: async () => over.localConfigWithSecrets ?? null,
      replaceLocalConfig: async () => { rec("replaceLocalConfig"); },
      resetLocalConfig: async () => { rec("resetLocalConfig"); },
      setWorkspaceRoot: async (p) => { rec(`setWorkspaceRoot:${p}`); },
      clearWorkspaceRoot: async () => { rec("clearWorkspaceRoot"); },
      markOnboardingComplete: async () => { rec("markOnboardingComplete"); },
    },
    adkPath: {
      get: async () => (adk.present ? { present: true, path: adk.path! } : { present: false }),
      set: async (p) => { rec(`adkPath.set:${p}`); },
      detectRoot: async () => { rec("detectRoot"); return null; },
    },
    workspace: {
      setRoot: async (r) => { rec(`setRoot:${r}`); return over.setRootOk === false ? { ok: false as const, error: "bad" } : { ok: true as const, root: { kind: "canonical-root" as const, path: r } }; },
      startWatch: async () => { rec("startWatch"); },
      stopWatch: async () => { rec("stopWatch"); },
    },
    startup: {
      store: async (m) => { rec(`store:${m.kind}`); },
      send: async (m) => { rec(`send:${m.kind}`); },
    },
    panels: {
      listInstalled: async () => { rec("listInstalled"); if (over.panelThrows) throw new Error("boom"); return []; },
    },
    setup: {
      initSettings: async (a) => { rec(`initSettings:${a}`); },
      copyBundledAssets: async (a) => { rec(`copyBundledAssets:${a}`); },
      inspectAdkDir: async (p) => { rec(`inspectAdkDir:${p}`); return { status: over.adkDirStatus ?? "missing" }; },
      cloneAdk: async (p) => { rec(`cloneAdk:${p}`); },
      deleteAdk: async (p) => { rec(`deleteAdk:${p}`); },
    },
  };
  return { ports, calls };
}

const cfg = (over: Partial<NaiaConfig> = {}): NaiaConfig => ({
  agent: { a: 1 }, secret: { naiaKey: "k" }, ui: { theme: "dark" }, ...over,
});

describe("domain 순수 규칙", () => {
  it("forAgent 는 secret+ui 제거, agent 만 노출", () => {
    expect(forAgent(cfg())).toEqual({ agent: { a: 1 } });
  });
  it("decideBoot 게이트 (codex R1/R3)", () => {
    expect(decideBoot(false, false)).toBe("SetupRequired");
    expect(decideBoot(true, false)).toBe("OnboardingOverlay");
    expect(decideBoot(true, true)).toBe("Main");
  });
  it("startup 고정 순서 + 조건 (C-R2/R10/R12)", () => {
    expect(startupMessagesToSend(false, false)).toEqual([]);
    expect(startupMessagesToSend(true, false)).toEqual(["NotifyConfig", "CredsUpdate"]);
    expect(startupMessagesToSend(true, true)).toEqual(["AuthUpdate", "NotifyConfig", "CredsUpdate"]);
  });
});

describe("boot() 게이트", () => {
  it("ADK-path 부재 → SetupRequired + detectRoot, panel list 는 게이트 이전", async () => {
    const { ports, calls } = mkPorts({ adk: { present: false } });
    expect(await new ControlPlaneBoot(ports).boot()).toBe("SetupRequired");
    expect(calls[0]).toBe("listInstalled");
    expect(calls).toContain("detectRoot");
  });
  it("ADK-path + onboarding 완료 → Main", async () => {
    const { ports } = mkPorts({ adk: { present: true, path: "/w" }, onboardingComplete: true });
    expect(await new ControlPlaneBoot(ports).boot()).toBe("Main");
  });
  it("ADK-path + onboarding 미완 → OnboardingOverlay", async () => {
    const { ports } = mkPorts({ adk: { present: true, path: "/w" }, onboardingComplete: false });
    expect(await new ControlPlaneBoot(ports).boot()).toBe("OnboardingOverlay");
  });
  it("panel list 실패 = non-fatal (boot 계속)", async () => {
    const { ports } = mkPorts({ adk: { present: true, path: "/w" }, onboardingComplete: true, panelThrows: true });
    await expect(new ControlPlaneBoot(ports).boot()).resolves.toBe("Main");
  });
  it("2b: config.workspaceRoot 권위 — adk 부재 시 adkPath.set(cfgRoot)", async () => {
    const { ports, calls } = mkPorts({ adk: { present: false }, localConfig: cfg({ workspaceRoot: "/auth" }) });
    await new ControlPlaneBoot(ports).boot();
    expect(calls).toContain("adkPath.set:/auth");
  });
});

describe("initAuth() — 게이트 독립, config 조건부", () => {
  it("config null → 발신 0", async () => {
    const { ports, calls } = mkPorts({ localConfigWithSecrets: null });
    await new ControlPlaneBoot(ports).initAuth();
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual([]);
  });
  it("config 有·무키 → NotifyConfig+CredsUpdate (AuthUpdate 없음)", async () => {
    const { ports, calls } = mkPorts({ localConfigWithSecrets: cfg({ naiaKey: undefined }) });
    await new ControlPlaneBoot(ports).initAuth();
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual(["send:NotifyConfig", "send:CredsUpdate"]);
  });
  it("config 有·키 有 → 고정순서 + store/send 동반", async () => {
    const { ports, calls } = mkPorts({ localConfigWithSecrets: cfg({ naiaKey: "k" }) });
    await new ControlPlaneBoot(ports).initAuth();
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual(["send:AuthUpdate", "send:NotifyConfig", "send:CredsUpdate"]);
    expect(calls).toContain("store:AuthUpdate");
  });
});

describe("workspace 패널 — boot 공통 아님, contain+fallback", () => {
  it("setRoot Err → clearWorkspaceRoot + startWatch (block 아님)", async () => {
    const { ports, calls } = mkPorts({ setRootOk: false });
    await new ControlPlaneBoot(ports).onWorkspacePanelMount("/bad");
    expect(calls).toEqual(["setRoot:/bad", "clearWorkspaceRoot", "startWatch"]);
  });
});

describe("setup 분기 — 모드별 완료조건 (C-R5/R6)", () => {
  it("new → inspect→initSettings→copy, markOnboardingComplete 안 함(overlay)", async () => {
    const { ports, calls } = mkPorts();
    await new ControlPlaneBoot(ports).onSetupConfirm("new", "/p");
    expect(calls.indexOf("inspectAdkDir:/p")).toBeLessThan(calls.indexOf("initSettings:/p"));
    expect(calls.indexOf("initSettings:/p")).toBeLessThan(calls.indexOf("copyBundledAssets:/p"));
    expect(calls).not.toContain("markOnboardingComplete");
  });
  it("load → markOnboardingComplete 무조건 + setWorkspaceRoot 강제", async () => {
    const { ports, calls } = mkPorts({ fileConfig: cfg() });
    await new ControlPlaneBoot(ports).onSetupConfirm("load", "/p");
    expect(calls).toContain("markOnboardingComplete");
    expect(calls).toContain("setWorkspaceRoot:/p");
  });
  it("use-existing + cfg null → markOnboardingComplete 안 함", async () => {
    const { ports, calls } = mkPorts({ fileConfig: null });
    await new ControlPlaneBoot(ports).onSetupConfirm("use-existing", "/p");
    expect(calls).toContain("resetLocalConfig");
    expect(calls).not.toContain("markOnboardingComplete");
  });
  it("use-existing + cfg 有 → markOnboardingComplete", async () => {
    const { ports, calls } = mkPorts({ fileConfig: cfg() });
    await new ControlPlaneBoot(ports).onSetupConfirm("use-existing", "/p");
    expect(calls).toContain("markOnboardingComplete");
  });
});

describe("setup clone/delete + workspace mount/activate (codex HIGH/MED)", () => {
  it("new + dir missing/empty → cloneAdk 호출", async () => {
    const { ports, calls } = mkPorts({ adkDirStatus: "empty" });
    await new ControlPlaneBoot(ports).onSetupConfirm("new", "/p");
    expect(calls).toContain("cloneAdk:/p");
    expect(calls).not.toContain("deleteAdk:/p");
  });
  it("★ new + has_other_files(비어있지 않음) → needs-decision throw, blind clone 금지(#325, F0-1)", async () => {
    const { ports, calls } = mkPorts({ adkDirStatus: "has_other_files" });
    await expect(new ControlPlaneBoot(ports).onSetupConfirm("new", "/p")).rejects.toBeInstanceOf(AdkDirNeedsDecisionError);
    expect(calls).not.toContain("cloneAdk:/p");   // 에러나는 blind clone 안 함
    expect(calls).not.toContain("initSettings:/p");
  });
  it("★ new + has_settings(기존 ADK) → needs-decision throw(자동결정 안 함)", async () => {
    const { ports, calls } = mkPorts({ adkDirStatus: "has_settings" });
    await expect(new ControlPlaneBoot(ports).onSetupConfirm("new", "/p")).rejects.toBeInstanceOf(AdkDirNeedsDecisionError);
    expect(calls).not.toContain("cloneAdk:/p");
  });
  it("recreate → 항상 deleteAdk 후 cloneAdk (status 무관, old 충실)", async () => {
    const { ports, calls } = mkPorts({ adkDirStatus: "has_settings" });
    await new ControlPlaneBoot(ports).onSetupConfirm("recreate", "/p");
    expect(calls.indexOf("deleteAdk:/p")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("deleteAdk:/p")).toBeLessThan(calls.indexOf("cloneAdk:/p"));
  });
  it("load + fileConfig null → replaceLocalConfig(base) 수행(누락 금지)", async () => {
    const { ports, calls } = mkPorts({ fileConfig: null });
    await new ControlPlaneBoot(ports).onSetupConfirm("load", "/p");
    expect(calls).toContain("replaceLocalConfig");
    expect(calls).toContain("markOnboardingComplete");
  });
  it("onWorkspacePanelActivate() = startWatch 만 (setRoot 안 함)", async () => {
    const { ports, calls } = mkPorts();
    await new ControlPlaneBoot(ports).onWorkspacePanelActivate();
    expect(calls).toEqual(["startWatch"]);
  });
});
