// ports/f2 — F2 driven 인터페이스 (contract §B.2). domain 만 의존. 모든 메서드 async.
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
  listDir(path: string): Promise<ReadResult<readonly string[]>>;
  readFile(path: string): Promise<ReadResult<string>>;
  fileStatus(path: string): Promise<ObservedState>;
  sessions(): Promise<readonly unknown[]>;
  processStatus(): Promise<readonly unknown[]>;
  worktrees(): Promise<readonly unknown[]>;
  subscribeChanges(onChange: (e: FileChangeEvent) => void): void; // 이벤트 구독(등록은 sync, 콜백은 비동기 발생)
}

export interface ExpectedStateProviderPort {
  goal(): Promise<string | null>;
  approvedIntent(): Promise<string | null>;
  lastSnapshot(target: string): Promise<string | null>;
}

export interface PtyReadPort {
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

export type { ObservedState };
