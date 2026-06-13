// adapters/tauri/live — F0 실배선 어댑터 (graft용). ⚠️ new-naia-os 는 @tauri-apps/api 에
// 의존하지 않는다 — old 의 함수(invoke·config·adk-store)를 *주입*받는다. graft 시 old 가 실제 함수 전달.
import type { ControlPlanePorts } from "../../app/control/boot.js";
import { toNaiaConfig } from "./config-map.js";
import type { NaiaConfig } from "../../ports/index.js";
import type { AdkDirStatus } from "../../domain/boot.js";

/** graft 시 old-naia-os 가 주입하는 실제 함수들. */
export interface LiveDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  loadConfig: () => Record<string, unknown> | null; // localStorage (sync)
  saveConfig: (c: Record<string, unknown>) => void;
  loadConfigWithSecrets: () => Promise<Record<string, unknown> | null>;
  getAdkPath: () => string | null;
  setAdkPath: (path: string) => void;
  isOnboardingComplete: () => boolean;
}

const toCfg = (flat: Record<string, unknown> | null): NaiaConfig | null => (flat ? toNaiaConfig(flat) : null);

/** old 함수 주입 → F0 control-plane 실배선 포트. */
export function makeF0LiveAdapters(d: LiveDeps): ControlPlanePorts {
  return {
    config: {
      async read(adkPath) { const s = (await d.invoke("read_naia_config", { adkPath })) as string | null; return s ? toNaiaConfig(JSON.parse(s)) : null; },
      async write(adkPath, agentView) { await d.invoke("write_naia_config", { adkPath, json: JSON.stringify(agentView.agent) }); },
    },
    bootState: {
      async mergeFromFile(config) { const cur = d.loadConfig() ?? {}; d.saveConfig({ ...cur, ...config.agent, ...config.secret, ...config.ui }); },
      async isOnboardingComplete() { return d.isOnboardingComplete(); },
      async loadLocalConfig() { return toCfg(d.loadConfig()); },
      async loadLocalConfigWithSecrets() { return toCfg(await d.loadConfigWithSecrets()); },
      async replaceLocalConfig(config) { d.saveConfig({ ...config.agent, ...config.secret, ...config.ui, ...(config.workspaceRoot ? { workspaceRoot: config.workspaceRoot } : {}), ...(config.onboardingComplete ? { onboardingComplete: true } : {}) }); },
      async resetLocalConfig() { d.saveConfig({}); },
      async setWorkspaceRoot(path) { d.saveConfig({ ...(d.loadConfig() ?? {}), workspaceRoot: path }); },
      async clearWorkspaceRoot() { const c = d.loadConfig() ?? {}; delete (c as Record<string, unknown>)["workspaceRoot"]; d.saveConfig(c); },
      async markOnboardingComplete() { d.saveConfig({ ...(d.loadConfig() ?? {}), onboardingComplete: true }); },
    },
    adkPath: {
      async get() { const p = d.getAdkPath(); return p ? { present: true, path: p } : { present: false }; },
      async set(path) { const normalized = path.replace(/[/\\]+$/, ""); d.setAdkPath(normalized); await d.invoke("write_naia_path_cache", { adkPath: normalized }); }, // F0-6: cache 도 normalized
      async detectRoot() { try { const p = (await d.invoke("workspace_detect_adk_root")) as string | null; return p ? { present: true, path: p } : null; } catch { return null; } }, // F0-7: 미발견 reject→null
    },
    workspace: {
      async setRoot(rawPath) { try { const canonical = String(await d.invoke("workspace_set_root", { root: rawPath })); return { ok: true, root: { kind: "canonical-root", path: canonical } }; } catch (e) { return { ok: false, error: String(e) }; } }, // F0-3: Rust canonicalize 반환값 사용(raw 라벨 금지)
      async startWatch() { await d.invoke("workspace_start_watch"); },
      async stopWatch() { await d.invoke("workspace_stop_watch"); },
    },
    startup: {
      async store(msg) { await d.invoke("store_startup_message", { message: JSON.stringify(msg) }); },
      async send(msg) { await d.invoke("send_to_agent_command", { message: JSON.stringify(msg) }); },
    },
    panels: {
      async listInstalled() { return (await d.invoke("panel_list_installed")) as readonly unknown[]; },
    },
    setup: {
      async initSettings(adkPath) { await d.invoke("init_naia_settings", { adkPath }); },
      async copyBundledAssets(adkPath) { await d.invoke("copy_bundled_assets", { adkPath }); },
      async inspectAdkDir(path) { // F0-1: Rust inspect_adk_dir 는 bare string 반환 — 4-state 그대로 매핑(이전 {exists,isAdk} 캐스팅=BLOCKER)
        const s = String(await d.invoke("inspect_adk_dir", { adkPath: path }));
        const status: AdkDirStatus = (s === "empty" || s === "has_settings" || s === "has_other_files") ? s : "missing";
        return { status };
      },
      async cloneAdk(path) { await d.invoke("clone_naia_adk", { adkPath: path }); },
      async deleteAdk(path) { await d.invoke("delete_naia_adk", { adkPath: path }); },
    },
  };
}
