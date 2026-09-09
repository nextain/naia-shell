// app/control/env-tool — #499 조립 (FR-ENV-TOOL.1~9·14). 포트만 사용. 판정 규칙 0.
// 계약: docs/progress/issue-497-universal-agent.md, docs/progress/issue-582-ego-browser-host.md (4.4·4.7).
// 여기가 드는 것 셋: 종결 상태 CAS, 진행 중 멱등 공유, 실제 deadline.
import type { BrowserOperationPort, CancellationPort, TerminalOperationPort } from "../../ports/env-tool.js";
import type { StructuredCommand } from "../../domain/herdr-control.js";
import { isStructuredCommand } from "../../domain/herdr-control.js";
import {
  EnvOperationFailure,
  admitEnvOperation,
  canTransition,
  coordinateFallbackNote,
  envFailureReasonOf,
  hasEvidence,
  isTerminal,
  terminate,
  type ElementTarget,
  type EnvFailureReason,
  type EnvOperationRequest,
  type EnvRejection,
  type Evidence,
  type OperationState,
  type PageObservation,
  type Termination,
} from "../../domain/env-tool.js";
import type { CapabilityTier } from "../../domain/capability.js";

export interface CompletedOperation {
  readonly operationId: string;
  readonly state: OperationState;
  readonly evidence?: Evidence;
  readonly notes: readonly string[];
  readonly deduplicated: boolean;
}

export type EnvOutcome =
  | { readonly ok: true; readonly operation: CompletedOperation }
  | { readonly ok: false; readonly rejections: readonly EnvRejection[] };

/** 밖에서 보는 작업 장부 한 줄. 늦게 도착한 종결 시도까지 남는다. */
export interface OperationSnapshot {
  readonly state: OperationState;
  readonly reason?: EnvFailureReason;
  readonly partialEffects: readonly string[];
  /** 이미 종결된 뒤에 온 종결 시도. 무시했다는 사실 자체가 증거다. */
  readonly lateTerminations: readonly string[];
}

interface OperationRecord {
  state: OperationState;
  reason?: EnvFailureReason;
  partialEffects: string[];
  lateTerminations: string[];
  readonly controller: AbortController;
}

/** 사유를 못 읽은 실패. 지어내지 않되 한 칸은 채워야 하므로 "사유를 받지 못했다"로 남긴다. */
const UNCLASSIFIED: EnvFailureReason = "disconnected";

export class EnvironmentToolService {
  private readonly operations = new Map<string, OperationRecord>();
  private readonly byIdempotencyKey = new Map<string, CompletedOperation>();
  /** 아직 돌고 있는 작업. 같은 키가 동시에 오면 포트를 두 번 부르지 않는다 (FR-ENV-TOOL.9). */
  private readonly inflight = new Map<string, Promise<EnvOutcome>>();

  constructor(
    private readonly browser: BrowserOperationPort,
    private readonly terminal: TerminalOperationPort,
    private readonly cancellation: CancellationPort,
    private readonly grantedTiers: readonly CapabilityTier[],
  ) {}

  stateOf(operationId: string): OperationState | undefined {
    return this.operations.get(operationId)?.state;
  }

  snapshotOf(operationId: string): OperationSnapshot | undefined {
    const record = this.operations.get(operationId);
    if (!record) return undefined;
    return {
      state: record.state,
      reason: record.reason,
      partialEffects: [...record.partialEffects],
      lateTerminations: [...record.lateTerminations],
    };
  }

  /** 브라우저 클릭. 참조가 없어 좌표를 썼다면 그 사실을 결과에 남긴다 (FR-ENV-TOOL.3). */
  async click(request: EnvOperationRequest, target: ElementTarget, page?: PageObservation): Promise<EnvOutcome> {
    return this.run(request, page, async (signal) => {
      const evidence = await this.browser.click(request, target, signal);
      const note = coordinateFallbackNote(target);
      return { evidence: { kind: "browser", value: evidence } as Evidence, notes: note ? [note] : [] };
    });
  }

  async exec(request: EnvOperationRequest, terminalId: string, command: StructuredCommand, page?: PageObservation): Promise<EnvOutcome> {
    if (!isStructuredCommand(command)) {
      return { ok: false, rejections: [{ code: "workspace-escape", detail: `명령이 구조화되지 않았다: ${command.executable}` }] };
    }
    return this.run(request, page, async (signal) => ({
      evidence: { kind: "terminal", value: await this.terminal.exec(request, terminalId, command, signal) } as Evidence,
      notes: [],
    }));
  }

