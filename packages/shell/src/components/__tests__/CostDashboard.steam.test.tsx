// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd === "frontend_log") return Promise.resolve();
		if (cmd === "get_distribution_channel") return "steam";
		return undefined;
	}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/distribution", () => ({
	useIsSteamChannel: () => true,
	isSteamChannelNow: () => true,
	usePaymentLinksHidden: () => true,
	paymentLinksHiddenNow: () => true,
}));

vi.mock("../../lib/config", () => ({
	LAB_GATEWAY_URL: "https://example.test",
	NAIA_WEB_BASE_URL: "https://www.naia.test",
	getNaiaKeySecure: vi.fn().mockResolvedValue("gw-steam-key-123"),
	hasNaiaKeySecure: vi.fn().mockResolvedValue(true),
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

import { clearCachedLabCredits } from "../../lib/lab-balance";
import { setLocale } from "../../lib/i18n";
import { CostDashboard } from "../CostDashboard";

describe("CostDashboard on Steam edition (#729)", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		clearCachedLabCredits();
		await setLocale("ko");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 500_000 }),
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("renders Steam charge button when on Steam channel", async () => {
		render(<CostDashboard messages={[]} />);

		await waitFor(() => {
			const chargeBtn = screen.getByTestId("steam-charge-btn");
			expect(chargeBtn).toBeDefined();
			expect(chargeBtn.textContent).toContain("충전");
		});
	});

	it("opens SteamPurchaseModal when Steam charge button is clicked", async () => {
		render(<CostDashboard messages={[]} />);

		await waitFor(() => {
			expect(screen.getByTestId("steam-charge-btn")).toBeDefined();
		});

		await act(async () => {
			fireEvent.click(screen.getByTestId("steam-charge-btn"));
		});

		// Modal should open and show title / pack
		await waitFor(() => {
			expect(screen.getAllByText("크레딧 충전").length).toBeGreaterThanOrEqual(2);
			expect(screen.getByText("1000000 크레딧")).toBeDefined();
		});
	});
});
