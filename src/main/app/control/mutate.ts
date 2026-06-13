// app/control/MutationGate — F3 (contract §B.3). 포트만 사용. 인지 0.
// 승인 먼저(F1) → host-system mutate(F3) → observed(F2) → reafference → 불확정 abort.
import { ApprovalGate, type GateInput } from "./approval.js";
import type { ContextIdentity, ActionScope } from "../../domain/approval.js";
import type { EnvironmentMutatePort } from "../../ports/f3.js";
import { isDenied } from "../../ports/f2.js";
import type { EnvironmentObservePort } from "../../ports/f2.js";
import {
  isBlockedCommand, isFileOp, classifyReafference, uncertainFromOutcome,
  type MutationCommand, type Reafference, type UncertainState, type Disposition,
} from "../../domain/mutate.js";

export type MutationResult =
  | { readonly kind: "blocked"; readonly reason: "unsafe" | "tier-T3" | "denied" | "drift" }
  | { readonly kind: "done"; readonly reafference: Reafference }
  | { readonly kind: "aborted"; readonly reafference: Reafference; readonly uncertain: UncertainState; readonly disposition: Disposition };

export interface MutationGatePorts {
  approvalGate: ApprovalGate;
  mutate: EnvironmentMutatePort;
  observe: EnvironmentObservePort; // reafference observed (F2 재사용)
}

export class MutationGate {
  constructor(private readonly p: MutationGatePorts) {}

  /**
   * FR-F3.1 승인 먼저 → 3.2 reafference → 3.3 불확정 abort.
   * @param exec 실행-시점 재샘플 context/scope (승인-시점과 다르면 drift). 생략 시 atomic(승인=실행).
   * FR-F1.3: 실패는 격리된 구조적 결과(throw 전파 X, planning 오염 X).
   */
  async execute(
    cmd: MutationCommand, gateInput: GateInput, expected: string | null,
    exec?: { context: ContextIdentity; scope: ActionScope },
  ): Promise<MutationResult> {
    // 1. CommandSafety (T3 blocked·sensitive) — 미실행
    if (isBlockedCommand(`${cmd.target} ${cmd.body}`)) return { kind: "blocked", reason: "unsafe" };

    // 2. 승인 *먼저* (F1)
    const gated = await this.p.approvalGate.gate(gateInput);
    if (gated.outcome.kind === "blocked") {
      return { kind: "blocked", reason: gated.outcome.reason === "tier-T3" ? "tier-T3" : "denied" };
    }
    // 2b. 실행 직전 drift (FR-F1.4) — 실행-시점 context 로 검사(승인↔실행 사이 변화 감지). 필수.
    const at = exec ?? { context: gateInput.context, scope: gateInput.scope };
    const auth = this.p.approvalGate.authorizeExecution(gated.binding, at);
    if (auth.kind === "blocked") return { kind: "blocked", reason: "drift" };

    // 3. mutate (async, 실행 개시)
    let ack;
    try { ack = await this.p.mutate.apply(cmd); }
    catch {
      const reaf = classifyReafference(cmd, false, expected, null, true);
      return { kind: "aborted", reafference: reaf, uncertain: "ackNotObserved", disposition: "abort" };
    }

    // 4. observed (op 종류별): file → 재-read(F2), exec/pty → ack.output
    let observed: string | null = null;
    let observeFailed = false;
    if (isFileOp(cmd.op)) {
      try {
        const st = await this.p.observe.fileStatus(cmd.target);
        if (isDenied(st)) observeFailed = true; // 거부=관측 불가 → 불확정(contain, FR-F3.3)
        else observed = st.value;
      } catch { observeFailed = true; }
    } else {
      observed = ack.output ?? null;
    }

    // 5. reafference 분류
    const reaf = classifyReafference(cmd, ack.accepted, expected, observed, observeFailed);

    // 6. mismatch/observationFailed → abort + 미확정 정직 (FR-F3.3, rollback 가정 금지)
    if (reaf.outcome !== "match") {
      const uncertain = uncertainFromOutcome(reaf.outcome) ?? "partial";
      return { kind: "aborted", reafference: reaf, uncertain, disposition: "abort" };
    }
    return { kind: "done", reafference: reaf };
  }
}
