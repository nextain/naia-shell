// adapters/tauri/f2 — F2 driven adapter (contract §B.4). STUB + 실배선(graft).
// ⚠️ 2026-06-13 신규 계약 delta 반영(2-AI 리뷰 r-f2-2026-06-13.json): 거부/실패 분리(F2-1),
//   DirEntryInfo(F2-6c), WorktreeInfo 투영(F2-5), 구독 Unsubscribe(F2-3), pty exit 코드 제거(F2-4).
import { isDenied } from "../../ports/f2.js";
import type {
  EnvironmentObservePort, ExpectedStateProviderPort, PtyReadPort, FileChangeEvent,
  ReadResult, PermissionDenied, ObservationFailure, DirEntryInfo, WorktreeInfo, Unsubscribe,
} from "../../ports/f2.js";
import type { ObservedState } from "../../domain/observe.js";

class NotWired extends Error {
  constructor(cmd: string) { super(`Tauri adapter not wired (라이브 trace 대기): ${cmd}`); }
}

export const tauriEnvObserve: EnvironmentObservePort = {
  async listDir(_p: string): Promise<ReadResult<readonly DirEntryInfo[]>> { throw new NotWired("workspace_list_dirs"); },
  async readFile(_p: string): Promise<ReadResult<string>> { throw new NotWired("workspace_read_file"); },
  async fileStatus(_p: string): Promise<ObservedState | PermissionDenied> { throw new NotWired("workspace_file_size/stat"); },
  async sessions(): Promise<readonly unknown[]> { throw new NotWired("workspace_get_sessions"); },
  async processStatus(): Promise<readonly unknown[]> { throw new NotWired("workspace_get_pty_agents"); },
  async worktrees(): Promise<readonly WorktreeInfo[]> { throw new NotWired("workspace_get_sessions(worktree)"); },
  subscribeChanges(_cb: (e: FileChangeEvent) => void): Unsubscribe { throw new NotWired("workspace_start_watch (notify)"); },
};

export const expectedStateProvider: ExpectedStateProviderPort = {
  async goal(): Promise<string | null> { throw new NotWired("goal-state source"); },
  async approvedIntent(): Promise<string | null> { throw new NotWired("approvedIntent (F1 binding)"); },
  async lastSnapshot(_t: string): Promise<string | null> { throw new NotWired("lastSnapshot persist"); },
};

export const tauriPtyRead: PtyReadPort = {
  onOutput(_cb: (c: string) => void): Unsubscribe { throw new NotWired("pty:output"); },
  onExit(_cb: () => void): Unsubscribe { throw new NotWired("pty:exit"); },
};

// ── 실배선 어댑터 (graft) — old-naia-os 가 invoke/listen 주입 (live.ts LiveDeps 와 동일 철학) ──
// new core 는 @tauri-apps/api 에 직접 의존하지 않는다. old 함수를 주입받아 old 명령에 1:1 매핑(parity).
// Old-Baseline (F2-baseline-contract §A): workspace_list_dirs{parent}/workspace_read_file{path}/
//   workspace_file_size{path}/workspace_get_sessions/workspace_get_pty_agents{pids} + workspace:file-changed.

/** graft 시 old-naia-os 가 주입하는 실제 함수. */
export interface F2LiveDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Tauri event listen. 반환=unlisten Promise. F2 watch/pty 구독에 필요(invoke 만으론 부족). */
  listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
  /** processStatus 가 조회할 현재 추적 중인 터미널 pid (old: 열린 터미널 pid). 없으면 빈 결과. */
  ptyPids?: () => readonly number[];
  /** drift 의 lastSnapshot 영속 (new-requirement). 미주입 시 lastSnapshot 부재(null). */
  snapshotStore?: { get(target: string): string | null };
}

// old wire 형상 (parity — 도메인 누출 안 함, 어댑터 경계 내부 타입).
interface OldDirEntry { readonly name: string; readonly path: string; readonly is_dir: boolean }
interface OldSessionInfo { readonly path: string; readonly branch?: string | null; readonly origin_path?: string | null }

/** invoke 거부(권한 밖)와 그외 실패(NotFound/IO/transport)를 정직 분류 — 보안신호 은폐 금지(F2-1).
 *  old validate_in_workspace: "Access denied: path is outside workspace root"(거부) vs "Path inaccessible"(그외). */
function classifyError(path: string, e: unknown): PermissionDenied | ObservationFailure {
  // Tauri Result<_,String> 은 문자열로 reject(현 live 경로). 객체/Error reject 도 .message 탐지(거부 오분류 방지, round2 hardening).
  const reason =
    typeof e === "string" ? e
    : e instanceof Error ? e.message
    : (e && typeof (e as { message?: unknown }).message === "string") ? (e as { message: string }).message
    : String(e);
  if (/outside workspace root/i.test(reason)) return { denied: true, path };
  return { failed: true, path, reason };
}

