// F0 control-plane 계약 테스트 (P02 drift-gate).
// mock 포트로 ControlPlaneBoot 의 조건부 포트 호출 순서가 baseline 과 일치하는지 검증.
import { describe, it, expect } from "vitest";
import { ControlPlaneBoot, type ControlPlanePorts } from "../main/app/control/boot.js";
import { forAgent } from "../main/domain/config.js";
import { decideBoot } from "../main/domain/boot.js";
import { startupMessagesToSend } from "../main/domain/startup.js";
import type { NaiaConfig } from "../main/ports/index.js";

// ── mock 포트 (호출 기록) ──
function mkPorts(over: {
  adk?: { present: boolean; path?: string };
  onboardingComplete?: boolean;
  localConfig?: NaiaConfig | null;
  localConfigWithSecrets?: NaiaConfig | null;
  fileConfig?: NaiaConfig | null;
  setRootOk?: boolean;
  panelThrows?: boolean;
  adkDirExists?: boolean;
  adkDirIsAdk?: boolean;
} = {}) {
  const calls: string[] = [];
  const rec = (s: string) => calls.push(s);
  const adk = over.adk ?? { present: false };
  const ports: ControlPlanePorts = {
    config: {
      read: (a) => { rec(`config.read:${a}`); return over.fileConfig ?? null; },
      write: (a) => rec(`config.write:${a}`),
    },
    bootState: {
      mergeFromFile: () => rec("mergeFromFile"),
      isOnboardingComplete: () => over.onboardingComplete ?? false,
      loadLocalConfig: () => over.localConfig ?? null,
      loadLocalConfigWithSecrets: () => over.localConfigWithSecrets ?? null,
      replaceLocalConfig: () => rec("replaceLocalConfig"),
      resetLocalConfig: () => rec("resetLocalConfig"),
      setWorkspaceRoot: (p) => rec(`setWorkspaceRoot:${p}`),
      clearWorkspaceRoot: () => rec("clearWorkspaceRoot"),
      markOnboardingComplete: () => rec("markOnboardingComplete"),
    },
    adkPath: {
      get: () => (adk.present ? { present: true, path: adk.path! } : { present: false }),
      set: (p) => rec(`adkPath.set:${p}`),
      detectRoot: () => { rec("detectRoot"); return null; },
    },
    workspace: {
      setRoot: (r) => { rec(`setRoot:${r}`); return over.setRootOk === false ? { ok: false, error: "bad" } : { ok: true, root: { kind: "canonical-root", path: r } }; },
      startWatch: () => rec("startWatch"),
      stopWatch: () => rec("stopWatch"),
    },
    startup: {
      store: (m) => rec(`store:${m.kind}`),
      send: (m) => rec(`send:${m.kind}`),
    },
    panels: {
      listInstalled: () => { rec("listInstalled"); if (over.panelThrows) throw new Error("boom"); return []; },
    },
    setup: {
      initSettings: (a) => rec(`initSettings:${a}`),
      copyBundledAssets: (a) => rec(`copyBundledAssets:${a}`),
      inspectAdkDir: (p) => { rec(`inspectAdkDir:${p}`); return { exists: over.adkDirExists ?? false, isAdk: over.adkDirIsAdk ?? false }; },
      cloneAdk: (p) => rec(`cloneAdk:${p}`),
      deleteAdk: (p) => rec(`deleteAdk:${p}`),
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
    expect(startupMessagesToSend(false, false)).toEqual([]); // config 없음 → skip
    expect(startupMessagesToSend(true, false)).toEqual(["NotifyConfig", "CredsUpdate"]); // 무키
    expect(startupMessagesToSend(true, true)).toEqual(["AuthUpdate", "NotifyConfig", "CredsUpdate"]); // 고정순서
  });
});

describe("boot() 게이트", () => {
  it("ADK-path 부재 → SetupRequired + detectRoot, panel list 는 게이트 이전", () => {
    const { ports, calls } = mkPorts({ adk: { present: false } });
    expect(new ControlPlaneBoot(ports).boot()).toBe("SetupRequired");
    expect(calls[0]).toBe("listInstalled"); // 게이트 이전 (C-R1)
    expect(calls).toContain("detectRoot");
  });
  it("ADK-path + onboarding 완료 → Main", () => {
    const { ports } = mkPorts({ adk: { present: true, path: "/w" }, onboardingComplete: true });
    expect(new ControlPlaneBoot(ports).boot()).toBe("Main");
  });
  it("ADK-path + onboarding 미완 → OnboardingOverlay", () => {
    const { ports } = mkPorts({ adk: { present: true, path: "/w" }, onboardingComplete: false });
    expect(new ControlPlaneBoot(ports).boot()).toBe("OnboardingOverlay");
  });
  it("panel list 실패 = non-fatal (boot 계속)", () => {
    const { ports } = mkPorts({ adk: { present: true, path: "/w" }, onboardingComplete: true, panelThrows: true });
    expect(() => new ControlPlaneBoot(ports).boot()).not.toThrow();
  });
  it("2b: config.workspaceRoot 권위 — adk 부재 시 adkPath.set(cfgRoot)", () => {
    const { ports, calls } = mkPorts({ adk: { present: false }, localConfig: cfg({ workspaceRoot: "/auth" }) });
    new ControlPlaneBoot(ports).boot();
    expect(calls).toContain("adkPath.set:/auth");
  });
});

