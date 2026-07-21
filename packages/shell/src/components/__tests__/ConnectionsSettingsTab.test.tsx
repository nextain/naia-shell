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

import { t } from "../../lib/i18n";
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

function bindingSnapshot<T>(
	bindings: readonly T[],
	generation: number | null = 1,
) {
	return { generation, bindings };
}

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
			if (command === "discord_binding_snapshot")
				return Promise.resolve(bindingSnapshot([]));
			return Promise.resolve();
		});
		render(<ConnectionsSettingsTab />);

		await waitFor(() => expect(screen.getByText("Nextain")).toBeDefined());
		expect(screen.getByText("naia (100)")).toBeDefined();
		expect(screen.queryByLabelText(/token/i)).toBeNull();
		expect(screen.getByRole("checkbox", { name: /private/ })).toBeDisabled();
	});

	it("keeps the Shell visibly pending while the native secure token prompt is open", async () => {
		let completeCapture:
			| ((value: { configured: boolean; code: string }) => void)
			| undefined;
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: false,
					generation: null,
					state: "disconnected",
					authoritative: false,
				});
			if (command === "discord_binding_snapshot")
				return Promise.resolve(bindingSnapshot([], null));
			if (command === "discord_capture_bot_token")
				return new Promise<{ configured: boolean; code: string }>((resolve) => {
					completeCapture = resolve;
				});
			return Promise.resolve();
		});
		render(<ConnectionsSettingsTab />);

		const captureButton = await screen.findByRole("button", {
			name: /Connect securely|보안 입력으로 연결/i,
		});
		fireEvent.click(captureButton);
		await waitFor(() =>
			expect(screen.getByTestId("discord-secure-prompt-opening")).toBeDefined(),
		);
		expect(captureButton).toBeDisabled();

		completeCapture?.({ configured: false, code: "capture_cancelled" });
		await waitFor(() =>
			expect(
				screen.queryByTestId("discord-secure-prompt-opening"),
			).toBeNull(),
		);
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
			if (command === "discord_binding_snapshot")
				return Promise.resolve(bindingSnapshot([]));
			if (command === "discord_save_bindings") return Promise.resolve(123);
			return Promise.resolve();
		});
		render(<ConnectionsSettingsTab />);
		await waitFor(() => expect(screen.getByText("Nextain")).toBeDefined());

		fireEvent.click(screen.getByRole("checkbox", { name: /general/ }));
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "400000, 400001" },
		});
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "paused" },
		});
		fireEvent.click(screen.getByRole("button", { name: /저장|Save|Apply/i }));

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_save_bindings", {
				expectedGeneration: 1,
				bindings: [
					{
						bindingId: "discord_200_300",
						guildId: "200",
						guildName: "Nextain",
						channelId: "300",
						channelName: "general",
						allowedUserIds: ["400000", "400001"],
						processingProfileRef: "default",
						participation: "paused",
					},
				],
			}),
		);
		await waitFor(() => expect(screen.getByRole("status")).toBeDefined());
	});

	it("allows the first binding save when no manifest generation exists", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: null,
					state: "configured",
					authoritative: false,
				});
			if (command === "discord_discover_channels")
				return Promise.resolve(discovery);
			if (command === "discord_binding_snapshot")
				return Promise.resolve(bindingSnapshot([], null));
			if (command === "discord_save_bindings") return Promise.resolve(123);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await screen.findByText("Nextain");
		fireEvent.click(screen.getByRole("checkbox", { name: /general/ }));
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "400000" },
		});
		fireEvent.click(screen.getByRole("button", { name: /저장|Save|Apply/i }));

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_save_bindings", {
				expectedGeneration: null,
				bindings: [
					{
						bindingId: "discord_200_300",
						guildId: "200",
						guildName: "Nextain",
						channelId: "300",
						channelName: "general",
						allowedUserIds: ["400000"],
						processingProfileRef: "default",
						participation: "mentions",
					},
				],
			}),
		);
	});

	it("refreshes instead of retrying a save after a generation conflict", async () => {
		const olderBinding = {
			bindingId: "existing_general",
			guildId: "200",
			guildName: "Nextain",
			channelId: "300",
			channelName: "general",
			allowedUserIds: ["666666"],
			processingProfileRef: "default",
			participation: "mentions",
		};
		const newerBinding = {
			...olderBinding,
			allowedUserIds: ["777777"],
			participation: "all",
		};
		let statusReads = 0;
		let bindingReads = 0;
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status") {
				statusReads += 1;
				return Promise.resolve({
					tokenConfigured: true,
					generation: statusReads,
					state: "ready",
					authoritative: true,
				});
			}
			if (command === "discord_binding_snapshot") {
				bindingReads += 1;
				return Promise.resolve(
					bindingReads === 1
						? bindingSnapshot([olderBinding], 1)
						: bindingSnapshot([newerBinding], 2),
				);
			}
			if (command === "discord_discover_channels")
				return Promise.resolve(discovery);
			if (command === "discord_save_bindings")
				return Promise.reject(
					new Error("discord_bindings_generation_conflict"),
				);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await screen.findByDisplayValue("666666");
		fireEvent.click(screen.getByRole("button", { name: /저장|Save|Apply/i }));

		await screen.findByDisplayValue("777777");
		expect(mockInvoke).toHaveBeenCalledWith("discord_save_bindings", {
			expectedGeneration: 1,
			bindings: [olderBinding],
		});
		expect(
			mockInvoke.mock.calls.filter(
				([command]) => command === "discord_save_bindings",
			),
		).toHaveLength(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("matches the native six-to-thirty-two digit user snowflake boundary", async () => {
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
				return Promise.resolve(bindingSnapshot([]));
			return Promise.resolve();
		});
		render(<ConnectionsSettingsTab />);
		await screen.findByText("Nextain");

		fireEvent.click(screen.getByRole("checkbox", { name: /general/ }));
		const users = screen.getByRole("textbox");
		const save = screen.getByRole("button", { name: /저장|Save|Apply/i });
		fireEvent.change(users, { target: { value: "12345" } });
		expect(save).toBeDisabled();
		fireEvent.change(users, { target: { value: "123456" } });
		expect(save).not.toBeDisabled();
		fireEvent.change(users, {
			target: { value: "123456789012345678901234567890123" },
		});
		expect(save).toBeDisabled();
	});

	it("restores saved values and preserves unavailable bindings without hiding them", async () => {
		const savedBindings = [
			{
				bindingId: "existing_general",
				guildId: "200",
				guildName: "Nextain",
				channelId: "300",
				channelName: "general",
				allowedUserIds: ["400000", "400001"],
				processingProfileRef: "default",
				participation: "all",
			},
			{
				bindingId: "discord_200_301",
				guildId: "200",
				guildName: "Nextain",
				channelId: "301",
				channelName: "private",
				allowedUserIds: ["400002"],
				processingProfileRef: "default",
				participation: "mentions",
			},
			{
				bindingId: "discord_900_901",
				guildId: "900",
				guildName: "Former server",
				channelId: "901",
				channelName: "archived",
				allowedUserIds: ["400003"],
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
				return Promise.resolve(bindingSnapshot(savedBindings));
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
		expect(screen.getByDisplayValue("400000, 400001")).toBeDefined();
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
				expectedGeneration: 1,
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
			allowedUserIds: ["400003"],
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
				return Promise.resolve(bindingSnapshot([stale]));
			if (command === "discord_save_bindings") return Promise.resolve(125);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		const archived = await screen.findByRole("checkbox", { name: /archived/ });
		fireEvent.click(archived);
		fireEvent.click(screen.getByRole("button", { name: /저장|Save|Apply/i }));

		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_save_bindings", {
				expectedGeneration: 1,
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
			if (command === "discord_binding_snapshot")
				return Promise.resolve(bindingSnapshot([]));
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

	it("does not clear a discovery warning when runtime status has no error", async () => {
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
				return Promise.resolve(bindingSnapshot([]));
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await waitFor(() =>
			expect(screen.getByRole("alert").getAttribute("data-error-code")).toBe(
				"discord_discovery_incomplete",
			),
		);
		const listener = mockListen.mock.calls[0]?.[1] as (() => void) | undefined;
		await act(async () => {
			listener?.();
		});
		expect(screen.getByRole("alert").getAttribute("data-error-code")).toBe(
			"discord_discovery_incomplete",
		);
	});

	it("does not let an older discovery refresh overwrite newer runtime status", async () => {
		let statusReads = 0;
		let discoveryReads = 0;
		let resolveDiscovery!: (value: typeof discovery) => void;
		const pendingDiscovery = new Promise<typeof discovery>((resolve) => {
			resolveDiscovery = resolve;
		});
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status") {
				statusReads += 1;
				return Promise.resolve({
					tokenConfigured: true,
					generation: 1,
					state: statusReads === 1 ? "connecting" : "ready",
					authoritative: statusReads > 1,
				});
			}
			if (command === "discord_discover_channels") {
				discoveryReads += 1;
				return discoveryReads === 1
					? pendingDiscovery
					: Promise.resolve(discovery);
			}
			if (command === "discord_binding_snapshot")
				return Promise.resolve(bindingSnapshot([]));
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_discover_channels"),
		);
		const listener = mockListen.mock.calls[0]?.[1] as (() => void) | undefined;
		await act(async () => {
			listener?.();
		});
		await screen.findByText(t("settings.connectionsConnected"));
		await act(async () => {
			resolveDiscovery(discovery);
		});
		expect(screen.getByText(t("settings.connectionsConnected"))).toBeDefined();
		expect(screen.getByText("Nextain")).toBeDefined();
	});

	it("does not let an older binding snapshot overwrite a newer refresh", async () => {
		const olderBinding = {
			bindingId: "existing_general",
			guildId: "200",
			guildName: "Nextain",
			channelId: "300",
			channelName: "general",
			allowedUserIds: ["666666"],
			processingProfileRef: "default",
			participation: "mentions",
		};
		const newerBinding = {
			...olderBinding,
			allowedUserIds: ["777777"],
			participation: "all",
		};
		let bindingReads = 0;
		let resolveOlder!: (value: (typeof olderBinding)[]) => void;
		let resolveNewer!: (value: (typeof newerBinding)[]) => void;
		const pendingOlder = new Promise<(typeof olderBinding)[]>((resolve) => {
			resolveOlder = resolve;
		});
		const pendingNewer = new Promise<(typeof newerBinding)[]>((resolve) => {
			resolveNewer = resolve;
		});
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
			if (command === "discord_binding_snapshot") {
				bindingReads += 1;
				if (bindingReads === 1) return Promise.resolve(bindingSnapshot([]));
				if (bindingReads === 2)
					return pendingOlder.then((bindings) => bindingSnapshot(bindings));
				if (bindingReads === 3)
					return pendingNewer.then((bindings) => bindingSnapshot(bindings));
				return Promise.resolve(bindingSnapshot([newerBinding]));
			}
			if (command === "discord_save_bindings") return Promise.resolve(127);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await screen.findByText("Nextain");
		const refresh = screen.getByRole("button", {
			name: t("settings.connectionsRefresh"),
		});
		fireEvent.click(refresh);
		fireEvent.click(refresh);
		await waitFor(() => expect(bindingReads).toBe(3));

		await act(async () => {
			resolveNewer([newerBinding]);
		});
		await screen.findByDisplayValue("777777");
		expect(
			screen.getByRole("combobox", { name: /Nextain.*general/ }),
		).toHaveValue("all");

		await act(async () => {
			resolveOlder([olderBinding]);
		});
		expect(screen.queryByDisplayValue("666666")).toBeNull();
		expect(screen.getByDisplayValue("777777")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: /저장|Save|Apply/i }));
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("discord_save_bindings", {
				expectedGeneration: 1,
				bindings: [newerBinding],
			}),
		);
	});

	it("loads the latest generation when a status event beats the initial snapshot", async () => {
		const olderBinding = {
			bindingId: "existing_general",
			guildId: "200",
			guildName: "Nextain",
			channelId: "300",
			channelName: "general",
			allowedUserIds: ["666666"],
			processingProfileRef: "default",
			participation: "mentions",
		};
		const newerBinding = {
			...olderBinding,
			allowedUserIds: ["777777"],
			participation: "all",
		};
		let statusReads = 0;
		let bindingReads = 0;
		let resolveInitialStatus!: (value: {
			tokenConfigured: boolean;
			generation: number;
			state: string;
			authoritative: boolean;
		}) => void;
		let resolveInitialBindings!: (value: (typeof olderBinding)[]) => void;
		const pendingInitialStatus = new Promise<{
			tokenConfigured: boolean;
			generation: number;
			state: string;
			authoritative: boolean;
		}>((resolve) => {
			resolveInitialStatus = resolve;
		});
		const pendingInitialBindings = new Promise<(typeof olderBinding)[]>(
			(resolve) => {
				resolveInitialBindings = resolve;
			},
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status") {
				statusReads += 1;
				return statusReads === 1
					? pendingInitialStatus
					: Promise.resolve({
							tokenConfigured: true,
							generation: 2,
							state: "ready",
							authoritative: true,
						});
			}
			if (command === "discord_binding_snapshot") {
				bindingReads += 1;
				return bindingReads === 1
					? pendingInitialBindings.then((bindings) =>
							bindingSnapshot(bindings, 1),
						)
					: Promise.resolve(bindingSnapshot([newerBinding], 2));
			}
			if (command === "discord_discover_channels")
				return Promise.resolve(discovery);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await waitFor(() => {
			expect(statusReads).toBe(1);
			expect(bindingReads).toBe(1);
		});
		const listener = mockListen.mock.calls[0]?.[1] as (() => void) | undefined;
		await act(async () => {
			listener?.();
		});

		await screen.findByDisplayValue("777777");
		expect(bindingReads).toBe(2);
		expect(
			screen.getByRole("combobox", { name: /Nextain.*general/ }),
		).toHaveValue("all");

		await act(async () => {
			resolveInitialStatus({
				tokenConfigured: true,
				generation: 1,
				state: "ready",
				authoritative: true,
			});
			resolveInitialBindings([olderBinding]);
		});
		expect(screen.queryByDisplayValue("666666")).toBeNull();
		expect(screen.getByDisplayValue("777777")).toBeDefined();
	});

	it("hides mismatched binding generations until a matching status refresh", async () => {
		const olderBinding = {
			bindingId: "existing_general",
			guildId: "200",
			guildName: "Nextain",
			channelId: "300",
			channelName: "general",
			allowedUserIds: ["666666"],
			processingProfileRef: "default",
			participation: "mentions",
		};
		const newerBinding = {
			...olderBinding,
			allowedUserIds: ["777777"],
			participation: "all",
		};
		let bindingReads = 0;
		let discoveryReads = 0;
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: 3,
					state: "ready",
					authoritative: true,
				});
			if (command === "discord_binding_snapshot") {
				bindingReads += 1;
				return Promise.resolve(
					bindingReads === 1
						? bindingSnapshot([olderBinding], 2)
						: bindingSnapshot([newerBinding], 3),
				);
			}
			if (command === "discord_discover_channels") {
				discoveryReads += 1;
				return Promise.resolve(discovery);
			}
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await waitFor(() => expect(bindingReads).toBe(1));
		expect(discoveryReads).toBe(0);
		expect(screen.queryByDisplayValue("666666")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /저장|Save|Apply/i }),
		).toBeNull();
		expect(screen.getByRole("alert").getAttribute("data-error-code")).toBe(
			"discord_binding_generation_mismatch",
		);

		const listener = mockListen.mock.calls[0]?.[1] as (() => void) | undefined;
		await act(async () => {
			listener?.();
		});

		await screen.findByDisplayValue("777777");
		expect(bindingReads).toBe(2);
		expect(discoveryReads).toBe(1);
		expect(
			screen.getByRole("button", { name: /저장|Save|Apply/i }),
		).toBeEnabled();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("fails closed for a legacy array snapshot without a generation", async () => {
		let discoveryReads = 0;
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: 3,
					state: "ready",
					authoritative: true,
				});
			if (command === "discord_binding_snapshot")
				return Promise.resolve([
					{
						bindingId: "legacy",
						guildId: "200",
						guildName: "Nextain",
						channelId: "300",
						channelName: "general",
						allowedUserIds: ["666666"],
						processingProfileRef: "default",
						participation: "mentions",
					},
				]);
			if (command === "discord_discover_channels") {
				discoveryReads += 1;
				return Promise.resolve(discovery);
			}
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await waitFor(() =>
			expect(screen.getByRole("alert").getAttribute("data-error-code")).toBe(
				"discord_binding_generation_mismatch",
			),
		);
		expect(discoveryReads).toBe(0);
		expect(screen.queryByDisplayValue("666666")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /저장|Save|Apply/i }),
		).toBeNull();
	});

	it("rejects generation zero before discovery or save is exposed", async () => {
		let discoveryReads = 0;
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: 0,
					state: "configured",
					authoritative: false,
				});
			if (command === "discord_binding_snapshot")
				return Promise.resolve(bindingSnapshot([], 0));
			if (command === "discord_discover_channels") {
				discoveryReads += 1;
				return Promise.resolve(discovery);
			}
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await waitFor(() =>
			expect(screen.getByRole("alert").getAttribute("data-error-code")).toBe(
				"discord_binding_generation_mismatch",
			),
		);
		expect(discoveryReads).toBe(0);
		expect(
			screen.queryByRole("button", { name: /저장|Save|Apply/i }),
		).toBeNull();
	});

	it("clears binding and save state when the token is not configured", async () => {
		let discoveryReads = 0;
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: false,
					generation: 3,
					state: "disconnected",
					authoritative: false,
				});
			if (command === "discord_binding_snapshot")
				return Promise.resolve(
					bindingSnapshot(
						[
							{
								bindingId: "stale",
								guildId: "200",
								channelId: "300",
								allowedUserIds: ["666666"],
								processingProfileRef: "default",
								participation: "mentions",
							},
						],
						2,
					),
				);
			if (command === "discord_discover_channels") {
				discoveryReads += 1;
				return Promise.resolve(discovery);
			}
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await screen.findByText(t("settings.connectionsDisconnected"));
		expect(discoveryReads).toBe(0);
		expect(screen.queryByDisplayValue("666666")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /저장|Save|Apply/i }),
		).toBeNull();
	});

	it("rejects old discovery before the replacement status resolves", async () => {
		const olderBinding = {
			bindingId: "existing_general",
			guildId: "200",
			guildName: "Nextain",
			channelId: "300",
			channelName: "general",
			allowedUserIds: ["666666"],
			processingProfileRef: "default",
			participation: "mentions",
		};
		const newerBinding = {
			...olderBinding,
			allowedUserIds: ["777777"],
			participation: "all",
		};
		let statusReads = 0;
		let bindingReads = 0;
		let discoveryReads = 0;
		let resolveOlderDiscovery!: (value: typeof discovery) => void;
		let resolveNewerStatus!: (value: {
			tokenConfigured: boolean;
			generation: number;
			state: string;
			authoritative: boolean;
		}) => void;
		const pendingOlderDiscovery = new Promise<typeof discovery>((resolve) => {
			resolveOlderDiscovery = resolve;
		});
		const pendingNewerStatus = new Promise<{
			tokenConfigured: boolean;
			generation: number;
			state: string;
			authoritative: boolean;
		}>((resolve) => {
			resolveNewerStatus = resolve;
		});
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status") {
				statusReads += 1;
				return statusReads === 1
					? Promise.resolve({
							tokenConfigured: true,
							generation: 1,
							state: "ready",
							authoritative: true,
						})
					: pendingNewerStatus;
			}
			if (command === "discord_binding_snapshot") {
				bindingReads += 1;
				return Promise.resolve(
					bindingSnapshot(
						bindingReads === 1 ? [olderBinding] : [newerBinding],
						bindingReads === 1 ? 1 : 2,
					),
				);
			}
			if (command === "discord_discover_channels") {
				discoveryReads += 1;
				return discoveryReads === 1
					? pendingOlderDiscovery
					: Promise.resolve(discovery);
			}
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await waitFor(() => expect(discoveryReads).toBe(1));
		expect(screen.queryByDisplayValue("666666")).toBeNull();
		const listener = mockListen.mock.calls[0]?.[1] as (() => void) | undefined;
		await act(async () => {
			listener?.();
		});

		await act(async () => {
			resolveOlderDiscovery(discovery);
		});
		expect(screen.queryByDisplayValue("666666")).toBeNull();
		expect(screen.queryByDisplayValue("777777")).toBeNull();

		await act(async () => {
			resolveNewerStatus({
				tokenConfigured: true,
				generation: 2,
				state: "ready",
				authoritative: true,
			});
		});
		await screen.findByDisplayValue("777777");
		expect(bindingReads).toBe(2);
		expect(
			screen.getByRole("combobox", { name: /Nextain.*general/ }),
		).toHaveValue("all");
	});

	it("removes stale save controls while event refresh data is pending", async () => {
		const olderBinding = {
			bindingId: "existing_general",
			guildId: "200",
			guildName: "Nextain",
			channelId: "300",
			channelName: "general",
			allowedUserIds: ["666666"],
			processingProfileRef: "default",
			participation: "mentions",
		};
		const newerBinding = {
			...olderBinding,
			allowedUserIds: ["777777"],
			participation: "all",
		};
		let bindingReads = 0;
		let resolveNewerBindings!: (value: (typeof newerBinding)[]) => void;
		const pendingNewerBindings = new Promise<(typeof newerBinding)[]>(
			(resolve) => {
				resolveNewerBindings = resolve;
			},
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "discord_connection_status")
				return Promise.resolve({
					tokenConfigured: true,
					generation: bindingReads === 0 ? 1 : 2,
					state: "ready",
					authoritative: true,
				});
			if (command === "discord_binding_snapshot") {
				bindingReads += 1;
				return bindingReads === 1
					? Promise.resolve(bindingSnapshot([olderBinding]))
					: pendingNewerBindings.then((bindings) =>
							bindingSnapshot(bindings, 2),
						);
			}
			if (command === "discord_discover_channels")
				return Promise.resolve(discovery);
			if (command === "discord_save_bindings") return Promise.resolve(128);
			return Promise.resolve();
		});

		render(<ConnectionsSettingsTab />);
		await screen.findByDisplayValue("666666");
		const staleSave = screen.getByRole("button", {
			name: /저장|Save|Apply/i,
		});
		const listener = mockListen.mock.calls[0]?.[1] as (() => void) | undefined;
		await act(async () => {
			listener?.();
		});

		expect(
			screen.queryByRole("button", { name: /저장|Save|Apply/i }),
		).toBeNull();
		fireEvent.click(staleSave);
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"discord_save_bindings",
			expect.anything(),
		);

		await act(async () => {
			resolveNewerBindings([newerBinding]);
		});
		await screen.findByDisplayValue("777777");
		expect(
			screen.getByRole("button", { name: /저장|Save|Apply/i }),
		).toBeEnabled();
		expect(mockInvoke).not.toHaveBeenCalledWith(
			"discord_save_bindings",
			expect.anything(),
		);
		expect(screen.getByDisplayValue("777777")).toBeDefined();
	});

	it("preserves bindings from a guild whose discovery is degraded", async () => {
		const uncertain = {
			bindingId: "discord_900_901",
			guildId: "900",
			guildName: "Temporarily unavailable",
			channelId: "901",
			channelName: "operations",
			allowedUserIds: ["400003"],
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
				return Promise.resolve(bindingSnapshot([uncertain]));
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
				expectedGeneration: 1,
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
			allowedUserIds: ["400003"],
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
				return Promise.resolve(bindingSnapshot([beyondProductBound]));
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
