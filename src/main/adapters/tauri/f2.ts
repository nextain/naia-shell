// adapters/tauri/f2 — F2 driven adapter STUBS (contract §B.4). 라이브 배선 대기 (async).
import type {
  EnvironmentObservePort, ExpectedStateProviderPort, PtyReadPort, FileChangeEvent, ReadResult, PermissionDenied,
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

// ── 실배선 어댑터 (graft) — old-naia-os 가 invoke/listen 주입 (live.ts LiveDeps 와 동일 철학) ──
// new core 는 @tauri-apps/api 에 직접 의존하지 않는다. old 함수를 주입받아 old 명령에 1:1 매핑(parity).
// Old-Baseline (F2-baseline-contract §A): workspace_list_dirs{parent}/workspace_read_file{path}/
//   workspace_file_size{path}/workspace_get_sessions/workspace_get_pty_agents{pids} + workspace:file-changed.

/** graft 시 old-naia-os 가 주입하는 실제 함수. */
export interface F2LiveDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Tauri event listen. 반환=unlisten. F2 watch/pty 구독에 필요(invoke 만으론 부족). */
  listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
  /** processStatus 가 조회할 현재 추적 중인 터미널 pid (old: 열린 터미널 pid). 없으면 빈 결과. */
  ptyPids?: () => readonly number[];
  /** drift 의 lastSnapshot 영속 (new-requirement). 미주입 시 lastSnapshot 부재(null). */
  snapshotStore?: { get(target: string): string | null };
}

// old DirEntry (parity 형상 — 도메인에 누출 안 함, 어댑터 경계 내부 타입).
interface OldDirEntry { readonly name: string; readonly path: string; readonly is_dir: boolean }

/** invoke 거부(권한 밖 포함)를 contain → PermissionDenied (FR-F2: 관측 실패는 정직 거부, 상위 오염 X). */
function denied(path: string): PermissionDenied { return { denied: true, path }; }

/** old 함수 주입 → F2 read-only 관측 실배선 포트 (env). */
export function makeF2EnvObserve(d: F2LiveDeps): EnvironmentObservePort {
  return {
    // workspace_list_dirs{parent} → DirEntry[]; 포트는 path 목록(소비자 file-search 등가). dotfile 제외는 Rust 측.
    async listDir(path: string): Promise<ReadResult<readonly string[]>> {
      try {
        const entries = (await d.invoke("workspace_list_dirs", { parent: path })) as OldDirEntry[];
        return entries.map((e) => e.path);
      } catch { return denied(path); }
    },
    async readFile(path: string): Promise<ReadResult<string>> {
      try { return (await d.invoke("workspace_read_file", { path })) as string; }
      catch { return denied(path); }
    },
    // workspace_file_size{path} → u64. drift 비교용 불투명 값(크기 문자열). 부재/거부 = value null(NotFound, contain).
    async fileStatus(path: string): Promise<ObservedState> {
      try {
        const size = (await d.invoke("workspace_file_size", { path })) as number;
        return { key: path, value: String(size) };
      } catch { return { key: path, value: null }; }
    },
    async sessions(): Promise<readonly unknown[]> {
      return (await d.invoke("workspace_get_sessions")) as readonly unknown[];
    },
    // processStatus: old 의 무인자 프로세스 read 없음 → pty-agents(추적 pid 기준). pid 없으면 빈 결과(정직).
    async processStatus(): Promise<readonly unknown[]> {
      const pids = d.ptyPids?.() ?? [];
      if (pids.length === 0) return [];
      const map = (await d.invoke("workspace_get_pty_agents", { pids: [...pids] })) as Record<string, string>;
      return Object.entries(map).map(([pid, agent]) => ({ pid: Number(pid), agent }));
    },
    // worktrees: get_main_worktree/get_all_worktree_paths 는 #[tauri::command] 아님(JS invoke 불가) →
    //   repo/worktree 상태는 workspace_get_sessions(SessionInfo.origin_path/branch)로만 노출. 동일 소스 경유(parity).
    async worktrees(): Promise<readonly unknown[]> {
      return (await d.invoke("workspace_get_sessions")) as readonly unknown[];
    },
    // workspace:file-changed{session,file,timestamp} 구독(외부변경 포함). listen 등록은 sync void(unlisten fire-and-forget).
    subscribeChanges(onChange: (e: FileChangeEvent) => void): void {
      void d.listen("workspace:file-changed", (ev) => {
        const p = (ev.payload ?? {}) as Partial<FileChangeEvent>;
        onChange({ session: p.session ?? "", file: p.file ?? "", timestamp: p.timestamp ?? 0 });
      });
    },
  };
}

/** drift 의 expected 출처 실배선. goal/approvedIntent = F1 binding·goal-source 미존재(현 null, 정직).
 *  lastSnapshot = 주입 store 영속(new-requirement). expected 전부 null 이면 detectDrift=null(비교 불가). */
export function makeF2ExpectedState(d: F2LiveDeps): ExpectedStateProviderPort {
  return {
    async goal(): Promise<string | null> { return null; }, // ⚠️ goal-state source 미존재(후속 tranche)
    async approvedIntent(): Promise<string | null> { return null; }, // ⚠️ F1 ApprovalBinding 배선 후 연계
    async lastSnapshot(target: string): Promise<string | null> { return d.snapshotStore?.get(target) ?? null; },
  };
}

/** pty read 실배선 — old 는 pty:output:{id}/pty:exit:{id} (per-id). 포트가 id 없으므로 id 바인딩 팩토리로 노출. */
export function makePtyReader(d: F2LiveDeps, ptyId: string): PtyReadPort {
  return {
    onOutput(cb: (c: string) => void): void {
      void d.listen(`pty:output:${ptyId}`, (ev) => cb(String(ev.payload ?? "")));
    },
    onExit(cb: (c: number) => void): void {
      void d.listen(`pty:exit:${ptyId}`, (ev) => cb(Number(ev.payload ?? 0)));
    },
  };
}
