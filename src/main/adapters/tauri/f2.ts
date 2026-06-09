// adapters/tauri/f2 — F2 driven adapter STUBS (contract §B.4). 라이브 배선 대기 (async).
import type {
  EnvironmentObservePort, ExpectedStateProviderPort, PtyReadPort, FileChangeEvent, ReadResult,
} from "../../ports/f2.js";
import type { ObservedState } from "../../domain/observe.js";

class NotWired extends Error {
  constructor(cmd: string) { super(`Tauri adapter not wired (라이브 trace 대기): ${cmd}`); }
}

export const tauriEnvObserve: EnvironmentObservePort = {
  async listDir(_p: string): Promise<ReadResult<readonly string[]>> { throw new NotWired("workspace_list_dirs"); },
  async readFile(_p: string): Promise<ReadResult<string>> { throw new NotWired("workspace_read_file"); },
  async fileStatus(_p: string): Promise<ObservedState> { throw new NotWired("workspace_file_size/stat"); },
  async sessions(): Promise<readonly unknown[]> { throw new NotWired("workspace_get_sessions"); },
  async processStatus(): Promise<readonly unknown[]> { throw new NotWired("system-status/workspace_get_pty_agents"); },
  async worktrees(): Promise<readonly unknown[]> { throw new NotWired("get_main_worktree/get_all_worktree_paths"); },
  subscribeChanges(_cb: (e: FileChangeEvent) => void): void { throw new NotWired("workspace_start_watch (notify)"); },
};

export const expectedStateProvider: ExpectedStateProviderPort = {
  async goal(): Promise<string | null> { throw new NotWired("goal-state source"); },
  async approvedIntent(): Promise<string | null> { throw new NotWired("approvedIntent (F1 binding)"); },
  async lastSnapshot(_t: string): Promise<string | null> { throw new NotWired("lastSnapshot persist"); },
};

export const tauriPtyRead: PtyReadPort = {
  onOutput(_cb: (c: string) => void): void { throw new NotWired("pty:output"); },
  onExit(_cb: (c: number) => void): void { throw new NotWired("pty:exit"); },
};
