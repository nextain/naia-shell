/**
 * Tool-call wiring for the naia-omni realtime session.
 *
 * Server (naia_realtime_server) emits response.function_call_arguments.done per
 * tool call, then response.done{requires_action:true}; it consumes a
 * conversation.item.create{function_call_output} and AUTO-resumes the turn
 * (_resume_after_tools) — so the client must NOT send response.create.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNaiaOmniSession } from "../naia-omni";
import type { NaiaOmniConfig } from "../types";

interface MockWSInstance {
	url: string;
	onopen: (() => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	onerror: (() => void) | null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null;
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}

let lastWs: MockWSInstance;

class MockWebSocket implements MockWSInstance {
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null = null;
	send = vi.fn();
	close = vi.fn();
	constructor(url: string) {
		this.url = url;
		lastWs = this;
	}
}

beforeEach(() => {
	vi.stubGlobal("WebSocket", MockWebSocket);
});
afterEach(() => {
	vi.restoreAllMocks();
});

function connect(config: NaiaOmniConfig) {
	const session = createNaiaOmniSession();
	const promise = session.connect(config);
	setTimeout(() => {
		lastWs.onmessage?.({ data: JSON.stringify({ type: "session.created" }) });
	}, 0);
	return { session, promise };
}

const DIRECT: NaiaOmniConfig = {
	provider: "naia-omni",
	serverUrl: "http://localhost:8000",
};

function recv(msg: unknown) {
	lastWs.onmessage?.({ data: JSON.stringify(msg) });
}

describe("naia-omni tool calls", () => {
	it("invokes onToolCall on response.function_call_arguments.done", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;
		const calls: Array<{ id: string; name: string; args: unknown }> = [];
		session.onToolCall = (id, name, args) => calls.push({ id, name, args });

		recv({
			type: "response.function_call_arguments.done",
			call_id: "tc_1",
			name: "skill_agent_browser",
			arguments: JSON.stringify({ query: "news" }),
		});

		expect(calls).toEqual([
			{ id: "tc_1", name: "skill_agent_browser", args: { query: "news" } },
		]);
	});

	it("sendToolResponse emits function_call_output and NO response.create", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;
		lastWs.send.mockClear();

		session.sendToolResponse("tc_1", "result text");

		const sent = lastWs.send.mock.calls.map(
			(c) => JSON.parse(c[0] as string) as Record<string, unknown>,
		);
		expect(sent).toHaveLength(1);
		expect(sent[0].type).toBe("conversation.item.create");
		expect(sent[0].item).toMatchObject({
			type: "function_call_output",
			call_id: "tc_1",
			output: "result text",
		});
		expect(sent.some((m) => m.type === "response.create")).toBe(false);
	});

	it("stringifies non-string tool output", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;
		lastWs.send.mockClear();

		session.sendToolResponse("tc_2", { ok: true });

		const sent = JSON.parse(lastWs.send.mock.calls[0][0] as string);
		expect(sent.item.output).toBe(JSON.stringify({ ok: true }));
	});

	it("does NOT end the turn on response.done{requires_action}, but does on a normal done", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;
		let turnEnded = 0;
		session.onTurnEnd = () => {
			turnEnded++;
		};

		recv({ type: "response.done", response: { id: "r1", requires_action: true } });
		expect(turnEnded).toBe(0);

		recv({ type: "response.done", response: { id: "r2" } });
		expect(turnEnded).toBe(1);
	});

	it("malformed tool arguments invoke onToolCall with empty args", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;
		let captured: unknown;
		session.onToolCall = (_id, _name, args) => {
			captured = args;
		};

		recv({
			type: "response.function_call_arguments.done",
			call_id: "tc_3",
			name: "x",
			arguments: "{bad json",
		});

		expect(captured).toEqual({});
	});
});
