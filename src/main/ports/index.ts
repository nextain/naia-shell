// ports — F0 control-plane driven 인터페이스 (contract §B.2). domain 만 의존.
// ⚠️ 모든 driven 포트 = async(Promise) — 실제 Tauri invoke 가 async(런타임 정정). substrate-agnostic 정합.
import type { NaiaConfig, AgentView } from "../domain/config.js";
import type { AdkPath, SetupMode, AdkDirState } from "../domain/boot.js";
import type { SetRootResult, CanonicalRoot } from "../domain/workspace.js";
import type { StartupMessage } from "../domain/startup.js";

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
  listInstalled(): Promise<readonly unknown[]>; // panel_list_installed
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

export type { NaiaConfig, AgentView, AdkPath, SetupMode, AdkDirState, SetRootResult, CanonicalRoot, StartupMessage };
