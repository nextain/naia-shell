// domain/env-tool — #499 브라우저·터미널 환경 도구의 순수 규칙 (FR-ENV-TOOL.1~10·14).
// 계약: docs/progress/issue-497-universal-agent.md, docs/progress/issue-582-ego-browser-host.md (4.4·4.5).
// 순수. 브라우저도 프로세스도 여기 없다 — 전부 ports/env-tool.ts 뒤.
// 핵심 불변식: 페이지에 적힌 문장은 자료이지 지시가 아니다. 권한은 상속되지 않는다.
import { permits, requiresApproval, type CapabilityTier } from "./capability.js";
import { isWithinBoundary } from "./workspace-context.js";

/** 공통 작업 생명주기 (FR-ENV-TOOL.1). 브라우저와 터미널이 같은 상태를 쓴다. */
export type OperationState = "accepted" | "running" | "completed" | "failed" | "cancelled";

const TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  accepted: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: OperationState, to: OperationState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminal(state: OperationState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** 요소를 가리키는 방법 (FR-ENV-TOOL.3). 참조가 우선이고 좌표는 예외다. */
export type ElementTarget =
  | { readonly kind: "reference"; readonly ref: string }
  | { readonly kind: "coordinate"; readonly x: number; readonly y: number; readonly why: string };

/** 좌표를 쓸 수밖에 없었다면 그 사실이 결과에 남아야 한다. */
export function coordinateFallbackNote(target: ElementTarget): string | null {
  return target.kind === "coordinate" ? `좌표 조작 사용: ${target.why}` : null;
}

/** 브라우저 증거 (FR-ENV-TOOL.6). 행동 전후를 설명할 수 있어야 한다. */
export interface BrowserEvidence {
  readonly snapshotRef: string;
  readonly screenshotRef: string;
  readonly url: string;
  readonly urlRevision: number;
}

/** 터미널 증거 (FR-ENV-TOOL.6). */
export interface TerminalEvidence {
  readonly exitCode: number | null;
  readonly outputRef: string;
  readonly artifactRefs: readonly string[];
}

export type Evidence = { readonly kind: "browser"; readonly value: BrowserEvidence } | { readonly kind: "terminal"; readonly value: TerminalEvidence };

export function hasEvidence(state: OperationState, evidence: Evidence | undefined): boolean {
  if (state !== "completed") return true;
  if (!evidence) return false;
  return evidence.kind === "browser"
    ? evidence.value.snapshotRef.length > 0 && evidence.value.screenshotRef.length > 0 && evidence.value.url.length > 0
    : evidence.value.outputRef.length > 0;
}

/**
 * 페이지 내용은 자료다 (FR-ENV-TOOL.4).
 * 어떤 문장이 실려 있든 요구 권한이 달라지지 않는다는 것을 함수로 못 박는다.
 */
export interface PageObservation {
  readonly text: string;
}

export function capabilityForOperation(declared: CapabilityTier, _page?: PageObservation): CapabilityTier {
  return declared;
}

export interface EnvOperationRequest {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly capability: CapabilityTier;
  readonly approvalRef?: string;
  readonly timeoutMs: number;
  /**
   * 작업이 도는 자리. 브라우저는 `BrowserWorkspace.id`, 터미널은 Herdr 워크스페이스 식별자다.
   * 자리 없는 작업은 없다 — 자원 소유와 정리 대상이 그때그때 정해지면 고아가 남는다 (#582 4.4·4.8).
   */
  readonly workspaceId: string;
  /** 브라우저 작업일 때만. 같은 공간 안의 어느 페이지인지 (#582 4.4). */
  readonly pageId?: string;
  /** 낡은 참조로 다른 페이지에 작용하지 않기 위한 개정 확인 (#582 S3a stale ref). */
  readonly expectedRevision?: number;
  /** 터미널 작업일 때만. 워크스페이스 루트 기준 상대 경로여야 한다. */
  readonly cwd?: string;
  readonly target?: ElementTarget;
}

/**
 * 형식 있는 실패 사유 (#582 4.4). 실패를 문자열로 뭉개면 취소·타임아웃·정책 거부가
 * 한 덩어리가 되어 원인을 못 짚는다. 수용 판정 사유(아래 `EnvRejectionCode`)도 여기에 포함된다.
 */
export type EnvFailureReason =
  | "timeout"
  | "cancelled"
  | "disconnected"
  | "process-exit"
  | "partial"
  | "context-mismatch"
  | "method-denied"
  | "capability-denied"
  | "approval-missing"
  | "workspace-escape"
  | "timeout-unbounded";

/** 수용 판정에서만 나오는 사유. `EnvFailureReason` 의 부분집합이다 (기존 호출부 호환). */
export type EnvRejectionCode = Extract<
  EnvFailureReason,
  "capability-denied" | "approval-missing" | "workspace-escape" | "timeout-unbounded"
>;

export const ENV_FAILURE_REASONS: readonly EnvFailureReason[] = [
  "timeout",
  "cancelled",
  "disconnected",
  "process-exit",
  "partial",
  "context-mismatch",
  "method-denied",
  "capability-denied",
  "approval-missing",
  "workspace-escape",
  "timeout-unbounded",
];

export function isEnvFailureReason(value: string): value is EnvFailureReason {
  return (ENV_FAILURE_REASONS as readonly string[]).includes(value);
}

export interface EnvRejection {
  readonly code: EnvFailureReason;
  readonly detail: string;
}

export interface EnvAdmissionContext {
  readonly grantedTiers: readonly CapabilityTier[];
  readonly page?: PageObservation;
}

/**
 * 수용 판정 (FR-ENV-TOOL.7·8·9). 하나라도 걸리면 실행하지 않는다.
 * 페이지 관측은 판정에 영향을 주지 않는다 — 넘겨받되 쓰지 않는다.
 */
export function admitEnvOperation(request: EnvOperationRequest, context: EnvAdmissionContext): readonly EnvRejection[] {
  const rejections: EnvRejection[] = [];
  const required = capabilityForOperation(request.capability, context.page);
  if (!permits(context.grantedTiers, required)) {
    rejections.push({ code: "capability-denied", detail: `요구 등급 ${required} 미부여` });
  }
  if (requiresApproval(required) && !request.approvalRef) {
    rejections.push({ code: "approval-missing", detail: `등급 ${required} 는 건별 승인이 필요하다` });
  }
  if (request.cwd !== undefined && !isWithinBoundary(request.cwd)) {
    rejections.push({ code: "workspace-escape", detail: `워크스페이스 경계 밖: ${request.cwd}` });
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    rejections.push({ code: "timeout-unbounded", detail: "모든 작업에는 상한이 있어야 한다" });
  }
  return rejections;
}

/** 종료 사유 (FR-ENV-TOOL.9). 취소·타임아웃·부분 실행은 성공으로 승격되지 않는다. */
export type TerminationCause = "finished" | "cancelled" | "timed-out";

export interface Termination {
  readonly state: OperationState;
  /** 이미 일어난 일. 취소·타임아웃이어도 남긴다. */
  readonly partialEffects: readonly string[];
  /**
   * 장부가 아는 작업이었는가 (#582 S0 리뷰 3번).
   * 모르는 작업의 취소에 `cancelled` 만 돌려주면 "취소했다"와 "그런 작업이 없다"가 같은 말이
   * 된다. 상태는 그대로 두고(기존 호출부 호환) 사실 한 칸을 더 싣는다.
   */
  readonly known: boolean;
}

export function terminate(cause: TerminationCause, partialEffects: readonly string[], known = true): Termination {
  const state: OperationState = cause === "finished" ? "completed" : cause === "cancelled" ? "cancelled" : "failed";
  return { state, partialEffects, known };
}

// ── 브라우저 작업 공간 자원 (#582 4.4, FR-ENV-TOOL.10) ────────────────────────
// 작업(operation)과 자원(workspace·page)은 수명이 다르다. 작업이 끝나도 공간은 남고,
// 공간이 닫혀도 이미 남긴 증거는 남는다. 그래서 여기 두 타입은 작업 상태를 갖지 않는다.

/** 헤드리스에서는 `agent` 만 도달 가능하다. 나머지 둘은 창 있는 모드의 자리다 (#582 결정 2). */
export type WorkspaceOwnership = "agent" | "agentDelegatedToUser" | "user";

export interface BrowserWorkspace {
  readonly id: string;
  /** 이번 범위는 헤드리스뿐이다. 창이 있는 모드는 열지 않는다 (FR-ENV-TOOL.11). */
  readonly mode: "headless";
  readonly ownership: WorkspaceOwnership;
  /** 공간이 바뀔 때마다 오른다. 낡은 참조가 다른 상태에 작용하지 못하게 하는 축. */
  readonly revision: number;
}

export interface BrowserPage {
  readonly id: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly urlRevision: number;
}

/** 공간을 만들면 언제나 에이전트 소유다. 사람에게 넘기는 길은 헤드리스에 없다. */
export function createHeadlessWorkspace(id: string): BrowserWorkspace {
  return { id, mode: "headless", ownership: "agent", revision: 0 };
}

/** 헤드리스에서 실제로 도달하는 소유 상태인가. `agent` 뿐이다. */
export function isReachableOwnership(ownership: WorkspaceOwnership): boolean {
  return ownership === "agent";
}

/** 업스트림 스킬의 작업 공간 헬퍼. 이름을 그대로 두어 ABI 대응을 눈으로 맞춘다 (#582 4.2). */
export type WorkspaceHelper =
  | "useOrCreateTaskSpace"
  | "switchTaskSpace"
  | "claimTaskSpace"
  | "handOffTaskSpace"
  | "takeOverTaskSpace"
  | "waitForAgentControl"
  | "completeTaskSpaceKeep"
  | "completeTaskSpaceClose";

/** 헤드리스에서 사람 인계 계열이 받는 형식 있는 오류 코드 (#582 4.4). */
export const EGO_HANDOFF_UNSUPPORTED_HEADLESS = "EGO_HANDOFF_UNSUPPORTED_HEADLESS" as const;

/** 사람 인계 계열 헬퍼 — 헤드리스에서는 전부 거부다. */
const HANDOFF_HELPERS: readonly WorkspaceHelper[] = ["claimTaskSpace", "handOffTaskSpace", "takeOverTaskSpace", "waitForAgentControl"];

export type WorkspaceEffect = "select" | "keep" | "close";

export type WorkspaceTransition =
  | { readonly ok: true; readonly effect: WorkspaceEffect; readonly workspace: BrowserWorkspace }
  | { readonly ok: false; readonly errorCode: typeof EGO_HANDOFF_UNSUPPORTED_HEADLESS; readonly detail: string };

/**
 * 헤드리스 소유권 전이 표 (#582 4.4) 를 함수 하나로 못 박는다.
 * 인계·회수·claim 은 성공하지 않는다. `agent` 밖 소유 상태는 애초에 도달하지 않으므로
 * 그런 공간이 들어오면 같은 형식 오류로 거부한다 — 조용히 성공시키지 않는 것이 요점이다.
 */
export function applyWorkspaceHelper(workspace: BrowserWorkspace, helper: WorkspaceHelper): WorkspaceTransition {
  if (!isReachableOwnership(workspace.ownership)) {
    return {
      ok: false,
      errorCode: EGO_HANDOFF_UNSUPPORTED_HEADLESS,
      detail: `헤드리스에서 도달하지 않는 소유 상태: ${workspace.ownership}`,
    };
  }
  if (HANDOFF_HELPERS.includes(helper)) {
    return { ok: false, errorCode: EGO_HANDOFF_UNSUPPORTED_HEADLESS, detail: `헤드리스 공간은 ${helper} 를 지원하지 않는다` };
  }
  if (helper === "completeTaskSpaceClose") {
    return { ok: true, effect: "close", workspace: { ...workspace, revision: workspace.revision + 1 } };
  }
  if (helper === "completeTaskSpaceKeep") {
    return { ok: true, effect: "keep", workspace };
  }
  return { ok: true, effect: "select", workspace };
}

/**
 * 개정 확인. 요청이 개정을 적어 왔는데 자원이 그 사이 바뀌었다면 작용하지 않는다 (#582 S3a stale ref).
 * 적지 않은 요청은 검사 대상이 아니다 — 없는 기대를 지어내지 않는다.
 */
export function revisionMatches(expected: number | undefined, actual: number): boolean {
  return expected === undefined || expected === actual;
}

/**
 * 포트가 실패 사유를 실어 보내는 통로 (#582 4.4).
 * 이것이 없으면 조립층이 오류를 문자열로 받아 한 가지 코드로 뭉갠다 — 실제로 그랬다.
 */
export class EnvOperationFailure extends Error {
  constructor(
    readonly reason: EnvFailureReason,
    detail: string,
  ) {
    super(detail);
    this.name = "EnvOperationFailure";
  }
}

/** 던져진 값에서 형식 있는 사유를 읽는다. 못 읽으면 지어내지 않고 undefined 다. */
export function envFailureReasonOf(error: unknown): EnvFailureReason | undefined {
  if (error instanceof EnvOperationFailure) return error.reason;
  if (typeof error !== "object" || error === null) return undefined;
  for (const key of ["reason", "code"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" && isEnvFailureReason(value)) return value;
  }
  return undefined;
}
