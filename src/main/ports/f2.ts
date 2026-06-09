// ports/f2 — F2 driven 인터페이스 (contract §B.2). domain 만 의존.
import type { ObservedState } from "../domain/observe.js";

export type PermissionDenied = { readonly denied: true; readonly path: string };
export type ReadResult<T> = T | PermissionDenied;
export function isDenied<T>(r: ReadResult<T>): r is PermissionDenied {
  return typeof r === "object" && r !== null && (r as PermissionDenied).denied === true;
}

export interface FileChangeEvent {
  readonly session: string;
  readonly file: string;
  readonly timestamp: number;
}

export interface EnvironmentObservePort {
  listDir(path: string): ReadResult<readonly string[]>; // 권한 밖=denied
  readFile(path: string): ReadResult<string>;
  fileStatus(path: string): ObservedState; // value=null 이면 NotFound
  sessions(): readonly unknown[];
  processStatus(): readonly unknown[];
  worktrees(): readonly unknown[]; // repo 상태 (processStatus 아님)
  subscribeChanges(onChange: (e: FileChangeEvent) => void): void; // watcher (외부변경 포함)
}

/** drift 의 expected 입력 출처 (hidden dep 해소). */
export interface ExpectedStateProviderPort {
  goal(): string | null;
  approvedIntent(): string | null;
  lastSnapshot(target: string): string | null;
}

export interface PtyReadPort {
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

export type { ObservedState };
