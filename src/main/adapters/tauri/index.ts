// adapters/tauri — F0 driven adapter STUBS (contract §B.4). 라이브 배선 대기 (async).
// 계약 테스트는 in-memory mock 포트 사용(src/test).
import type {
  ConfigPort, BootStatePort, AdkPathPort, WorkspacePort,
  StartupMessagePort, PanelInventoryPort, AdkSetupPort, CredentialStorePort,
  NaiaConfig, AgentView, AdkPath, SetRootResult, StartupMessage, AdkDirState,
} from "../../ports/index.js";

class NotWired extends Error {
  constructor(cmd: string) { super(`Tauri adapter not wired (라이브 trace 대기): ${cmd}`); }
}

export const tauriConfig: ConfigPort = {
  async read(_a: string): Promise<NaiaConfig | null> { throw new NotWired("read_naia_config"); },
  async write(_a: string, _v: AgentView): Promise<void> { throw new NotWired("write_naia_config"); },
};

export const tauriBootState: BootStatePort = {
  async mergeFromFile(_c: NaiaConfig): Promise<void> { throw new NotWired("loadConfig/saveConfig"); },
  async isOnboardingComplete(): Promise<boolean> { throw new NotWired("isOnboardingComplete"); },
  async loadLocalConfig(): Promise<NaiaConfig | null> { throw new NotWired("loadConfig"); },
  async loadLocalConfigWithSecrets(): Promise<NaiaConfig | null> { throw new NotWired("loadConfigWithSecrets"); },
  async replaceLocalConfig(_c: NaiaConfig): Promise<void> { throw new NotWired("saveConfig(replace)"); },
  async resetLocalConfig(): Promise<void> { throw new NotWired("saveConfig(reset)"); },
  async setWorkspaceRoot(_p: string): Promise<void> { throw new NotWired("saveConfig(workspaceRoot)"); },
  async clearWorkspaceRoot(): Promise<void> { throw new NotWired("saveConfig(clear root)"); },
  async markOnboardingComplete(): Promise<void> { throw new NotWired("saveConfig(onboardingComplete)"); },
};

export const tauriAdkPath: AdkPathPort = {
  async get(): Promise<AdkPath> { throw new NotWired("getAdkPath"); },
  async set(_p: string): Promise<void> { throw new NotWired("setAdkPath/write_naia_path_cache"); },
  async detectRoot(): Promise<AdkPath | null> { throw new NotWired("workspace_detect_adk_root"); },
};

export const tauriWorkspace: WorkspacePort = {
  async setRoot(_r: string): Promise<SetRootResult> { throw new NotWired("workspace_set_root"); },
  async startWatch(): Promise<void> { throw new NotWired("workspace_start_watch"); },
  async stopWatch(): Promise<void> { throw new NotWired("workspace_stop_watch"); },
};

export const tauriStartup: StartupMessagePort = {
  async store(_m: StartupMessage): Promise<void> { throw new NotWired("store_startup_message"); },
  async send(_m: StartupMessage): Promise<void> { throw new NotWired("send_to_agent_command"); },
};

export const tauriPanels: PanelInventoryPort = {
  async listInstalled(): Promise<readonly unknown[]> { throw new NotWired("app_list_installed"); },
};

export const tauriSetup: AdkSetupPort = {
  async initSettings(_a: string): Promise<void> { throw new NotWired("init_naia_settings"); },
  async copyBundledAssets(_a: string): Promise<void> { throw new NotWired("copy_bundled_assets"); },
  async inspectAdkDir(_p: string): Promise<AdkDirState> { throw new NotWired("inspect_adk_dir"); },
  async cloneAdk(_p: string): Promise<void> { throw new NotWired("clone_naia_adk"); },
  async deleteAdk(_p: string): Promise<void> { throw new NotWired("delete_naia_adk"); },
};

/** DEFERRED — 외부키 영역. */
export const tauriCredentialStore: CredentialStorePort = {
  async writeAgentKey(_k: string, _v: string): Promise<void> { throw new NotWired("write_agent_key"); },
};
