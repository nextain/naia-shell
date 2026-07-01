/**
 * Cold-start-aware connection status tests for the naia-omni realtime session.
 *
 * naia-0.9-omni-24g runs on RunPod on-demand, so connect() is not instant: the
 * gateway answers pod-starting while the Pod warms up. The session emits
 * `onStatusChange` (connecting / cold-start / sold-out / error) so ChatArea can
 * render the scenario and offer a cancel that releases the warming Pod
 * (abandonPod) instead of a frozen "connecting" spinner. These tests cover the
 * status emissions, close-code classification (4001 auth / 4003 credits), and
 * the cancel → abandon path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNaiaOmniSession } from "../naia-omni";
import { abandonPod } from "../ondemand-retry";
import type { NaiaOmniConfig, VoiceConnectionStatus } from "../types";

vi.mock("../ondemand-retry", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ondemand-retry")>();
	return { ...actual, abandonPod: vi.fn().mockResolvedValue(undefined) };
});

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
	vi.mocked(abandonPod).mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const GATEWAY: NaiaOmniConfig = {
	provider: "naia-omni",
	gatewayUrl: "https://gw.example.com",
	naiaKey: "gw-test-key",
	instanceId: "user-1:install-abc",
	model: "naia-0.9-omni-24g",
};

/** Flush pending microtasks so connect()'s async control flow advances. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function serverError(reason: string) {
	lastWs.onmessage?.({
		data: JSON.stringify({ type: "error", error: reason }),
	});
}

describe("naia-omni cold-start status", () => {
	it("emits connecting synchronously when connect() is called", () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		// Don't await — connecting must be emitted before the first await.
		void session.connect(GATEWAY).catch(() => {});
		expect(onStatus).toHaveBeenCalledWith({ phase: "connecting" });
	});

	it("emits cold-start on pod-starting, then abandons the Pod on cancel", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		serverError("pod-starting");
		await flush();

		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "cold-start", attempt: 1 }),
		);
		// setup was sent on open (gateway auth frame).
		const setup = JSON.parse(lastWs.send.mock.calls[0][0] as string);
		expect(setup.setup.apiKey).toBe(GATEWAY.naiaKey);

		// User cancels mid-cold-start → break the retry loop + release the Pod.
		session.disconnect();
		await expect(promise).rejects.toThrow();
		expect(abandonPod).toHaveBeenCalledWith(
			GATEWAY.gatewayUrl,
			GATEWAY.instanceId,
			GATEWAY.naiaKey,
		);
	});

	it("does not abandon a Pod when cancelling before any cold-start", async () => {
		const session = createNaiaOmniSession();
		const promise = session.connect(GATEWAY);
		await flush();
		// No pod-starting seen yet → nothing to abandon.
		session.disconnect();
		// A real WebSocket fires onclose when closed; the mock's close() is a
		// no-op, so simulate it to settle the in-flight connect attempt.
		lastWs.onclose?.({ code: 1000, reason: "", wasClean: true });
		await expect(promise).rejects.toThrow();
		expect(abandonPod).not.toHaveBeenCalled();
	});

	it("classifies a 4003 close as a credits error", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		lastWs.onclose?.({ code: 4003, reason: "", wasClean: false });
		await expect(promise).rejects.toThrow();
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "error", reason: "credits" }),
		);
	});

	it("classifies a 4001 close as an auth error", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		lastWs.onclose?.({ code: 4001, reason: "", wasClean: false });
		await expect(promise).rejects.toThrow();
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "error", reason: "auth" }),
		);
	});

	it("classifies a 4002 pre-session close as a superseded error", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		// Same account opened a session elsewhere before this one went live →
		// gateway closes with 4002 (last-wins).
		lastWs.onclose?.({ code: 4002, reason: "", wasClean: false });
		await expect(promise).rejects.toThrow();
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "error", reason: "superseded" }),
		);
	});

	it("fires onDisconnect with the close reason when 4002 drops a LIVE session", async () => {
		const session = createNaiaOmniSession();
		const onDisconnect = vi.fn();
		session.onDisconnect = onDisconnect;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		// Bring the session live so the close is treated as a mid-call drop.
		lastWs.onmessage?.({ data: JSON.stringify({ type: "session.created" }) });
		await promise;
		// Another device takes over → gateway closes this socket with 4002.
		lastWs.onclose?.({ code: 4002, reason: "", wasClean: false });
		expect(onDisconnect).toHaveBeenCalledWith({
			code: 4002,
			reason: "superseded",
		});
	});

	it("reports a normal reason when a LIVE session closes cleanly", async () => {
		const session = createNaiaOmniSession();
		const onDisconnect = vi.fn();
		session.onDisconnect = onDisconnect;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		lastWs.onmessage?.({ data: JSON.stringify({ type: "session.created" }) });
		await promise;
		lastWs.onclose?.({ code: 1000, reason: "", wasClean: true });
		expect(onDisconnect).toHaveBeenCalledWith({ code: 1000, reason: "normal" });
	});

	it("emits sold-out and never fires onDisconnect before a live session", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		const onDisconnect = vi.fn();
		session.onStatusChange = onStatus;
		session.onDisconnect = onDisconnect;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		serverError("sold-out");
		await expect(promise).rejects.toThrow();
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "sold-out" }),
		);
		// Pre-connect closes must not tear down a (non-existent) live session.
		lastWs.onclose?.({ code: 1006, reason: "", wasClean: false });
		expect(onDisconnect).not.toHaveBeenCalled();
	});

	// ── SoT §4 typed admission events (mirrors naia.nextain.io #34) ──

	it("treats session.preparing as cold-start, carrying eta/position", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		lastWs.onmessage?.({
			data: JSON.stringify({ type: "session.preparing", eta_s: 30, position: 2 }),
		});
		await flush();
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "cold-start",
				attempt: 1,
				etaSeconds: 30,
				queuePosition: 2,
			}),
		);
		// Cancel to break the retry backoff sleep.
		session.disconnect();
		await expect(promise).rejects.toThrow();
	});

	it("treats session.sold_out as a sold-out status", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		lastWs.onmessage?.({ data: JSON.stringify({ type: "session.sold_out" }) });
		await expect(promise).rejects.toThrow();
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "sold-out" }),
		);
	});

	it("classifies session.consent_required as a consent error", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		lastWs.onmessage?.({
			data: JSON.stringify({ type: "session.consent_required" }),
		});
		await expect(promise).rejects.toThrow();
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "error", reason: "consent" }),
		);
	});

	it("treats a bare 4503 close as cold-start (transient), not an error", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		// No preceding status event — bare 4503 must be treated as warming, retried.
		lastWs.onclose?.({ code: 4503, reason: "", wasClean: false });
		await flush();
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "cold-start" }),
		);
		expect(onStatus).not.toHaveBeenCalledWith(
			expect.objectContaining({ phase: "error" }),
		);
		session.disconnect();
		await expect(promise).rejects.toThrow();
	});

	it("classifies a 4409 close as a consent error", async () => {
		const session = createNaiaOmniSession();
		const onStatus = vi.fn<(s: VoiceConnectionStatus) => void>();
		session.onStatusChange = onStatus;
		const promise = session.connect(GATEWAY);
		await flush();
		lastWs.onopen?.();
		lastWs.onclose?.({ code: 4409, reason: "", wasClean: false });
		await expect(promise).rejects.toThrow();
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "error", reason: "consent" }),
		);
	});

	// Regression: a cold-start attempt's socket closes (4503) AFTER the retry
	// opened a newer socket that went active. The stale close must be ignored —
	// it must NOT tear down the live session (sock !== ws guard).
	it("ignores a superseded attempt's late close after a newer attempt is active", async () => {
		vi.useFakeTimers();
		try {
			const session = createNaiaOmniSession();
			const onDisconnect = vi.fn();
			session.onStatusChange = vi.fn();
			session.onDisconnect = onDisconnect;
			const promise = session.connect(GATEWAY);
			await vi.advanceTimersByTimeAsync(0);
			const oldWs = lastWs;
			oldWs.onopen?.();
			// First attempt: gateway says preparing → reject pod-starting → retry.
			oldWs.onmessage?.({
				data: JSON.stringify({ type: "session.preparing" }),
			});
			// Advance past the 5s backoff so the retry opens a fresh socket.
			await vi.advanceTimersByTimeAsync(5_000);
			const newWs = lastWs;
			expect(newWs).not.toBe(oldWs);
			// Newer attempt goes live.
			newWs.onopen?.();
			newWs.onmessage?.({ data: JSON.stringify({ type: "session.created" }) });
			await vi.advanceTimersByTimeAsync(0);
			await promise;
			expect(session.isConnected).toBe(true);
			// The OLD socket finally delivers its 4503 close — must be a no-op.
			oldWs.onclose?.({ code: 4503, reason: "", wasClean: false });
			expect(onDisconnect).not.toHaveBeenCalled();
			expect(session.isConnected).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
