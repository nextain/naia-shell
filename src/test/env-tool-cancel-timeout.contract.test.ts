// #499 취소·타임아웃 계약 테스트 (P02) — FR-ENV-TOOL.1·9.
// 취소가 실제로 멈추는가, 부분 실행이 남는가, 재전송이 두 번 실행하지 않는가.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EnvironmentToolService } from "../main/app/control/env-tool.js";
import { EnvOperationFailure, terminate, type BrowserEvidence } from "../main/domain/env-tool.js";
import type { BrowserOperationPort, CancellationPort } from "../main/ports/env-tool.js";
import { BROWSER_EVIDENCE, envRequest, fakeBrowser, fakeCancellation, fakeTerminal } from "./helpers/env-tool-fixture.js";

function service() {
  const browser = fakeBrowser();
  return { svc: new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]), browser };
}

describe("종료 사유 구별 (FR-ENV-TOOL.9) [UC-ENV-TOOL-CANCEL]", () => {
  it("정상 종료만 완료다", () => {
    expect(terminate("finished", []).state).toBe("completed");
  });

  it("취소는 완료가 아니고 실패도 아니다", () => {
    expect(terminate("cancelled", []).state).toBe("cancelled");
  });

  it("타임아웃은 완료로 승격되지 않는다", () => {
    expect(terminate("timed-out", []).state).not.toBe("completed");
  });

  it("취소·타임아웃이어도 이미 일어난 일은 남는다", () => {
    expect(terminate("cancelled", ["파일 3개 기록됨"]).partialEffects).toEqual(["파일 3개 기록됨"]);
    expect(terminate("timed-out", ["요청 1건 전송됨"]).partialEffects).toEqual(["요청 1건 전송됨"]);
  });
});

describe("취소 (FR-ENV-TOOL.9)", () => {
  it("진행 중 작업을 취소하면 상태가 취소로 바뀌고 부분 결과가 온다", async () => {
    const { svc } = service();
    await svc.click(envRequest(), { kind: "reference", ref: "b" });
    // 완료된 작업은 취소되지 않는다.
    const done = await svc.cancel("op1");
    expect(done.partialEffects).toEqual([]);
    expect(svc.stateOf("op1")).toBe("completed");
  });

  it("모르는 작업을 취소해도 터지지 않는다", async () => {
    const { svc } = service();
    const out = await svc.cancel("없는작업");
    expect(out.state).toBe("cancelled");
    expect(out.partialEffects).toEqual([]);
  });
});

describe("멱등 재전송 (FR-ENV-TOOL.9)", () => {
  it("같은 키를 두 번 보내면 브라우저를 한 번만 부른다", async () => {
    const { svc, browser } = service();
    const first = await svc.click(envRequest(), { kind: "reference", ref: "b" });
    const second = await svc.click(envRequest({ operationId: "op2" }), { kind: "reference", ref: "b" });
    expect(browser.calls.filter((c) => c === "click")).toHaveLength(1);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.operation.deduplicated).toBe(true);
    expect(second.operation.operationId).toBe("op1");
  });

  it("키가 다르면 각각 실행한다", async () => {
    const { svc, browser } = service();
    await svc.click(envRequest({ idempotencyKey: "k1" }), { kind: "reference", ref: "b" });
    await svc.click(envRequest({ operationId: "op2", idempotencyKey: "k2" }), { kind: "reference", ref: "b" });
    expect(browser.calls.filter((c) => c === "click")).toHaveLength(2);
  });

  it("거절된 요청은 기억하지 않는다", async () => {
    const { svc, browser } = service();
    const bad = await svc.click(envRequest({ capability: "purchase" }), { kind: "reference", ref: "b" });
    expect(bad.ok).toBe(false);
    const good = await svc.click(envRequest(), { kind: "reference", ref: "b" });
    expect(good.ok).toBe(true);
    expect(browser.calls.filter((c) => c === "click")).toHaveLength(1);
  });
});

// ── #582 S0b: 종결 CAS · 진행 중 멱등 공유 · 실제 deadline ──────────────────────
// 계약: docs/progress/issue-582-ego-browser-host.md 4.4·4.7.

interface ControllableBrowser extends BrowserOperationPort {
  readonly calls: string[];
  readonly signals: (AbortSignal | undefined)[];
  finish(evidence?: Partial<BrowserEvidence>): void;
  fail(error: unknown): void;
}

