// app/control/env-tool — #499 조립 (FR-ENV-TOOL.1~9·14). 포트만 사용. 판정 규칙 0.
// 계약: docs/progress/issue-497-universal-agent.md, docs/progress/issue-582-ego-browser-host.md (4.4·4.7).
// 여기가 드는 것 셋: 종결 상태 CAS, 진행 중 멱등 공유, 실제 deadline.
import type {
  BrowserOperationPort,
  BrowserScript,
  BrowserWorkspacePort,
  CancellationPort,
  TerminalOperationPort,
} from "../../ports/env-tool.js";
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
  type BrowserEvidence,
  type BrowserWorkspace,
  type ElementTarget,
  type EnvFailureReason,
  type EnvOperationRequest,
  type EnvRejection,
  type Evidence,
  type OperationState,
  type PageObservation,
  type Termination,
} from "../../domain/env-tool.js";
import { ALL_TIERS, type CapabilityTier } from "../../domain/capability.js";

export interface CompletedOperation {
  readonly operationId: string;
  readonly state: OperationState;
  readonly evidence?: Evidence;
  readonly notes: readonly string[];
  readonly deduplicated: boolean;
  /** 평가(evaluate)처럼 값을 돌려주는 RPC 만 채운다. */
  readonly result?: string;
}

/**
 * 효과가 고정된 브라우저 RPC 목록 (#582 4.4, FR-ENV-TOOL.14).
 * 도구가 부를 수 있는 것은 이 목록뿐이다. 임의 자바스크립트 묶음 실행은 여기 없다 —
 * 그것은 터미널 실행과 같은 등급이고 승인 뒤 감독자 핸드셰이크로만 시작된다.
 */
export type BrowserRpc =
  | "createWorkspace"
  | "listWorkspaces"
  | "closeWorkspace"
  | "open"
  | "navigate"
  | "snapshot"
  | "click"
  | "fill"
  | "evaluate"
  | "screenshot"
  | "close";

/**
 * 등급 고정 표. 호출자가 선언한 등급은 판정에 쓰지 않는다 —
 * 선언을 믿으면 낮게 적어 통과하거나 높게 적어 남의 승인을 끌어 쓸 수 있다.
 * 관측은 보기만 하는 둘, 나머지는 전부 워크스페이스 내부 변경이다. 공간 생성·닫기도 변경이다.
 */
export const BROWSER_RPC_TIERS: Readonly<Record<BrowserRpc, CapabilityTier>> = {
  snapshot: "observe",
  screenshot: "observe",
  listWorkspaces: "observe",
  createWorkspace: "workspace-write",
  closeWorkspace: "workspace-write",
  open: "workspace-write",
  navigate: "workspace-write",
  click: "workspace-write",
  fill: "workspace-write",
  evaluate: "workspace-write",
  close: "workspace-write",
};

/**
 * 터미널 실행의 등급 바닥 (#582 S0d, FR-ENV-TOOL.14).
 * 브라우저 RPC 와 달리 터미널 명령의 효과는 목록으로 고정할 수 없으므로 표가 아니라 바닥을 둔다.
 */
export const TERMINAL_EXEC_TIER_FLOOR: CapabilityTier = "workspace-write";

export type EnvOutcome =
  | { readonly ok: true; readonly operation: CompletedOperation }
  | { readonly ok: false; readonly rejections: readonly EnvRejection[] };

/** 증거가 아니라 자원을 돌려주는 RPC 의 결과 (공간 생성·목록·닫기, 페이지 닫기). */
export type ResourceOutcome<T> =
  | { readonly ok: true; readonly operationId: string; readonly value: T }
  | { readonly ok: false; readonly rejections: readonly EnvRejection[] };

/** 밖에서 보는 작업 장부 한 줄. 늦게 도착한 종결 시도까지 남는다. */
export interface OperationSnapshot {
  readonly state: OperationState;
  /** 판정에 실제로 쓴 등급. 선언이 아니라 표가 정한 값이다. */
  readonly tier: CapabilityTier;
  readonly reason?: EnvFailureReason;
  readonly partialEffects: readonly string[];
  /** 이미 종결된 뒤에 온 종결 시도. 무시했다는 사실 자체가 증거다. */
  readonly lateTerminations: readonly string[];
}

