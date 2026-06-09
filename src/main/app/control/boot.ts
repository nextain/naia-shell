// app/control/ControlPlaneBoot — F0 (contract §B.3). 포트만 사용(adapter 직접 import 금지).
// 인지 0. 순서 결속은 baseline 이 실제 결속한 것만(과결속=drift).
import type {
  ConfigPort, BootStatePort, AdkPathPort, WorkspacePort,
  StartupMessagePort, PanelInventoryPort, AdkSetupPort,
} from "../../ports/index.js";
import { decideBoot, type BootDecision, type SetupMode } from "../../domain/boot.js";
import { hasNaiaKey } from "../../domain/config.js";
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

  /** §3-A boot() — 전역 부팅. 반환 = 게이트 결정(렌더 분기용). */
  boot(): BootDecision {
    // 1. panel list — 게이트 이전, 항상, non-fatal contain
    try { this.p.panels.listInstalled(); } catch { /* non-fatal */ }

    // 2. adk path
    let adk = this.p.adkPath.get();

    // 2b. persisted state normalization — config.workspaceRoot 권위적 (다음 평가용 persist)
    const cfgRoot = this.p.bootState.loadLocalConfig()?.workspaceRoot;
    if (cfgRoot && (!adk.present || adk.path !== cfgRoot)) {
      this.p.adkPath.set(cfgRoot);
    } else if (adk.present && !cfgRoot) {
      this.p.bootState.setWorkspaceRoot(adk.path);
    }

    // 3. 게이트 전 file→local 병합 (adk 있을 때)
    if (adk.present) {
      const config = this.p.config.read(adk.path);
      if (config) this.p.bootState.mergeFromFile(config);
    }

    // 4. 결정 (둘 다 포트 경유)
    const decision = decideBoot(adk.present, this.p.bootState.isOnboardingComplete());

    // 5. SetupRequired → detectRoot 제시 후 게이트 종료 (initAuth 는 §D 독립)
    if (decision === "SetupRequired") {
      this.p.adkPath.detectRoot();
    }
    return decision;
  }

  /** §3-D initAuth() — 게이트와 독립한 mount effect. 고정 순서. */
  initAuth(): void {
    const config = this.p.bootState.loadLocalConfigWithSecrets();
    const kinds = startupMessagesToSend(config !== null, hasNaiaKey(config));
    for (const kind of kinds) {
      const msg = { kind, body: {} };
      this.p.startup.store(msg);
      this.p.startup.send(msg);
    }
  }

  /** §3-B WorkspaceCenterPanel 마운트 — boot 공통 아님. */
  onWorkspacePanelActivate(rawRoot: string): void {
    const result = this.p.workspace.setRoot(rawRoot);
    if (!result.ok) {
      this.p.bootState.clearWorkspaceRoot(); // contain+fallback (block 아님)
    }
    this.p.workspace.startWatch(); // 성공/fallback 후 (마운트+활성화)
  }

  onWorkspacePanelDeactivate(): void {
    this.p.workspace.stopWatch();
  }

  /** §3-C setup 완료 분기 — 모드별 reset/replace + 완료조건. */
  onSetupConfirm(mode: SetupMode, path: string): void {
    if (mode === "new" || mode === "recreate") {
      this.p.setup.inspectAdkDir(path); // 조건부 clone/delete 는 adapter 내부
    }
    this.p.setup.initSettings(path); // init_naia_settings (먼저)
    this.p.setup.copyBundledAssets(path); // asset:// scope 확장

    if (mode === "load") {
      const cfg = this.p.config.read(path);
      if (cfg) this.p.bootState.replaceLocalConfig(cfg);
      this.p.bootState.setWorkspaceRoot(path); // 선택 path 강제 보존
      this.p.bootState.markOnboardingComplete(); // 무조건
    } else if (mode === "use-existing") {
      this.p.bootState.resetLocalConfig();
      const cfg = this.p.config.read(path);
      if (cfg) {
        this.p.bootState.replaceLocalConfig(cfg);
        this.p.bootState.setWorkspaceRoot(path);
        this.p.bootState.markOnboardingComplete(); // cfg 있을 때만
      }
      // cfg null → 미완료(overlay 재진입)
    } else {
      // new/recreate: workspaceRoot 만 — markOnboardingComplete 안 함 → overlay
      this.p.bootState.resetLocalConfig();
      this.p.bootState.setWorkspaceRoot(path);
    }
    this.p.adkPath.set(path); // → 이후 boot() 재평가
  }
}
