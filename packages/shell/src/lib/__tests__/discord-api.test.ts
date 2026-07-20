import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe("discord-api", () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it("checks token availability without moving raw tokens over WebView IPC", async () => {
		mockInvoke.mockResolvedValueOnce(true);
		const { isDiscordApiAvailable } = await import("../discord-api");

		await expect(isDiscordApiAvailable()).resolves.toBe(true);

		const commands = mockInvoke.mock.calls.map(([command]) => command);
		expect(commands).toEqual(["discord_bot_token_available"]);
		expect(commands).not.toContain("read_discord_bot_token");
		expect(commands).not.toContain("write_discord_bot_token");
	});

	it("treats availability command errors as unavailable", async () => {
		mockInvoke.mockRejectedValueOnce(new Error("native secret storage is not wired"));
		const { isDiscordApiAvailable } = await import("../discord-api");

		await expect(isDiscordApiAvailable()).resolves.toBe(false);
	});
});
