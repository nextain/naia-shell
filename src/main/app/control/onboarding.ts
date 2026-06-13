// app/control/onboarding — UC12 OnboardingController (contract §B.3). 포트만 의존(구상 직접의존 0).
import {
  advance,
  applyNaiaLogin,
  completeOnboarding,
  initialOnboarding,
  type OnboardingState,
  type StepInput,
} from "../../domain/onboarding.js";
import { baseConfig, forAgent, resolveAgentEnvKey, stripSecret, type NaiaConfig } from "../../domain/config.js";
import type {
  AdkPathPort,
  AssetInventoryPort,
  AssetRef,
  BootStatePort,
  ConfigPatch,
  ConfigPort,
  CredentialStorePort,
  OAuthPort,
  OnboardingFlowPort,
  SettingsPort,
} from "../../ports/index.js";

interface Deps {
  readonly assets: AssetInventoryPort;
  readonly oauth: OAuthPort;
  readonly config: ConfigPort;
  readonly bootState: BootStatePort;
  readonly creds: CredentialStorePort;
  readonly adkPath: AdkPathPort;
}

export class OnboardingController implements OnboardingFlowPort, SettingsPort {
  private state: OnboardingState = initialOnboarding();
  constructor(private readonly p: Deps) {}

  current(): OnboardingState {
    return this.state;
  }

  async submit(input: StepInput): Promise<OnboardingState> {
    this.state = advance(this.state, input); // 순수 — asset 기본선택은 호출측이 assets()로 미리 resolve
    return this.state;
  }

  async assets(kind: "vrm-files" | "background"): Promise<readonly AssetRef[]> {
    const adk = await this.p.adkPath.get();
    if (!adk.present) return [];
    return this.p.assets.list(adk.path, kind);
  }

  async startNaiaAuth(): Promise<void> {
    await this.p.oauth.launch();
  }

  async onNaiaAuthCallback(payload: { naiaKey: string }): Promise<OnboardingState> {
    if (this.state.naiaLoginDone) return this.state; // idempotent (R2-5)
    this.state = applyNaiaLogin(this.state, payload.naiaKey);
    const envKey = resolveAgentEnvKey("nextain", "naiaKey"); // → NAIA_ANYLLM_API_KEY (agent 가 env 로 읽음 = naiaKey 의 실 전달 경로)
    if (envKey) await this.p.creds.writeAgentKey(envKey, payload.naiaKey);
    return this.state;
  }

  async complete(): Promise<void> {
    // 가드(UC12 리뷰): provider 또는 naia 로그인 없이 complete 금지(건너뜀 0 — empty draft 로 onboardingComplete 방지).
    const provider = (this.state.draft.agent as Record<string, unknown>).provider;
    if (!provider && !this.state.naiaLoginDone) {
      throw new Error("온보딩 미완료: provider 또는 naia 로그인 없이 complete 불가");
    }
    await this.persist(completeOnboarding(this.state.draft));
    await this.p.bootState.markOnboardingComplete();
  }

  /** §D 신규계약(2026-06-14): 외부에서 빌드한 완성 config 로 온보딩 완료(셸-graft seam).
   *  complete() 는 내부 draft(submit 구동)에서 persist 하나, 실 셸 OnboardingWizard 는 자체 snapshot 으로
   *  외부 config 를 빌드 → 이 메서드로 동일 persist 경로(+markComplete) 재사용. 부작용 = complete() 와 동일. */
  async completeWith(cfg: NaiaConfig): Promise<void> {
    await this.persist(cfg);
    await this.p.bootState.markOnboardingComplete();
  }

  /** S02/S03 설정 편집 — base(secret 포함 read) per-category 병합 → 동일 영속. */
  async update(patch: ConfigPatch): Promise<void> {
    const base = (await this.p.bootState.loadLocalConfigWithSecrets()) ?? baseConfig();
    const merged: NaiaConfig = {
      ...base,
      agent: { ...base.agent, ...(patch.agent ?? {}) },
      ui: { ...base.ui, ...(patch.ui ?? {}) },
      // provider 전환 = 구 secret 미보존(R12-1): patch.secret 만; 아니면 per-category 병합.
      secret: patch.providerChanged ? { ...(patch.secret ?? {}) } : { ...base.secret, ...(patch.secret ?? {}) },
      ...(patch.naiaKey !== undefined ? { naiaKey: patch.naiaKey } : {}),
    };
    await this.persist(merged);
    // R12-1(UC13/F0 패턴, #329 방지): provider 전환 시 구 provider 의 키체인 envKey clear — stale 키 잔존→Unauthorized 차단.
    if (patch.providerChanged) {
      const oldProvider = String((base.agent as Record<string, unknown>).provider ?? "");
      const newProvider = String((merged.agent as Record<string, unknown>).provider ?? "");
      const oldEnvKey = resolveAgentEnvKey(oldProvider, "apiKey");
      const newEnvKey = resolveAgentEnvKey(newProvider, "apiKey");
      if (oldEnvKey && oldEnvKey !== newEnvKey) await this.p.creds.writeAgentKey(oldEnvKey, ""); // 구 키 비움
    }
  }

  /** 공통 영속(R3/R9/R10): 로컬=secret strip, agent-file=forAgent, secret→키체인(도메인 envKey 매핑). */
  private async persist(cfg: NaiaConfig): Promise<void> {
    const adk = await this.p.adkPath.get();
    await this.p.bootState.replaceLocalConfig(stripSecret(cfg)); // 로컬엔 secret 미포함
    if (adk.present) await this.p.config.write(adk.path, forAgent(cfg)); // agent-file = secret+ui strip
    const provider = String((cfg.agent as Record<string, unknown>).provider ?? "");
    const apiKey = (cfg.secret as Record<string, unknown>).apiKey;
    if (typeof apiKey === "string" && apiKey) {
      const envKey = resolveAgentEnvKey(provider, "apiKey");
      if (envKey) await this.p.creds.writeAgentKey(envKey, apiKey); // 키 없는 provider=null=skip(R11)
    }
    if (cfg.naiaKey) {
      const envKey = resolveAgentEnvKey(provider, "naiaKey");
      if (envKey) await this.p.creds.writeAgentKey(envKey, cfg.naiaKey);
    }
  }
}
