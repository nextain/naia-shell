// F2 계약 테스트 (P02). host-system read-only 관측 + drift(권위 우선) + 권한 거부.
import { describe, it, expect } from "vitest";
import { ObservationService, DriftDetector } from "../main/app/control/observe.js";
import { resolveExpected, detectDrift, type ObservedState } from "../main/domain/observe.js";
import { isDenied, type EnvironmentObservePort, type ExpectedStateProviderPort, type FileChangeEvent } from "../main/ports/f2.js";

describe("domain 순수 규칙 (F2)", () => {
  it("resolveExpected 권위 우선순위 goal>approvedIntent>lastSnapshot", () => {
    expect(resolveExpected("g", "a", "s")).toEqual({ source: "goal", value: "g" });
    expect(resolveExpected(null, "a", "s")).toEqual({ source: "approvedIntent", value: "a" });
    expect(resolveExpected(null, null, "s")).toEqual({ source: "lastSnapshot", value: "s" });
    expect(resolveExpected(null, null, null)).toBeNull();
  });
  it("detectDrift: observed≠expected → drift, 같으면 null, expected null이면 null", () => {
    const obs: ObservedState = { key: "/f", value: "v2" };
    expect(detectDrift(obs, { source: "goal", value: "v1" })?.key).toBe("/f");
    expect(detectDrift(obs, { source: "goal", value: "v2" })).toBeNull();
    expect(detectDrift(obs, null)).toBeNull();
  });
  // 경로 권한 경계는 driven adapter(주입 Rust validate_in_workspace)가 SoT — 도메인 미보유(F2-2).
  // 어댑터의 거부 분류는 f2-live-adapter.test.ts 에서 검증.
});

function mkEnv(over: { fileStatus?: string | null; denied?: boolean; changeFile?: string } = {}): EnvironmentObservePort & { fire?: (e: FileChangeEvent) => void } {
  let fire: ((e: FileChangeEvent) => void) | undefined;
  const env: EnvironmentObservePort & { fire?: (e: FileChangeEvent) => void } = {
    listDir: async (p) => (over.denied ? { denied: true, path: p } : [{ name: "a", path: "/w/a", isDir: true }, { name: "b", path: "/w/b", isDir: false }]),
    readFile: async (p) => (over.denied ? { denied: true, path: p } : "content"),
    fileStatus: async (p) => (over.denied ? { denied: true, path: p } : { key: p, value: over.fileStatus ?? null }),
    sessions: async () => [], processStatus: async () => [], worktrees: async () => [],
    subscribeChanges: (cb) => { fire = cb; return () => { fire = undefined; }; },
  };
  env.fire = (e) => fire?.(e);
  return env;
}

describe("ObservationService — 권한 거부 정직 + 신선도", () => {
  it("권한 밖 → PermissionDenied 반환(throw 아님) + timestamp", async () => {
    const svc = new ObservationService(mkEnv({ denied: true }), () => 123);
    const r = await svc.readFile("/etc/x");
    expect(isDenied(r.result)).toBe(true);
    expect(r.timestamp).toBe(123);
  });
  it("정상 read → 값 + 신선도", async () => {
    const r = await new ObservationService(mkEnv(), () => 7).listDir("/w");
    expect(r.result).toEqual([{ name: "a", path: "/w/a", isDir: true }, { name: "b", path: "/w/b", isDir: false }]);
    expect(r.timestamp).toBe(7);
  });
});

describe("DriftDetector — 외부변경 vs expected(권위 우선)", () => {
  const provider = (g: string | null, a: string | null, s: string | null): ExpectedStateProviderPort => ({
    goal: async () => g, approvedIntent: async () => a, lastSnapshot: async () => s,
  });
  it("observed≠goal → drift 보고", async () => {
    const env = mkEnv({ fileStatus: "changed" });
    const drifts: string[] = [];
    const d = new DriftDetector(env, provider("orig", null, null), (x) => drifts.push(x.key));
    const out = await d.handleChange({ session: "s", file: "/f", timestamp: 1 });
    expect(out?.expected.source).toBe("goal");
    expect(drifts).toEqual(["/f"]);
  });
  it("observed=expected → drift 없음", async () => {
    const env = mkEnv({ fileStatus: "same" });
    const d = new DriftDetector(env, provider("same", null, null), () => {});
    expect(await d.handleChange({ session: "s", file: "/f", timestamp: 1 })).toBeNull();
  });
  it("goal 없으면 lastSnapshot 권위 사용", async () => {
    const env = mkEnv({ fileStatus: "now" });
    const d = new DriftDetector(env, provider(null, null, "before"), () => {});
    expect((await d.handleChange({ session: "s", file: "/f", timestamp: 1 }))?.expected.source).toBe("lastSnapshot");
  });
  it("start→stop 구독 해제(누수 방지, F2-3 NI-1) + 거부는 contain(drift 아님)", async () => {
    let live = 0;
    const env: EnvironmentObservePort = {
      listDir: async () => [], readFile: async () => "", fileStatus: async (p) => ({ key: p, value: "v" }),
      sessions: async () => [], processStatus: async () => [], worktrees: async () => [],
      subscribeChanges: () => { live += 1; return () => { live -= 1; }; },
    };
    const d = new DriftDetector(env, provider(null, null, null), () => {});
    d.start(); expect(live).toBe(1);
    d.start(); expect(live).toBe(1);   // 재-start 시 이전 구독 해제(중복 누적 X)
    d.stop(); expect(live).toBe(0);    // 해제됨(누수 방지)
    // 거부 = drift 판정 아님(contain)
    const denyEnv: EnvironmentObservePort = { ...env, fileStatus: async (p) => ({ denied: true, path: p }) };
    const dd = new DriftDetector(denyEnv, provider("g", null, null), () => { throw new Error("거부인데 drift 보고됨"); });
    expect(await dd.handleChange({ session: "s", file: "/x", timestamp: 1 })).toBeNull();
  });
});
