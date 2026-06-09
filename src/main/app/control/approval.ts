// app/control/ApprovalGate — F1 (contract §B.3 ②). 포트만 사용. 인지 0.
import type { ApprovalPort, PersistentGrantPort } from "../../ports/f1.js";
import {
  isBlocked, needsApproval, isAutoBypass, isPreExecDrift,
  type ActionScope, type ApprovalBinding, type ApprovalRequest, type GateOutcome,
} from "../../domain/approval.js";

export interface ApprovalGatePorts {
  approval: ApprovalPort;
  grant: PersistentGrantPort;
}

export class ApprovalGate {
  constructor(private readonly p: ApprovalGatePorts) {}

  /**
   * §B.3 gate: classify → T3 block → auto-bypass → pre-grant → request(+binding).
   * 실행 *전* drift 재검사 = block(재승인). 실행 후 drift = F3 소관.
   * FR-F1.3: 승인 실패는 격리된 negative 결과 — downstream(plan/route/skill) 오염 금지.
   */
  gate(req: ApprovalRequest, binding: ApprovalBinding): GateOutcome {
    if (isBlocked(req.tier)) return { kind: "blocked", reason: "tier-T3" };
    if (isAutoBypass(req.tool)) return { kind: "approved", via: "auto-bypass" };
    if (req.tier === "T0" || this.p.grant.isAllowed(req.tool)) {
      return { kind: "approved", via: "pre-grant" };
    }
    if (!needsApproval(req.tier)) return { kind: "approved", via: "pre-grant" };

    const decision = this.p.approval.request(req, binding);
    if (decision !== "once" && decision !== "always") {
      return { kind: "blocked", reason: "denied" }; // reject·expired·duplicate
    }
    return { kind: "approved", via: "user-once" };
  }

  /** 실행 직전 drift 재검사 (FR-F1.4) — 불일치 = block(재승인, side-effect 없음). */
  checkPreExecDrift(binding: ApprovalBinding, now: { digest: string; scope: ActionScope }): GateOutcome | null {
    return isPreExecDrift(binding, now) ? { kind: "blocked", reason: "drift" } : null;
  }
}