/** 언제 끝날지 테스트가 정하는 브라우저 대역. 경주를 손으로 만들어야 CAS 를 볼 수 있다. */
function controllableBrowser(): ControllableBrowser {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  // 대기 중인 호출 전부를 들고 있는다. 하나만 들면 두 번째 호출이 첫 번째를 덮어
  // 첫 호출이 영영 안 끝나고, 테스트가 상한 만료로 통과해 버린다(실측 5초).
  const pending: { resolve: (value: BrowserEvidence) => void; reject: (error: unknown) => void }[] = [];
  return {
    calls,
    signals,
    finish(evidence: Partial<BrowserEvidence> = {}) {
      for (const p of pending.splice(0)) p.resolve({ ...BROWSER_EVIDENCE, ...evidence });
    },
    fail(error: unknown) {
      for (const p of pending.splice(0)) p.reject(error);
    },
    async open() {
      throw new Error("쓰지 않는다");
    },
    async snapshot() {
      throw new Error("쓰지 않는다");
    },
    async click(_request, _target, signal) {
      calls.push("click");
      signals.push(signal);
      return new Promise<BrowserEvidence>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    async fill() {
      throw new Error("쓰지 않는다");
    },
    async close() {},
  };
}

function recordingCancellation(): CancellationPort & { readonly cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    cancelled,
    async cancel(operationId: string) {
      cancelled.push(operationId);
      return ["요청 1건 전송됨"];
    },
  };
}

const REF = { kind: "reference", ref: "b" } as const;

describe("종결 상태 CAS (#582 4.4) [UC-ENV-TOOL-CANCEL]", () => {
  it("취소가 먼저면 뒤늦은 완료는 완료로 승격되지 않고 그 사실이 남는다", async () => {
    const browser = controllableBrowser();
    const svc = new EnvironmentToolService(browser, fakeTerminal(), recordingCancellation(), ["observe", "workspace-write"]);
    const inflight = svc.click(envRequest(), REF);
    await Promise.resolve();

    const termination = await svc.cancel("op1");
    expect(termination.state).toBe("cancelled");
    browser.finish();
    const outcome = await inflight;

    expect(outcome.ok, "취소된 작업이 완료로 돌아왔다").toBe(false);
    expect(svc.stateOf("op1")).toBe("cancelled");
    const snapshot = svc.snapshotOf("op1");
    expect(snapshot?.reason).toBe("cancelled");
    expect(snapshot?.lateTerminations.join(" "), "무시했다는 사실이 남지 않았다").toContain("completed");
  });

  it("완료가 먼저면 뒤늦은 취소가 상태를 뒤집지 못하고 효과를 지어내지 않는다", async () => {
    const cancellation = recordingCancellation();
    const svc = new EnvironmentToolService(fakeBrowser(), fakeTerminal(), cancellation, ["observe", "workspace-write"]);
    const done = await svc.click(envRequest(), REF);
    expect(done.ok).toBe(true);

    const termination = await svc.cancel("op1");
    expect(termination.partialEffects).toEqual([]);
    expect(svc.stateOf("op1")).toBe("completed");
    expect(cancellation.cancelled, "이미 끝난 작업인데 취소가 포트까지 내려갔다").toEqual([]);
    expect(svc.snapshotOf("op1")?.lateTerminations.join(" ")).toContain("cancelled");
  });

  it("취소는 포트까지 내려가고 진행 중 작업의 중단 신호를 발화한다", async () => {
    const browser = controllableBrowser();
    const cancellation = recordingCancellation();
    const svc = new EnvironmentToolService(browser, fakeTerminal(), cancellation, ["observe", "workspace-write"]);
    const inflight = svc.click(envRequest(), REF);
    await Promise.resolve();

    const signal = browser.signals[0];
    expect(signal?.aborted, "시작부터 끊겨 있었다").toBe(false);
    const termination = await svc.cancel("op1");

    expect(cancellation.cancelled).toEqual(["op1"]);
    expect(signal?.aborted, "포트가 받은 신호가 발화하지 않았다").toBe(true);
    expect(termination.partialEffects).toEqual(["요청 1건 전송됨"]);
    browser.finish();
    await inflight;
    expect(svc.snapshotOf("op1")?.partialEffects).toEqual(["요청 1건 전송됨"]);
  });
});

