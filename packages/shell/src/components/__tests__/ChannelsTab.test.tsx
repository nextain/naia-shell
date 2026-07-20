// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
const mockListen = vi.fn().mockResolvedValue(() => {});
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: unknown[]) => mockListen(...args),
}));

import { ChannelsTab } from "../ChannelsTab";

const snapshot = [
	{
		bindingId: "binding_1",
		guildId: "100",
		guildName: "Nextain",
		channelId: "200",
		channelName: "naia",
		participation: "mentions",
		unread: 2,
		lastActivity: 1_753_000_000_000,
		records: [
			{
				recordId: "incoming_300",
				direction: "incoming",
				bindingId: "binding_1",
				guildId: "100",
				channelId: "200",
				sourceMessageId: "300",
				authorId: "400",
				content: "Discord context",
				createdAt: 1_753_000_000_000,
			},
		],
	},
];

describe("ChannelsTab", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders a loading state while the native snapshot is pending", () => {
		mockInvoke.mockReturnValue(new Promise(() => {}));
		render(<ChannelsTab />);
		expect(screen.getByTestId("channels-tab")).toBeDefined();
		expect(screen.getByText(/불러|Loading/i)).toBeDefined();
	});

	it("shows the localized empty state without reading Discord REST in WebView", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_inbox_snapshot") return Promise.resolve([]);
			if (command === "discord_get_last_binding") return Promise.resolve(null);
			return Promise.resolve();
		});
		render(<ChannelsTab />);
		await waitFor(() => expect(screen.getByText(/없|No/i)).toBeDefined());
		expect(mockInvoke).toHaveBeenCalledWith("discord_inbox_snapshot");
	});

	it("shows a safe localized error when the native snapshot fails", async () => {
		mockInvoke.mockRejectedValue(new Error("sensitive native detail"));
		render(<ChannelsTab />);
		await waitFor(() => expect(screen.getByText(/오류|Error/i)).toBeDefined());
		expect(screen.queryByText(/sensitive native detail/)).toBeNull();
	});

	it("renders server, channel, preview, unread count, and activity", async () => {
		const collidingSnapshot = [{
			...snapshot[0],
			records: [
				...snapshot[0].records,
				{
					...snapshot[0].records[0],
					recordId: "outgoing_300_0",
					direction: "outgoing" as const,
					content: "Discord response chunk",
				},
			],
		}];
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_inbox_snapshot")
				return Promise.resolve(collidingSnapshot);
			if (command === "discord_get_last_binding") return Promise.resolve(null);
			if (command === "discord_fetch_channel_history")
				return Promise.resolve([
					{
						...snapshot[0].records[0],
						recordId: "history_299",
						sourceMessageId: "299",
						content: "Earlier Discord context",
						createdAt: 1_752_999_999_000,
					},
				]);
			return Promise.resolve();
		});
		render(<ChannelsTab />);
		await waitFor(() =>
			expect(screen.getByText("Nextain · #naia")).toBeDefined(),
		);
		expect(screen.getAllByText("Discord context").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Discord response chunk").length).toBeGreaterThan(0);
		expect(screen.getByText("Earlier Discord context")).toBeDefined();
		expect(mockInvoke).toHaveBeenCalledWith("discord_fetch_channel_history", {
			bindingId: "binding_1",
		});
		expect(mockInvoke).toHaveBeenCalledWith("discord_mark_inbox_read", {
			bindingId: "binding_1",
			createdAt: 1_753_000_000_000,
		});
		expect(screen.queryByLabelText("2")).toBeNull();
		expect(screen.getByRole("navigation")).toBeDefined();
	});

	it("persists native selection and the read cursor without copying into private chat", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_inbox_snapshot")
				return Promise.resolve(snapshot);
			if (command === "discord_inbox_snapshot_cached")
				return Promise.resolve(snapshot);
			if (command === "discord_get_last_binding") return Promise.resolve(null);
			if (command === "discord_set_last_binding") return Promise.resolve();
			if (command === "discord_mark_inbox_read") return Promise.resolve();
			if (command === "discord_fetch_channel_history")
				return Promise.resolve([]);
			return Promise.reject(new Error("unexpected command"));
		});
		render(<ChannelsTab />);
		await waitFor(() =>
			expect(screen.getByText("Nextain · #naia")).toBeDefined(),
		);

		fireEvent.click(screen.getByText("Nextain · #naia"));
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_set_last_binding", {
				bindingId: "binding_1",
			}),
		);
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_mark_inbox_read", {
				bindingId: "binding_1",
				createdAt: 1_753_000_000_000,
			}),
		);
		expect(screen.queryByRole("button", { name: /Naia/ })).toBeNull();
	});

	it("coalesces inbox events into local-only refreshes without rehydrating preference", async () => {
		let inboxListener: (() => void) | undefined;
		mockListen.mockImplementation(
			(event: string, listener: () => void) => {
				if (event === "discord_inbox_changed") inboxListener = listener;
				return Promise.resolve(() => {});
			},
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_inbox_snapshot") return Promise.resolve(snapshot);
			if (command === "discord_inbox_snapshot_cached")
				return Promise.resolve(snapshot);
			if (command === "discord_get_last_binding") return Promise.resolve(null);
			if (command === "discord_fetch_channel_history")
				return Promise.resolve([]);
			if (command === "discord_mark_inbox_read") return Promise.resolve();
			return Promise.resolve();
		});
		render(<ChannelsTab />);
		await screen.findByRole("button", { name: /Nextain.*#naia/ });

		inboxListener?.();
		inboxListener?.();
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith(
				"discord_inbox_snapshot_cached",
				{ bindingIds: ["binding_1"] },
			),
		);
		expect(
			mockInvoke.mock.calls.filter(
				([command]) => command === "discord_inbox_snapshot",
			),
		).toHaveLength(1);
		expect(
			mockInvoke.mock.calls.filter(
				([command]) => command === "discord_get_last_binding",
			),
		).toHaveLength(1);
	});

	it("switches from the narrow list to detail and supports back navigation", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_inbox_snapshot")
				return Promise.resolve(snapshot);
			if (command === "discord_get_last_binding") return Promise.resolve(null);
			if (command === "discord_set_last_binding") return Promise.resolve();
			if (command === "discord_mark_inbox_read") return Promise.resolve();
			return Promise.reject(new Error("unexpected command"));
		});
		render(<ChannelsTab />);
		const channel = await screen.findByRole("button", {
			name: /Nextain.*#naia/,
		});

		expect(
			document.querySelector(".channels-inbox-layout")?.classList,
		).toContain("detail-open");

		fireEvent.click(screen.getByRole("button", { name: /뒤로|Back/i }));
		expect(
			document.querySelector(".channels-inbox-layout")?.classList,
		).not.toContain("detail-open");
		fireEvent.click(channel);
		expect(
			document.querySelector(".channels-inbox-layout")?.classList,
		).toContain("detail-open");

		fireEvent.click(screen.getByRole("button", { name: /뒤로|Back/i }));
		expect(
			document.querySelector(".channels-inbox-layout")?.classList,
		).not.toContain("detail-open");
		expect(channel.getAttribute("aria-current")).toBe("page");
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"discord_set_last_binding",
			{
				bindingId: null,
			},
		);
	});

	it("restores the last opened binding through typed native IPC after remount", async () => {
		const second = {
			...snapshot[0],
			bindingId: "binding_2",
			channelId: "201",
			channelName: "support",
			unread: 0,
			lastActivity: 1_752_000_000_000,
			records: [],
		};
		const channels = [snapshot[0], second];
		let lastBinding: string | null = null;
		mockInvoke.mockImplementation(
			(command: string, args?: { bindingId?: string | null }) => {
				if (command === "discord_inbox_snapshot")
					return Promise.resolve(channels);
				if (command === "discord_get_last_binding")
					return Promise.resolve(lastBinding);
				if (command === "discord_set_last_binding") {
					lastBinding = args?.bindingId ?? null;
					return Promise.resolve();
				}
				if (command === "discord_mark_inbox_read") return Promise.resolve();
				return Promise.reject(new Error("unexpected command"));
			},
		);
		const firstRender = render(<ChannelsTab />);
		const support = await screen.findByRole("button", {
			name: /Nextain.*#support/,
		});
		fireEvent.click(support);
		await waitFor(() => expect(lastBinding).toBe("binding_2"));
		firstRender.unmount();

		render(<ChannelsTab />);
		const restored = await screen.findByRole("button", {
			name: /Nextain.*#support/,
		});
		await waitFor(() =>
			expect(restored.getAttribute("aria-current")).toBe("page"),
		);
	});

	it("falls back to the channel with the latest activity without a native preference", async () => {
		const older = {
			...snapshot[0],
			bindingId: "binding_older",
			channelId: "199",
			channelName: "older",
			lastActivity: 1_752_000_000_000,
			records: [],
		};
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_inbox_snapshot")
				return Promise.resolve([older, snapshot[0]]);
			if (command === "discord_get_last_binding") return Promise.resolve(null);
			return Promise.resolve();
		});
		render(<ChannelsTab />);
		const newest = await screen.findByRole("button", {
			name: /Nextain.*#naia/,
		});
		expect(newest.getAttribute("aria-current")).toBe("page");
		expect(
			document.querySelector(".channels-inbox-layout")?.classList,
		).toContain("detail-open");
		expect(screen.getAllByText("Discord context").length).toBeGreaterThan(0);
	});

	it("keeps the list unselected when no channel has activity or a native preference", async () => {
		const inactive = [
			{ ...snapshot[0], lastActivity: undefined, records: [], unread: 0 },
			{
				...snapshot[0],
				bindingId: "binding_2",
				channelId: "201",
				channelName: "support",
				lastActivity: undefined,
				records: [],
				unread: 0,
			},
		];
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_inbox_snapshot")
				return Promise.resolve(inactive);
			if (command === "discord_get_last_binding") return Promise.resolve(null);
			return Promise.resolve();
		});

		render(<ChannelsTab />);
		await screen.findByRole("button", { name: /Nextain.*#naia/ });

		expect(screen.getByText(/채널을 선택|Select a channel/i)).toBeDefined();
		expect(
			screen
				.getAllByRole("button")
				.some((button) => button.getAttribute("aria-current") === "page"),
		).toBe(false);
	});

	it("keeps the inbox usable when the native preference cannot be read", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_inbox_snapshot")
				return Promise.resolve(snapshot);
			if (command === "discord_get_last_binding")
				return Promise.reject(new Error("preference unavailable"));
			return Promise.resolve();
		});
		render(<ChannelsTab />);
		expect(
			await screen.findByRole("button", { name: /Nextain.*#naia/ }),
		).toBeDefined();
		expect(screen.queryByText(/오류|Error/i)).toBeNull();
	});

	it("clears an invalid native preference and falls back to latest activity", async () => {
		const newest = {
			...snapshot[0],
			bindingId: "binding_2",
			channelId: "201",
			channelName: "support",
			lastActivity: 1_754_000_000_000,
			records: [],
		};
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_inbox_snapshot")
				return Promise.resolve([snapshot[0], newest]);
			if (command === "discord_get_last_binding")
				return Promise.resolve("removed_binding");
			if (command === "discord_set_last_binding") return Promise.resolve();
			return Promise.resolve();
		});
		render(<ChannelsTab />);
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_set_last_binding", {
				bindingId: null,
			}),
		);
		expect(
			screen.getByRole("button", { name: /Nextain.*#support/ }).getAttribute(
				"aria-current",
			),
		).toBe("page");
	});
});
