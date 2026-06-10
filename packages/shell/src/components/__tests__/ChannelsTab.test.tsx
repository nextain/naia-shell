// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock Tauri APIs
const mockInvoke = vi.fn();
const mockListen = vi.fn().mockResolvedValue(() => {});
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: unknown[]) => mockListen(...args),
}));

// Mock config
const mockLoadConfig = vi.fn();
vi.mock("../../lib/config", () => ({
	loadConfig: () => mockLoadConfig(),
	saveConfig: vi.fn(),
}));

// Mock gateway-sessions
vi.mock("../../lib/gateway-sessions", () => ({
	discoverAndPersistDiscordDmChannel: vi.fn().mockResolvedValue(null),
}));

// Mock discord-api
const mockIsAvailable = vi.fn();
const mockOpenDm = vi.fn();
const mockFetchMessages = vi.fn();
const mockGetBotUserId = vi.fn();
vi.mock("../../lib/discord-api", () => ({
	isDiscordApiAvailable: () => mockIsAvailable(),
	openDmChannel: (id: string) => mockOpenDm(id),
	fetchDiscordMessages: (id: string, limit: number) =>
		mockFetchMessages(id, limit),
	getBotUserId: () => mockGetBotUserId(),
	sendDiscordMessage: vi.fn(),
}));

import { ChannelsTab } from "../ChannelsTab";

describe("ChannelsTab", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders with data-testid", () => {
		mockIsAvailable.mockReturnValue(new Promise(() => {}));
		render(<ChannelsTab />);
		expect(screen.getByTestId("channels-tab")).toBeDefined();
	});

	it("shows error when bot token not found", async () => {
		mockIsAvailable.mockResolvedValue(false);
		render(<ChannelsTab />);

		await waitFor(() => {
			expect(screen.getByText(/봇 토큰/)).toBeDefined();
		});
	});

	it("shows error when no discord user ID", async () => {
		mockIsAvailable.mockResolvedValue(true);
		mockLoadConfig.mockReturnValue({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
		});

		render(<ChannelsTab />);

		await waitFor(() => {
			expect(screen.getByText(/DM 채널을 찾을 수 없습니다/)).toBeDefined();
		});
	});

	it("auto-resolves DM channel from userId", async () => {
		mockIsAvailable.mockResolvedValue(true);
		mockLoadConfig.mockReturnValue({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
			discordDefaultUserId: "865850174651498506",
		});
		mockOpenDm.mockResolvedValue("1474816723579306105");
		mockGetBotUserId.mockResolvedValue("bot-123");
		mockFetchMessages.mockResolvedValue([]);

		render(<ChannelsTab />);

		await waitFor(() => {
			expect(mockOpenDm).toHaveBeenCalledWith("865850174651498506");
		});

		await waitFor(() => {
			expect(screen.getByText(/메시지가 없습니다/)).toBeDefined();
		});
	});

	it("uses existing channelId from config", async () => {
		mockIsAvailable.mockResolvedValue(true);
		mockLoadConfig.mockReturnValue({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key",
			discordDmChannelId: "1474816723579306105",
		});
		mockGetBotUserId.mockResolvedValue("bot-123");
		mockFetchMessages.mockResolvedValue([
			{
				id: "msg-1",
				content: "Hello",
				author: { id: "user-1", username: "fstory97", bot: false },
				timestamp: "2026-02-22T10:00:00Z",
			},
		]);

		render(<ChannelsTab />);

		await waitFor(() => {
			expect(screen.getByText("Hello")).toBeDefined();
			expect(screen.getByText("fstory97")).toBeDefined();
		});

		// Should NOT call openDmChannel since channelId already exists
		expect(mockOpenDm).not.toHaveBeenCalled();
	});
});
