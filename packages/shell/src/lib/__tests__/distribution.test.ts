// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
	isSteamChannelNow,
	loadDistributionChannel,
	paymentLinksHiddenNow,
	resetDistributionChannelForTests,
	steamPurchaseAvailableNow,
	useIsSteamChannel,
	useSteamPurchaseAvailable,
} from "../distribution";
import { renderHook, waitFor } from "@testing-library/react";

describe("distribution channel (#727, #729)", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		resetDistributionChannelForTests();
	});

	it("is steam when the native side reports steam (marker file present)", async () => {
		invokeMock.mockResolvedValue("steam");
		expect(paymentLinksHiddenNow()).toBe(true); // unknown yet: fail closed
		expect(isSteamChannelNow()).toBe(false);
		expect(steamPurchaseAvailableNow()).toBe(false);
		await expect(loadDistributionChannel()).resolves.toBe("steam");
		expect(invokeMock).toHaveBeenCalledWith("get_distribution_channel");
		expect(paymentLinksHiddenNow()).toBe(true);
		expect(isSteamChannelNow()).toBe(true);
		expect(steamPurchaseAvailableNow()).toBe(true);
	});

	it("is standard when the marker is absent", async () => {
		invokeMock.mockResolvedValue("standard");
		await expect(loadDistributionChannel()).resolves.toBe("standard");
		expect(paymentLinksHiddenNow()).toBe(false);
		expect(isSteamChannelNow()).toBe(false);
		expect(steamPurchaseAvailableNow()).toBe(false);
	});

	it("fails closed when the native call fails: payment UI stays hidden (#727)", async () => {
		invokeMock.mockRejectedValue(new Error("boom"));
		await expect(loadDistributionChannel()).resolves.toBe("unknown");
		expect(paymentLinksHiddenNow()).toBe(true);
		expect(isSteamChannelNow()).toBe(false);
		expect(steamPurchaseAvailableNow()).toBe(false);
	});

	it("fails closed on an unexpected native answer", async () => {
		invokeMock.mockResolvedValue(undefined);
		await expect(loadDistributionChannel()).resolves.toBe("unknown");
		expect(paymentLinksHiddenNow()).toBe(true);
		expect(isSteamChannelNow()).toBe(false);
		expect(steamPurchaseAvailableNow()).toBe(false);
	});

	it("react hooks reflect steam channel state", async () => {
		invokeMock.mockResolvedValue("steam");
		const { result } = renderHook(() => ({
			isSteam: useIsSteamChannel(),
			purchaseAvailable: useSteamPurchaseAvailable(),
		}));
		expect(result.current.isSteam).toBe(false);
		expect(result.current.purchaseAvailable).toBe(false);
		await waitFor(() => {
			expect(result.current.isSteam).toBe(true);
			expect(result.current.purchaseAvailable).toBe(true);
		});
	});
});
