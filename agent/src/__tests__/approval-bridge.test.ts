import { describe, expect, it, vi } from "vitest";
import {
	APPROVAL_DEFAULT_TIMEOUT_MS,
	NaiaApprovalBridge,
} from "../approval-bridge.js";

/**
 * Day 4.5.2 — approval-bridge tests.
 * Verify the Phase 4.1 transition broker contract (mirrors IpcApprovalBroker
 * tests in cli-app, but using naia-os legacy ApprovalResponse shape).
 */

describe("NaiaApprovalBridge — decide()", () => {
	it("T0 → immediately approved (no emit)", async () => {
		const emit = vi.fn();
		const bridge = new NaiaApprovalBridge({ emit });
		const decision = await bridge.decide({
			id: "id-t0",
			toolName: "ls",
			toolArgs: {},
			tier: "T0",
			summary: "list",
		});
		expect(decision.status).toBe("approved");
		expect(emit).not.toHaveBeenCalled();
		bridge.close();
	});

	it("emits approval_request with correct shape", () => {
		const emit = vi.fn();
		const bridge = new NaiaApprovalBridge({ emit });
		void bridge.decide({
			id: "id-emit",
			toolName: "write",
			toolArgs: { path: "src/api.ts" },
			tier: "T2",
			summary: "write src/api.ts",
		});
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "approval_request",
				requestId: "id-emit",
				toolCallId: "id-emit",
				toolName: "write",
				tier: 2,
				description: "write src/api.ts",
			}),
		);
		bridge.close();
	});

	it("handleResponse approve (once) → approved", async () => {
		const bridge = new NaiaApprovalBridge({ emit: vi.fn() });
		const p = bridge.decide({
			id: "id-app",
			toolName: "x",
			toolArgs: {},
			tier: "T2",
			summary: "x",
		});
		bridge.handleResponse({
			type: "approval_response",
			requestId: "id-app",
			toolCallId: "id-app",
			decision: "once",
		});
		const d = await p;
		expect(d.status).toBe("approved");
		bridge.close();
	});

	it("handleResponse reject → denied with reason", async () => {
		const bridge = new NaiaApprovalBridge({ emit: vi.fn() });
		const p = bridge.decide({
			id: "id-rej",
			toolName: "x",
			toolArgs: {},
			tier: "T2",
			summary: "x",
		});
		bridge.handleResponse({
			type: "approval_response",
			requestId: "id-rej",
			toolCallId: "id-rej",
			decision: "reject",
			message: "user clicked deny",
		});
		const d = await p;
		expect(d.status).toBe("denied");
		if (d.status === "denied") {
			expect(d.reason).toBe("user clicked deny");
		}
		bridge.close();
	});

	it("timeout → status timeout", async () => {
		const bridge = new NaiaApprovalBridge({ emit: vi.fn() });
		const p = bridge.decide({
			id: "id-to",
			toolName: "x",
			toolArgs: {},
			tier: "T2",
			summary: "x",
			timeoutMs: 30,
		});
		const d = await p;
		expect(d.status).toBe("timeout");
		bridge.close();
	}, 1000);

	it("multiple concurrent decisions routed by id", async () => {
		const bridge = new NaiaApprovalBridge({ emit: vi.fn() });
		const p1 = bridge.decide({ id: "a", toolName: "x", toolArgs: {}, tier: "T2", summary: "" });
		const p2 = bridge.decide({ id: "b", toolName: "y", toolArgs: {}, tier: "T2", summary: "" });
		expect(bridge.pendingCount()).toBe(2);
		bridge.handleResponse({ type: "approval_response", requestId: "b", toolCallId: "b", decision: "once" });
		bridge.handleResponse({ type: "approval_response", requestId: "a", toolCallId: "a", decision: "reject" });
		const [d1, d2] = await Promise.all([p1, p2]);
		expect(d1.status).toBe("denied");
		expect(d2.status).toBe("approved");
		expect(bridge.pendingCount()).toBe(0);
		bridge.close();
	});

	it("close settles all pending as denied", async () => {
		const bridge = new NaiaApprovalBridge({ emit: vi.fn() });
		const p1 = bridge.decide({ id: "x", toolName: "a", toolArgs: {}, tier: "T2", summary: "" });
		const p2 = bridge.decide({ id: "y", toolName: "b", toolArgs: {}, tier: "T2", summary: "" });
		bridge.close();
		const [d1, d2] = await Promise.all([p1, p2]);
		expect(d1.status).toBe("denied");
		expect(d2.status).toBe("denied");
		expect(bridge.pendingCount()).toBe(0);
	});

	it("decide after close → immediately denied", async () => {
		const bridge = new NaiaApprovalBridge({ emit: vi.fn() });
		bridge.close();
		const d = await bridge.decide({ id: "z", toolName: "x", toolArgs: {}, tier: "T2", summary: "" });
		expect(d.status).toBe("denied");
	});

	it("stale response (unknown id) → silently dropped", () => {
		const bridge = new NaiaApprovalBridge({ emit: vi.fn() });
		bridge.handleResponse({ type: "approval_response", requestId: "stale", toolCallId: "stale", decision: "once" });
		expect(bridge.pendingCount()).toBe(0);
		bridge.close();
	});

	it("'always' decision treated as approved (Phase 4.1 transition note)", async () => {
		const bridge = new NaiaApprovalBridge({ emit: vi.fn() });
		const p = bridge.decide({ id: "alw", toolName: "x", toolArgs: {}, tier: "T3", summary: "" });
		bridge.handleResponse({ type: "approval_response", requestId: "alw", toolCallId: "alw", decision: "always" });
		const d = await p;
		expect(d.status).toBe("approved");
		bridge.close();
	});

	it("emit throw → denied with reason", async () => {
		const bridge = new NaiaApprovalBridge({
			emit: () => { throw new Error("write failed"); },
		});
		const d = await bridge.decide({ id: "throw", toolName: "x", toolArgs: {}, tier: "T2", summary: "" });
		expect(d.status).toBe("denied");
		if (d.status === "denied") {
			expect(d.reason).toContain("emit failed");
		}
		bridge.close();
	});
});

describe("NaiaApprovalBridge — tier defaults", () => {
	it("APPROVAL_DEFAULT_TIMEOUT_MS matches D40 spec", () => {
		expect(APPROVAL_DEFAULT_TIMEOUT_MS.T0).toBe(0);
		expect(APPROVAL_DEFAULT_TIMEOUT_MS.T1).toBe(60_000);
		expect(APPROVAL_DEFAULT_TIMEOUT_MS.T2).toBe(120_000);
		expect(APPROVAL_DEFAULT_TIMEOUT_MS.T3).toBe(300_000);
	});

	it("custom defaultTimeoutMs override", async () => {
		const bridge = new NaiaApprovalBridge({
			emit: vi.fn(),
			defaultTimeoutMs: { T1: 30 },
		});
		const p = bridge.decide({ id: "t1", toolName: "x", toolArgs: {}, tier: "T1", summary: "" });
		const d = await p;
		expect(d.status).toBe("timeout");
		bridge.close();
	}, 500);
});
