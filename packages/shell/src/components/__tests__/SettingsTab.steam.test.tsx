// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSteamLinkIdentity = vi.fn();
vi.mock("../../lib/steam-auth", () => ({
	steamLinkIdentity: (...args: unknown[]) => mockSteamLinkIdentity(...args),
}));

vi.mock("../../lib/distribution", () => ({
	useIsSteamChannel: () => true,
	isSteamChannelNow: () => true,
	usePaymentLinksHidden: () => true,
	paymentLinksHiddenNow: () => true,
	loadDistributionChannel: async () => "steam",
}));

vi.mock("../../lib/steam-billing", () => ({
	fetchSteamPacks: vi.fn().mockResolvedValue([
		{
			id: "pack-1",
			price_cents: 1000,
			currency: "USD",
			credits: 1000000,
		},
	]),
	createSteamOrder: vi.fn(),
	finalizeSteamOrder: vi.fn(),
	listenToSteamAuthorization: vi.fn().mockResolvedValue(() => {}),
	openSteamUrl: vi.fn(),
}));

const secureStoreMock = vi.hoisted(() => ({
	get: vi.fn().mockResolvedValue(null),
	set: vi.fn().mockResolvedValue(undefined),
	delete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
	load: vi.fn().mockResolvedValue(secureStoreMock),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd === "frontend_log") return Promise.resolve();
		if (cmd === "fetch_naia_balance") return Promise.resolve({ balance: 500_000 });
		if (cmd === "read_naia_ui_config" || cmd === "read_naia_config") return "{}";
		if (cmd === "list_stt_models") return [];
		if (cmd === "get_distribution_channel") return "steam";
		return [];
	}),
	convertFileSrc: vi.fn((path: string) => `file://${path}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../lib/voice/host-profile", () => ({
	voiceHostProfile: () =>
		Promise.resolve({
			profile: "windows_trt_6g",
			gpus: [{ index: 0, freeMib: 8192, totalMib: 8192 }],
			gpuChoiceIsMeaningful: false,
			defaultGpuIndex: 0,
		}),
	resetVoiceHostProfileCache: () => {},
}));

vi.mock("../../lib/chat-service", () => ({
	activateNaiaLlm: vi.fn().mockResolvedValue({
		available: true,
		loaded: true,
		provider: "nextain",
		model: "deepseek-v4-flash",
		llm: "naia",
	}),
	directToolCall: vi.fn().mockResolvedValue({ success: false }),
	reloadAgentSettings: vi.fn().mockResolvedValue(undefined),
	sendAuthUpdate: vi.fn().mockResolvedValue(undefined),
	sendAuthUpdateStrict: vi.fn().mockResolvedValue(undefined),
	sendNotifyConfig: vi.fn().mockResolvedValue(undefined),
	sendCredsUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { clearCachedLabCredits } from "../../lib/lab-balance";
import { setLocale } from "../../lib/i18n";
import { SettingsTab } from "../SettingsTab";

describe("SettingsTab on Steam edition (#729)", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		clearCachedLabCredits();
		await setLocale("ko");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gemini-2.5-flash",
				apiKey: "",
				naiaKey: "gw-test-steam-key",
				naiaUserId: "steam-user-123",
			}),
		);
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {},
		});
	});

	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	it("renders Steam charge and link buttons when logged in", async () => {
		render(<SettingsTab />);

		await screen.findByTestId("profile-naia-account");
		expect(screen.getByTestId("steam-charge-btn")).toBeDefined();
		expect(screen.getByTestId("steam-link-btn")).toBeDefined();
		expect(screen.getByTestId("steam-link-btn").textContent).toContain("Steam 계정 연결");
	});

	it("opens SteamPurchaseModal when Steam charge button is clicked", async () => {
		render(<SettingsTab />);

		await screen.findByTestId("profile-naia-account");
		const chargeBtn = screen.getByTestId("steam-charge-btn");

		await act(async () => {
			fireEvent.click(chargeBtn);
		});

		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeDefined();
			expect(screen.getAllByText("크레딧 충전").length).toBeGreaterThanOrEqual(2);
			expect(screen.getByText("1000000 크레딧")).toBeDefined();
		});
	});

	it("calls steamLinkIdentity and displays success message on success", async () => {
		mockSteamLinkIdentity.mockResolvedValueOnce({
			success: true,
		});

		render(<SettingsTab />);

		await screen.findByTestId("profile-naia-account");
		const linkBtn = screen.getByTestId("steam-link-btn");

		await act(async () => {
			fireEvent.click(linkBtn);
		});

		await waitFor(() => {
			expect(mockSteamLinkIdentity).toHaveBeenCalledWith("gw-test-steam-key");
			const msg = screen.getByTestId("steam-link-message");
			expect(msg.textContent).toContain("Steam 계정이 연결되었습니다");
		});
	});

	it("displays error message when identity_linked_elsewhere occurs", async () => {
		mockSteamLinkIdentity.mockResolvedValueOnce({
			success: false,
			errorCode: "identity_linked_elsewhere",
			error: "이 Steam 계정은 다른 나이아 계정에 연결되어 있습니다",
		});

		render(<SettingsTab />);

		await screen.findByTestId("profile-naia-account");
		const linkBtn = screen.getByTestId("steam-link-btn");

		await act(async () => {
			fireEvent.click(linkBtn);
		});

		await waitFor(() => {
			expect(mockSteamLinkIdentity).toHaveBeenCalledWith("gw-test-steam-key");
			const msg = screen.getByTestId("steam-link-message");
			expect(msg.textContent).toContain("다른 나이아 계정에 연결되어 있습니다");
		});
	});

	it("displays general error message when steamLinkIdentity fails with other errors", async () => {
		mockSteamLinkIdentity.mockResolvedValueOnce({
			success: false,
			errorCode: "network_error",
			error: "Network connection failed",
		});

		render(<SettingsTab />);

		await screen.findByTestId("profile-naia-account");
		const linkBtn = screen.getByTestId("steam-link-btn");

		await act(async () => {
			fireEvent.click(linkBtn);
		});

		await waitFor(() => {
			expect(mockSteamLinkIdentity).toHaveBeenCalledWith("gw-test-steam-key");
			const msg = screen.getByTestId("steam-link-message");
			expect(msg.textContent).toContain("Network connection failed");
		});
	});
});
