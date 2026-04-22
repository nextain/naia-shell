import type {
	LLMContentBlock,
	LLMStreamChunk,
} from "@nextain/agent-types";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types.js";
import {
	convertStreamChunk,
	toNextainMessage,
} from "../nextain-provider-adapter.js";

/**
 * These tests pin the X1 adapter's two pure translation boundaries:
 *   1) naia-os ChatMessage → @nextain LLMMessage (request side)
 *   2) @nextain LLMStreamChunk → naia-os StreamChunk (response side)
 *
 * The adapter's stream-reassembly state lives in the two Maps passed
 * to `convertStreamChunk`; tests drive a realistic chunk sequence and
 * assert the yielded StreamChunk vocabulary matches the native
 * `src/providers/anthropic.ts` behaviour.
 */

describe("toNextainMessage", () => {
	it("maps a plain assistant text message", () => {
		const msg: ChatMessage = { role: "assistant", content: "hello" };
		expect(toNextainMessage(msg)).toEqual({
			role: "assistant",
			content: "hello",
		});
	});

	it("maps a user message", () => {
		const msg: ChatMessage = { role: "user", content: "hi" };
		expect(toNextainMessage(msg)).toEqual({
			role: "user",
			content: "hi",
		});
	});

	it("maps an assistant turn that issued tool calls to tool_use blocks", () => {
		const msg: ChatMessage = {
			role: "assistant",
			content: "calling a tool",
			toolCalls: [
				{ id: "t-1", name: "echo", args: { value: "x" } },
			],
		};
		expect(toNextainMessage(msg)).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "calling a tool" },
				{ type: "tool_use", id: "t-1", name: "echo", input: { value: "x" } },
			],
		});
	});

	it("omits the leading text block when assistant content is empty", () => {
		const msg: ChatMessage = {
			role: "assistant",
			content: "",
			toolCalls: [{ id: "t-2", name: "noop", args: {} }],
		};
		const out = toNextainMessage(msg);
		expect(out.role).toBe("assistant");
		expect(Array.isArray(out.content)).toBe(true);
		expect((out.content as LLMContentBlock[])[0]).toEqual({
			type: "tool_use",
			id: "t-2",
			name: "noop",
			input: {},
		});
	});

	it("maps a tool-role message to a tool_result block with toolCallId", () => {
		const msg: ChatMessage = {
			role: "tool",
			content: "result-body",
			toolCallId: "t-1",
		};
		expect(toNextainMessage(msg)).toEqual({
			role: "tool",
			content: [
				{ type: "tool_result", toolCallId: "t-1", content: "result-body" },
			],
			toolCallId: "t-1",
		});
	});
});

