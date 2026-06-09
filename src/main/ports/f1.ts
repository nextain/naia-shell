// ports/f1 — F1 driven 인터페이스 (contract §B.2). domain 만 의존. 모든 메서드 async.
import type { DegradationSignal, SystemStatus, DeviceStatus } from "../domain/degradation.js";
import type { Tier, ApprovalRequest, ApprovalBinding, ApprovalDecision } from "../domain/approval.js";

export interface InteroceptivePort {
  systemStatus(): Promise<SystemStatus>;
  diagnostics(): Promise<readonly unknown[]>;
  devices(): Promise<readonly DeviceStatus[]>;
  degradations(): Promise<readonly DegradationSignal[]>; // probe=adapter, 판정(isDegraded)=domain
}

export interface ApprovalPort {
  classify(tool: string, args: Readonly<Record<string, unknown>>): Promise<Tier>; // 미매핑=T2
  request(req: ApprovalRequest, binding: ApprovalBinding): Promise<ApprovalDecision>;
}

export interface PersistentGrantPort {
  isAllowed(tool: string): Promise<boolean>; // config.allowedTools
  add(tool: string): Promise<void>;
}

export type { DegradationSignal, SystemStatus, DeviceStatus, Tier, ApprovalRequest, ApprovalBinding, ApprovalDecision };