/** listen Promise → Unsubscribe (해제 보관 가능, 누수 방지 F2-3). 해제 호출 시 resolve 후 unlisten. */
function deferUnsub(p: Promise<() => void>): Unsubscribe {
  return () => { void p.then((un) => un()).catch(() => {}); };
}

/** old 함수 주입 → F2 read-only 관측 실배선 포트 (env). */
export function makeF2EnvObserve(d: F2LiveDeps): EnvironmentObservePort {
  return {
    // workspace_list_dirs{parent} → DirEntry[]; dir/file 구분(isDir) 보존(F2-6c). dotfile 제외는 Rust 측.
    async listDir(path: string): Promise<ReadResult<readonly DirEntryInfo[]>> {
      try {
        const entries = (await d.invoke("workspace_list_dirs", { parent: path })) as OldDirEntry[];
        return entries.map((e) => ({ name: e.name, path: e.path, isDir: e.is_dir }));
      } catch (e) { return classifyError(path, e); }
    },
    async readFile(path: string): Promise<ReadResult<string>> {
      try { return (await d.invoke("workspace_read_file", { path })) as string; }
      catch (e) { return classifyError(path, e); }
    },
    // workspace_file_size{path} → u64. drift 비교용 값(크기 문자열). 거부=PermissionDenied(≠NotFound), 그외 부재=value null(F2-1).
    async fileStatus(path: string): Promise<ObservedState | PermissionDenied> {
      try {
        const size = (await d.invoke("workspace_file_size", { path })) as number;
        return { key: path, value: String(size) };
      } catch (e) {
        const c = classifyError(path, e);
        if (isDenied(c)) return c;              // 거부 = 보안신호 보존
        return { key: path, value: null };      // 그외(NotFound/IO) = 부재 신호(drift contain)
      }
    },
    async sessions(): Promise<readonly unknown[]> {
      return (await d.invoke("workspace_get_sessions")) as readonly unknown[];
    },
    // processStatus: ⚠️ new-requirement(old 무인자 프로세스 read 없음 — lastSnapshot 처럼 baseline 부재).
    //   pty-agents(추적 pid 기준). pid 없으면 빈 결과(정직). (system-status/diagnostics 는 F1 tranche.)
    async processStatus(): Promise<readonly unknown[]> {
      const pids = d.ptyPids?.() ?? [];
      if (pids.length === 0) return [];
      const map = (await d.invoke("workspace_get_pty_agents", { pids: [...pids] })) as Record<string, string>;
      return Object.entries(map).map(([pid, agent]) => ({ pid: Number(pid), agent }));
    },
    // worktrees: get_main_worktree/get_all_worktree_paths 는 #[tauri::command] 아님(JS invoke 불가) →
    //   repo/worktree 상태는 workspace_get_sessions(SessionInfo) 경유. **WorktreeInfo 로 투영**(sessions 와 구분, F2-5).
    async worktrees(): Promise<readonly WorktreeInfo[]> {
      const ss = (await d.invoke("workspace_get_sessions")) as OldSessionInfo[];
      return ss.map((s) => ({ path: s.path, branch: s.branch ?? null, originPath: s.origin_path ?? null }));
    },
    // workspace:file-changed{session,file,timestamp} 구독(외부변경 포함). 반환 Unsubscribe(누수 방지, F2-3).
    subscribeChanges(onChange: (e: FileChangeEvent) => void): Unsubscribe {
      const p = d.listen("workspace:file-changed", (ev) => {
        const x = (ev.payload ?? {}) as Partial<FileChangeEvent>;
        onChange({ session: x.session ?? "", file: x.file ?? "", timestamp: x.timestamp ?? 0 });
      });
      return deferUnsub(p);
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

/** pty read 실배선 — old 는 pty:output:{ptyId}/pty:exit:{ptyId} (per-id). 포트가 id 없으므로 id 바인딩 팩토리.
 *  ⚠️ ptyId 규약 = old `format!("pty-{pid}")` 그대로(예: "pty-1234"). raw pid 아님(F2-6a).
 *  exit 는 old 가 unit() emit = 코드 없음 → cb() 무인자(코드 발명 금지, F2-4). 반환 Unsubscribe(F2-3). */
export function makePtyReader(d: F2LiveDeps, ptyId: string): PtyReadPort {
  return {
    onOutput(cb: (c: string) => void): Unsubscribe {
      return deferUnsub(d.listen(`pty:output:${ptyId}`, (ev) => cb(String(ev.payload ?? ""))));
    },
    onExit(cb: () => void): Unsubscribe {
      return deferUnsub(d.listen(`pty:exit:${ptyId}`, () => cb()));
    },
  };
}