interface OperationRecord {
  state: OperationState;
  /** 실제로 판정에 쓴 등급. 호출자 선언이 아니라 RPC 표가 정한 값이다 (FR-ENV-TOOL.14). */
  tier: CapabilityTier;
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
    /** 작업 공간 포트. 아직 배선되지 않은 조립에서는 공간 RPC 가 형식 있는 오류로 끝난다. */
    private readonly workspaces?: BrowserWorkspacePort,
  ) {}

  stateOf(operationId: string): OperationState | undefined {
    return this.operations.get(operationId)?.state;
  }

  snapshotOf(operationId: string): OperationSnapshot | undefined {
    const record = this.operations.get(operationId);
    if (!record) return undefined;
    return {
      state: record.state,
      tier: record.tier,
      reason: record.reason,
      partialEffects: [...record.partialEffects],
      lateTerminations: [...record.lateTerminations],
    };
  }

  /** 브라우저 클릭. 참조가 없어 좌표를 썼다면 그 사실을 결과에 남긴다 (FR-ENV-TOOL.3). */
  async click(request: EnvOperationRequest, target: ElementTarget, page?: PageObservation): Promise<EnvOutcome> {
    return this.runBrowser(request, "click", page, async (fixed, signal) => ({
      evidence: await this.browser.click(fixed, target, signal),
      notes: [coordinateFallbackNote(target)].filter((n): n is string => n !== null),
    }));
  }

  async open(request: EnvOperationRequest, url: string, page?: PageObservation): Promise<EnvOutcome> {
    return this.runBrowser(request, "open", page, async (fixed, signal) => ({ evidence: await this.browser.open(fixed, url, signal), notes: [] }));
  }

  async navigate(request: EnvOperationRequest, url: string, page?: PageObservation): Promise<EnvOutcome> {
    return this.runBrowser(request, "navigate", page, async (fixed, signal) => ({
      evidence: await this.browser.navigate(fixed, url, signal),
      notes: [],
    }));
  }

  async snapshot(request: EnvOperationRequest, page?: PageObservation): Promise<EnvOutcome> {
    return this.runBrowser(request, "snapshot", page, async (fixed, signal) => ({ evidence: await this.browser.snapshot(fixed, signal), notes: [] }));
  }

  async fill(request: EnvOperationRequest, target: ElementTarget, value: string, page?: PageObservation): Promise<EnvOutcome> {
    return this.runBrowser(request, "fill", page, async (fixed, signal) => ({
      evidence: await this.browser.fill(fixed, target, value, signal),
      notes: [coordinateFallbackNote(target)].filter((n): n is string => n !== null),
    }));
  }

  /** 효과가 고정된 평가. 임의 묶음 실행(env_browser_script)이 아니다 — 그것은 터미널 등급이다. */
  async evaluate(request: EnvOperationRequest, script: BrowserScript, page?: PageObservation): Promise<EnvOutcome> {
    return this.runBrowser(request, "evaluate", page, async (fixed, signal) => {
      const evaluation = await this.browser.evaluate(fixed, script, signal);
      return { evidence: evaluation.evidence, notes: [], result: evaluation.result };
    });
  }

  /** 캡처. 파일 경로는 감독자가 정하고 여기로는 참조만 온다 (#582 4.5). */
  async screenshot(request: EnvOperationRequest, page?: PageObservation): Promise<EnvOutcome> {
    return this.runBrowser(request, "screenshot", page, async (fixed, signal) => ({
      evidence: await this.browser.screenshot(fixed, signal),
      notes: [],
    }));
  }

  /** 페이지 닫기. 닫힌 페이지에는 스냅샷이 없으므로 증거가 아니라 자원 결과로 끝난다. */
  async close(request: EnvOperationRequest, page?: PageObservation): Promise<ResourceOutcome<null>> {
    return this.runResource(request, "close", page, async (fixed, signal) => {
      await this.browser.close(fixed, signal);
      return null;
    });
  }

  async createWorkspace(request: EnvOperationRequest, page?: PageObservation): Promise<ResourceOutcome<BrowserWorkspace>> {
    return this.runResource(request, "createWorkspace", page, async (fixed, signal) => this.requireWorkspaces().create(fixed, signal));
  }

  async listWorkspaces(request: EnvOperationRequest, page?: PageObservation): Promise<ResourceOutcome<readonly BrowserWorkspace[]>> {
    return this.runResource(request, "listWorkspaces", page, async (_fixed, signal) => this.requireWorkspaces().list(signal));
  }

  async closeWorkspace(request: EnvOperationRequest, workspaceId: string, page?: PageObservation): Promise<ResourceOutcome<null>> {
    return this.runResource(request, "closeWorkspace", page, async (fixed, signal) => {
      await this.requireWorkspaces().close(fixed, workspaceId, signal);
      return null;
    });
  }

  private requireWorkspaces(): BrowserWorkspacePort {
    if (!this.workspaces) throw new EnvOperationFailure("method-denied", "이 조립에는 브라우저 작업 공간 포트가 없다");
    return this.workspaces;
  }

  /**
   * 터미널 실행 (#582 S0d). 등급 바닥은 `workspace-write` 다 — 명령 하나가 무엇을 하는지는
   * 셸이 미리 알 수 없으므로 "보기만 한다"는 선언은 받지 않는다. 호출자가 더 높은 등급을
   * 선언하면(파괴적 명령 등) 그 높은 쪽으로 판정한다. 낮추는 길은 막고 올리는 길은 둔다.
   * 판정에 쓴 등급은 작업 장부(`snapshotOf().tier`)에 남는다.
   */
  async exec(request: EnvOperationRequest, terminalId: string, command: StructuredCommand, page?: PageObservation): Promise<EnvOutcome> {
    if (!isStructuredCommand(command)) {
      return { ok: false, rejections: [{ code: "workspace-escape", detail: `명령이 구조화되지 않았다: ${command.executable}` }] };
    }
    const floored = withFlooredTier(request, TERMINAL_EXEC_TIER_FLOOR);
    return this.run(floored, page, async (signal) => ({
      evidence: { kind: "terminal", value: await this.terminal.exec(floored, terminalId, command, signal) } as Evidence,
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
    body: (signal: AbortSignal) => Promise<{ evidence: Evidence; notes: readonly string[]; result?: string }>,
  ): Promise<EnvOutcome> {
    // 판정이 먼저다. 같은 멱등 키라도 판정을 통과하지 못한 호출자가 남의 결과를 주워 가지 못한다.
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

  /** 증거를 돌려주는 브라우저 RPC. 등급은 표가 정하고 호출자 선언은 판정에 쓰지 않는다 (FR-ENV-TOOL.14). */
  private async runBrowser(
    request: EnvOperationRequest,
    rpc: BrowserRpc,
    page: PageObservation | undefined,
    body: (fixed: EnvOperationRequest, signal: AbortSignal) => Promise<{ evidence: BrowserEvidence; notes: readonly string[]; result?: string }>,
  ): Promise<EnvOutcome> {
    const fixed = withFixedTier(request, rpc);
    return this.run(fixed, page, async (signal) => {
      const out = await body(fixed, signal);
      return { evidence: { kind: "browser", value: out.evidence } as Evidence, notes: out.notes, result: out.result };
    });
  }

  /**
   * 자원 RPC. 증거를 만들지 않는 대신(닫힌 페이지에는 스냅샷이 없다) 같은 생명주기·상한·취소를 쓴다.
   * 멱등 캐시는 두지 않는다 — 공간을 다시 만들어 달라는 요청과 같은 공간을 달라는 요청은 다른 말이다.
   */
  private async runResource<T>(
    request: EnvOperationRequest,
    rpc: BrowserRpc,
    page: PageObservation | undefined,
    body: (fixed: EnvOperationRequest, signal: AbortSignal) => Promise<T>,
  ): Promise<ResourceOutcome<T>> {
    const fixed = withFixedTier(request, rpc);
    const rejections = admitEnvOperation(fixed, { grantedTiers: this.grantedTiers, page });
    if (rejections.length > 0) return { ok: false, rejections };

    const record = this.begin(fixed);
    const deadline = this.armDeadline(fixed, record);
    let value: T;
    try {
      const work = body(fixed, record.controller.signal);
      void work.catch(() => undefined);
      value = await Promise.race([work, deadline.promise]);
    } catch (e) {
      return { ok: false, rejections: this.failFrom(fixed.operationId, record, e) };
    } finally {
      deadline.disarm();
    }
    if (!this.settle(fixed.operationId, "completed", undefined)) {
      return { ok: false, rejections: [terminalAlready(record)] };
    }
    return { ok: true, operationId: fixed.operationId, value };
  }

  private async execute(
    request: EnvOperationRequest,
    body: (signal: AbortSignal) => Promise<{ evidence: Evidence; notes: readonly string[]; result?: string }>,
  ): Promise<EnvOutcome> {
    const record = this.begin(request);
    const deadline = this.armDeadline(request, record);

    let result: { evidence: Evidence; notes: readonly string[]; result?: string };
    try {
      const work = body(record.controller.signal);
      // 경주에서 진 쪽이 나중에 실패해도 프로세스를 흔들지 않는다.
      void work.catch(() => undefined);
      result = await Promise.race([work, deadline.promise]);
    } catch (e) {
      return { ok: false, rejections: this.failFrom(request.operationId, record, e) };
    } finally {
      deadline.disarm();
    }

    if (!hasEvidence("completed", result.evidence)) {
      this.settle(request.operationId, "failed", "partial");
      return { ok: false, rejections: [{ code: record.reason ?? "partial", detail: "증거 없는 완료는 수용하지 않는다" }] };
    }
    if (!this.settle(request.operationId, "completed", undefined)) {
      // 취소나 타임아웃이 먼저 자리를 차지했다. 늦게 끝난 일은 완료가 되지 않는다.
      return { ok: false, rejections: [terminalAlready(record)] };
    }
    const operation: CompletedOperation = {
      operationId: request.operationId,
      state: "completed",
      evidence: result.evidence,
      notes: result.notes,
      deduplicated: false,
      result: result.result,
    };
    this.byIdempotencyKey.set(request.idempotencyKey, operation);
    return { ok: true, operation };
  }

  private begin(request: EnvOperationRequest): OperationRecord {
    const record: OperationRecord = {
      state: "running",
      tier: request.capability,
      partialEffects: [],
      lateTerminations: [],
      controller: new AbortController(),
    };
    this.operations.set(request.operationId, record);
    return record;
  }

  /** 실제 상한. 만료하면 신호를 끊고 failed(timeout) 으로 종결한다 — 완료로 승격되지 않는다. */
  private armDeadline(request: EnvOperationRequest, record: OperationRecord): { promise: Promise<never>; disarm: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const failure = new EnvOperationFailure("timeout", `상한 ${request.timeoutMs}ms 를 넘겼다`);
        this.settle(request.operationId, "failed", "timeout");
        record.controller.abort(failure);
        reject(failure);
      }, request.timeoutMs);
    });
    // 아무도 안 듣는 거부가 남지 않게 한다.
    void promise.catch(() => undefined);
    return {
      promise,
      disarm: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    };
  }

  /** 포트가 실은 사유를 그대로 쓴다. 한 코드로 뭉개면 취소·타임아웃·정책 거부가 구별되지 않는다. */
  private failFrom(operationId: string, record: OperationRecord, error: unknown): readonly EnvRejection[] {
    const reason = envFailureReasonOf(error) ?? UNCLASSIFIED;
    this.settle(operationId, reason === "cancelled" ? "cancelled" : "failed", reason);
    return [{ code: record.reason ?? reason, detail: describe(error) }];
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

function terminalAlready(record: OperationRecord): EnvRejection {
  return { code: record.reason ?? "cancelled", detail: `이미 ${record.state} 로 종결된 작업이다 — 완료로 승격하지 않는다` };
}

/**
 * 등급 고정 (#582 4.4, FR-ENV-TOOL.14). 호출자가 뭐라 선언했든 RPC 가 등급을 정한다.
 * 낮게 적어 통과하는 길도, 높게 적어 남의 승인을 끌어 쓰는 길도 없다.
 * 무엇으로 판정했는지는 작업 장부(`snapshotOf().tier`)에 남는다.
 */
export function requiredTierFor(rpc: BrowserRpc): CapabilityTier {
  return BROWSER_RPC_TIERS[rpc];
}

function withFixedTier(request: EnvOperationRequest, rpc: BrowserRpc): EnvOperationRequest {
  const required = requiredTierFor(rpc);
  return request.capability === required ? request : { ...request, capability: required };
}

/**
 * 등급 바닥 (#582 S0d). 선언과 바닥 중 `ALL_TIERS` 순서로 높은 쪽을 쓴다.
 * 목록에 없는 선언은 믿지 않고 바닥으로 되돌린다 — 모르는 이름이 바닥을 뚫는 길이 되면 안 된다.
 */
export function flooredTierFor(declared: CapabilityTier, floor: CapabilityTier): CapabilityTier {
  const declaredRank = ALL_TIERS.indexOf(declared);
  const floorRank = ALL_TIERS.indexOf(floor);
  if (declaredRank < 0) return floor;
  return declaredRank > floorRank ? declared : floor;
}

function withFlooredTier(request: EnvOperationRequest, floor: CapabilityTier): EnvOperationRequest {
  const required = flooredTierFor(request.capability, floor);
  return request.capability === required ? request : { ...request, capability: required };
}
