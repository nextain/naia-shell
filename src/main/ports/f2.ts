// ports/f2 — F2 driven 인터페이스 (contract §B.2). domain 만 의존. 모든 메서드 async.
// substrate-agnostic(목표: 장기 안드로이드/로봇) — host-neutral 카테고리. Tauri/OS 어휘 누출 금지.
// ⚠️ 2026-06-13 신규 계약 delta (F2 2-AI 리뷰 r-f2-2026-06-13.json 반영):
//   - 관측 실패를 거부(PermissionDenied)와 그외(ObservationFailure)로 분리 — 보안신호 은폐 금지(F2-1)
//   - listDir 가 dir/file 구분 보존(DirEntryInfo, F2-6c)
//   - worktrees → WorktreeInfo 투영(sessions 와 구분, F2-5)
//   - 구독(subscribeChanges·pty)은 Unsubscribe 반환 — 리스너 누수 금지(F2-3)
//   - pty onExit 는 exit-code 없음(old 는 unit emit — 코드 발명 금지, F2-4)
import type { ObservedState } from "../domain/observe.js";

/** 경로가 workspace 권한 경계 밖 = 거부(보안신호). 다른 실패와 구분. */
export type PermissionDenied = { readonly denied: true; readonly path: string };
/** 거부 외 관측 실패(NotFound/IO/transport 등) — 정직 표면화(거부로 위장 금지, F2-1). */
export type ObservationFailure = { readonly failed: true; readonly path: string; readonly reason: string };
export type ReadResult<T> = T | PermissionDenied | ObservationFailure;

export function isDenied<T>(r: ReadResult<T>): r is PermissionDenied {
  return typeof r === "object" && r !== null && (r as PermissionDenied).denied === true;
}
export function isFailure<T>(r: ReadResult<T>): r is ObservationFailure {
  return typeof r === "object" && r !== null && (r as ObservationFailure).failed === true;
}
export function isOk<T>(r: ReadResult<T>): r is T {
  return !isDenied(r) && !isFailure(r);
}
// ⚠️ 가드는 구조적(=== true). T 가 literal `denied:true`/`failed:true` 필드를 가진 객체면 오분류 가능 →
//    EnvironmentObservePort 의 성공 타입(T)에 그런 형상을 두지 말 것(현 T=string·DirEntryInfo[]·ObservedState 안전).

/** dir 엔트리 (old DirEntry parity — dir/file 구분 보존, F2-6c). host-neutral. */
export interface DirEntryInfo {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
}

/** repo/worktree 상태 (old SessionInfo 투영, F2-5). sessions() 와 구분되는 worktree facet. */
export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string | null;
  /** 링크된 worktree 의 메인 worktree 절대경로(메인이면 null). */
  readonly originPath: string | null;
}

export interface FileChangeEvent {
  readonly session: string;
  readonly file: string;
  readonly timestamp: number;
}

/** 구독 해제 (리스너 누수 방지, F2-3). 등록 측이 반드시 보관·호출. */
export type Unsubscribe = () => void;

export interface EnvironmentObservePort {
  listDir(path: string): Promise<ReadResult<readonly DirEntryInfo[]>>;
  readFile(path: string): Promise<ReadResult<string>>;
  /** 거부(PermissionDenied)는 NotFound(value:null)와 구분 — 보안신호 은폐 금지(F2-1). */
  fileStatus(path: string): Promise<ObservedState | PermissionDenied>;
  sessions(): Promise<readonly unknown[]>;
  processStatus(): Promise<readonly unknown[]>;
  worktrees(): Promise<readonly WorktreeInfo[]>;
  subscribeChanges(onChange: (e: FileChangeEvent) => void): Unsubscribe; // 등록=sync, 콜백=비동기. 반환=해제(F2-3)
}

export interface ExpectedStateProviderPort {
  goal(): Promise<string | null>;
  approvedIntent(): Promise<string | null>;
  lastSnapshot(target: string): Promise<string | null>;
}

export interface PtyReadPort {
  onOutput(cb: (chunk: string) => void): Unsubscribe; // F2-3
  onExit(cb: () => void): Unsubscribe; // F2-4: old 는 unit emit — exit-code 없음(발명 금지)
}

export type { ObservedState };
