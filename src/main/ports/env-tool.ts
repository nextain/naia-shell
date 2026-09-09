// ports/env-tool — #499 driven 인터페이스. domain 만 의존. 모든 메서드 async.
// 터미널의 생명주기 소유는 Herdr 에 있다 — 여기서는 요청만 한다 (FR-ENV-TOOL.5).
import type { BrowserEvidence, ElementTarget, EnvOperationRequest, TerminalEvidence } from "../domain/env-tool.js";
import type { StructuredCommand } from "../domain/herdr-control.js";

// 취소·deadline 은 서비스가 들고 있고 포트는 신호만 받는다 (#582 4.7). 신호를 안 보는 어댑터도
// 계약을 어기지 않는다 — 다만 그 어댑터는 취소가 늦게 도착한다.
export interface BrowserOperationPort {
  open(request: EnvOperationRequest, url: string, signal?: AbortSignal): Promise<BrowserEvidence>;
  snapshot(request: EnvOperationRequest, signal?: AbortSignal): Promise<BrowserEvidence>;
  click(request: EnvOperationRequest, target: ElementTarget, signal?: AbortSignal): Promise<BrowserEvidence>;
  fill(request: EnvOperationRequest, target: ElementTarget, value: string, signal?: AbortSignal): Promise<BrowserEvidence>;
  close(request: EnvOperationRequest, signal?: AbortSignal): Promise<void>;
}

/** 터미널 실행 요청. Herdr 가 만든 터미널을 참조할 뿐 직접 소유하지 않는다. */
export interface TerminalOperationPort {
  exec(request: EnvOperationRequest, terminalId: string, command: StructuredCommand, signal?: AbortSignal): Promise<TerminalEvidence>;
}

export interface CancellationPort {
  cancel(operationId: string): Promise<readonly string[]>;
}
