// domain/approval — F1 (contract §B.1). 순수 규칙. I/O 0.

export type Tier = "T0" | "T1" | "T2" | "T3";

/** T1·T2 = 승인 필요. T0 = auto. T3 = blocked(승인 불가). 미매핑 = T2(보수적). */
export function needsApproval(t: Tier): boolean {
  return t === "T1" || t === "T2";
}
export function isBlocked(t: Tier): boolean {
  return t === "T3";
}

/**
 * 자동 승인 direct-tool 예외 — **인자 조건 포함**(baseline §A.2; codex HIGH 정정).
 * skill_voicewake=전체 / skill_tts=preview 만 / skill_config=models 만.
 */
export function isAutoBypass(tool: string, args: Readonly<Record<string, unknown>>): boolean {
  switch (tool) {
    case "skill_voicewake": return true;
    case "skill_tts": return args["action"] === "preview";
    case "skill_config": return args["action"] === "models";
    default: return false;
  }
}

export interface ActionScope {
  readonly target: string;
  readonly op: string;
  readonly body: string;
  readonly env: string;
}

/** context-identity digest 입력 (FR-F1.4). active surface = headless 시 null 허용. */
export interface ContextIdentity {
  readonly sessionId: string;
  readonly canonicalRoot: string;
  readonly activeSurface: string | null;
  readonly configVersion: string;
  readonly clientId: string;
}

/**
 * 결정적 digest (순수). 구분자 충돌 불가 — JSON 배열 직렬화(필드에 구분자 포함돼도
 * 배열 경계가 보존됨, codex HIGH 정정). 같은 입력 → 같은 문자열.
 */
export function contextDigest(c: ContextIdentity): string {
  return JSON.stringify([
    c.sessionId,
    c.canonicalRoot,
    c.activeSurface, // null 그대로 (headless) — JSON 이 ∅ 없이 구분
    c.configVersion,
    c.clientId,
  ]);
}

export interface ApprovalBinding {
  readonly correlationId: string;
  readonly digest: string; // contextDigest 결과
  readonly scope: ActionScope;
}

/** 실행 *전* drift 판정 (FR-F1.4): 현재 digest/scope ≠ 승인시점 → block(재승인). side-effect 없음. */
export function isPreExecDrift(bound: ApprovalBinding, now: { digest: string; scope: ActionScope }): boolean {
  return bound.digest !== now.digest || !sameScope(bound.scope, now.scope);
}
function sameScope(a: ActionScope, b: ActionScope): boolean {
  return a.target === b.target && a.op === b.op && a.body === b.body && a.env === b.env;
}

export interface ApprovalRequest {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly tier: Tier; // ApprovalGate 가 classify() 로 채움 (호출자 신뢰 X)
  readonly toolCallId: string;
  readonly sessionId: string; // 계약 정합 (codex HIGH 정정)
}

export type ApprovalDecision =
  | "once"
  | "always" // D40: deferred 정책
  | "reject"
  | "expired" // F1 신설 (baseline=timeout→reject 붕괴)
  | "duplicate"; // F1 신설 (baseline 미분기)

/** 게이트 결과. */
export type GateOutcome =
  | { readonly kind: "blocked"; readonly reason: "tier-T3" | "denied" | "drift" }
  | { readonly kind: "approved"; readonly via: "auto-bypass" | "pre-grant" | "user-once" };