describe("initAuth() — 게이트 독립, config 조건부", () => {
  it("config null → 발신 0", () => {
    const { ports, calls } = mkPorts({ localConfigWithSecrets: null });
    new ControlPlaneBoot(ports).initAuth();
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual([]);
  });
  it("config 有·무키 → NotifyConfig+CredsUpdate (AuthUpdate 없음)", () => {
    const { ports, calls } = mkPorts({ localConfigWithSecrets: cfg({ naiaKey: undefined }) });
    new ControlPlaneBoot(ports).initAuth();
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual(["send:NotifyConfig", "send:CredsUpdate"]);
  });
  it("config 有·키 有 → 고정순서 + store/send 동반", () => {
    const { ports, calls } = mkPorts({ localConfigWithSecrets: cfg({ naiaKey: "k" }) });
    new ControlPlaneBoot(ports).initAuth();
    expect(calls.filter((c) => c.startsWith("send:"))).toEqual(["send:AuthUpdate", "send:NotifyConfig", "send:CredsUpdate"]);
    expect(calls).toContain("store:AuthUpdate");
  });
});

describe("workspace 패널 — boot 공통 아님, contain+fallback", () => {
  it("setRoot Err → clearWorkspaceRoot + startWatch (block 아님)", () => {
    const { ports, calls } = mkPorts({ setRootOk: false });
    new ControlPlaneBoot(ports).onWorkspacePanelMount("/bad");
    expect(calls).toEqual(["setRoot:/bad", "clearWorkspaceRoot", "startWatch"]);
  });
});

describe("setup 분기 — 모드별 완료조건 (C-R5/R6)", () => {
  it("new → inspect→initSettings→copy, resetLocalConfig, markOnboardingComplete 안 함(overlay)", () => {
    const { ports, calls } = mkPorts();
    new ControlPlaneBoot(ports).onSetupConfirm("new", "/p");
    expect(calls.indexOf("inspectAdkDir:/p")).toBeLessThan(calls.indexOf("initSettings:/p"));
    expect(calls.indexOf("initSettings:/p")).toBeLessThan(calls.indexOf("copyBundledAssets:/p"));
    expect(calls).not.toContain("markOnboardingComplete");
  });
  it("load → markOnboardingComplete 무조건 + setWorkspaceRoot 강제", () => {
    const { ports, calls } = mkPorts({ fileConfig: cfg() });
    new ControlPlaneBoot(ports).onSetupConfirm("load", "/p");
    expect(calls).toContain("markOnboardingComplete");
    expect(calls).toContain("setWorkspaceRoot:/p");
  });
  it("use-existing + cfg null → markOnboardingComplete 안 함", () => {
    const { ports, calls } = mkPorts({ fileConfig: null });
    new ControlPlaneBoot(ports).onSetupConfirm("use-existing", "/p");
    expect(calls).toContain("resetLocalConfig");
    expect(calls).not.toContain("markOnboardingComplete");
  });
  it("use-existing + cfg 有 → markOnboardingComplete", () => {
    const { ports, calls } = mkPorts({ fileConfig: cfg() });
    new ControlPlaneBoot(ports).onSetupConfirm("use-existing", "/p");
    expect(calls).toContain("markOnboardingComplete");
  });
});

describe("setup clone/delete + workspace mount/activate (codex HIGH/MED)", () => {
  it("new + dir 없음 → cloneAdk 호출", () => {
    const { ports, calls } = mkPorts({ adkDirExists: false });
    new ControlPlaneBoot(ports).onSetupConfirm("new", "/p");
    expect(calls).toContain("cloneAdk:/p");
    expect(calls).not.toContain("deleteAdk:/p");
  });
  it("recreate + dir 존재 → deleteAdk 후 cloneAdk", () => {
    const { ports, calls } = mkPorts({ adkDirExists: true });
    new ControlPlaneBoot(ports).onSetupConfirm("recreate", "/p");
    expect(calls.indexOf("deleteAdk:/p")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("deleteAdk:/p")).toBeLessThan(calls.indexOf("cloneAdk:/p"));
  });
  it("load + fileConfig null → replaceLocalConfig(base) 수행(누락 금지)", () => {
    const { ports, calls } = mkPorts({ fileConfig: null });
    new ControlPlaneBoot(ports).onSetupConfirm("load", "/p");
    expect(calls).toContain("replaceLocalConfig");
    expect(calls).toContain("markOnboardingComplete");
  });
  it("onWorkspacePanelActivate() = startWatch 만 (setRoot 안 함)", () => {
    const { ports, calls } = mkPorts();
    new ControlPlaneBoot(ports).onWorkspacePanelActivate();
    expect(calls).toEqual(["startWatch"]);
  });
});
