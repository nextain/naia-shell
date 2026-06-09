// domain/observe — F2 (contract §B.1). 순수. canonicalize/notify/sysinfo I/O 는 포트 뒤.

/** 관측 스냅샷 값 (파일 존재/메타·프로세스·dir). 비교 가능한 불투명 값. */
export interface ObservedState {
  readonly key: string; // 대상 식별 (예: file path)
  readonly value: string | null; // 관측 값 (없으면 null = NotFound)
}

export type ExpectedSource = "goal" | "approvedIntent" | "lastSnapshot";

export interface ExpectedState {
  readonly source: ExpectedSource;
  readonly value: string | null;
}

/**
 * 권위 우선순위 (결정적, FR-F2): goal-state > approvedIntent > lastSnapshot.
 * 상위 존재(non-null) 시 그것을 expected 로 채택. 전부 null 이면 null(비교 불가).
 */
export function resolveExpected(
  goal: string | null,
  approvedIntent: string | null,
  lastSnapshot: string | null,
): ExpectedState | null {
  if (goal !== null) return { source: "goal", value: goal };
  if (approvedIntent !== null) return { source: "approvedIntent", value: approvedIntent };
  if (lastSnapshot !== null) return { source: "lastSnapshot", value: lastSnapshot };
  return null;
}

export interface DriftSignal {
  readonly key: string;
  readonly observed: string | null;
  readonly expected: ExpectedState;
}

/** observed ≠ expected → drift (외부 간섭 포함). expected 없으면 drift 판정 불가(null). */
export function detectDrift(observed: ObservedState, expected: ExpectedState | null): DriftSignal | null {
  if (expected === null) return null;
  if (observed.value === expected.value) return null;
  return { key: observed.key, observed: observed.value, expected };
}

/** 경로 권한: path ∈ canonical workspace root (순수 prefix 규칙; canonicalize=adapter). */
export function isWithinWorkspace(canonicalRoot: string, canonicalPath: string): boolean {
  const root = canonicalRoot.endsWith("/") ? canonicalRoot : canonicalRoot + "/";
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(root);
}
