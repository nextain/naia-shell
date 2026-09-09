// ports/env-tool — #499·#582 driven 인터페이스. domain 만 의존. 모든 메서드 async.
// 터미널의 생명주기 소유는 Herdr 에 있다 — 여기서는 요청만 한다 (FR-ENV-TOOL.5).
// 브라우저의 생명주기 소유는 감독자에 있다 — 여기서는 작업 공간과 작업만 말한다 (#582 4.4·4.8).
import type { BrowserEvidence, BrowserWorkspace, ElementTarget, EnvOperationRequest, TerminalEvidence } from "../domain/env-tool.js";
import type { StructuredCommand } from "../domain/herdr-control.js";

/**
 * 작업 공간은 작업과 수명이 다르다 (#582 4.4). 그래서 작업 포트와 나눈다.
 * `browserContextId` 같은 원시 CDP 능력은 이 경계를 넘지 않는다 — 어댑터 안 매핑이다.
 */
export interface BrowserWorkspacePort {
  create(request: EnvOperationRequest, signal?: AbortSignal): Promise<BrowserWorkspace>;
  list(signal?: AbortSignal): Promise<readonly BrowserWorkspace[]>;
  close(request: EnvOperationRequest, workspaceId: string, signal?: AbortSignal): Promise<void>;
}

/** 묶음 실행이 아닌 한 덩어리 자바스크립트. 효과가 고정된 RPC 안에서만 돈다 (#582 4.4). */
export interface BrowserScript {
  readonly expression: string;
}

export interface BrowserEvaluation {
  readonly evidence: BrowserEvidence;
  readonly result: string;
}

// 취소·deadline 은 서비스가 들고 있고 포트는 신호만 받는다 (#582 4.7). 신호를 안 보는 어댑터도
// 계약을 어기지 않는다 — 다만 그 어댑터는 취소가 늦게 도착한다.
export interface BrowserOperationPort {
  open(request: EnvOperationRequest, url: string, signal?: AbortSignal): Promise<BrowserEvidence>;
  navigate(request: EnvOperationRequest, url: string, signal?: AbortSignal): Promise<BrowserEvidence>;
  snapshot(request: EnvOperationRequest, signal?: AbortSignal): Promise<BrowserEvidence>;
  click(request: EnvOperationRequest, target: ElementTarget, signal?: AbortSignal): Promise<BrowserEvidence>;
  fill(request: EnvOperationRequest, target: ElementTarget, value: string, signal?: AbortSignal): Promise<BrowserEvidence>;
  evaluate(request: EnvOperationRequest, script: BrowserScript, signal?: AbortSignal): Promise<BrowserEvaluation>;
  /** 캡처 경로는 호출자가 아니라 감독자가 정한다 (#582 4.5). 여기로는 참조만 돌아온다. */
  screenshot(request: EnvOperationRequest, signal?: AbortSignal): Promise<BrowserEvidence>;
  close(request: EnvOperationRequest, signal?: AbortSignal): Promise<void>;
}

/** 터미널 실행 요청. Herdr 가 만든 터미널을 참조할 뿐 직접 소유하지 않는다. */
export interface TerminalOperationPort {
  exec(request: EnvOperationRequest, terminalId: string, command: StructuredCommand, signal?: AbortSignal): Promise<TerminalEvidence>;
}

export interface CancellationPort {
  cancel(operationId: string): Promise<readonly string[]>;
}
