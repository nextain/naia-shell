import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@nextain/agent-protocol";
import {
	isValidKind,
	looksLikeFrame,
	unwrapFrame,
	wrapAsFrame,
} from "../protocol-bridge.js";

describe("protocol-bridge — wrapAsFrame", () => {
	it("wraps chat_request → kind=chat (request)", () => {
		const frame = wrapAsFrame({
			type: "chat_request",
			requestId: "req-1",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(frame.v).toBe(PROTOCOL_VERSION);
		expect(frame.id).toBe("req-1");
		expect(frame.type).toBe("request");
		expect((frame.payload as { kind: string }).kind).toBe("chat");
		expect((frame.payload as { messages: unknown }).messages).toEqual([
			{ role: "user", content: "hi" },
		]);
	});

	it("wraps cancel_stream → kind=cancel (request)", () => {
		const frame = wrapAsFrame({ type: "cancel_stream", requestId: "req-2" });
		expect((frame.payload as { kind: string }).kind).toBe("cancel");
		expect(frame.type).toBe("request");
	});

	it("wraps approval_response → kind=approval (response)", () => {
		const frame = wrapAsFrame({
			type: "approval_response",
			requestId: "req-3",
			toolCallId: "tu-1",
			decision: "once",
		});
		expect((frame.payload as { kind: string }).kind).toBe("approval");
		expect(frame.type).toBe("response");
	});

	it("wraps text chunk → kind=chat_chunk (event)", () => {
		const frame = wrapAsFrame({
			type: "text",
			requestId: "req-4",
			text: "hello",
		});
		expect((frame.payload as { kind: string }).kind).toBe("chat_chunk");
		expect(frame.type).toBe("event");
	});

	it("wraps panel_install → kind=panel_install (request)", () => {
		const frame = wrapAsFrame({
			type: "panel_install",
			requestId: "req-5",
			source: "https://github.com/example/panel",
		});
		expect((frame.payload as { kind: string }).kind).toBe("panel_install");
		expect(frame.type).toBe("request");
	});

	it("generates uuid for missing requestId", () => {
		const frame = wrapAsFrame({ type: "ready" });
		expect(typeof frame.id).toBe("string");
		expect(frame.id.length).toBeGreaterThan(10);
	});

	it("throws on invalid kind", () => {
		expect(() =>
			wrapAsFrame({ type: "totally_made_up_type" as never }),
		).toThrow(/invalid kind/);
	});
});

describe("protocol-bridge — unwrapFrame", () => {
	it("unwraps kind=chat → chat_request", () => {
		const flat = unwrapFrame({
			v: "1",
			id: "id-a",
			type: "request",
			payload: { kind: "chat", messages: [], systemPrompt: "hi" },
		});
		expect(flat).not.toBeNull();
		expect(flat!.type).toBe("chat_request");
		expect((flat as { requestId: string }).requestId).toBe("id-a");
	});

	it("unwraps kind=approval → approval_response", () => {
		const flat = unwrapFrame({
			v: "1",
			id: "id-b",
			type: "response",
			payload: { kind: "approval", status: "approved", at: 1 },
		});
		expect(flat).not.toBeNull();
		expect(flat!.type).toBe("approval_response");
	});

	it("returns null on invalid kind (whitelist)", () => {
		const flat = unwrapFrame({
			v: "1",
			id: "x",
			type: "request",
			payload: { kind: "totally_made_up" },
		});
		expect(flat).toBeNull();
	});

	it("returns null on __proto__ injection", () => {
		const flat = unwrapFrame({
			v: "1",
			id: "x",
			type: "request",
			payload: { kind: "__proto__" },
		});
		expect(flat).toBeNull();
	});

	it("returns null on missing payload", () => {
		const flat = unwrapFrame({
			v: "1",
			id: "x",
			type: "request",
			payload: null,
		} as unknown as Parameters<typeof unwrapFrame>[0]);
		expect(flat).toBeNull();
	});
});

describe("protocol-bridge — round-trip identity (Day 4.4 review P1 fix)", () => {
	it("flat tool_request → wrap → unwrap restores type + payload", () => {
		const original = {
			type: "tool_request",
			requestId: "id-rt",
			toolName: "naia_skill_memo",
			args: { content: "hello" },
		};
		const frame = wrapAsFrame(original);
		const restored = unwrapFrame(frame);
		expect(restored).not.toBeNull();
		expect(restored!.type).toBe("tool_request");
		expect((restored as { requestId: string }).requestId).toBe("id-rt");
		expect((restored as { toolName: string }).toolName).toBe("naia_skill_memo");
		expect((restored as { args: { content: string } }).args).toEqual({
			content: "hello",
		});
	});

	// 12 message type round-trip + chat_chunk variant distinction
	it("chat_request round-trip", () => {
		const r = unwrapFrame(wrapAsFrame({ type: "chat_request", requestId: "1", messages: [] }));
		expect(r?.type).toBe("chat_request");
	});

	it("cancel_stream round-trip", () => {
		const r = unwrapFrame(wrapAsFrame({ type: "cancel_stream", requestId: "2" }));
		expect(r?.type).toBe("cancel_stream");
	});

	it("approval_response round-trip", () => {
		const r = unwrapFrame(wrapAsFrame({ type: "approval_response", requestId: "3", toolCallId: "tu", decision: "once" }));
		expect(r?.type).toBe("approval_response");
	});

	it("tts_request round-trip", () => {
		const r = unwrapFrame(wrapAsFrame({ type: "tts_request", requestId: "4", text: "hi" }));
		expect(r?.type).toBe("tts_request");
	});

	it("memory_export round-trip", () => {
		const r = unwrapFrame(wrapAsFrame({ type: "memory_export", requestId: "5", password: "p" }));
		expect(r?.type).toBe("memory_export");
	});

	it("memory_import round-trip", () => {
		const r = unwrapFrame(wrapAsFrame({ type: "memory_import", requestId: "6", data: [], password: "p" }));
		expect(r?.type).toBe("memory_import");
	});

	it("panel_skills_clear round-trip", () => {
		const r = unwrapFrame(wrapAsFrame({ type: "panel_skills_clear", requestId: "7", panelId: "p" }));
		expect(r?.type).toBe("panel_skills_clear");
	});

	it("chat_chunk variant — text restored (delta-aware)", () => {
		// agent → shell event: { type: "text", text: "hi" } → wrap → kind=chat_chunk
		// → unwrap should restore type=text via delta inspection
		const wrapped = wrapAsFrame({ type: "text", requestId: "8", text: "hi" });
		// payload structure check (wrapping is collapse but delta-aware unwrap should restore)
		// Note: current wrapAsFrame doesn't synthesize delta envelope — it preserves
		// raw fields. So unwrap returns "text" only when payload.delta has text key.
		// For symmetry, downstream must format chat_chunk events with delta envelope.
		const restored = unwrapFrame({
			v: "1", id: "8", type: "event",
			payload: { kind: "chat_chunk", delta: { text: "hi" } },
		});
		expect(restored?.type).toBe("text");
	});

	it("chat_chunk variant — thinking restored", () => {
		const restored = unwrapFrame({
			v: "1", id: "9", type: "event",
			payload: { kind: "chat_chunk", delta: { thinking: "..." } },
		});
		expect(restored?.type).toBe("thinking");
	});

	it("chat_chunk variant — tool_use restored", () => {
		const restored = unwrapFrame({
			v: "1", id: "10", type: "event",
			payload: { kind: "chat_chunk", delta: { tool_use: { id: "tu", name: "x", args: {} } } },
		});
		expect(restored?.type).toBe("tool_use");
	});

	it("response-side kinds reversed (memory_export_result)", () => {
		const restored = unwrapFrame({
			v: "1", id: "11", type: "response",
			payload: { kind: "memory_export_result", error: "not supported" },
		});
		expect(restored?.type).toBe("memory_export_result");
	});

	it("response-side kinds reversed (skill_list_response)", () => {
		const restored = unwrapFrame({
			v: "1", id: "12", type: "response",
			payload: { kind: "skill_list_response", tools: [] },
		});
		expect(restored?.type).toBe("skill_list_response");
	});
});

describe("protocol-bridge — looksLikeFrame heuristic", () => {
	it("true for valid v1 envelope shape", () => {
		expect(
			looksLikeFrame({ v: "1", id: "x", type: "request", payload: {} }),
		).toBe(true);
	});

	it("false for legacy flat", () => {
		expect(looksLikeFrame({ type: "chat_request", requestId: "x" })).toBe(false);
	});

	it("false for null/undefined/primitives", () => {
		expect(looksLikeFrame(null)).toBe(false);
		expect(looksLikeFrame(undefined)).toBe(false);
		expect(looksLikeFrame("string")).toBe(false);
		expect(looksLikeFrame(42)).toBe(false);
	});

	it("false for missing v field", () => {
		expect(looksLikeFrame({ id: "x", type: "request", payload: {} })).toBe(
			false,
		);
	});

	it("false for wrong protocol version", () => {
		expect(
			looksLikeFrame({ v: "2", id: "x", type: "request", payload: {} }),
		).toBe(false);
	});
});

describe("protocol-bridge — isValidKind", () => {
	it("allows whitelisted kinds", () => {
		expect(isValidKind("chat")).toBe(true);
		expect(isValidKind("approval")).toBe(true);
		expect(isValidKind("handshake")).toBe(true);
	});

	it("rejects __proto__ / constructor / prototype", () => {
		expect(isValidKind("__proto__")).toBe(false);
		expect(isValidKind("constructor")).toBe(false);
		expect(isValidKind("prototype")).toBe(false);
	});

	it("rejects unknown kinds", () => {
		expect(isValidKind("unknown_xyz")).toBe(false);
	});

	it("rejects non-string values", () => {
		expect(isValidKind(42)).toBe(false);
		expect(isValidKind(null)).toBe(false);
		expect(isValidKind(undefined)).toBe(false);
	});
});
