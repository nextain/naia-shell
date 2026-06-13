// F2 실배선 어댑터 parity 테스트 (drift-gate, P02).
// 검증 = 행동 ≡ Old-Baseline: live 어댑터가 *정확히 old 명령/인자*를 호출(F2-baseline-contract §A).
// 주입형(invoke/listen mock)이라 실 Tauri 없이 결정적 검증 — graft 전 자율 검증 가능.
import { describe, it, expect } from "vitest";
import {
  makeF2EnvObserve, makeF2ExpectedState, makePtyReader, type F2LiveDeps,
} from "../main/adapters/tauri/f2.js";
import { isDenied, type FileChangeEvent } from "../main/ports/f2.js";

/** 호출 기록 invoke + 등록 기록 listen mock. */
function makeDeps(over: Partial<F2LiveDeps> = {}): {
  deps: F2LiveDeps;
  calls: Array<{ cmd: string; args?: Record<string, unknown> }>;
  listens: Array<{ event: string; cb: (e: { payload: unknown }) => void }>;
  resolve: (cmd: string, value: unknown) => void;
  reject: (cmd: string, err: unknown) => void;
} {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const listens: Array<{ event: string; cb: (e: { payload: unknown }) => void }> = [];
  const responses = new Map<string, unknown>();
  const rejections = new Map<string, unknown>();
  const deps: F2LiveDeps = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (rejections.has(cmd)) throw rejections.get(cmd);
      return responses.get(cmd);
    },
    listen: async (event, cb) => { listens.push({ event, cb }); return () => {}; },
    ...over,
  };
  return {
    deps, calls, listens,
    resolve: (cmd, value) => responses.set(cmd, value),
    reject: (cmd, err) => rejections.set(cmd, err),
  };
}

