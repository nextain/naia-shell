// F2 실배선 어댑터 parity + 신규계약 테스트 (drift-gate, P02).
// 검증 = 행동 ≡ Old-Baseline + 2-AI 리뷰(r-f2-2026-06-13) 반증 테스트:
//   거부≠실패≠NotFound 분리(F2-1) / DirEntryInfo isDir 보존(F2-6c) / WorktreeInfo 투영(F2-5) /
//   구독 Unsubscribe 누수방지(F2-3) / pty onExit 무코드+pty-{id} 규약(F2-4·F2-6a).
import { describe, it, expect } from "vitest";
import {
  makeF2EnvObserve, makeF2ExpectedState, makePtyReader, type F2LiveDeps,
} from "../main/adapters/tauri/f2.js";
import { isDenied, isFailure, isOk } from "../main/ports/f2.js";

interface Listen { event: string; cb: (e: { payload: unknown }) => void; }
function makeDeps(over: Partial<F2LiveDeps> = {}): {
  deps: F2LiveDeps;
  calls: Array<{ cmd: string; args?: Record<string, unknown> }>;
  listens: Listen[];
  unlistened: string[];
  resolve: (cmd: string, value: unknown) => void;
  reject: (cmd: string, err: unknown) => void;
} {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const listens: Listen[] = [];
  const unlistened: string[] = [];
  const responses = new Map<string, unknown>();
  const rejections = new Map<string, unknown>();
  const deps: F2LiveDeps = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (rejections.has(cmd)) throw rejections.get(cmd);
      return responses.get(cmd);
    },
    listen: async (event, cb) => {
      listens.push({ event, cb });
      return () => { unlistened.push(event); };
    },
    ...over,
  };
  return {
    deps, calls, listens, unlistened,
    resolve: (cmd, value) => responses.set(cmd, value),
    reject: (cmd, err) => rejections.set(cmd, err),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const DENY = "Access denied: path is outside workspace root";

describe("F2 live env — old 명령 parity + 에러 분류(F2-1)", () => {
  it("listDir → workspace_list_dirs{parent}; DirEntry→DirEntryInfo(isDir 보존, F2-6c)", async () => {
    const t = makeDeps();
    t.resolve("workspace_list_dirs", [
      { name: "a", path: "/ws/a", is_dir: true },
      { name: "b.ts", path: "/ws/b.ts", is_dir: false },
    ]);
    const env = makeF2EnvObserve(t.deps);
    const r = await env.listDir("/ws");
    expect(t.calls).toEqual([{ cmd: "workspace_list_dirs", args: { parent: "/ws" } }]);
    expect(isOk(r)).toBe(true);
    expect(r).toEqual([
      { name: "a", path: "/ws/a", isDir: true },
      { name: "b.ts", path: "/ws/b.ts", isDir: false },
    ]);
  });

  it("거부(outside workspace root) → PermissionDenied; 그외 에러 → ObservationFailure(은폐 금지, F2-1)", async () => {
    const td = makeDeps(); td.reject("workspace_list_dirs", DENY);
    const rd = await makeF2EnvObserve(td.deps).listDir("/etc");
    expect(isDenied(rd)).toBe(true);
    expect(rd).toEqual({ denied: true, path: "/etc" });

    const tf = makeDeps(); tf.reject("workspace_list_dirs", "Path inaccessible: ENOENT");
    const rf = await makeF2EnvObserve(tf.deps).listDir("/ws/gone");
    expect(isFailure(rf)).toBe(true);          // 거부로 위장 안 함
    expect(isDenied(rf)).toBe(false);
    expect((rf as { reason: string }).reason).toMatch(/inaccessible/i);
  });

  it("readFile → workspace_read_file{path}; 거부/실패 분리", async () => {
    const t = makeDeps(); t.resolve("workspace_read_file", "hello");
    expect(await makeF2EnvObserve(t.deps).readFile("/ws/f")).toBe("hello");
    expect(t.calls[0]).toEqual({ cmd: "workspace_read_file", args: { path: "/ws/f" } });

    const td = makeDeps(); td.reject("workspace_read_file", DENY);
    expect(isDenied(await makeF2EnvObserve(td.deps).readFile("/secret"))).toBe(true);
    const tf = makeDeps(); tf.reject("workspace_read_file", "EIO");
    expect(isFailure(await makeF2EnvObserve(tf.deps).readFile("/ws/x"))).toBe(true);
  });

  it("★ fileStatus: 거부=PermissionDenied(≠NotFound), NotFound/IO=value null (F2-1 핵심)", async () => {
    const t = makeDeps(); t.resolve("workspace_file_size", 1234);
    expect(await makeF2EnvObserve(t.deps).fileStatus("/ws/f")).toEqual({ key: "/ws/f", value: "1234" });

    const td = makeDeps(); td.reject("workspace_file_size", DENY);
    const denied = await makeF2EnvObserve(td.deps).fileStatus("/etc/passwd");
    expect(isDenied(denied)).toBe(true);       // ★ 거부를 null(NotFound)로 뭉개지 않음
    expect(denied).toEqual({ denied: true, path: "/etc/passwd" });

    const tn = makeDeps(); tn.reject("workspace_file_size", "Path inaccessible: ENOENT");
    expect(await makeF2EnvObserve(tn.deps).fileStatus("/ws/gone")).toEqual({ key: "/ws/gone", value: null });
  });

  it("sessions → workspace_get_sessions (무인자)", async () => {
    const t = makeDeps(); t.resolve("workspace_get_sessions", [{ path: "/ws/r" }]);
    await makeF2EnvObserve(t.deps).sessions();
    expect(t.calls).toEqual([{ cmd: "workspace_get_sessions", args: undefined }]);
  });

  it("★ worktrees → WorktreeInfo 투영(sessions 와 구분, F2-5)", async () => {
    const t = makeDeps();
    t.resolve("workspace_get_sessions", [
      { dir: "r", path: "/ws/r", branch: "main", origin_path: "/ws/main", status: "idle" },
      { dir: "r2", path: "/ws/r2", status: "active" }, // branch/origin 없음
    ]);
    const r = await makeF2EnvObserve(t.deps).worktrees();
    expect(r).toEqual([
      { path: "/ws/r", branch: "main", originPath: "/ws/main" },
      { path: "/ws/r2", branch: null, originPath: null },
    ]);
    // sessions() 와 동일 명령이나 *투영*돼 raw 와 다름(= 별개 facet)
    expect(r[0]).not.toHaveProperty("status");
  });

  it("processStatus: pid 없으면 invoke 안 함, 있으면 pty_agents{pids}", async () => {
    const t0 = makeDeps();
    expect(await makeF2EnvObserve(t0.deps).processStatus()).toEqual([]);
    expect(t0.calls).toEqual([]);

    const t = makeDeps({ ptyPids: () => [1111, 2222] });
    t.resolve("workspace_get_pty_agents", { "1111": "claude", "2222": "" });
    const r = await makeF2EnvObserve(t.deps).processStatus();
    expect(t.calls).toEqual([{ cmd: "workspace_get_pty_agents", args: { pids: [1111, 2222] } }]);
    expect(r).toEqual([{ pid: 1111, agent: "claude" }, { pid: 2222, agent: "" }]);
  });

  it("★ subscribeChanges → listen('workspace:file-changed') + payload 정규화 + Unsubscribe 누수방지(F2-3)", async () => {
    const t = makeDeps();
    const got: Array<{ session: string; file: string; timestamp: number }> = [];
    const unsub = makeF2EnvObserve(t.deps).subscribeChanges((e) => got.push(e));
    expect(t.listens.map((l) => l.event)).toEqual(["workspace:file-changed"]);
    t.listens[0].cb({ payload: { session: "s1", file: "src/x.ts", timestamp: 42 } });
    expect(got).toEqual([{ session: "s1", file: "src/x.ts", timestamp: 42 }]);
    t.listens[0].cb({ payload: {} });
    expect(got[1]).toEqual({ session: "", file: "", timestamp: 0 });
    // ★ Unsubscribe 가 실제 unlisten 호출(누수 방지)
    unsub(); await flush();
    expect(t.unlistened).toEqual(["workspace:file-changed"]);
  });
});

describe("F2 live expectedState", () => {
  it("goal/approvedIntent null, lastSnapshot=store", async () => {
    const t = makeDeps({ snapshotStore: { get: (k) => (k === "/ws/f" ? "100" : null) } });
    const ep = makeF2ExpectedState(t.deps);
    expect(await ep.goal()).toBeNull();
    expect(await ep.approvedIntent()).toBeNull();
    expect(await ep.lastSnapshot("/ws/f")).toBe("100");
    expect(await ep.lastSnapshot("/x")).toBeNull();
  });
});

describe("F2 live pty reader (F2-4 무코드 exit · F2-6a pty-{id} 규약 · F2-3 누수)", () => {
  it("makePtyReader(ptyId) → listen('pty:output/exit:{ptyId}') verbatim(pty-{pid})", () => {
    const t = makeDeps();
    const pty = makePtyReader(t.deps, "pty-1234"); // old format!("pty-{pid}")
    pty.onOutput(() => {});
    pty.onExit(() => {});
    expect(t.listens.map((l) => l.event)).toEqual(["pty:output:pty-1234", "pty:exit:pty-1234"]);
  });

  it("★ onExit 는 코드 없음 — old unit() emit, 0 발명 금지(F2-4)", () => {
    const t = makeDeps();
    const pty = makePtyReader(t.deps, "pty-7");
    let fired = 0;
    pty.onExit(() => { fired += 1; }); // 콜백 무인자
    t.listens.find((l) => l.event === "pty:exit:pty-7")!.cb({ payload: null });
    expect(fired).toBe(1); // 신호만, 가짜 코드(0) 없음
  });

  it("onOutput payload→string + Unsubscribe 누수방지(F2-3)", async () => {
    const t = makeDeps();
    const pty = makePtyReader(t.deps, "pty-7");
    const out: string[] = [];
    const unsub = pty.onOutput((c) => out.push(c));
    t.listens[0].cb({ payload: "line1" });
    expect(out).toEqual(["line1"]);
    unsub(); await flush();
    expect(t.unlistened).toEqual(["pty:output:pty-7"]);
  });
});
