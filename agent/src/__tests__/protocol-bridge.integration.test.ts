/**
 * Phase 5+ adversarial review fix - protocol-bridge integration test.
 *
 * Adversarial review: protocol-bridge.test.ts (34 tests) = pure function
 * verification. Real readline + JSON.parse + envelope-aware dispatch loop
 * (index.ts:1162-1196 main loop) was never exercised end-to-end.
 *
 * This test simulates real stdio: PassThrough stream + readline.createInterface
 * + main loop logic replicated. Verifies envelope vs legacy detection works in
 * actual event-driven flow.
 */

import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	isValidKind,
	looksLikeFrame,
	unwrapFrame,
	wrapAsFrame,
} from "../protocol-bridge.js";
import { parseRequest, type AgentRequest } from "../protocol.js";

interface DispatchResult {
	type: string;
	source: "envelope" | "legacy" | "error";
	requestId?: string;
	frame?: unknown;
}

/**
 * Replicates main() readline dispatch logic from index.ts:1146-1196.
 * Returns observed events as array (synchronous via PassThrough push).
 *
 * NOTE (적대적 4차 조건): runDispatchLoop replicates main() PARSING logic
 * (envelope/legacy discrimination + JSON parse + isValidKind whitelist).
 * Does NOT exercise actual request dispatching (writeLine emits, handler
 * invocation, async approval flow). main() dispatch logic drift risk is
 * tracked separately in shell ↔ agent E2E (deferred to Tauri test environment).
 */
function runDispatchLoop(
	lines: string[],
	envelopeOnly = false,
): Promise<DispatchResult[]> {
	return new Promise((resolve) => {
		const inStream = new PassThrough();
		const events: DispatchResult[] = [];
		const rl = readline.createInterface({ input: inStream, terminal: false });

		rl.on("line", (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;

			let request: AgentRequest | null = null;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (looksLikeFrame(parsed)) {
					request = unwrapFrame(parsed as Parameters<typeof unwrapFrame>[0]);
					if (!request) {
						events.push({ type: "invalid_frame", source: "error" });
						return;
					}
					events.push({ type: request.type, source: "envelope", requestId: (request as { requestId?: string }).requestId });
				} else if (envelopeOnly) {
					events.push({ type: "envelope_only_reject", source: "error" });
					return;
				} else {
					request = parseRequest(trimmed);
					if (request) {
						events.push({ type: request.type, source: "legacy", requestId: (request as { requestId?: string }).requestId });
					} else {
						events.push({ type: "parse_fail", source: "error" });
					}
				}
			} catch {
				request = parseRequest(trimmed);
				if (request) {
					events.push({ type: request.type, source: "legacy", requestId: (request as { requestId?: string }).requestId });
				} else {
					events.push({ type: "parse_fail_json", source: "error" });
				}
			}
		});
		rl.on("close", () => resolve(events));

		for (const line of lines) inStream.write(`${line}\n`);
		inStream.end();
	});
}

describe("protocol-bridge integration - real readline + envelope-aware dispatch", () => {
	it("legacy flat protocol routed via parseRequest (default mode)", async () => {
		const events = await runDispatchLoop([
			JSON.stringify({ type: "chat_request", requestId: "id-1", provider: { provider: "anthropic", model: "x", apiKey: "k" }, messages: [] }),
		]);
		expect(events.length).toBe(1);
		expect(events[0]?.type).toBe("chat_request");
		expect(events[0]?.source).toBe("legacy");
		expect(events[0]?.requestId).toBe("id-1");
	});

	it("envelope StdioFrame v1 unwrapped to flat AgentRequest", async () => {
		const wrapped = wrapAsFrame({
			type: "chat_request",
			requestId: "id-2",
			provider: { provider: "anthropic", model: "x", apiKey: "k" },
			messages: [],
		});
		const events = await runDispatchLoop([JSON.stringify(wrapped)]);
		expect(events.length).toBe(1);
		expect(events[0]?.type).toBe("chat_request");
		expect(events[0]?.source).toBe("envelope");
		expect(events[0]?.requestId).toBe("id-2");
	});

	it("envelope-only mode rejects legacy flat (lock mode)", async () => {
		const events = await runDispatchLoop(
			[
				JSON.stringify({ type: "chat_request", requestId: "id-3", provider: { provider: "anthropic", model: "x", apiKey: "k" }, messages: [] }),
			],
			true,
		);
		expect(events.length).toBe(1);
		expect(events[0]?.source).toBe("error");
		expect(events[0]?.type).toBe("envelope_only_reject");
	});

	it("envelope-only mode accepts proper StdioFrame", async () => {
		const wrapped = wrapAsFrame({
			type: "chat_request",
			requestId: "id-4",
			provider: { provider: "anthropic", model: "x", apiKey: "k" },
			messages: [],
		});
		const events = await runDispatchLoop([JSON.stringify(wrapped)], true);
		expect(events.length).toBe(1);
		expect(events[0]?.source).toBe("envelope");
		expect(events[0]?.type).toBe("chat_request");
	});

	it("malformed JSON falls back to parseRequest null path", async () => {
		const events = await runDispatchLoop(["not-valid-json"]);
		expect(events.length).toBe(1);
		expect(events[0]?.source).toBe("error");
	});

	it("invalid envelope kind dropped explicitly", async () => {
		const events = await runDispatchLoop([
			JSON.stringify({ v: "1", id: "x", type: "request", payload: { kind: "totally_made_up" } }),
		]);
		expect(events.length).toBe(1);
		expect(events[0]?.source).toBe("error");
		expect(events[0]?.type).toBe("invalid_frame");
	});

	it("__proto__ injection rejected via isValidKind", async () => {
		const events = await runDispatchLoop([
			JSON.stringify({ v: "1", id: "x", type: "request", payload: { kind: "__proto__" } }),
		]);
		expect(events.length).toBe(1);
		expect(events[0]?.source).toBe("error");
	});

	it("multiple envelope frames batched in single readline session", async () => {
		const f1 = wrapAsFrame({ type: "cancel_stream", requestId: "a" });
		const f2 = wrapAsFrame({ type: "skill_list", requestId: "b" });
		const events = await runDispatchLoop([JSON.stringify(f1), JSON.stringify(f2)]);
		expect(events.length).toBe(2);
		expect(events[0]?.type).toBe("cancel_stream");
		expect(events[1]?.type).toBe("skill_list");
		expect(events[0]?.source).toBe("envelope");
		expect(events[1]?.source).toBe("envelope");
	});

	it("mixed envelope + legacy in same session both routed correctly", async () => {
		const envelope = wrapAsFrame({ type: "skill_list", requestId: "envelope-id" });
		const legacy = JSON.stringify({ type: "skill_list", requestId: "legacy-id" });
		const events = await runDispatchLoop([JSON.stringify(envelope), legacy]);
		expect(events.length).toBe(2);
		expect(events[0]?.source).toBe("envelope");
		expect(events[1]?.source).toBe("legacy");
	});

	it("empty lines skipped (no event emitted)", async () => {
		const events = await runDispatchLoop(["", "  ", JSON.stringify({ type: "skill_list", requestId: "x" })]);
		expect(events.length).toBe(1);
		expect(events[0]?.requestId).toBe("x");
	});

	it("isValidKind handles whitelist + injection at API boundary", () => {
		expect(isValidKind("chat")).toBe(true);
		expect(isValidKind("approval")).toBe(true);
		expect(isValidKind("__proto__")).toBe(false);
		expect(isValidKind("constructor")).toBe(false);
		expect(isValidKind(undefined)).toBe(false);
		expect(isValidKind(42)).toBe(false);
	});
});
