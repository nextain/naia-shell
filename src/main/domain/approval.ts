// domain/approval — F1 (contract §B.1). 순수 규칙. I/O 0.

export type Tier = "T0" | "T1" | "T2" | "T3";

/** T1·T2 = 승인 필요. T0 = auto. T3 = blocked(승인 불가). 미매핑 = T2(보수적). */
export function needsApproval(t: Tier): boolean {
  return t === "T1" || t === "T2";
}
export function isBlocked(t: Tier): boolean {
  return t === "T3";
}

/** tier 무관 자동 승인되는 direct-tool 명시 집합 (baseline §A.2). */
export const AUTO_BYPASS: ReadonlySet<string> = new Set([
  "skill_voicewake",
  "skill_tts",
  "skill_config",
]);
export function isAutoBypass(tool: string): boolean {
  return AUTO_BYPASS.has(tool);
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

/** 결정적 digest (순수 직렬화). 같은 입력 → 같은 문자열. */
export function contextDigest(c: ContextIdentity): string {
  return [
    c.sessionId,
    c.canonicalRoot,
    c.activeSurface ?? "∅",
    c.configVersion,
    c.clientId,
  ].join("|");
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
  readonly tier: Tier;
  readonly toolCallId: string;
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
