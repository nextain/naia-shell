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

// ⚠️ 경로 권한 경계(workspace root 포함 판정)는 **driven adapter(주입 Rust validate_in_workspace)가 SoT** 다.
//    old-naia-os 도 경계를 Rust(canonicalize + 컴포넌트단위 starts_with)에 위임했음 — JS 도메인에 재구현하지 않는다.
//    (이전 isWithinWorkspace 는 문자열 prefix 라 컴포넌트단위와 비등가 + live 어댑터 미사용 죽은코드 → 삭제, F2-2.)
//    어댑터는 거부를 PermissionDenied 로 정직 분류(보안신호 은폐 금지). 도메인측 defense-in-depth 가 필요하면
//    canonicalize 주입 + 컴포넌트단위 비교로 *별도 계약*에서 추가(애드혹 금지).
