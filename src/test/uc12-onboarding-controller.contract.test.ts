import { describe, expect, it } from "vitest";
import { OnboardingController } from "../main/app/control/onboarding.js";
import type { NaiaConfig } from "../main/domain/config.js";

/**
 * UC12 app 계약 — OnboardingController orchestration (contract §B.3).
 * 인메모리 fake 포트로 영속 순서/채널/idempotency/provider-switch 검증.
 */
function makeFakes(initialLocal: NaiaConfig | null = null) {
  const calls = {
    replaceLocalConfig: [] as NaiaConfig[],
    configWrite: [] as { adkPath: string; agentView: unknown }[],
    writeAgentKey: [] as { envKey: string; value: string }[],
    authUpdate: [] as string[],
    sync: [] as NaiaConfig[],
    markComplete: 0,
    oauthLaunch: 0,
    assetList: [] as { adkPath: string; kind: string }[],
  };
  let local = initialLocal;
  const deps = {
    assets: { list: async (adkPath: string, kind: "vrm-files" | "background") => { calls.assetList.push({ adkPath, kind }); return [{ url: "u", label: "l", path: "/p/x.vrm", type: "image" as const }]; } },
    oauth: { launch: async () => { calls.oauthLaunch++; } },
    gateway: { authUpdate: async (k: string) => { calls.authUpdate.push(k); }, sync: async (c: NaiaConfig) => { calls.sync.push(c); } },
    config: { read: async () => local, write: async (adkPath: string, agentView: unknown) => { calls.configWrite.push({ adkPath, agentView }); } },
    bootState: {
      mergeFromFile: async () => {}, isOnboardingComplete: async () => false,
      loadLocalConfig: async () => local, loadLocalConfigWithSecrets: async () => local,
      replaceLocalConfig: async (c: NaiaConfig) => { calls.replaceLocalConfig.push(c); local = c; },
      resetLocalConfig: async () => {}, setWorkspaceRoot: async () => {}, clearWorkspaceRoot: async () => {},
      markOnboardingComplete: async () => { calls.markComplete++; },
    },
    creds: { writeAgentKey: async (envKey: string, value: string) => { calls.writeAgentKey.push({ envKey, value }); } },
    adkPath: { get: async () => ({ present: true as const, path: "/adk" }), set: async () => {}, detectRoot: async () => null },
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fakes
  return { ctrl: new OnboardingController(deps as any), calls };
}

describe("UC12 app — OnboardingController (contract §B.3)", () => {
  it("complete() → 영속 순서: replaceLocalConfig(secret strip) + config.write(forAgent) + secret→키체인 + markComplete + gateway.sync", async () => {
    const { ctrl, calls } = makeFakes();
    await ctrl.submit({ step: "welcome" });
    await ctrl.submit({ step: "agentName", agentName: "나이아" });
    await ctrl.submit({ step: "userName", userName: "루크" });
    await ctrl.submit({ step: "speechStyle", speechStyle: "반말" });
    await ctrl.submit({ step: "character", vrmModel: "/v.vrm" });
    await ctrl.submit({ step: "background", background: "space" });
    await ctrl.submit({ step: "provider", provider: "glm", model: "glm-4.6", apiKey: "K" });
    await ctrl.complete();
    // 로컬엔 secret 없음
    expect(calls.replaceLocalConfig[0].secret).toEqual({});
    expect(calls.replaceLocalConfig[0].naiaKey).toBeUndefined();
    // agent-file write
    expect(calls.configWrite[0].adkPath).toBe("/adk");
    // secret → 키체인(glm→GLM_API_KEY)
    expect(calls.writeAgentKey).toContainEqual({ envKey: "GLM_API_KEY", value: "K" });
    expect(calls.markComplete).toBe(1);
    expect(calls.sync.length).toBe(1);
  });

  it("onNaiaAuthCallback → naiaKey 키체인(NAIA_ANYLLM_API_KEY) + authUpdate 1회; idempotent", async () => {
    const { ctrl, calls } = makeFakes();
    await ctrl.onNaiaAuthCallback({ naiaKey: "NK" });
    await ctrl.onNaiaAuthCallback({ naiaKey: "NK2" }); // 중복 = no-op
    expect(calls.writeAgentKey).toContainEqual({ envKey: "NAIA_ANYLLM_API_KEY", value: "NK" });
    expect(calls.authUpdate).toEqual(["NK"]); // 1회만
    expect(ctrl.current().naiaLoginDone).toBe(true);
  });

  it("assets() → adkPath.get + assets.list(path, kind)", async () => {
    const { ctrl, calls } = makeFakes();
    const a = await ctrl.assets("vrm-files");
    expect(calls.assetList).toEqual([{ adkPath: "/adk", kind: "vrm-files" }]);
    expect(a[0].path).toBe("/p/x.vrm");
  });

  it("startNaiaAuth() → oauth.launch", async () => {
    const { ctrl, calls } = makeFakes();
    await ctrl.startNaiaAuth();
    expect(calls.oauthLaunch).toBe(1);
  });

  it("update(providerChanged) → 구 secret 미보존(R12-1)", async () => {
    const { ctrl, calls } = makeFakes({ agent: { provider: "glm" }, ui: {}, secret: { apiKey: "OLD" } });
    await ctrl.update({ agent: { provider: "openai" }, secret: { apiKey: "NEW" }, providerChanged: true });
    // 영속된 cfg(gateway.sync)에 구 apiKey 없음, 신 키만
    const synced = calls.sync[0];
    expect((synced.secret as Record<string, unknown>).apiKey).toBe("NEW");
    expect(calls.writeAgentKey).toContainEqual({ envKey: "OPENAI_API_KEY", value: "NEW" });
  });

  it("update(키 외 변경) → 기존 apiKey 보존(R6 — secret 포함 base 병합)", async () => {
    const { ctrl, calls } = makeFakes({ agent: { provider: "glm" }, ui: {}, secret: { apiKey: "KEEP" } });
    await ctrl.update({ ui: { theme: "dark" } });
    const synced = calls.sync[0];
    expect((synced.secret as Record<string, unknown>).apiKey).toBe("KEEP"); // 보존
    expect((synced.ui as Record<string, unknown>).theme).toBe("dark");
  });
});
