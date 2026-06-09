// composition root — F0 (contract §B.5). 와이어링은 이 1곳에만.
// 슬라이스는 Factory/Registry 포트만 노출 → 여기서 주입.
import { ControlPlaneBoot, type ControlPlanePorts } from "../app/control/boot.js";
import {
  tauriConfig, tauriBootState, tauriAdkPath, tauriWorkspace,
  tauriStartup, tauriPanels, tauriSetup,
} from "../adapters/tauri/index.js";

/** Tauri 어댑터 주입한 control-plane (라이브). */
export function wireControlPlaneTauri(): ControlPlaneBoot {
  const ports: ControlPlanePorts = {
    config: tauriConfig,
    bootState: tauriBootState,
    adkPath: tauriAdkPath,
    workspace: tauriWorkspace,
    startup: tauriStartup,
    panels: tauriPanels,
    setup: tauriSetup,
  };
  return new ControlPlaneBoot(ports);
}

/** 임의 포트 주입 (테스트/대체 substrate). */
export function wireControlPlane(ports: ControlPlanePorts): ControlPlaneBoot {
  return new ControlPlaneBoot(ports);
}
