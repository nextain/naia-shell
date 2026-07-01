// ports — F0 control-plane driven 인터페이스 (contract §B.2). domain 만 의존.
// ⚠️ 모든 driven 포트 = async(Promise) — 실제 Tauri invoke 가 async(런타임 정정). substrate-agnostic 정합.
import type { NaiaConfig, AgentView } from "../domain/config.js";
import type { AdkPath, SetupMode, AdkDirState } from "../domain/boot.js";
import type { SetRootResult, CanonicalRoot } from "../domain/workspace.js";
import type { StartupMessage } from "../domain/startup.js";
import type { OnboardingState, StepInput } from "../domain/onboarding.js";

export interface ConfigPort {
  read(adkPath: string): Promise<NaiaConfig | null>; // read_naia_config (invoke)
  write(adkPath: string, agentView: AgentView): Promise<void>; // write_naia_config
}

export interface BootStatePort {
  mergeFromFile(config: NaiaConfig): Promise<void>;
  isOnboardingComplete(): Promise<boolean>;
  loadLocalConfig(): Promise<NaiaConfig | null>; // plain loadConfig (no keychain)
  loadLocalConfigWithSecrets(): Promise<NaiaConfig | null>; // initAuth 전용 (secrets)
  replaceLocalConfig(config: NaiaConfig): Promise<void>;
  resetLocalConfig(): Promise<void>;
  setWorkspaceRoot(path: string): Promise<void>;
  clearWorkspaceRoot(): Promise<void>;
  markOnboardingComplete(): Promise<void>;
}

export interface AdkPathPort {
  get(): Promise<AdkPath>;
  set(path: string): Promise<void>; // localStorage + write_naia_path_cache(invoke)
  detectRoot(): Promise<AdkPath | null>; // workspace_detect_adk_root(invoke)
}

export interface WorkspacePort {
  setRoot(rawPath: string): Promise<SetRootResult>; // workspace_set_root(invoke)
  startWatch(): Promise<void>;
  stopWatch(): Promise<void>;
}

export interface StartupMessagePort {
  store(msg: StartupMessage): Promise<void>; // store_startup_message
  send(msg: StartupMessage): Promise<void>; // send_to_agent_command
}

export interface PanelInventoryPort {
  listInstalled(): Promise<readonly unknown[]>; // app_list_installed
}

export interface AdkSetupPort {
  initSettings(adkPath: string): Promise<void>;
  copyBundledAssets(adkPath: string): Promise<void>;
  inspectAdkDir(path: string): Promise<AdkDirState>;
  cloneAdk(path: string): Promise<void>;
  deleteAdk(path: string): Promise<void>;
}

/** DEFERRED — 외부키 영역. */
export interface CredentialStorePort {
  writeAgentKey(envKey: string, value: string): Promise<void>;
}

// ── UC12 (온보딩/설정) — control-plane config 확장 (contract §B.2) ──
export interface AssetRef {
  readonly url: string; // asset:// 또는 blob URL
  readonly label: string;
  readonly path: string; // 절대 경로
  readonly type: "image" | "video";
}

/** 온보딩 자산(VRM/배경) 목록 = {adkPath}/naia-settings/{kind}. driven. */
export interface AssetInventoryPort {
  list(adkPath: string, kind: "vrm-files" | "background"): Promise<readonly AssetRef[]>;
}

// ⚠️ GatewaySyncPort 제거됨(2026-06-12): gateway(openclaw)는 #201에서 제거 — gateway.json 을 읽는 곳이 없음(순수 군더더기).
//    config 영속 = ConfigPort(naia-settings) + CredentialStorePort(키체인). naiaKey = onNaiaAuthCallback 이 키체인에 기록(agent env).
//    cf docs/progress/cleanup-agent-coupling-2026-06-12.md

/** naia OAuth — launch 만 driven (callback 수신=OnboardingFlowPort.onNaiaAuthCallback driving, R15). */
export interface OAuthPort {
  launch(): Promise<void>;
}

/** 온보딩 8단계 flow (driving — UI 호출). asset/oauth 노출로 UI 가 driven 직접호출 안 함(R14). */
export interface OnboardingFlowPort {
  current(): OnboardingState;
  submit(input: StepInput): Promise<OnboardingState>; // input.step = 현재 단계(discriminated)
  assets(kind: "vrm-files" | "background"): Promise<readonly AssetRef[]>;
  startNaiaAuth(): Promise<void>;
  onNaiaAuthCallback(payload: { naiaKey: string }): Promise<OnboardingState>; // R15: payload=resolved naiaKey
  complete(): Promise<void>;
}

/** 설정 편집 patch (categorized 부분 — S02/S03). */
export interface ConfigPatch {
  readonly agent?: Readonly<Record<string, unknown>>;
  readonly ui?: Readonly<Record<string, unknown>>;
  readonly secret?: Readonly<Record<string, unknown>>;
  readonly naiaKey?: string;
  readonly providerChanged?: boolean; // provider 전환 시 구 secret 리셋 신호(R12-1)
}

/** 완료 후 설정 편집 (driving). */
export interface SettingsPort {
  update(patch: ConfigPatch): Promise<void>;
}

export type { NaiaConfig, AgentView, AdkPath, SetupMode, AdkDirState, SetRootResult, CanonicalRoot, StartupMessage, OnboardingState, StepInput };