  /**
   * 취소 (FR-ENV-TOOL.9, #582 4.7). 이미 일어난 일은 남기고 성공으로 승격하지 않는다.
   * 순서가 중요하다: 먼저 종결 자리를 차지하고(CAS), 진행 중 작업의 신호를 끊고, 그다음 포트에 내려간다.
   * 신호를 먼저 끊으면 몸통이 실패로 종결해 취소가 실패로 둔갑한다.
   */
  async cancel(operationId: string): Promise<Termination> {
    const record = this.operations.get(operationId);
    if (!record || !canTransition(record.state, "cancelled")) {
      if (record) record.lateTerminations.push(`cancelled 늦게 도착 — ${record.state} 유지`);
      return terminate("cancelled", []);
    }
    this.settle(operationId, "cancelled", "cancelled");
    record.controller.abort(new EnvOperationFailure("cancelled", `작업 ${operationId} 취소`));
    let partial: readonly string[] = [];
    try {
      partial = await this.cancellation.cancel(operationId);
    } catch (e) {
      record.lateTerminations.push(`취소 포트 실패: ${describe(e)}`);
    }
    record.partialEffects.push(...partial);
    return terminate("cancelled", partial);
  }

  private async run(
    request: EnvOperationRequest,
    page: PageObservation | undefined,
    body: (signal: AbortSignal) => Promise<{ evidence: Evidence; notes: readonly string[] }>,
  ): Promise<EnvOutcome> {
    // 판정이 먼저다. 같은 멱등 키라도 권한 없는 호출자가 남의 결과를 주워 가지 못한다.
    const rejections = admitEnvOperation(request, { grantedTiers: this.grantedTiers, page });
    if (rejections.length > 0) return { ok: false, rejections };

    const cached = this.byIdempotencyKey.get(request.idempotencyKey);
    if (cached) return { ok: true, operation: { ...cached, deduplicated: true } };

    const shared = this.inflight.get(request.idempotencyKey);
    if (shared) {
      const outcome = await shared;
      return outcome.ok ? { ok: true, operation: { ...outcome.operation, deduplicated: true } } : outcome;
    }

    const running = this.execute(request, body);
    this.inflight.set(request.idempotencyKey, running);
    try {
      return await running;
    } finally {
      this.inflight.delete(request.idempotencyKey);
    }
  }

  private async execute(
    request: EnvOperationRequest,
    body: (signal: AbortSignal) => Promise<{ evidence: Evidence; notes: readonly string[] }>,
  ): Promise<EnvOutcome> {
    const record: OperationRecord = {
      state: "accepted",
      partialEffects: [],
      lateTerminations: [],
      controller: new AbortController(),
    };
    this.operations.set(request.operationId, record);
    record.state = "running";

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const failure = new EnvOperationFailure("timeout", `상한 ${request.timeoutMs}ms 를 넘겼다`);
        this.settle(request.operationId, "failed", "timeout");
        record.controller.abort(failure);
        reject(failure);
      }, request.timeoutMs);
    });

    let result: { evidence: Evidence; notes: readonly string[] };
    try {
      const work = body(record.controller.signal);
      // 경주에서 진 쪽이 나중에 실패해도 프로세스를 흔들지 않는다.
      void work.catch(() => undefined);
      result = await Promise.race([work, deadline]);
    } catch (e) {
      // 포트가 실은 사유를 그대로 쓴다. 한 코드로 뭉개면 취소·타임아웃·정책 거부가 구별되지 않는다.
      const reason = envFailureReasonOf(e) ?? UNCLASSIFIED;
      this.settle(request.operationId, reason === "cancelled" ? "cancelled" : "failed", reason);
      return { ok: false, rejections: [{ code: record.reason ?? reason, detail: describe(e) }] };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (!hasEvidence("completed", result.evidence)) {
      this.settle(request.operationId, "failed", "partial");
      return { ok: false, rejections: [{ code: record.reason ?? "partial", detail: "증거 없는 완료는 수용하지 않는다" }] };
    }
    if (!this.settle(request.operationId, "completed", undefined)) {
      // 취소나 타임아웃이 먼저 자리를 차지했다. 늦게 끝난 일은 완료가 되지 않는다.
      return {
        ok: false,
        rejections: [
          { code: record.reason ?? "cancelled", detail: `이미 ${record.state} 로 종결된 작업이다 — 완료로 승격하지 않는다` },
        ],
      };
    }
    const operation: CompletedOperation = {
      operationId: request.operationId,
      state: "completed",
      evidence: result.evidence,
      notes: result.notes,
      deduplicated: false,
    };
    this.byIdempotencyKey.set(request.idempotencyKey, operation);
    return { ok: true, operation };
  }

  /**
   * 종결 상태는 한 번만 쓴다 (#582 4.4). 먼저 종결한 쪽이 남고 늦게 온 쪽은 무시되며,
   * 무시했다는 사실이 장부에 남는다 — 조용히 버리면 나중에 "왜 취소가 완료로 보이나"를 못 푼다.
   */
  private settle(operationId: string, state: OperationState, reason: EnvFailureReason | undefined): boolean {
    const record = this.operations.get(operationId);
    if (!record) return false;
    const attempt = `${state}${reason ? `(${reason})` : ""}`;
    if (isTerminal(record.state) || !canTransition(record.state, state)) {
      record.lateTerminations.push(`${attempt} 늦게 도착 — ${record.state} 유지`);
      return false;
    }
    record.state = state;
    record.reason = reason;
    return true;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
