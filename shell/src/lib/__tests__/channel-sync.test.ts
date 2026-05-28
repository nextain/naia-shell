// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri invoke (discord-api uses it)
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

// Mock gateway-sync (fire-and-forget calls)
vi.mock("../gateway-sync", () => ({
	syncToGateway: vi.fn().mockResolvedValue(undefined),
	restartGateway: vi.fn().mockResolvedValue(undefined),
}));

// Mock persona
vi.mock("../persona", () => ({
	buildSystemPrompt: vi.fn().mockReturnValue("mock-system-prompt"),
}));

// #337 Phase 6b: channel-sync now talks to the agent via lab_proxy_request
// instead of doing raw fetch with the naiaKey. Mock the agent-ipc wrappers.
//
// #337 Phase 10-pre cross-review CRITICAL #2: the entry gate is now
// `agentAuthQuery({loggedIn: true})` instead of `config.naiaKey` —
// shell never sees the raw key.
vi.mock("../agent-ipc", () => ({
	agentLabProxyRequest: vi.fn(),
	agentAuthQuery: vi.fn().mockResolvedValue({
		loggedIn: true,
		userId: "test-user-id",
	}),
	resolveAuthMode: vi.fn().mockReturnValue("prod"),
}));

import { invoke } from "@tauri-apps/api/core";
import { agentAuthQuery, agentLabProxyRequest } from "../agent-ipc";
import { syncLinkedChannels } from "../channel-sync";
import { loadConfig } from "../config";
import { restartGateway, syncToGateway } from "../gateway-sync";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockedLabProxy = agentLabProxyRequest as unknown as ReturnType<
	typeof vi.fn
>;
const mockedAuthQuery = agentAuthQuery as unknown as ReturnType<typeof vi.fn>;

/** Seed localStorage with a base config that has lab credentials. */
function seedConfig(overrides: Record<string, unknown> = {}) {
	const base = {
		provider: "gemini",
		model: "gemini-2.5-flash",
		apiKey: "test-key",
		naiaKey: "gw-test-lab-key",
		naiaUserId: "test-user-id",
		agentName: "Naia",
		userName: "Tester",
		persona: "friendly",
		...overrides,
	};
	localStorage.setItem("naia-config", JSON.stringify(base));
}

/** Build a successful lab_proxy response carrying linked-channels payload. */
function okChannels(channels: Array<{ type: string; userId: string }>) {
	return {
		ok: true,
		status: 200,
		body: { channels },
	};
}

/**
 * Default routing — answer per `path`:
 *  - /api/discord/bot-token → 404 (no bot configured, harmless skip)
 *  - /api/gateway/linked-channels → caller-supplied payload
 */
function wireLabProxy(
	linkedChannelsResp: ReturnType<typeof okChannels> | {
		ok: false;
		status: number;
		body: null;
		error?: string;
	},
) {
	mockedLabProxy.mockImplementation(
		async (opts: { method: string; path: string }) => {
			if (opts.path === "/api/discord/bot-token") {
				return { ok: false, status: 404, body: null };
			}
			if (opts.path === "/api/gateway/linked-channels") {
				return linkedChannelsResp;
			}
			return { ok: false, status: 500, body: null, error: "unhandled-path" };
		},
	);
}

