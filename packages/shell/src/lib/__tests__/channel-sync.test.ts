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

import { invoke } from "@tauri-apps/api/core";
import { syncLinkedChannels } from "../channel-sync";
import { loadConfig } from "../config";
import { restartGateway, syncToGateway } from "../gateway-sync";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

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

/** Create a mock fetch response for linked-channels API. */
function mockLinkedChannelsResponse(
	channels: Array<{ type: string; userId: string }>,
) {
	return {
		ok: true,
		status: 200,
		json: () => Promise.resolve({ channels }),
	} as unknown as Response;
}

describe("syncLinkedChannels", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
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
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "gemini", model: "", apiKey: "" }),
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await syncLinkedChannels();

		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("skips when linked-channels returns no channels", async () => {
		seedConfig();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(mockLinkedChannelsResponse([]));

		await syncLinkedChannels();

		// 2 fetch calls: bot-token restore + linked-channels
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		// No discord_api invoke should happen (Logger may call invoke for frontend_log)
		expect(mockedInvoke).not.toHaveBeenCalledWith(
			"discord_api",
			expect.anything(),
		);
		fetchSpy.mockRestore();
	});

	it("skips when no discord channel in response", async () => {
		seedConfig();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				mockLinkedChannelsResponse([{ type: "slack", userId: "U123" }]),
			);

		await syncLinkedChannels();

		expect(mockedInvoke).not.toHaveBeenCalledWith(
			"discord_api",
			expect.anything(),
		);
		fetchSpy.mockRestore();
	});

	it("discovers DM channel ID and saves to config", async () => {
		seedConfig();
		const discordUserId = "865850174651498506";
		const dmChannelId = "1234567890123456789";

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				mockLinkedChannelsResponse([
					{ type: "discord", userId: discordUserId },
				]),
			);

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

		fetchSpy.mockRestore();
	});

	it("always refreshes DM channel ID even when already set", async () => {
		const oldChannelId = "9999999999999999999";
		const newChannelId = "1234567890123456789";
		seedConfig({
			discordDmChannelId: oldChannelId,
			discordDefaultUserId: "865850174651498506",
		});

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				mockLinkedChannelsResponse([
					{ type: "discord", userId: "865850174651498506" },
				]),
			);

		await syncLinkedChannels();

		// Should have refreshed to new channel ID
		const config = loadConfig();
		expect(config?.discordDmChannelId).toBe(newChannelId);
		expect(config?.discordDmChannelId).not.toBe(oldChannelId);

		fetchSpy.mockRestore();
	});

	it("calls syncToGateway with DM channel ID and restarts gateway", async () => {
		seedConfig();
		const discordUserId = "865850174651498506";
		const dmChannelId = "1234567890123456789";

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				mockLinkedChannelsResponse([
					{ type: "discord", userId: discordUserId },
				]),
			);

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
			"gw-test-lab-key",
			undefined, // ollamaHost (not set in seedConfig)
		);
		expect(restartGateway).toHaveBeenCalled();

		fetchSpy.mockRestore();
	});

	it("sends correct headers to linked-channels BFF", async () => {
		seedConfig({ naiaKey: "gw-my-key", naiaUserId: "uid-123" });
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(mockLinkedChannelsResponse([]));

		await syncLinkedChannels();

		expect(fetchSpy).toHaveBeenCalledWith(
			"https://naia.nextain.io/api/gateway/linked-channels",
			{
				headers: {
					"X-Desktop-Key": "gw-my-key",
					"X-User-Id": "uid-123",
				},
			},
		);

		fetchSpy.mockRestore();
	});

	it("handles openDmChannel failure gracefully", async () => {
		seedConfig();
		mockedInvoke.mockRejectedValue(new Error("Bot token missing"));

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				mockLinkedChannelsResponse([
					{ type: "discord", userId: "865850174651498506" },
				]),
			);

		// Should not throw
		await syncLinkedChannels();

		// discordDefaultUserId should still be saved
		const config = loadConfig();
		expect(config?.discordDefaultUserId).toBe("865850174651498506");
		// dmChannelId should not be set (openDmChannel failed)
		expect(config?.discordDmChannelId).toBeUndefined();

		fetchSpy.mockRestore();
	});

	it("handles BFF API error gracefully", async () => {
		seedConfig();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 500,
		} as Response);

		await syncLinkedChannels();

		// No discord_api invoke should happen (Logger may call invoke for frontend_log)
		expect(mockedInvoke).not.toHaveBeenCalledWith(
			"discord_api",
			expect.anything(),
		);

		fetchSpy.mockRestore();
	});
});
