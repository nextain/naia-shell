// app/control/ControlPlaneBoot — F0 (contract §B.3). 포트만 사용(adapter 직접 import 금지).
// 인지 0. 순서 결속은 baseline 이 실제 결속한 것만. ⚠️ async — 포트가 async(런타임 정정).
import type {
  ConfigPort, BootStatePort, AdkPathPort, WorkspacePort,
  StartupMessagePort, PanelInventoryPort, AdkSetupPort,
} from "../../ports/index.js";
import { decideBoot, adkPrepAction, type BootDecision, type SetupMode } from "../../domain/boot.js";
import { hasNaiaKey, baseConfig } from "../../domain/config.js";
import { startupMessagesToSend } from "../../domain/startup.js";

export interface ControlPlanePorts {
  config: ConfigPort;
  bootState: BootStatePort;
  adkPath: AdkPathPort;
  workspace: WorkspacePort;
  startup: StartupMessagePort;
  panels: PanelInventoryPort;
  setup: AdkSetupPort;
}

export class ControlPlaneBoot {
  constructor(private readonly p: ControlPlanePorts) {}

  /** §3-A boot() — 전역 부팅. 반환 = 게이트 결정. */
  async boot(): Promise<BootDecision> {
    // 1. panel list — 게이트 이전, 항상, non-fatal contain
    try { await this.p.panels.listInstalled(); } catch { /* non-fatal */ }

    // 2. adk path
    const adk = await this.p.adkPath.get();

    // 2b. persisted state normalization — config.workspaceRoot 권위적 (다음 평가용 persist)
    const cfgRoot = (await this.p.bootState.loadLocalConfig())?.workspaceRoot;
    if (cfgRoot && (!adk.present || adk.path !== cfgRoot)) {
      await this.p.adkPath.set(cfgRoot);
    } else if (adk.present && !cfgRoot) {
      await this.p.bootState.setWorkspaceRoot(adk.path);
    }

    // 3. 게이트 전 file→local 병합 (adk 있을 때)
    if (adk.present) {
      const config = await this.p.config.read(adk.path);
      if (config) await this.p.bootState.mergeFromFile(config);
    }

    // 4. 결정 (둘 다 포트 경유)
    const decision = decideBoot(adk.present, await this.p.bootState.isOnboardingComplete());

    // 5. SetupRequired → detectRoot 제시 후 게이트 종료 (initAuth 는 §D 독립)
    if (decision === "SetupRequired") {
      await this.p.adkPath.detectRoot();
    }
    return decision;
  }

  /** §3-D initAuth() — 게이트와 독립한 mount effect. 고정 순서. */
  async initAuth(): Promise<void> {
    const config = await this.p.bootState.loadLocalConfigWithSecrets();
    const kinds = startupMessagesToSend(config !== null, hasNaiaKey(config));
    for (const kind of kinds) {
      const msg = { kind, body: {} };
      await this.p.startup.store(msg);
      await this.p.startup.send(msg);
    }
  }

  /** §3-B 마운트 — setRoot(+성공시 startWatch). 활성화와 분리. */
  async onWorkspacePanelMount(rawRoot: string): Promise<void> {
    const result = await this.p.workspace.setRoot(rawRoot);
    if (!result.ok) {
      await this.p.bootState.clearWorkspaceRoot(); // contain+fallback (block 아님)
    }
    await this.p.workspace.startWatch();
  }

  /** §3-B 활성화 — 인자 없는 startWatch 재호출만. */
  async onWorkspacePanelActivate(): Promise<void> {
    await this.p.workspace.startWatch();
  }

  async onWorkspacePanelDeactivate(): Promise<void> {
    await this.p.workspace.stopWatch();
  }

  /** §3-C setup 완료 분기 — 모드별 reset/replace + 완료조건. */
  async onSetupConfirm(mode: SetupMode, path: string): Promise<void> {
    if (mode === "new" || mode === "recreate") {
      const st = await this.p.setup.inspectAdkDir(path);
      const action = adkPrepAction(mode, st);
      if (action === "delete-then-clone") { await this.p.setup.deleteAdk(path); await this.p.setup.cloneAdk(path); }
      else if (action === "clone") { await this.p.setup.cloneAdk(path); }
    }
    await this.p.setup.initSettings(path);
    await this.p.setup.copyBundledAssets(path);

    if (mode === "load") {
      const cfg = await this.p.config.read(path);
      await this.p.bootState.replaceLocalConfig(cfg ?? baseConfig());
      await this.p.bootState.setWorkspaceRoot(path);
      await this.p.bootState.markOnboardingComplete();
    } else if (mode === "use-existing") {
      await this.p.bootState.resetLocalConfig();
      const cfg = await this.p.config.read(path);
      if (cfg) {
        await this.p.bootState.replaceLocalConfig(cfg);
        await this.p.bootState.setWorkspaceRoot(path);
        await this.p.bootState.markOnboardingComplete();
      }
    } else {
      await this.p.bootState.resetLocalConfig();
      await this.p.bootState.setWorkspaceRoot(path);
    }
    await this.p.adkPath.set(path);
  }
}
