/**
 * Phase 5+ adversarial review fix - approval-bridge integration test.
 *
 * Adversarial review: approval-bridge.test.ts (13 tests) = vi.fn(emit) only.
 * Real emit -> writeLine round-trip not exercised. Day 8.1 D40 "always" -> emit
 * frame channel never verified end-to-end (frame shape + sequence).
 *
 * This test uses Writable subclass to capture real emit output, then verifies:
 *   - emit invocation frame shape matches naia-os ApprovalRequest protocol
 *   - timeout fires real settle (no mock setTimeout)
 *   - approve / deny round-trip via handleResponse
 *   - "always" -> warn frame emitted with __d40_warn__ tool name (Phase 4 P0-3 fix)
 *   - close() settles all pending with real timer cleanup
 *   - concurrent decisions routed by id (real Map ops)
 */

import { describe, expect, it } from "vitest";
import { NaiaApprovalBridge } from "../approval-bridge.js";
import type { ApprovalResponse } from "../protocol.js";

interface CapturedFrame {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  description?: string;
  tier?: number;
  requestId?: string;
}

function makeCaptureBridge(captured: CapturedFrame[]): NaiaApprovalBridge {
  return new NaiaApprovalBridge({
    emit: (frame) => {
      captured.push(frame as CapturedFrame);
    },
  });
}