describe("진행 중 멱등 공유 (FR-ENV-TOOL.9) [UC-ENV-TOOL-CANCEL]", () => {
  it("같은 키로 동시에 다섯 번 불러도 포트는 한 번만 돈다", async () => {
    const browser = controllableBrowser();
    const svc = new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]);
    const inflight = [0, 1, 2, 3, 4].map((n) => svc.click(envRequest({ operationId: `op-${n}` }), REF));
    await Promise.resolve();
    browser.finish();
    const outcomes = await Promise.all(inflight);

    expect(browser.calls.filter((c) => c === "click"), "동시 요청이 포트를 여러 번 불렀다").toHaveLength(1);
    for (const outcome of outcomes) expect(outcome.ok).toBe(true);
    const ids = outcomes.map((o) => (o.ok ? o.operation.operationId : "실패"));
    expect(new Set(ids).size, "같은 키인데 서로 다른 작업으로 갈렸다").toBe(1);
    expect(outcomes.filter((o) => o.ok && o.operation.deduplicated)).toHaveLength(4);
  });

  it("키가 다르면 동시라도 각각 돈다", async () => {
    const browser = controllableBrowser();
    const svc = new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]);
    const inflight = [
      svc.click(envRequest({ operationId: "op-a", idempotencyKey: "k-a" }), REF),
      svc.click(envRequest({ operationId: "op-b", idempotencyKey: "k-b" }), REF),
    ];
    await Promise.resolve();
    browser.finish();
    await Promise.all(inflight);
    expect(browser.calls.filter((c) => c === "click")).toHaveLength(2);
  });

  it("권한이 없는 호출자는 같은 키의 진행 중 결과를 주워 가지 못한다", async () => {
    const browser = controllableBrowser();
    const svc = new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]);
    const inflight = svc.click(envRequest(), REF);
    await Promise.resolve();
    const stolen = await svc.click(envRequest({ operationId: "op-2", capability: "purchase" }), REF);
    expect(stolen.ok).toBe(false);
    browser.finish();
    await inflight;
  });
});

describe("실제 deadline (FR-ENV-TOOL.9, #582 4.7) [UC-ENV-TOOL-CANCEL]", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("상한이 지나면 타이머가 작업을 실패로 끝내고 신호를 끊는다", async () => {
    vi.useFakeTimers();
    const browser = controllableBrowser();
    const svc = new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]);
    const inflight = svc.click(envRequest({ timeoutMs: 5_000 }), REF);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await inflight;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((r) => r.code)).toEqual(["timeout"]);
    expect(svc.stateOf("op1")).toBe("failed");
    expect(svc.snapshotOf("op1")?.reason).toBe("timeout");
    expect(browser.signals[0]?.aborted, "상한을 넘겼는데 포트에 신호가 안 갔다").toBe(true);
  });

  it("상한 뒤 늦게 끝난 일은 완료로 승격되지 않는다", async () => {
    vi.useFakeTimers();
    const browser = controllableBrowser();
    const svc = new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]);
    const inflight = svc.click(envRequest({ timeoutMs: 1_000 }), REF);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await inflight;

    browser.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.stateOf("op1")).toBe("failed");
    expect(svc.snapshotOf("op1")?.reason).toBe("timeout");
  });

  it("상한 안에 끝나면 타이머가 결과를 건드리지 않는다", async () => {
    vi.useFakeTimers();
    const browser = controllableBrowser();
    const svc = new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]);
    const inflight = svc.click(envRequest({ timeoutMs: 10_000 }), REF);
    await Promise.resolve();
    browser.finish();
    const outcome = await inflight;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(outcome.ok).toBe(true);
    expect(svc.stateOf("op1")).toBe("completed");
  });
});

describe("실패 사유를 뭉개지 않는다 (#582 4.4)", () => {
  it.each(["method-denied", "context-mismatch", "disconnected", "process-exit"] as const)(
    "포트가 실은 %s 사유가 그대로 기록된다",
    async (reason) => {
      const browser = controllableBrowser();
      const svc = new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]);
      const inflight = svc.click(envRequest(), REF);
      await Promise.resolve();
      browser.fail(new EnvOperationFailure(reason, `포트가 ${reason} 로 거부했다`));
      const outcome = await inflight;

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.rejections.map((r) => r.code), "사유가 경계 이탈로 뭉개졌다").toEqual([reason]);
      expect(outcome.rejections[0]?.detail).toContain(reason);
      expect(svc.snapshotOf("op1")?.reason).toBe(reason);
    },
  );

  it("사유 없는 오류는 지어내지 않고 사유를 못 받았다는 자리에 남는다", async () => {
    const browser = controllableBrowser();
    const svc = new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]);
    const inflight = svc.click(envRequest(), REF);
    await Promise.resolve();
    browser.fail(new Error("무슨 일인지 모르겠다"));
    const outcome = await inflight;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 경계 이탈로 뭉개지 않는 것이 요점이다.
    expect(outcome.rejections.map((r) => r.code)).not.toContain("workspace-escape");
    expect(outcome.rejections[0]?.detail).toContain("무슨 일인지 모르겠다");
  });

  it("증거 없는 완료는 경계 이탈이 아니라 부분 실행으로 기록된다", async () => {
    const svc = new EnvironmentToolService(fakeBrowser({ screenshotRef: "" }), fakeTerminal(), fakeCancellation(), [
      "observe",
      "workspace-write",
    ]);
    const outcome = await svc.click(envRequest(), REF);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((r) => r.code)).toEqual(["partial"]);
    expect(svc.snapshotOf("op1")?.reason).toBe("partial");
  });
});
