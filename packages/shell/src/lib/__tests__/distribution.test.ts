// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
	loadDistributionChannel,
	paymentLinksHiddenNow,
	resetDistributionChannelForTests,
} from "../distribution";

describe("distribution channel (#727)", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		resetDistributionChannelForTests();
	});

	it("is steam when the native side reports steam (marker file present)", async () => {
		invokeMock.mockResolvedValue("steam");
		expect(paymentLinksHiddenNow()).toBe(true); // unknown yet: fail closed
		await expect(loadDistributionChannel()).resolves.toBe("steam");
		expect(invokeMock).toHaveBeenCalledWith("get_distribution_channel");
		expect(paymentLinksHiddenNow()).toBe(true);
	});

	it("is standard when the marker is absent", async () => {
		invokeMock.mockResolvedValue("standard");
		await expect(loadDistributionChannel()).resolves.toBe("standard");
		expect(paymentLinksHiddenNow()).toBe(false);
	});

	it("falls back to standard when the native call fails (browser dev)", async () => {
		invokeMock.mockRejectedValue(new Error("no tauri"));
		await expect(loadDistributionChannel()).resolves.toBe("standard");
		expect(paymentLinksHiddenNow()).toBe(false);
	});
});