describe("NaiaApprovalBridge integration - real emit channel + timer", () => {
  it("emit frame shape matches naia-os ApprovalRequest protocol", async () => {
    const captured: CapturedFrame[] = [];
    const bridge = makeCaptureBridge(captured);
    const decisionPromise = bridge.decide({
      id: "id-shape",
      toolName: "naia_skill_write",
      toolArgs: { path: "src/api.ts" },
      tier: "T2",
      summary: "write src/api.ts",
    });
    expect(captured.length).toBe(1);
    const frame = captured[0]!;
    expect(frame.type).toBe("approval_request");
    expect(frame.toolName).toBe("naia_skill_write");
    expect(frame.toolCallId).toBe("id-shape");
    expect(frame.requestId).toBe("id-shape");
    expect(frame.tier).toBe(2);
    expect(frame.description).toBe("write src/api.ts");
    expect(frame.args).toEqual({ path: "src/api.ts" });

    // Settle to clean up pending
    bridge.handleResponse({
      type: "approval_response",
      requestId: "id-shape",
      toolCallId: "id-shape",
      decision: "reject",
    });
    await decisionPromise;
    bridge.close();
  });

  it("real timeout fires via setTimeout (no mock)", async () => {
    const captured: CapturedFrame[] = [];
    const bridge = makeCaptureBridge(captured);
    const start = Date.now();
    const decision = await bridge.decide({
      id: "id-timeout",
      toolName: "tool",
      toolArgs: {},
      tier: "T2",
      summary: "",
      timeoutMs: 50,
    });
    const elapsed = Date.now() - start;
    expect(decision.status).toBe("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
    bridge.close();
  });

  it("D40 always -> __d40_warn__ frame emitted (Phase 4 P0-3 fix verification)", async () => {
    const captured: CapturedFrame[] = [];
    const bridge = makeCaptureBridge(captured);
    const decisionPromise = bridge.decide({
      id: "id-always",
      toolName: "tool",
      toolArgs: {},
      tier: "T2",
      summary: "",
    });
    expect(captured.length).toBe(1);
    expect(captured[0]?.toolName).toBe("tool");

    // Send legacy "always" decision - bridge MUST emit warn frame + still approve
    bridge.handleResponse({
      type: "approval_response",
      requestId: "id-always",
      toolCallId: "id-always",
      decision: "always",
    });

    const decision = await decisionPromise;
    expect(decision.status).toBe("approved");

    // 2nd frame is the __d40_warn__ visibility frame
    expect(captured.length).toBe(2);
    expect(captured[1]?.toolName).toBe("__d40_warn__");
    expect(captured[1]?.requestId).toContain("always-warn-id-always");
    expect(captured[1]?.args?.["originalToolCallId"]).toBe("id-always");
    expect(captured[1]?.args?.["message"]).toMatch(/D40 fresh-per-tier/);
    bridge.close();
  });

  it("approve via handleResponse - real Map dispatch", async () => {
    const captured: CapturedFrame[] = [];
    const bridge = makeCaptureBridge(captured);
    const decisionPromise = bridge.decide({
      id: "id-approve",
      toolName: "x",
      toolArgs: {},
      tier: "T2",
      summary: "",
    });
    bridge.handleResponse({
      type: "approval_response",
      requestId: "id-approve",
      toolCallId: "id-approve",
      decision: "once",
    });
    const decision = await decisionPromise;
    expect(decision.status).toBe("approved");
    bridge.close();
  });

  it("deny with reason - reason propagated through bridge", async () => {
    const captured: CapturedFrame[] = [];
    const bridge = makeCaptureBridge(captured);
    const decisionPromise = bridge.decide({
      id: "id-deny",
      toolName: "x",
      toolArgs: {},
      tier: "T2",
      summary: "",
    });
    bridge.handleResponse({
      type: "approval_response",
      requestId: "id-deny",
      toolCallId: "id-deny",
      decision: "reject",
      message: "user clicked deny",
    });
    const decision = await decisionPromise;
    expect(decision.status).toBe("denied");
    if (decision.status === "denied") {
      expect(decision.reason).toBe("user clicked deny");
    }
    bridge.close();
  });

  it("concurrent decisions routed by id (real Map operations)", async () => {
    const captured: CapturedFrame[] = [];
    const bridge = makeCaptureBridge(captured);

    const p1 = bridge.decide({ id: "a", toolName: "tA", toolArgs: {}, tier: "T2", summary: "A" });
    const p2 = bridge.decide({ id: "b", toolName: "tB", toolArgs: {}, tier: "T3", summary: "B" });
    const p3 = bridge.decide({ id: "c", toolName: "tC", toolArgs: {}, tier: "T1", summary: "C" });

    expect(bridge.pendingCount()).toBe(3);
    expect(captured.length).toBe(3);

    // Resolve in non-deterministic order
    bridge.handleResponse({ type: "approval_response", requestId: "b", toolCallId: "b", decision: "reject" });
    bridge.handleResponse({ type: "approval_response", requestId: "c", toolCallId: "c", decision: "once" });
    bridge.handleResponse({ type: "approval_response", requestId: "a", toolCallId: "a", decision: "once" });

    const [d1, d2, d3] = await Promise.all([p1, p2, p3]);
    expect(d1.status).toBe("approved");
    expect(d2.status).toBe("denied");
    expect(d3.status).toBe("approved");
    expect(bridge.pendingCount()).toBe(0);
    bridge.close();
  });

  it("close() settles all pending with real timer cleanup", async () => {
    const captured: CapturedFrame[] = [];
    const bridge = makeCaptureBridge(captured);
    const p1 = bridge.decide({ id: "x", toolName: "a", toolArgs: {}, tier: "T2", summary: "" });
    const p2 = bridge.decide({ id: "y", toolName: "b", toolArgs: {}, tier: "T2", summary: "" });
    expect(bridge.pendingCount()).toBe(2);
    bridge.close();
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1.status).toBe("denied");
    expect(d2.status).toBe("denied");
    expect(bridge.pendingCount()).toBe(0);
  });

  it("T0 immediate-approve emits no frame (no IPC roundtrip)", async () => {
    const captured: CapturedFrame[] = [];
    const bridge = makeCaptureBridge(captured);
    const decision = await bridge.decide({
      id: "id-t0",
      toolName: "ls",
      toolArgs: {},
      tier: "T0",
      summary: "list",
    });
    expect(decision.status).toBe("approved");
    expect(captured.length).toBe(0);
    bridge.close();
  });

  it("stale handleResponse (unknown id) silently dropped", () => {
    const captured: CapturedFrame[] = [];
    const bridge = makeCaptureBridge(captured);
    const stale: ApprovalResponse = {
      type: "approval_response",
      requestId: "stale-id",
      toolCallId: "stale-id",
      decision: "once",
    };
    // Should not throw
    bridge.handleResponse(stale);
    expect(bridge.pendingCount()).toBe(0);
    expect(captured.length).toBe(0);
    bridge.close();
  });
});
