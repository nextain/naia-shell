// ports — F0 control-plane driven 인터페이스 (contract §B.2). domain 만 의존.
import type { NaiaConfig, AgentView } from "../domain/config.js";
import type { AdkPath, SetupMode } from "../domain/boot.js";
import type { SetRootResult, CanonicalRoot } from "../domain/workspace.js";
import type { StartupMessage } from "../domain/startup.js";

export interface ConfigPort {
  read(adkPath: string): NaiaConfig | null; // 없으면 null
  write(adkPath: string, agentView: AgentView): void; // 독립 debounced write-back
}

export interface BootStatePort {
  mergeFromFile(config: NaiaConfig): void; // 부팅 게이트 전용 (setup 엔 X)
  isOnboardingComplete(): boolean;
  loadLocalConfig(): NaiaConfig | null; // plain loadConfig (keychain I/O 없음) — 2b/게이트
  loadLocalConfigWithSecrets(): NaiaConfig | null; // initAuth 전용 (secrets 경로)
  replaceLocalConfig(config: NaiaConfig): void; // setup: 통째 교체(load)
  resetLocalConfig(): void; // setup(use-existing/new/recreate): 비우고 최소 재작성
  setWorkspaceRoot(path: string): void;
  clearWorkspaceRoot(): void; // workspace fallback 시
  markOnboardingComplete(): void;
}

export interface AdkPathPort {
  get(): AdkPath;
  set(path: string): void; // localStorage + ~/.naia/adk-path
  detectRoot(): AdkPath | null; // defaultPath 제시(자동완료 X)
}

export interface WorkspacePort {
  setRoot(rawPath: string): SetRootResult; // canonicalize/is_dir = adapter
  startWatch(): void; // 인자 없음 (패널 mount/onActivate)
  stopWatch(): void; // 패널 onDeactivate
}

export interface StartupMessagePort {
  store(msg: StartupMessage): void; // replay cache
  send(msg: StartupMessage): void; // 라이브 전송
}

export interface PanelInventoryPort {
  listInstalled(): readonly unknown[]; // setup 게이트 이전, 실패=non-fatal contain
}

export interface AdkSetupPort {
  initSettings(adkPath: string): void; // mode 무관 단일 호출
  copyBundledAssets(adkPath: string): void; // asset:// scope 확장
  inspectAdkDir(path: string): unknown; // new/recreate 선행
  cloneAdk(path: string): void;
  deleteAdk(path: string): void;
}

/** DEFERRED — 외부키 영역, 무키 UC12-min 엔 no-op. */
export interface CredentialStorePort {
  writeAgentKey(envKey: string, value: string): void; // OS keychain
}

export type { NaiaConfig, AgentView, AdkPath, SetupMode, SetRootResult, CanonicalRoot, StartupMessage };
