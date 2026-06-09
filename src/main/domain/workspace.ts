// domain/workspace — F0 control-plane slice (codex 2-clean contract §B.1)
// 순수 값객체. filesystem I/O 0 (canonicalize/is_dir 는 WorkspacePort adapter 책임).

/** 검증된 canonical workspace root 값. 생성 = adapter/backend 가 canonicalize+is_dir 후 산출. */
export interface CanonicalRoot {
  readonly kind: "canonical-root";
  readonly path: string; // 이미 정규화된 path (symlink/mount/대소문자)
}

export function canonicalRoot(path: string): CanonicalRoot {
  return { kind: "canonical-root", path };
}

/** WorkspacePort.setRoot 결과: 성공(canonical) 또는 실패(앱이 contain+fallback). */
export type SetRootResult =
  | { readonly ok: true; readonly root: CanonicalRoot }
  | { readonly ok: false; readonly error: string };