describe("syncLinkedChannels", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
		// #337 Phase 10-pre cross-review CRITICAL #2: re-prime the default
		// `agentAuthQuery` response after `clearAllMocks` — most tests rely
		// on the agent reporting logged-in. The "skips when no lab
		// credentials" test overrides this to logged_out.
		mockedAuthQuery.mockResolvedValue({
			loggedIn: true,
			userId: "test-user-id",
		});
		// Default: openDmChannel via Rust returns a DM channel ID
		mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === "discord_api") {
				const a = args as Record<string, unknown> | undefined;
				const endpoint = a?.endpoint as string;
				if (endpoint === "/users/@me/channels") {
					return JSON.stringify({ id: "1234567890123456789" });
				}
			}
			return "";
		});
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("skips when no lab credentials", async () => {
		// #337 Phase 10-pre: the gate is the agent's auth state, not
		// localStorage. "No credentials" = `agentAuthQuery` returns
		// `loggedIn: false`.
		mockedAuthQuery.mockResolvedValue({ loggedIn: false });
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "gemini", model: "", apiKey: "" }),
		);

		await syncLinkedChannels();

		// No agent proxy traffic at all when credentials are absent.
		expect(mockedLabProxy).not.toHaveBeenCalled();
	});

	it("skips when linked-channels returns no channels", async () => {
		seedConfig();
		wireLabProxy(okChannels([]));

		await syncLinkedChannels();

		// 2 proxy calls: bot-token restore (404) + linked-channels (empty)
		expect(mockedLabProxy).toHaveBeenCalledTimes(2);
		// No discord_api invoke should happen (Logger may call invoke for frontend_log)
		expect(mockedInvoke).not.toHaveBeenCalledWith(
			"discord_api",
			expect.anything(),
		);
	});

	it("skips when no discord channel in response", async () => {
		seedConfig();
		wireLabProxy(okChannels([{ type: "slack", userId: "U123" }]));

		await syncLinkedChannels();

		expect(mockedInvoke).not.toHaveBeenCalledWith(
			"discord_api",
			expect.anything(),
		);
	});

	it("discovers DM channel ID and saves to config", async () => {
		seedConfig();
		const discordUserId = "865850174651498506";
		const dmChannelId = "1234567890123456789";

		wireLabProxy(okChannels([{ type: "discord", userId: discordUserId }]));

		await syncLinkedChannels();

		// Should have called openDmChannel via Rust invoke
		expect(mockedInvoke).toHaveBeenCalledWith("discord_api", {
			endpoint: "/users/@me/channels",
			method: "POST",
			body: JSON.stringify({ recipient_id: discordUserId }),
		});

		// Config should have discord user ID and DM channel ID
		const config = loadConfig();
		expect(config?.discordDefaultUserId).toBe(discordUserId);
		expect(config?.discordDmChannelId).toBe(dmChannelId);
		expect(config?.discordDefaultTarget).toBe(`user:${discordUserId}`);
	});

	it("always refreshes DM channel ID even when already set", async () => {
		const oldChannelId = "9999999999999999999";
		const newChannelId = "1234567890123456789";
		seedConfig({
			discordDmChannelId: oldChannelId,
			discordDefaultUserId: "865850174651498506",
		});

		wireLabProxy(
			okChannels([{ type: "discord", userId: "865850174651498506" }]),
		);

		await syncLinkedChannels();

		const config = loadConfig();
		expect(config?.discordDmChannelId).toBe(newChannelId);
		expect(config?.discordDmChannelId).not.toBe(oldChannelId);
	});

	it("calls syncToGateway with DM channel ID and restarts gateway", async () => {
		seedConfig();
		const discordUserId = "865850174651498506";
		const dmChannelId = "1234567890123456789";

		wireLabProxy(okChannels([{ type: "discord", userId: discordUserId }]));

		await syncLinkedChannels();

		expect(syncToGateway).toHaveBeenCalledWith(
			"gemini",
			"gemini-2.5-flash",
			"test-key",
			"friendly",
			"Naia",
			"Tester",
			"mock-system-prompt",
			expect.any(String), // locale
			dmChannelId,
			discordUserId,
			undefined, // ttsProvider
			undefined, // ttsVoice
			"off", // ttsAuto (ttsEnabled unset → "off")
			undefined, // ttsMode
			// #337 Phase 10-pre cross-review CRITICAL #2: naiaKey is owned by
			// the agent — channel-sync passes `undefined` and the agent
			// injects auth at the actual gateway hop.
			undefined,
			undefined, // ollamaHost (not set in seedConfig)
		);
		expect(restartGateway).toHaveBeenCalled();
	});

	it("sends X-User-Id (not naiaKey) to linked-channels via lab proxy", async () => {
		// #337 Phase 6b: the X-AnyLLM-Key header is injected by the agent —
		// shell only forwards X-User-Id. The naiaKey value never leaves the
		// agent process.
		//
		// #337 Phase 10-pre cross-review CRITICAL #2: the userId now comes
		// from `agentAuthQuery` (agent SoT), not from `config.naiaUserId`.
		// Override the default mock so this test asserts the agent-supplied
		// userId reaches the X-User-Id header.
		mockedAuthQuery.mockResolvedValue({
			loggedIn: true,
			userId: "uid-123",
		});
		seedConfig({ naiaKey: "gw-my-key", naiaUserId: "uid-123" });
		wireLabProxy(okChannels([]));

		await syncLinkedChannels();

		expect(mockedLabProxy).toHaveBeenCalledWith({
			mode: "prod",
			method: "GET",
			path: "/api/gateway/linked-channels",
			headers: { "X-User-Id": "uid-123" },
		});
		const allCalls = mockedLabProxy.mock.calls.map(
			(c) => c[0] as Record<string, unknown>,
		);
		// Critical: naiaKey must never appear in any header forwarded through
		// the proxy.
		for (const call of allCalls) {
			const headers =
				(call.headers as Record<string, string> | undefined) ?? {};
			for (const value of Object.values(headers)) {
				expect(value).not.toContain("gw-my-key");
			}
		}
	});

	it("handles openDmChannel failure gracefully", async () => {
		seedConfig();
		mockedInvoke.mockRejectedValue(new Error("Bot token missing"));
		wireLabProxy(
			okChannels([{ type: "discord", userId: "865850174651498506" }]),
		);

		// Should not throw
		await syncLinkedChannels();

		// discordDefaultUserId should still be saved
		const config = loadConfig();
		expect(config?.discordDefaultUserId).toBe("865850174651498506");
		// dmChannelId should not be set (openDmChannel failed)
		expect(config?.discordDmChannelId).toBeUndefined();
	});

	it("handles agent proxy error gracefully", async () => {
		seedConfig();
		wireLabProxy({ ok: false, status: 500, body: null });

		await syncLinkedChannels();

		// No discord_api invoke should happen (Logger may call invoke for frontend_log)
		expect(mockedInvoke).not.toHaveBeenCalledWith(
			"discord_api",
			expect.anything(),
		);
	});

	it("surfaces a 401 from the agent without infinite retry", async () => {
		// Regression: if the agent reports "not_logged_in" we should treat the
		// response as "no channels" and stop — never loop.
		seedConfig();
		wireLabProxy({
			ok: false,
			status: 401,
			body: null,
			error: "not_logged_in",
		});

		await syncLinkedChannels();

		// Exactly two attempts (bot-token + linked-channels), no retries.
		expect(mockedLabProxy).toHaveBeenCalledTimes(2);
		expect(mockedInvoke).not.toHaveBeenCalledWith(
			"discord_api",
			expect.anything(),
		);
	});

	it("treats network/transport failure (status 0) as offline", async () => {
		seedConfig();
		wireLabProxy({ ok: false, status: 0, body: null, error: "network" });

		await syncLinkedChannels();

		// No discord_api invoke; no syncToGateway/restart because no channel.
		expect(mockedInvoke).not.toHaveBeenCalledWith(
			"discord_api",
			expect.anything(),
		);
		expect(syncToGateway).not.toHaveBeenCalled();
		expect(restartGateway).not.toHaveBeenCalled();
	});
});
