/**
 * #313 L3 — panel-context → Live-session bridge specs.
 *
 * The bridge has 5 invariants:
 *   1. attach + change → debounced dispatch (single send within window).
 *   2. attach + change + change → only the LAST change dispatches.
 *   3. attach + detach + change → no dispatch (subscription torn down).
 *   4. session.sendContextUpdate === undefined → bridge is silent no-op.
 *   5. dispatch deduplicated against last-sent JSON (no spam re-sends).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	attachAppContextBridge,
	type AppContextSource,
} from "../app-context-bridge";
import type { AppContextUpdate, VoiceSession } from "../types";

function makeSource(initial: AppContextUpdate | null = null) {
	let ctx: AppContextUpdate | null = initial;
	const listeners = new Set<() => void>();
	const source: AppContextSource = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getContext: () => ctx,
	};
	return {
		source,
		set(next: AppContextUpdate | null) {
			ctx = next;
			for (const l of listeners) l();
		},
		listenerCount: () => listeners.size,
	};
}

function makeSession(opts: { withSendContextUpdate: boolean }): VoiceSession & {
	sendContextUpdate: ReturnType<typeof vi.fn>;
} {
	const sendContextUpdate = vi.fn();
	const session = {
		onAudio: null,
		onInputTranscript: null,
		onOutputTranscript: null,
		onToolCall: null,
		onTurnEnd: null,
		onInterrupted: null,
		onError: null,
		onDisconnect: null,
		isConnected: true,
		connect: vi.fn(async () => undefined),
		sendAudio: vi.fn(),
		sendText: vi.fn(),
		sendToolResponse: vi.fn(),
		disconnect: vi.fn(),
		sendContextUpdate: opts.withSendContextUpdate
			? sendContextUpdate
			: undefined,
	} as unknown as VoiceSession & {
		sendContextUpdate: ReturnType<typeof vi.fn>;
	};
	return session;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("attachAppContextBridge (#313 L3)", () => {
	it("dispatches a single update after the debounce window", () => {
		const session = makeSession({ withSendContextUpdate: true });
		const { source, set } = makeSource();

		const bridge = attachAppContextBridge(session, source, {
			debounceMs: 500,
		});

		set({ type: "browser", data: { url: "https://a.test" } });
		expect(session.sendContextUpdate).not.toHaveBeenCalled();

		vi.advanceTimersByTime(499);
		expect(session.sendContextUpdate).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(session.sendContextUpdate).toHaveBeenCalledTimes(1);
		expect(session.sendContextUpdate).toHaveBeenCalledWith({
			type: "browser",
			data: { url: "https://a.test" },
		});

		bridge.detach();
	});

	it("coalesces rapid changes — only the last value within the window dispatches", () => {
		const session = makeSession({ withSendContextUpdate: true });
		const { source, set } = makeSource();

		const bridge = attachAppContextBridge(session, source, {
			debounceMs: 500,
		});

		set({ type: "browser", data: { url: "https://a.test" } });
		vi.advanceTimersByTime(100);
		set({ type: "browser", data: { url: "https://b.test" } });
		vi.advanceTimersByTime(100);
		set({ type: "browser", data: { url: "https://c.test" } });

		vi.advanceTimersByTime(500);
		expect(session.sendContextUpdate).toHaveBeenCalledTimes(1);
		expect(session.sendContextUpdate).toHaveBeenCalledWith({
			type: "browser",
			data: { url: "https://c.test" },
		});

		bridge.detach();
	});

	it("drops pending update on detach (paused/closed session — silent drop)", () => {
		const session = makeSession({ withSendContextUpdate: true });
		const { source, set, listenerCount } = makeSource();

		const bridge = attachAppContextBridge(session, source, {
			debounceMs: 500,
		});

		set({ type: "browser", data: { url: "https://a.test" } });
		// Debounce timer is armed but has not fired yet.
		bridge.detach();
		expect(listenerCount()).toBe(0);

		vi.advanceTimersByTime(1_000);
		expect(session.sendContextUpdate).not.toHaveBeenCalled();
	});

	it("is a silent no-op when session has no sendContextUpdate (vllm-omni, naia-talk path)", () => {
		const session = makeSession({ withSendContextUpdate: false });
		const { source, set } = makeSource();

		const bridge = attachAppContextBridge(session, source, {
			debounceMs: 500,
		});

		set({ type: "browser", data: { url: "https://a.test" } });
		vi.advanceTimersByTime(1_000);
		// No throw, no dispatch — provider has no inject API; we degrade
		// gracefully to the next-turn systemInstruction path.

		bridge.detach();
	});

	it("does not dispatch when context becomes null (no active panel)", () => {
		const session = makeSession({ withSendContextUpdate: true });
		const { source, set } = makeSource({
			type: "browser",
			data: { url: "x" },
		});

		const bridge = attachAppContextBridge(session, source, {
			debounceMs: 500,
		});

		// Now the user switches to default (avatar) view — context cleared.
		set(null);
		vi.advanceTimersByTime(1_000);
		expect(session.sendContextUpdate).not.toHaveBeenCalled();

		bridge.detach();
	});

	it("deduplicates: same payload twice → only first dispatches", () => {
		const session = makeSession({ withSendContextUpdate: true });
		const { source, set } = makeSource();

		const bridge = attachAppContextBridge(session, source, {
			debounceMs: 500,
		});

		set({ type: "browser", data: { url: "https://a.test" } });
		vi.advanceTimersByTime(500);
		expect(session.sendContextUpdate).toHaveBeenCalledTimes(1);

		// Re-fire identical context (e.g. component re-render pushed same ctx).
		set({ type: "browser", data: { url: "https://a.test" } });
		vi.advanceTimersByTime(500);
		expect(session.sendContextUpdate).toHaveBeenCalledTimes(1);

		// Different payload → fires again.
		set({ type: "browser", data: { url: "https://b.test" } });
		vi.advanceTimersByTime(500);
		expect(session.sendContextUpdate).toHaveBeenCalledTimes(2);

		bridge.detach();
	});

	it("flushPending() synchronously dispatches a pending update", () => {
		const session = makeSession({ withSendContextUpdate: true });
		const { source, set } = makeSource();

		const bridge = attachAppContextBridge(session, source, {
			debounceMs: 500,
		});

		set({ type: "browser", data: { url: "https://a.test" } });
		// Without flush, no dispatch yet.
		expect(session.sendContextUpdate).not.toHaveBeenCalled();
		bridge.flushPending();
		expect(session.sendContextUpdate).toHaveBeenCalledTimes(1);

		// flushPending after detach is safe and silent.
		bridge.detach();
		bridge.flushPending();
		expect(session.sendContextUpdate).toHaveBeenCalledTimes(1);
	});

	it("swallows provider exceptions — does not propagate to subscriber", () => {
		const session = makeSession({ withSendContextUpdate: true });
		session.sendContextUpdate.mockImplementation(() => {
			throw new Error("WS already closed");
		});
		const { source, set } = makeSource();

		const bridge = attachAppContextBridge(session, source, {
			debounceMs: 500,
		});

		set({ type: "browser", data: { url: "https://a.test" } });
		// MUST NOT throw — the bridge owns its own try/catch around dispatch.
		expect(() => vi.advanceTimersByTime(500)).not.toThrow();

		bridge.detach();
	});
});