describe("F2 live env 어댑터 — old 명령 parity", () => {
  it("listDir → workspace_list_dirs{parent} 호출 + DirEntry[]→path[] 매핑", async () => {
    const t = makeDeps();
    t.resolve("workspace_list_dirs", [
      { name: "a", path: "/ws/a", is_dir: true },
      { name: "b.ts", path: "/ws/b.ts", is_dir: false },
    ]);
    const env = makeF2EnvObserve(t.deps);
    const r = await env.listDir("/ws");
    expect(t.calls).toEqual([{ cmd: "workspace_list_dirs", args: { parent: "/ws" } }]);
    expect(isDenied(r)).toBe(false);
    expect(r).toEqual(["/ws/a", "/ws/b.ts"]);
  });

  it("listDir 거부(throw) → PermissionDenied contain", async () => {
    const t = makeDeps();
    t.reject("workspace_list_dirs", "path escapes workspace root");
    const env = makeF2EnvObserve(t.deps);
    const r = await env.listDir("/etc");
    expect(isDenied(r)).toBe(true);
    expect(r).toEqual({ denied: true, path: "/etc" });
  });

  it("readFile → workspace_read_file{path}; 거부 → PermissionDenied", async () => {
    const t = makeDeps();
    t.resolve("workspace_read_file", "hello");
    const env = makeF2EnvObserve(t.deps);
    expect(await env.readFile("/ws/f.txt")).toBe("hello");
    expect(t.calls).toEqual([{ cmd: "workspace_read_file", args: { path: "/ws/f.txt" } }]);

    const t2 = makeDeps();
    t2.reject("workspace_read_file", "denied");
    const env2 = makeF2EnvObserve(t2.deps);
    expect(await env2.readFile("/secret")).toEqual({ denied: true, path: "/secret" });
  });

  it("fileStatus → workspace_file_size{path}; size→value(string), 부재→value null", async () => {
    const t = makeDeps();
    t.resolve("workspace_file_size", 1234);
    const env = makeF2EnvObserve(t.deps);
    expect(await env.fileStatus("/ws/f")).toEqual({ key: "/ws/f", value: "1234" });
    expect(t.calls[0]).toEqual({ cmd: "workspace_file_size", args: { path: "/ws/f" } });

    const t2 = makeDeps();
    t2.reject("workspace_file_size", "ENOENT");
    const env2 = makeF2EnvObserve(t2.deps);
    expect(await env2.fileStatus("/ws/missing")).toEqual({ key: "/ws/missing", value: null });
  });

  it("sessions → workspace_get_sessions (무인자)", async () => {
    const t = makeDeps();
    t.resolve("workspace_get_sessions", [{ dir: "repo", path: "/ws/repo", status: "active" }]);
    const env = makeF2EnvObserve(t.deps);
    const r = await env.sessions();
    expect(t.calls).toEqual([{ cmd: "workspace_get_sessions", args: undefined }]);
    expect(r).toHaveLength(1);
  });

  it("worktrees → workspace_get_sessions 경유(get_main_worktree 는 JS invoke 불가, parity)", async () => {
    const t = makeDeps();
    t.resolve("workspace_get_sessions", [{ dir: "repo", path: "/ws/repo", origin_path: "/ws/main", status: "idle" }]);
    const env = makeF2EnvObserve(t.deps);
    await env.worktrees();
    expect(t.calls).toEqual([{ cmd: "workspace_get_sessions", args: undefined }]);
  });

  it("processStatus: pid 없으면 invoke 안 함(빈 결과), pid 있으면 workspace_get_pty_agents{pids}", async () => {
    const t0 = makeDeps();
    const env0 = makeF2EnvObserve(t0.deps);
    expect(await env0.processStatus()).toEqual([]);
    expect(t0.calls).toEqual([]); // 추적 pid 없으면 호출 자체 안 함

    const t = makeDeps({ ptyPids: () => [1111, 2222] });
    t.resolve("workspace_get_pty_agents", { "1111": "claude", "2222": "" });
    const env = makeF2EnvObserve(t.deps);
    const r = await env.processStatus();
    expect(t.calls).toEqual([{ cmd: "workspace_get_pty_agents", args: { pids: [1111, 2222] } }]);
    expect(r).toEqual([{ pid: 1111, agent: "claude" }, { pid: 2222, agent: "" }]);
  });

  it("subscribeChanges → listen('workspace:file-changed') + payload 정규화", async () => {
    const t = makeDeps();
    const env = makeF2EnvObserve(t.deps);
    const got: FileChangeEvent[] = [];
    env.subscribeChanges((e) => got.push(e));
    expect(t.listens).toHaveLength(1);
    expect(t.listens[0].event).toBe("workspace:file-changed");
    // 외부 변경 이벤트 도착(payload 정규화)
    t.listens[0].cb({ payload: { session: "s1", file: "src/x.ts", timestamp: 42 } });
    expect(got).toEqual([{ session: "s1", file: "src/x.ts", timestamp: 42 }]);
    // 누락 필드 = 안전 기본값(crash X)
    t.listens[0].cb({ payload: {} });
    expect(got[1]).toEqual({ session: "", file: "", timestamp: 0 });
  });
});

describe("F2 live expectedState — drift authority", () => {
  it("goal/approvedIntent = null(소스 미존재, 정직), lastSnapshot = 주입 store", async () => {
    const t = makeDeps({ snapshotStore: { get: (k) => (k === "/ws/f" ? "100" : null) } });
    const ep = makeF2ExpectedState(t.deps);
    expect(await ep.goal()).toBeNull();
    expect(await ep.approvedIntent()).toBeNull();
    expect(await ep.lastSnapshot("/ws/f")).toBe("100");
    expect(await ep.lastSnapshot("/ws/other")).toBeNull();
  });

  it("snapshotStore 미주입 → lastSnapshot null", async () => {
    const t = makeDeps();
    const ep = makeF2ExpectedState(t.deps);
    expect(await ep.lastSnapshot("/ws/f")).toBeNull();
  });
});

describe("F2 live pty reader — per-id 이벤트", () => {
  it("makePtyReader(id) → listen('pty:output:{id}'/'pty:exit:{id}')", () => {
    const t = makeDeps();
    const pty = makePtyReader(t.deps, "term-7");
    const out: string[] = []; const exits: number[] = [];
    pty.onOutput((c) => out.push(c));
    pty.onExit((c) => exits.push(c));
    expect(t.listens.map((l) => l.event)).toEqual(["pty:output:term-7", "pty:exit:term-7"]);
    t.listens[0].cb({ payload: "line1" });
    t.listens[1].cb({ payload: 0 });
    expect(out).toEqual(["line1"]);
    expect(exits).toEqual([0]);
  });
});