describe("convertStreamChunk", () => {
	function newState() {
		return {
			toolUseById: new Map<
				string,
				{ id: string; name: string; argsJson: string }
			>(),
			blockKindByIndex: new Map<number, LLMContentBlock["type"]>(),
		};
	}

	it("drops `start` chunks (informational)", () => {
		const s = newState();
		const out = convertStreamChunk(
			{ type: "start", id: "id-1", model: "claude-x" },
			s.toolUseById,
			s.blockKindByIndex,
		);
		expect(out).toBeNull();
	});

	it("accumulates content_block_start state without yielding", () => {
		const s = newState();
		const chunk: LLMStreamChunk = {
			type: "content_block_start",
			index: 0,
			block: { type: "text", text: "" },
		};
		expect(convertStreamChunk(chunk, s.toolUseById, s.blockKindByIndex)).toBeNull();
		expect(s.blockKindByIndex.get(0)).toBe("text");
	});

	it("converts text_delta into a naia-os text chunk", () => {
		const s = newState();
		s.blockKindByIndex.set(0, "text");
		const chunk: LLMStreamChunk = {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "hello " },
		};
		expect(convertStreamChunk(chunk, s.toolUseById, s.blockKindByIndex)).toEqual({
			type: "text",
			text: "hello ",
		});
	});

	it("converts thinking_delta into a naia-os thinking chunk", () => {
		const s = newState();
		s.blockKindByIndex.set(0, "thinking");
		const chunk: LLMStreamChunk = {
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "ponder..." },
		};
		expect(convertStreamChunk(chunk, s.toolUseById, s.blockKindByIndex)).toEqual({
			type: "thinking",
			text: "ponder...",
		});
	});

	it("reassembles tool_use across start/delta/stop and yields a single tool_use chunk", () => {
		const s = newState();
		// start
		convertStreamChunk(
			{
				type: "content_block_start",
				index: 0,
				block: { type: "tool_use", id: "tu-1", name: "echo", input: {} },
			},
			s.toolUseById,
			s.blockKindByIndex,
		);
		// partial JSON in two slices
		convertStreamChunk(
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partialJson: '{"value' },
			},
			s.toolUseById,
			s.blockKindByIndex,
		);
		convertStreamChunk(
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partialJson: '":"x"}' },
			},
			s.toolUseById,
			s.blockKindByIndex,
		);
		// stop → yields
		const out = convertStreamChunk(
			{ type: "content_block_stop", index: 0 },
			s.toolUseById,
			s.blockKindByIndex,
		);
		expect(out).toEqual({
			type: "tool_use",
			id: "tu-1",
			name: "echo",
			args: { value: "x" },
		});
		expect(s.toolUseById.size).toBe(0); // cleaned up
	});

	it("recovers to empty args on malformed JSON (agent loop reports the tool error)", () => {
		const s = newState();
		convertStreamChunk(
			{
				type: "content_block_start",
				index: 0,
				block: { type: "tool_use", id: "tu-2", name: "broken", input: {} },
			},
			s.toolUseById,
			s.blockKindByIndex,
		);
		convertStreamChunk(
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partialJson: "not-json" },
			},
			s.toolUseById,
			s.blockKindByIndex,
		);
		const out = convertStreamChunk(
			{ type: "content_block_stop", index: 0 },
			s.toolUseById,
			s.blockKindByIndex,
		);
		expect(out).toEqual({
			type: "tool_use",
			id: "tu-2",
			name: "broken",
			args: {},
		});
	});

	it("translates partial usage chunks (both tokens present) into a usage chunk", () => {
		const s = newState();
		const out = convertStreamChunk(
			{ type: "usage", usage: { inputTokens: 12, outputTokens: 7 } },
			s.toolUseById,
			s.blockKindByIndex,
		);
		expect(out).toEqual({ type: "usage", inputTokens: 12, outputTokens: 7 });
	});

	it("drops a usage chunk that is missing token counts", () => {
		const s = newState();
		const out = convertStreamChunk(
			{ type: "usage", usage: { cacheReadTokens: 4 } },
			s.toolUseById,
			s.blockKindByIndex,
		);
		expect(out).toBeNull();
	});

	it("translates `end` into a final usage chunk", () => {
		const s = newState();
		const out = convertStreamChunk(
			{
				type: "end",
				stopReason: "end_turn",
				usage: { inputTokens: 30, outputTokens: 18 },
			},
			s.toolUseById,
			s.blockKindByIndex,
		);
		expect(out).toEqual({ type: "usage", inputTokens: 30, outputTokens: 18 });
	});

	it("reassembles a realistic text + tool_use sequence in order", () => {
		const s = newState();
		const yielded: Array<
			NonNullable<ReturnType<typeof convertStreamChunk>>
		> = [];

		const push = (c: LLMStreamChunk) => {
			const r = convertStreamChunk(c, s.toolUseById, s.blockKindByIndex);
			if (r) yielded.push(r);
		};

		push({ type: "start", id: "id-x", model: "m" });
		push({
			type: "content_block_start",
			index: 0,
			block: { type: "text", text: "" },
		});
		push({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "ok, " },
		});
		push({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "calling tool" },
		});
		push({ type: "content_block_stop", index: 0 });
		push({
			type: "content_block_start",
			index: 1,
			block: { type: "tool_use", id: "tu-3", name: "run", input: {} },
		});
		push({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partialJson: '{"k":1}' },
		});
		push({ type: "content_block_stop", index: 1 });
		push({
			type: "end",
			stopReason: "tool_use",
			usage: { inputTokens: 10, outputTokens: 5 },
		});

		expect(yielded).toEqual([
			{ type: "text", text: "ok, " },
			{ type: "text", text: "calling tool" },
			{ type: "tool_use", id: "tu-3", name: "run", args: { k: 1 } },
			{ type: "usage", inputTokens: 10, outputTokens: 5 },
		]);
	});
});
