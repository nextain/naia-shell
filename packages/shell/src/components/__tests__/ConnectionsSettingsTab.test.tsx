// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
const mockListen = vi.fn().mockResolvedValue(vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: unknown[]) => mockListen(...args),
}));

import { ConnectionsSettingsTab } from "../ConnectionsSettingsTab";

const discovery = {
	botId: "100",
	botUsername: "naia",
	messageContentIntent: true,
	intentCode: "message_content_enabled",
	degradedGuildIds: [],
	discoveryTruncated: false,
	guilds: [
		{
			id: "200",
			name: "Nextain",
			channels: [
				{
					id: "300",
					name: "general",
					kind: 0,
					position: 0,
					permissions: {
						viewChannel: true,
						sendMessages: true,
						readMessageHistory: true,
						usable: true,
					},
				},
				{
					id: "301",
					name: "private",
					kind: 0,
					position: 1,
					permissions: {
						viewChannel: true,
						sendMessages: false,
						readMessageHistory: true,
						usable: false,
					},
				},
			],
		},
	],
};

describe("ConnectionsSettingsTab Discord binding", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		mockListen.mockResolvedValue(vi.fn());
	});

	it("discovers native metadata without rendering a token input", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: 1,
					state: "ready",
					authoritative: true,
				});
			if (command === "discord_discover_channels")
				return Promise.resolve(discovery);
			if (command === "discord_binding_snapshot") return Promise.resolve([]);
			return Promise.resolve();
		});
		render(<ConnectionsSettingsTab />);

		await waitFor(() => expect(screen.getByText("Nextain")).toBeDefined());
		expect(screen.getByText("naia (100)")).toBeDefined();
		expect(screen.queryByLabelText(/token/i)).toBeNull();
		expect(screen.getByRole("checkbox", { name: /private/ })).toBeDisabled();
	});

	it("saves only usable selected channels with explicit users and participation", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: 1,
					state: "ready",
					authoritative: true,
				});
			if (command === "discord_discover_channels")
				return Promise.resolve(discovery);
			if (command === "discord_binding_snapshot") return Promise.resolve([]);
			if (command === "discord_save_bindings") return Promise.resolve(123);
			return Promise.resolve();
		});
		render(<ConnectionsSettingsTab />);
		await waitFor(() => expect(screen.getByText("Nextain")).toBeDefined());

		fireEvent.click(screen.getByRole("checkbox", { name: /general/ }));
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "400, 401" },
		});
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "paused" },
		});
		fireEvent.click(screen.getByRole("button", { name: /저장|Save|Apply/i }));

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_save_bindings", {
				bindings: [
					{
						bindingId: "discord_200_300",
						guildId: "200",
						guildName: "Nextain",
						channelId: "300",
						channelName: "general",
						allowedUserIds: ["400", "401"],
						processingProfileRef: "default",
						participation: "paused",
					},
				],
			}),
		);
		await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
	});

	it("restores saved values and preserves unavailable bindings without hiding them", async () => {
		const savedBindings = [
			{
				bindingId: "existing_general",
				guildId: "200",
				guildName: "Nextain",
				channelId: "300",
				channelName: "general",
				allowedUserIds: ["400", "401"],
				processingProfileRef: "default",
				participation: "all",
			},
			{
				bindingId: "discord_200_301",
				guildId: "200",
				guildName: "Nextain",
				channelId: "301",
				channelName: "private",
				allowedUserIds: ["402"],
				processingProfileRef: "default",
				participation: "mentions",
			},
			{
				bindingId: "discord_900_901",
				guildId: "900",
				guildName: "Former server",
				channelId: "901",
				channelName: "archived",
				allowedUserIds: ["403"],
				processingProfileRef: "default",
				participation: "paused",
			},
		];
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: 1,
					state: "ready",
					authoritative: true,
				});
			if (command === "discord_discover_channels")
				return Promise.resolve(discovery);
			if (command === "discord_binding_snapshot")
				return Promise.resolve(savedBindings);
			if (command === "discord_save_bindings") return Promise.resolve(124);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		const general = await screen.findByRole("checkbox", { name: /general/ });
		expect(general).toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: /private/ }),
		).not.toBeDisabled();
		expect(screen.getByRole("checkbox", { name: /private/ })).toBeChecked();
		expect(screen.getByDisplayValue("400, 401")).toBeDefined();
		expect(
			screen.getByRole("combobox", { name: /Nextain.*general/ }),
		).toHaveValue("all");
		expect(screen.getByText("Former server")).toBeDefined();
		expect(screen.getByText("#archived")).toBeDefined();
		expect(screen.getByTestId("discord-stale-binding")).toBeDefined();

		fireEvent.click(screen.getByRole("checkbox", { name: /private/ }));
		expect(screen.getByRole("checkbox", { name: /private/ })).toBeDisabled();
		fireEvent.click(screen.getByRole("checkbox", { name: /archived/ }));
		fireEvent.click(screen.getByRole("button", { name: /저장|Save|Apply/i }));
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_save_bindings", {
				bindings: savedBindings.slice(0, 1),
			}),
		);
	});

	it("can remove the final stale binding and save an empty allow-list", async () => {
		const stale = {
			bindingId: "discord_900_901",
			guildId: "900",
			guildName: "Former server",
			channelId: "901",
			channelName: "archived",
			allowedUserIds: ["403"],
			processingProfileRef: "default",
			participation: "paused",
		};
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: 1,
					state: "ready",
					authoritative: true,
				});
			if (command === "discord_discover_channels")
				return Promise.resolve(discovery);
			if (command === "discord_binding_snapshot")
				return Promise.resolve([stale]);
			if (command === "discord_save_bindings") return Promise.resolve(125);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		const archived = await screen.findByRole("checkbox", { name: /archived/ });
		fireEvent.click(archived);
		fireEvent.click(screen.getByRole("button", { name: /저장|Save|Apply/i }));

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_save_bindings", {
				bindings: [],
			}),
		);
	});

	it("clears a stale runtime error when a status event returns no code", async () => {
		let statusReads = 0;
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status") {
				statusReads += 1;
				return Promise.resolve({
					tokenConfigured: true,
					generation: 1,
					state: statusReads === 1 ? "failed" : "ready",
					code: statusReads === 1 ? "runtime_terminal" : undefined,
					authoritative: statusReads > 1,
				});
			}
			if (command === "discord_discover_channels")
				return Promise.resolve(discovery);
			if (command === "discord_binding_snapshot") return Promise.resolve([]);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await waitFor(() =>
			expect(screen.getByRole("alert").getAttribute("data-error-code")).toBe(
				"runtime_terminal",
			),
		);
		const listener = mockListen.mock.calls[0]?.[1] as (() => void) | undefined;
		expect(listener).toBeDefined();
		await act(async () => {
			listener?.();
		});
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("preserves bindings from a guild whose discovery is degraded", async () => {
		const uncertain = {
			bindingId: "discord_900_901",
			guildId: "900",
			guildName: "Temporarily unavailable",
			channelId: "901",
			channelName: "operations",
			allowedUserIds: ["403"],
			processingProfileRef: "default",
			participation: "mentions",
		};
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: 1,
					state: "ready",
					authoritative: true,
				});
			if (command === "discord_discover_channels")
				return Promise.resolve({
					...discovery,
					degradedGuildIds: ["900"],
				});
			if (command === "discord_binding_snapshot")
				return Promise.resolve([uncertain]);
			if (command === "discord_save_bindings") return Promise.resolve(126);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await screen.findByTestId("discord-uncertain-binding");
		expect(screen.queryByTestId("discord-stale-binding")).toBeNull();
		expect(screen.getByRole("alert").getAttribute("data-error-code")).toBe(
			"discord_discovery_incomplete",
		);
		fireEvent.click(screen.getByRole("button", { name: /저장|Save|Apply/i }));
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_save_bindings", {
				bindings: [uncertain],
			}),
		);
	});

	it("surfaces a product-bound guild discovery as incomplete", async () => {
		const beyondProductBound = {
			bindingId: "discord_900_901",
			guildId: "900",
			guildName: "Beyond product bound",
			channelId: "901",
			channelName: "operations",
			allowedUserIds: ["403"],
			processingProfileRef: "default",
			participation: "mentions",
		};
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: 1,
					state: "ready",
					authoritative: true,
				});
			if (command === "discord_discover_channels")
				return Promise.resolve({
					...discovery,
					discoveryTruncated: true,
				});
			if (command === "discord_binding_snapshot")
				return Promise.resolve([beyondProductBound]);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await waitFor(() =>
			expect(screen.getByRole("alert").getAttribute("data-error-code")).toBe(
				"discord_discovery_incomplete",
			),
		);
		expect(screen.getByTestId("discord-uncertain-binding")).toBeDefined();
		expect(screen.queryByTestId("discord-stale-binding")).toBeNull();
	});
});
