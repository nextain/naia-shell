/**
 * Naia Local host policy (naia-omni direct mode, `localContainer: true`).
 *
 * Policy decision: naia-os does NOT block remote plaintext ws:// at the OS
 * layer. The subscriber key flows over the `setup` frame, but securing the
 * transport (Tailscale / WireGuard / SSH tunnel / wss terminator / trusted LAN)
 * is the USER's responsibility — guided in the manual (naia-model-dev), not
 * enforced in code. naia-os is not always on Tailscale, so forcing wss:// would
 * break legitimate trusted-network setups.
 *
 * This test pins that policy: any well-formed ws(s):// host connects (loopback,
 * Tailscale, arbitrary remote), and only a malformed/invalid URL scheme is
 * rejected (by normalizeServerUrl input validation, not a security gate).
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

let lastWs: MockWSInstance | undefined;

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
	lastWs = undefined;
	vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function local(serverUrl: string): NaiaOmniConfig {
	return {
		provider: "naia-omni",
		serverUrl,
		localContainer: true,
		naiaKey: "gw-test-key",
	};
}

/** Connect and feed session.created so an accepted URL resolves. */
function connectOk(config: NaiaOmniConfig): Promise<void> {
	const session = createNaiaOmniSession();
	const promise = session.connect(config);
	setTimeout(() => {
		lastWs?.onmessage?.({
			data: JSON.stringify({ type: "session.created" }),
		});
	}, 0);
	return promise;
}

describe("naia-omni Naia Local host policy (no OS-layer block)", () => {
	it("connects to loopback ws://", async () => {
		await expect(
			connectOk(local("ws://localhost:8892")),
		).resolves.toBeUndefined();
	});

	it("connects to a Tailscale MagicDNS host over ws://", async () => {
		await expect(
			connectOk(local("ws://pc-bazzite.tail4f7a25.ts.net:8892")),
		).resolves.toBeUndefined();
	});

	it("connects to an arbitrary remote host over plaintext ws:// (not blocked — user's responsibility)", async () => {
		await expect(
			connectOk(local("ws://192.168.1.50:8892")),
		).resolves.toBeUndefined();
		expect(lastWs?.url).toBe("ws://192.168.1.50:8892/v1/realtime");
	});

	it("connects over wss://", async () => {
		await expect(
			connectOk(local("wss://gpu.example.com:8892")),
		).resolves.toBeUndefined();
	});

	it("strips embedded credentials from the URL before connecting", async () => {
		await expect(
			connectOk(local("ws://user:pass@10.0.0.5:8892")),
		).resolves.toBeUndefined();
		expect(lastWs?.url).toBe("ws://10.0.0.5:8892/v1/realtime");
	});

	it("rejects a malformed / unsupported URL scheme (input validation)", async () => {
		const session = createNaiaOmniSession();
		await expect(
			session.connect(local("ftp://gpu.example.com:8892")),
		).rejects.toThrow(/Invalid serverUrl/);
		expect(lastWs).toBeUndefined();
	});
});
