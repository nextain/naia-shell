import { describe, expect, it, vi } from "vitest";
import { relayAgentPort } from "../agent-port-relay";

describe("agent-port-relay", () => {
	it("preserves ordering chat_request -> cancel_stream even when beforeChatRequest is delayed", async () => {
		const outerChan = new MessageChannel();
		const innerChan = new MessageChannel();

		const receivedByInner: string[] = [];
		innerChan.port2.onmessage = (event) => {
			receivedByInner.push(event.data);
		};

		let resolveRefresh: () => void = () => {};
		const refreshPromise = new Promise<void>((r) => {
			resolveRefresh = r;
		});

		const beforeChatRequest = vi.fn(async () => {
			await refreshPromise;
		});

		const diag = { log: vi.fn() };

		const relay = relayAgentPort({
			outer: outerChan.port1,
			inner: innerChan.port1,
			beforeChatRequest,
			diag,
		});

		const chatReq = JSON.stringify({ type: "chat_request", message: "hi" });
		const cancelReq = JSON.stringify({ type: "cancel_stream" });

		outerChan.port2.postMessage(chatReq);
		outerChan.port2.postMessage(cancelReq);

		// Before refresh resolves, nothing should have reached innerChan yet
		await new Promise((r) => setTimeout(r, 20));
		expect(receivedByInner).toHaveLength(0);

		// Resolve refresh
		resolveRefresh();

		// Wait for both to be delivered
		await new Promise((r) => setTimeout(r, 50));

		expect(receivedByInner).toEqual([chatReq, cancelReq]);
		expect(beforeChatRequest).toHaveBeenCalledTimes(1);

		relay.stop();
	});

	it("passes line through and logs to diag when beforeChatRequest throws", async () => {
		const outerChan = new MessageChannel();
		const innerChan = new MessageChannel();

		const receivedByInner: string[] = [];
		innerChan.port2.onmessage = (event) => {
			receivedByInner.push(event.data);
		};

		const refreshError = new Error("Snapshot read failed");
		const beforeChatRequest = vi.fn(async () => {
			throw refreshError;
		});

		const diag = { log: vi.fn() };

		const relay = relayAgentPort({
			outer: outerChan.port1,
			inner: innerChan.port1,
			beforeChatRequest,
			diag,
		});

		const chatReq = JSON.stringify({ type: "chat_request", message: "hello" });
		outerChan.port2.postMessage(chatReq);

		await new Promise((r) => setTimeout(r, 30));

		expect(receivedByInner).toEqual([chatReq]);
		expect(diag.log).toHaveBeenCalledWith(
			"adk snapshot refresh failed",
			expect.objectContaining({ error: refreshError }),
		);

		relay.stop();
	});

	it("does not call beforeChatRequest for non-chat_request lines", async () => {
		const outerChan = new MessageChannel();
		const innerChan = new MessageChannel();

		const receivedByInner: string[] = [];
		innerChan.port2.onmessage = (event) => {
			receivedByInner.push(event.data);
		};

		const beforeChatRequest = vi.fn(async () => {});
		const diag = { log: vi.fn() };

		const relay = relayAgentPort({
			outer: outerChan.port1,
			inner: innerChan.port1,
			beforeChatRequest,
			diag,
		});

		const cancelReq = JSON.stringify({ type: "cancel_stream" });
		const invalidJson = "{invalid json";
		outerChan.port2.postMessage(cancelReq);
		outerChan.port2.postMessage(invalidJson);

		await new Promise((r) => setTimeout(r, 30));

		expect(receivedByInner).toEqual([cancelReq, invalidJson]);
		expect(beforeChatRequest).not.toHaveBeenCalled();

		relay.stop();
	});

	it("relays inner messages to outer directly", async () => {
		const outerChan = new MessageChannel();
		const innerChan = new MessageChannel();

		const receivedByOuter: string[] = [];
		outerChan.port2.onmessage = (event) => {
			receivedByOuter.push(event.data);
		};

		const diag = { log: vi.fn() };

		const relay = relayAgentPort({
			outer: outerChan.port1,
			inner: innerChan.port1,
			beforeChatRequest: async () => {},
			diag,
		});

		const agentReply = JSON.stringify({ type: "chat_chunk", delta: "hi" });
		innerChan.port2.postMessage(agentReply);

		await new Promise((r) => setTimeout(r, 30));

		expect(receivedByOuter).toEqual([agentReply]);

		relay.stop();
	});

	it("drops non-string messages and logs to diag", async () => {
		const outerChan = new MessageChannel();
		const innerChan = new MessageChannel();

		const receivedByInner: string[] = [];
		innerChan.port2.onmessage = (event) => {
			receivedByInner.push(event.data);
		};

		const diag = { log: vi.fn() };

		const relay = relayAgentPort({
			outer: outerChan.port1,
			inner: innerChan.port1,
			beforeChatRequest: async () => {},
			diag,
		});

		// Post non-string object
		outerChan.port2.postMessage({ some: "object" });

		await new Promise((r) => setTimeout(r, 30));

		expect(receivedByInner).toHaveLength(0);
		expect(diag.log).toHaveBeenCalledWith(
			"non-string message ignored on outer port",
			expect.anything(),
		);

		relay.stop();
	});
});
