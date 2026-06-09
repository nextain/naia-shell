// adapters/tauri/f1 — F1 driven adapter STUBS (contract §B.4). 라이브 배선 대기.
import type {
  InteroceptivePort, ApprovalPort, PersistentGrantPort,
  SystemStatus, DeviceStatus, DegradationSignal, Tier, ApprovalRequest, ApprovalBinding, ApprovalDecision,
} from "../../ports/f1.js";

class NotWired extends Error {
  constructor(cmd: string) { super(`Tauri adapter not wired (라이브 trace 대기): ${cmd}`); }
}

export const tauriInteroceptive: InteroceptivePort = {
  systemStatus(): SystemStatus { throw new NotWired("gateway_health/skill_system_status"); },
  diagnostics(): readonly unknown[] { throw new NotWired("skill_diagnostics"); },
  devices(): readonly DeviceStatus[] { throw new NotWired("list_audio_output_devices"); },
  degradations(): readonly DegradationSignal[] { throw new NotWired("registry.fetchModels(connected)+probe"); },
};

export const agentWireApproval: ApprovalPort = {
  classify(_t: string, _a: Readonly<Record<string, unknown>>): Tier { throw new NotWired("tool-tiers classify"); },
  request(_r: ApprovalRequest, _b: ApprovalBinding): ApprovalDecision { throw new NotWired("waitForApproval/send_to_agent_command"); },
};

export const configGrant: PersistentGrantPort = {
  isAllowed(_t: string): boolean { throw new NotWired("isToolAllowed"); },
  add(_t: string): void { throw new NotWired("addAllowedTool"); },
};
