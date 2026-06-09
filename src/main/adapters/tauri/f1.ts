// adapters/tauri/f1 — F1 driven adapter STUBS (contract §B.4). 라이브 배선 대기 (async).
import type {
  InteroceptivePort, ApprovalPort, PersistentGrantPort,
  SystemStatus, DeviceStatus, DegradationSignal, Tier, ApprovalRequest, ApprovalBinding, ApprovalDecision,
} from "../../ports/f1.js";

class NotWired extends Error {
  constructor(cmd: string) { super(`Tauri adapter not wired (라이브 trace 대기): ${cmd}`); }
}

export const tauriInteroceptive: InteroceptivePort = {
  async systemStatus(): Promise<SystemStatus> { throw new NotWired("gateway_health/skill_system_status"); },
  async diagnostics(): Promise<readonly unknown[]> { throw new NotWired("skill_diagnostics"); },
  async devices(): Promise<readonly DeviceStatus[]> { throw new NotWired("list_audio_output_devices"); },
  async degradations(): Promise<readonly DegradationSignal[]> { throw new NotWired("registry.fetchModels(connected)+probe"); },
};

export const agentWireApproval: ApprovalPort = {
  async classify(_t: string, _a: Readonly<Record<string, unknown>>): Promise<Tier> { throw new NotWired("tool-tiers classify"); },
  async request(_r: ApprovalRequest, _b: ApprovalBinding): Promise<ApprovalDecision> { throw new NotWired("waitForApproval/send_to_agent_command"); },
};

export const configGrant: PersistentGrantPort = {
  async isAllowed(_t: string): Promise<boolean> { throw new NotWired("isToolAllowed"); },
  async add(_t: string): Promise<void> { throw new NotWired("addAllowedTool"); },
};
