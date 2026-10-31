import { describe, expect, it, vi } from "vitest";
import { type RelayPortLike, relayAgentPort } from "../agent-port-relay";

class FakePort implements RelayPortLike {
	listeners: ((event: { data: unknown }) => void)[] = [];
	messages: unknown[] = [];
	private waitTarget: { count: number; resolve: () => void } | null = null;

	postMessage(data: unknown): void {
		this.messages.push(data);
		if (this.waitTarget && this.messages.length >= this.waitTarget.count) {
			const res = this.waitTarget.resolve;
			this.waitTarget = null;
			res();
		}
	}

	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void {
		if (type === "message") {
			this.listeners.push(listener);
		}
	}

	removeEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void {
		if (type === "message") {
			this.listeners = this.listeners.filter((l) => l !== listener);
		}
	}

	start(): void {}

	dispatchSync(data: unknown): void {
		for (const listener of [...this.listeners]) {
			listener({ data });
		}
	}

	waitForMessages(count: number): Promise<void> {
		if (this.messages.length >= count) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waitTarget = { count, resolve };
		});
	}
}

describe("agent-port-relay", () => {
	it("preserves ordering chat_request -> cancel_stream even when beforeChatRequest is delayed", async () => {
		const fakeOuter = new FakePort();
		const fakeInner = new FakePort();

		let notifyRefreshCalled: () => void = () => {};
		const refreshCalled = new Promise<void>((r) => {
			notifyRefreshCalled = r;
		});

		let openRefreshGate: () => void = () => {};
		const refreshGate = new Promise<void>((r) => {
			openRefreshGate = r;
		});

		const beforeChatRequest = vi.fn(async () => {
			notifyRefreshCalled();
			await refreshGate;
		});

		const diag = { log: vi.fn() };

		const relay = relayAgentPort({
			outer: fakeOuter,
			inner: fakeInner,
			beforeChatRequest,
			diag,
		});

		const chatReq = JSON.stringify({ type: "chat_request", message: "hi" });
		const cancelReq = JSON.stringify({ type: "cancel_stream" });

		fakeOuter.dispatchSync(chatReq);
		fakeOuter.dispatchSync(cancelReq);

		await refreshCalled;
		expect(beforeChatRequest).toHaveBeenCalledTimes(1);
		expect(fakeInner.messages).toHaveLength(0);

		openRefreshGate();
		await fakeInner.waitForMessages(2);

		expect(fakeInner.messages).toEqual([chatReq, cancelReq]);
		expect(beforeChatRequest).toHaveBeenCalledTimes(1);

		relay.stop();
	});

	it("ensures non-chat lines do not bypass the serial chain while beforeChatRequest is pending", async () => {
		const fakeOuter = new FakePort();
		const fakeInner = new FakePort();

		let notifyRefreshCalled: () => void = () => {};
		const refreshCalled = new Promise<void>((r) => {
			notifyRefreshCalled = r;
		});

		let openRefreshGate: () => void = () => {};
		const refreshGate = new Promise<void>((r) => {
			openRefreshGate = r;
		});

		const beforeChatRequest = vi.fn(async () => {
			notifyRefreshCalled();
			await refreshGate;
		});

		const diag = { log: vi.fn() };

		const relay = relayAgentPort({
			outer: fakeOuter,
			inner: fakeInner,
			beforeChatRequest,
			diag,
		});

		const chatReq = JSON.stringify({ type: "chat_request", message: "hi" });
		const cancelReq = JSON.stringify({ type: "cancel_stream" });
		const pingReq = JSON.stringify({ type: "ping" });

		// Dispatch all three lines synchronously while the gate is closed
		fakeOuter.dispatchSync(chatReq);
		fakeOuter.dispatchSync(cancelReq);
		fakeOuter.dispatchSync(pingReq);

		// (가) Wait for refresh mock to be called; verify 1 refresh call and 0 inner received
		await refreshCalled;
		expect(beforeChatRequest).toHaveBeenCalledTimes(1);
		expect(fakeInner.messages).toHaveLength(0);

		// Release the gate (나) and wait for all three messages on inner (다)
		openRefreshGate();
		await fakeInner.waitForMessages(3);

		expect(fakeInner.messages).toEqual([chatReq, cancelReq, pingReq]);
		expect(beforeChatRequest).toHaveBeenCalledTimes(1);

		relay.stop();
	});

	it("passes line through and logs to diag when beforeChatRequest throws", async () => {
		const fakeOuter = new FakePort();
		const fakeInner = new FakePort();

		const refreshError = new Error("Snapshot read failed");
		const beforeChatRequest = vi.fn(async () => {
			throw refreshError;
		});

		let resolveDiag: () => void = () => {};
		const diagCalled = new Promise<void>((r) => {
			resolveDiag = r;
		});

		const diag = {
			log: vi.fn((_message: string, _ctx?: unknown) => {
				resolveDiag();
			}),
		};

		const relay = relayAgentPort({
			outer: fakeOuter,
			inner: fakeInner,
			beforeChatRequest,
			diag,
		});

		const chatReq = JSON.stringify({ type: "chat_request", message: "hello" });
		fakeOuter.dispatchSync(chatReq);

		await Promise.all([fakeInner.waitForMessages(1), diagCalled]);

		expect(fakeInner.messages).toEqual([chatReq]);
		expect(diag.log).toHaveBeenCalledWith(
			"adk snapshot refresh failed",
			expect.objectContaining({ error: refreshError }),
		);

		relay.stop();
	});

	it("does not call beforeChatRequest for non-chat_request lines", async () => {
		const fakeOuter = new FakePort();
		const fakeInner = new FakePort();

		const beforeChatRequest = vi.fn(async () => {});
		const diag = { log: vi.fn() };

		const relay = relayAgentPort({
			outer: fakeOuter,
			inner: fakeInner,
			beforeChatRequest,
			diag,
		});

		const cancelReq = JSON.stringify({ type: "cancel_stream" });
		const invalidJson = "{invalid json";

		fakeOuter.dispatchSync(cancelReq);
		fakeOuter.dispatchSync(invalidJson);

		await fakeInner.waitForMessages(2);

		expect(fakeInner.messages).toEqual([cancelReq, invalidJson]);
		expect(beforeChatRequest).not.toHaveBeenCalled();

		relay.stop();
	});

	it("relays inner messages to outer directly", async () => {
		const fakeOuter = new FakePort();
		const fakeInner = new FakePort();

		const diag = { log: vi.fn() };

		const relay = relayAgentPort({
			outer: fakeOuter,
			inner: fakeInner,
			beforeChatRequest: async () => {},
			diag,
		});

		const agentReply = JSON.stringify({ type: "chat_chunk", delta: "hi" });
		fakeInner.dispatchSync(agentReply);

		await fakeOuter.waitForMessages(1);

		expect(fakeOuter.messages).toEqual([agentReply]);

		relay.stop();
	});

	it("drops non-string messages and logs to diag", async () => {
		const fakeOuter = new FakePort();
		const fakeInner = new FakePort();

		let resolveDiag: () => void = () => {};
		const diagCalled = new Promise<void>((r) => {
			resolveDiag = r;
		});

		const diag = {
			log: vi.fn((_message: string, _ctx?: unknown) => {
				resolveDiag();
			}),
		};

		const relay = relayAgentPort({
			outer: fakeOuter,
			inner: fakeInner,
			beforeChatRequest: async () => {},
			diag,
		});

		// Post non-string object
		fakeOuter.dispatchSync({ some: "object" });

		// Wait for diag call (라)
		await diagCalled;

		// Immediately send normal line and wait for it on inner (다)
		const normalLine = JSON.stringify({ type: "ping" });
		fakeOuter.dispatchSync(normalLine);
		await fakeInner.waitForMessages(1);

		expect(fakeInner.messages).toEqual([normalLine]);
		expect(diag.log).toHaveBeenCalledWith(
			"non-string message ignored on outer port",
			expect.anything(),
		);

		relay.stop();
	});
});
