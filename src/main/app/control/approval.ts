// app/control/ApprovalGate — F1 (contract §B.3 ②). 포트만 사용. 인지 0.
import type { ApprovalPort, PersistentGrantPort } from "../../ports/f1.js";
import {
  isBlocked, needsApproval, isAutoBypass, isPreExecDrift, contextDigest,
  type ActionScope, type ApprovalBinding, type ApprovalRequest, type GateOutcome,
  type ContextIdentity,
} from "../../domain/approval.js";

export interface ApprovalGatePorts {
  approval: ApprovalPort;
  grant: PersistentGrantPort;
}

/** 게이트 입력 — tool/args/toolCallId/sessionId + 결속 컨텍스트(binding 은 게이트가 생성). */
export interface GateInput {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly toolCallId: string;
  readonly sessionId: string;
  readonly context: ContextIdentity; // binding digest 소스 (게이트 author)
  readonly scope: ActionScope; // 승인 결속 행위 스코프
  readonly correlationId: string;
}

export interface GateResult {
  readonly outcome: GateOutcome;
  readonly binding: ApprovalBinding; // 게이트가 author — 외부 위조 불가
}

export class ApprovalGate {
  constructor(private readonly p: ApprovalGatePorts) {}

  /**
   * §B.3 gate: classify(신뢰 X) → T3 block → auto-bypass(인자조건) → pre-grant → request(+게이트-author binding).
   * always → PersistentGrantPort.add (영구 grant 저장). reject/expired/duplicate → block.
   * FR-F1.3: 승인 실패는 격리 negative 결과(downstream 오염 금지).
   */
  async gate(input: GateInput): Promise<GateResult> {
    const tier = await this.p.approval.classify(input.tool, input.args); // ⚠️ 호출자 tier 신뢰 X (codex HIGH)
    const binding: ApprovalBinding = {
      correlationId: input.correlationId,
      digest: contextDigest(input.context),
      scope: input.scope,
    };
    const block = (reason: "tier-T3" | "denied"): GateResult => ({ outcome: { kind: "blocked", reason }, binding });
    const approve = (via: "auto-bypass" | "pre-grant" | "user-once"): GateResult => ({ outcome: { kind: "approved", via }, binding });

    if (isBlocked(tier)) return block("tier-T3");
    if (isAutoBypass(input.tool, input.args)) return approve("auto-bypass");
    if (tier === "T0" || (await this.p.grant.isAllowed(input.tool))) return approve("pre-grant");
    if (!needsApproval(tier)) return approve("pre-grant");

    const req: ApprovalRequest = {
      tool: input.tool, args: input.args, tier, toolCallId: input.toolCallId, sessionId: input.sessionId,
    };
    const decision = await this.p.approval.request(req, binding);
    if (decision === "always") {
      await this.p.grant.add(input.tool); // 영구 grant 저장 (codex MED). D40: 정책상 추후 거부 가능.
      return approve("user-once");
    }
    if (decision === "once") return approve("user-once");
    return block("denied"); // reject·expired·duplicate
  }

  /**
   * 실행 직전 인가 — pre-exec drift 검사(FR-F1.4). **실행자가 binding 으로 반드시 호출**.
   * 불일치 = block(재승인, side-effect 없음).
   */
  authorizeExecution(binding: ApprovalBinding, now: { context: ContextIdentity; scope: ActionScope }): GateOutcome {
    const driftNow = { digest: contextDigest(now.context), scope: now.scope };
    return isPreExecDrift(binding, driftNow) ? { kind: "blocked", reason: "drift" } : { kind: "approved", via: "user-once" };
  }
}
