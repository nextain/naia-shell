// ports/f1 — F1 driven 인터페이스 (contract §B.2). domain 만 의존.
import type { DegradationSignal, SystemStatus, DeviceStatus } from "../domain/degradation.js";
import type { Tier, ApprovalRequest, ApprovalBinding, ApprovalDecision } from "../domain/approval.js";

export interface InteroceptivePort {
  systemStatus(): SystemStatus;
  diagnostics(): readonly unknown[];
  devices(): readonly DeviceStatus[];
  degradations(): readonly DegradationSignal[]; // probe=adapter, 판정(isDegraded)=domain
}

export interface ApprovalPort {
  classify(tool: string, args: Readonly<Record<string, unknown>>): Tier; // 미매핑=T2
  request(req: ApprovalRequest, binding: ApprovalBinding): ApprovalDecision; // 부재·거부·expired·duplicate
}

/** 영구 승인 저장(정책 격리). D40: always 정책=deferred. */
export interface PersistentGrantPort {
  isAllowed(tool: string): boolean; // config.allowedTools
  add(tool: string): void;
}

export type { DegradationSignal, SystemStatus, DeviceStatus, Tier, ApprovalRequest, ApprovalBinding, ApprovalDecision };
