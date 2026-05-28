// Tests for #337 Phase 5b agent-ipc wrapper. Each wrapper sends a JSON
// request via the existing `send_to_agent_command` invoke and resolves on a
// matching `agent_response` event filtered by (responseType, id).
//
// Per repo testing rules: mock @tauri-apps/api/{core,event} the same way
// chat-service.test.ts does — listen is captured, then we synthesize a
// response event with the same id the wrapper sent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
const mockListen = vi.fn();
let mockUnlisten: ReturnType<typeof vi.fn>;

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: unknown[]) => mockListen(...args),
}));

// Logger silently bridges to a Tauri command we don't want firing during tests.
vi.mock("../logger", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

interface AgentResponseEvent {
	payload: string;
}

/**
 * Helper: wire mockListen so the next listen() call captures the handler,
 * then `respond(payload)` is callable from the test body. Returns the
 * captured `id` from the invoke side after sendFn() resolves (sniffed via
 * mockInvoke.mock.calls).
 */
function wireListenWithReply(
	buildReply: (sentRequest: Record<string, unknown>) => Record<string, unknown>,
): void {
	mockListen.mockImplementation(
		async (_event: string, handler: (event: AgentResponseEvent) => void) => {
			// invoke is called AFTER listen resolves (see requestAgent flow).
			// Schedule the reply once invoke fires so we know the id.
			mockInvoke.mockImplementation(
				async (_cmd: string, args: { message: string }) => {
					const sent = JSON.parse(args.message) as Record<string, unknown>;
					const reply = buildReply(sent);
					setTimeout(() => {
						handler({ payload: JSON.stringify(reply) });
					}, 0);
					return undefined;
				},
			);
			return mockUnlisten;
		},
	);
}

describe("agent-ipc", () => {
	beforeEach(() => {
		mockUnlisten = vi.fn();
		mockInvoke.mockReset();
		mockListen.mockReset();
		mockInvoke.mockResolvedValue(undefined);
		mockListen.mockResolvedValue(mockUnlisten);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it("agentAuthStart sends correct JSON shape and parses response", async () => {
		const { agentAuthStart } = await import("../agent-ipc");

		wireListenWithReply((sent) => ({
			type: "auth_start_response",
			id: sent.id,
			authUrl: "https://example.test/login?state=abc",
			state: "abc",
		}));

		const result = await agentAuthStart({
			mode: "dev",
			scope: ["chat", "memory"],
			locale: "ko",
		});

		expect(result).toEqual({
			authUrl: "https://example.test/login?state=abc",
			state: "abc",
		});

		expect(mockInvoke).toHaveBeenCalledWith("send_to_agent_command", {
			message: expect.any(String),
		});
		const sentMessage = mockInvoke.mock.calls[0][1].message as string;
		const sent = JSON.parse(sentMessage);
		expect(sent.type).toBe("auth_start");
		expect(sent.mode).toBe("dev");
		expect(sent.scope).toEqual(["chat", "memory"]);
		expect(sent.locale).toBe("ko");
		expect(typeof sent.id).toBe("string");
		expect((sent.id as string).startsWith("auth-start-")).toBe(true);

		// Listener cleanup after settle
		expect(mockUnlisten).toHaveBeenCalled();
	});

	it("agentAuthReceived propagates response.ok=true with userId", async () => {
		const { agentAuthReceived } = await import("../agent-ipc");

		wireListenWithReply((sent) => ({
			type: "auth_received_response",
			id: sent.id,
			ok: true,
			userId: "naia_user-1",
			mode: "prod",
		}));

		const result = await agentAuthReceived("naia://auth?key=gw-x&state=s");
		expect(result.ok).toBe(true);
		expect(result.userId).toBe("naia_user-1");
		expect(result.mode).toBe("prod");
	});

	it("agentAuthReceived propagates response.ok=false with reason", async () => {
		const { agentAuthReceived } = await import("../agent-ipc");

		wireListenWithReply((sent) => ({
			type: "auth_received_response",
			id: sent.id,
			ok: false,
			reason: "state_mismatch",
		}));

		const result = await agentAuthReceived("naia://auth?bogus=1");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("state_mismatch");
		expect(result.userId).toBeUndefined();
	});

	it("agentAuthQuery parses loggedIn + scope + expiresAt correctly", async () => {
		const { agentAuthQuery } = await import("../agent-ipc");

		wireListenWithReply((sent) => ({
			type: "auth_query_response",
			id: sent.id,
			loggedIn: true,
			userId: "naia_user-7",
			expiresAt: 1_700_000_000,
			scope: ["chat", "memory"],
		}));

		const result = await agentAuthQuery("dev");
		expect(result.loggedIn).toBe(true);
		expect(result.userId).toBe("naia_user-7");
		expect(result.expiresAt).toBe(1_700_000_000);
		expect(result.scope).toEqual(["chat", "memory"]);
	});

	it("agentAuthQuery returns loggedIn=false when agent says so", async () => {
		const { agentAuthQuery } = await import("../agent-ipc");

		wireListenWithReply((sent) => ({
			type: "auth_query_response",
			id: sent.id,
			loggedIn: false,
		}));

		const result = await agentAuthQuery("prod");
		expect(result.loggedIn).toBe(false);
		expect(result.scope).toBeUndefined();
	});

	it("agentLabProxyRequest propagates status + body + ok", async () => {
		const { agentLabProxyRequest } = await import("../agent-ipc");

		wireListenWithReply((sent) => ({
			type: "lab_proxy_response",
			id: sent.id,
			ok: true,
			status: 200,
			body: { credits: 4242 },
		}));

		const result = await agentLabProxyRequest({
			mode: "prod",
			method: "GET",
			path: "/api/balance",
		});

		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ credits: 4242 });
	});

	it("agentLabProxyRequest surfaces error string when agent rejects", async () => {
		const { agentLabProxyRequest } = await import("../agent-ipc");

		wireListenWithReply((sent) => ({
			type: "lab_proxy_response",
			id: sent.id,
			ok: false,
			status: 401,
			body: null,
			error: "not_logged_in",
		}));

		const result = await agentLabProxyRequest({
			mode: "dev",
			method: "POST",
			path: "/api/usage",
			body: { range: "7d" },
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe(401);
		expect(result.error).toBe("not_logged_in");
	});

	it("agentAuthLogout returns void after agent ack", async () => {
		const { agentAuthLogout } = await import("../agent-ipc");

		wireListenWithReply((sent) => ({
			type: "auth_logout_response",
			id: sent.id,
			ok: true,
		}));

		await expect(agentAuthLogout("dev")).resolves.toBeUndefined();
		expect(mockInvoke).toHaveBeenCalledTimes(1);
	});

	it("onAgentAuthChanged fires on matching events and unsubscribes cleanly", async () => {
		const { onAgentAuthChanged } = await import("../agent-ipc");

		let capturedHandler: ((event: AgentResponseEvent) => void) | null = null;
		mockListen.mockImplementation(
			async (_event: string, handler: (event: AgentResponseEvent) => void) => {
				capturedHandler = handler;
				return mockUnlisten;
			},
		);

		const events: Array<{ mode: string; loggedIn: boolean }> = [];
		const unsubscribe = onAgentAuthChanged((e) => events.push(e));

		// Wait one microtask cycle so the .then() inside onAgentAuthChanged
		// has a chance to capture the unlisten fn.
		await Promise.resolve();
		await Promise.resolve();

		expect(capturedHandler).not.toBeNull();
		const handler = capturedHandler as unknown as (
			e: AgentResponseEvent,
		) => void;
		handler({
			payload: JSON.stringify({
				type: "auth_changed",
				mode: "dev",
				loggedIn: true,
			}),
		});
		handler({
			// Different type → should be ignored
			payload: JSON.stringify({
				type: "auth_query_response",
				id: "x",
				loggedIn: true,
			}),
		});
		handler({
			payload: JSON.stringify({
				type: "auth_changed",
				mode: "prod",
				loggedIn: false,
			}),
		});

		expect(events).toEqual([
			{ mode: "dev", loggedIn: true },
			{ mode: "prod", loggedIn: false },
		]);

		unsubscribe();
		expect(mockUnlisten).toHaveBeenCalled();
	});

	it("agentAuthStart rejects when invoke throws", async () => {
		const { agentAuthStart } = await import("../agent-ipc");

		mockInvoke.mockReset();
		mockInvoke.mockRejectedValue(new Error("backend crash"));
		mockListen.mockResolvedValue(mockUnlisten);

		await expect(agentAuthStart({ mode: "prod" })).rejects.toThrow(
			"backend crash",
		);
		// Listener must be cleaned up after error
		expect(mockUnlisten).toHaveBeenCalled();
	});

	it("agentAuthQuery rejects when invoke throws", async () => {
		const { agentAuthQuery } = await import("../agent-ipc");

		mockInvoke.mockReset();
		mockInvoke.mockRejectedValue(new Error("agent dead"));
		mockListen.mockResolvedValue(mockUnlisten);

		await expect(agentAuthQuery("dev")).rejects.toThrow("agent dead");
		expect(mockUnlisten).toHaveBeenCalled();
	});

	it("agentAuthStart surfaces structured error from agent response", async () => {
		const { agentAuthStart } = await import("../agent-ipc");

		wireListenWithReply((sent) => ({
			type: "auth_start_response",
			id: sent.id,
			error: "internal_failure",
		}));

		await expect(agentAuthStart({ mode: "prod" })).rejects.toThrow(
			/internal_failure/,
		);
	});
});
