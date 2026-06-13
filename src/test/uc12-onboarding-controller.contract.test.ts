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
    markComplete: 0,
    oauthLaunch: 0,
    assetList: [] as { adkPath: string; kind: string }[],
  };
  let local = initialLocal;
  const deps = {
    assets: { list: async (adkPath: string, kind: "vrm-files" | "background") => { calls.assetList.push({ adkPath, kind }); return [{ url: "u", label: "l", path: "/p/x.vrm", type: "image" as const }]; } },
    oauth: { launch: async () => { calls.oauthLaunch++; } },
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
  it("complete() → 영속 순서: replaceLocalConfig(secret strip) + config.write(forAgent) + secret→키체인 + markComplete", async () => {
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
  });

  it("onNaiaAuthCallback → naiaKey 키체인(NAIA_ANYLLM_API_KEY, agent env 경로) 1회; idempotent", async () => {
    const { ctrl, calls } = makeFakes();
    await ctrl.onNaiaAuthCallback({ naiaKey: "NK" });
    await ctrl.onNaiaAuthCallback({ naiaKey: "NK2" }); // 중복 = no-op
    expect(calls.writeAgentKey).toContainEqual({ envKey: "NAIA_ANYLLM_API_KEY", value: "NK" });
    expect(calls.writeAgentKey.filter((w) => w.envKey === "NAIA_ANYLLM_API_KEY")).toHaveLength(1); // 1회만(idempotent)
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

  it("★ complete() 가드: provider/naia 없이 complete → throw(건너뜀 0, empty draft 완료 방지)", async () => {
    const { ctrl } = makeFakes({ agent: {}, ui: {}, secret: {} });
    await expect(ctrl.complete()).rejects.toThrow(); // provider 없음 + naiaLoginDone 아님 → 거부
  });

  it("★ update(providerChanged) → 신 키 기록 + 구 provider 키체인 키 clear(R12-1, #329 stale 키 방지)", async () => {
    const { ctrl, calls } = makeFakes({ agent: { provider: "glm" }, ui: {}, secret: { apiKey: "OLD" } });
    await ctrl.update({ agent: { provider: "openai" }, secret: { apiKey: "NEW" }, providerChanged: true });
    expect(calls.writeAgentKey).toContainEqual({ envKey: "OPENAI_API_KEY", value: "NEW" });
    // ★ 구 GLM 키는 빈값으로 *clear*(stale 키 잔존→agent Unauthorized 차단, UC12 리뷰 BLOCKER fix)
    expect(calls.writeAgentKey).toContainEqual({ envKey: "GLM_API_KEY", value: "" });
  });

  it("update(키 외 변경) → 기존 apiKey 보존(R6) + ui 영속(secret-strip 로컬에 ui 유지)", async () => {
    const { ctrl, calls } = makeFakes({ agent: { provider: "glm" }, ui: {}, secret: { apiKey: "KEEP" } });
    await ctrl.update({ ui: { theme: "dark" } });
    // apiKey 보존 = 키체인에 KEEP 재기록(secret-포함 base 병합). ui = secret-strip 로컬에 유지(stripSecret 은 ui 보존).
    expect(calls.writeAgentKey).toContainEqual({ envKey: "GLM_API_KEY", value: "KEEP" });
    const local = calls.replaceLocalConfig[calls.replaceLocalConfig.length - 1];
    expect((local.ui as Record<string, unknown>).theme).toBe("dark");
  });
});
