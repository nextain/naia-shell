// domain/mutate — F3 (contract §B.1). 순수. canonicalize/RPC/spawn I/O 는 포트 뒤.
import type { ActionScope } from "./approval.js";

export type MutateOp = "writeFile" | "applyDiff" | "execCommand" | "ptyWrite";

export interface MutationCommand {
  readonly op: MutateOp;
  readonly target: string; // file path 또는 명령
  readonly body: string; // content/diff/args
}

/** 승인 결속용: 실제 실행할 cmd 에서 ActionScope 도출(F1 §B.3 ActionScope=행위 결속).
 *  ⚠️ 승인은 *이 cmd* 에 묶여야 함 — 호출자 supplied scope 신뢰 금지(승인A→행위B 방지, UC13 BLOCKER fix). */
export function actionScopeOf(cmd: MutationCommand, env: string): ActionScope {
  return { target: cmd.target, op: cmd.op, body: cmd.body, env };
}

/** file-op 경로 안전(old validatePath 복원, defense-in-depth): null-byte + `..` traversal 거부.
 *  (writeFile 은 Rust validate_in_workspace 가 경계검증하나, 도메인 self-contained 방어 = 보안 GOAL.) */
export function isUnsafePath(path: string): boolean {
  if (path.includes("\0")) return true; // null-byte 주입
  return path.split(/[/\\]/).includes(".."); // 디렉터리 traversal 세그먼트
}

export interface Ack {
  readonly accepted: boolean;
  readonly exit?: number; // exec/pty
  readonly output?: string; // exec/pty 캡처
}

/** observed 출처: file 계열=target 재-read, exec/pty=ack.exit/output (op 종류별). */
export function isFileOp(op: MutateOp): boolean {
  return op === "writeFile" || op === "applyDiff";
}

export type ReafferenceOutcome = "match" | "mismatch" | "observationFailed";

export interface Reafference {
  readonly commanded: MutationCommand;
  readonly acknowledged: boolean;
  readonly outcome: ReafferenceOutcome;
}

/**
 * Reafference 분류 (gemini R2/R3 정합):
 * ack 받음 + 관측 성공 → match(=expected) | mismatch(≠)
 * ack 받음 + 관측 실패/무응답 → observationFailed (→ UncertainState{ackNotObserved})
 */
export function classifyReafference(
  cmd: MutationCommand,
  acknowledged: boolean,
  expected: string | null,
  observed: string | null,
  observeFailed: boolean,
): Reafference {
  if (observeFailed) return { commanded: cmd, acknowledged, outcome: "observationFailed" };
  return { commanded: cmd, acknowledged, outcome: observed === expected ? "match" : "mismatch" };
}

export type UncertainState = "timeout" | "partial" | "postExecDrift" | "ackNotObserved";
export type Disposition = "contain" | "degrade" | "block" | "abort";

/** observationFailed → ackNotObserved 불확정 (FR-F3.3). */
export function uncertainFromOutcome(o: ReafferenceOutcome): UncertainState | null {
  return o === "observationFailed" ? "ackNotObserved" : null;
}

// ── CommandSafety (T3 blocked 패턴 + sensitive 경로, baseline isBlockedCommand) ──
const BLOCKED: readonly RegExp[] = [
  /(^|\s)rm\s+-rf\s+\//,
  /(^|\s)sudo(\s|$)/,
  /(^|\s)chmod\s+777/,
  /\|\s*bash(\s|$)/,
  /curl\s.*\|\s*sh(\s|$)/,
  /(^|\s)mkfs\./,
  /(^|\s)dd\s+if=/,
];
const SENSITIVE_PATH: readonly RegExp[] = [
  /(^|\s|\/)\.ssh(\/|$)/, /(^|\s|\/)\.gnupg(\/|$)/, /(^|\s|\/)\.aws(\/|$)/, /(^|\s|\/)\.kube(\/|$)/,
  /(^|\s)\/etc(\/|$)/, /(^|\s)\/proc(\/|$)/, /(^|\s)\/sys(\/|$)/, /(^|\s)\/dev(\/|$)/,
];

export function isBlockedCommand(command: string): boolean {
  return BLOCKED.some((re) => re.test(command)) || SENSITIVE_PATH.some((re) => re.test(command));
}
