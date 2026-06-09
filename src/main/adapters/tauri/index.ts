// adapters/tauri — F0 driven adapter STUBS (contract §B.4).
// 라이브 배선(Tauri invoke) 대기 — 현재는 NotWired throw. ports 구현만 고정.
// 계약 테스트는 이 stub 이 아니라 in-memory mock 포트를 사용(src/test).
import type {
  ConfigPort, BootStatePort, AdkPathPort, WorkspacePort,
  StartupMessagePort, PanelInventoryPort, AdkSetupPort, CredentialStorePort,
  NaiaConfig, AgentView, AdkPath, SetRootResult, StartupMessage,
} from "../../ports/index.js";

class NotWired extends Error {
  constructor(cmd: string) { super(`Tauri adapter not wired (라이브 trace 대기): ${cmd}`); }
}

export const tauriConfig: ConfigPort = {
  read(_a: string): NaiaConfig | null { throw new NotWired("read_naia_config"); },
  write(_a: string, _v: AgentView): void { throw new NotWired("write_naia_config"); },
};

export const tauriBootState: BootStatePort = {
  mergeFromFile(_c: NaiaConfig): void { throw new NotWired("loadConfig/saveConfig"); },
  isOnboardingComplete(): boolean { throw new NotWired("isOnboardingComplete"); },
  loadLocalConfig(): NaiaConfig | null { throw new NotWired("loadConfig"); },
  loadLocalConfigWithSecrets(): NaiaConfig | null { throw new NotWired("loadConfigWithSecrets"); },
  replaceLocalConfig(_c: NaiaConfig): void { throw new NotWired("saveConfig(replace)"); },
  resetLocalConfig(): void { throw new NotWired("saveConfig(reset)"); },
  setWorkspaceRoot(_p: string): void { throw new NotWired("saveConfig(workspaceRoot)"); },
  clearWorkspaceRoot(): void { throw new NotWired("saveConfig(clear root)"); },
  markOnboardingComplete(): void { throw new NotWired("saveConfig(onboardingComplete)"); },
};

export const tauriAdkPath: AdkPathPort = {
  get(): AdkPath { throw new NotWired("getAdkPath"); },
  set(_p: string): void { throw new NotWired("setAdkPath/write_naia_path_cache"); },
  detectRoot(): AdkPath | null { throw new NotWired("workspace_detect_adk_root"); },
};

export const tauriWorkspace: WorkspacePort = {
  setRoot(_r: string): SetRootResult { throw new NotWired("workspace_set_root"); },
  startWatch(): void { throw new NotWired("workspace_start_watch"); },
  stopWatch(): void { throw new NotWired("workspace_stop_watch"); },
};

export const tauriStartup: StartupMessagePort = {
  store(_m: StartupMessage): void { throw new NotWired("store_startup_message"); },
  send(_m: StartupMessage): void { throw new NotWired("send_to_agent_command"); },
};

export const tauriPanels: PanelInventoryPort = {
  listInstalled(): readonly unknown[] { throw new NotWired("panel_list_installed"); },
};

export const tauriSetup: AdkSetupPort = {
  initSettings(_a: string): void { throw new NotWired("init_naia_settings"); },
  copyBundledAssets(_a: string): void { throw new NotWired("copy_bundled_assets"); },
  inspectAdkDir(_p: string): unknown { throw new NotWired("inspect_adk_dir"); },
  cloneAdk(_p: string): void { throw new NotWired("clone_naia_adk"); },
  deleteAdk(_p: string): void { throw new NotWired("delete_naia_adk"); },
};

/** DEFERRED — 외부키 영역. */
export const tauriCredentialStore: CredentialStorePort = {
  writeAgentKey(_k: string, _v: string): void { throw new NotWired("write_agent_key"); },
};
