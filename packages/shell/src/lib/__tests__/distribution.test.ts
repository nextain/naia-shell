// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const web = vi.hoisted(() => ({ mode: false }));
vi.mock("../web-runtime/web-assets", () => ({ isWebMode: () => web.mode }));
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
		web.mode = false;
		resetDistributionChannelForTests();
	});

	it("is standard on the web build without asking the native side", async () => {
		web.mode = true;
		await expect(loadDistributionChannel()).resolves.toBe("standard");
		expect(invokeMock).not.toHaveBeenCalled();
		expect(paymentLinksHiddenNow()).toBe(false);
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

	it("fails closed when the native call fails: payment UI stays hidden (#727)", async () => {
		invokeMock.mockRejectedValue(new Error("boom"));
		await expect(loadDistributionChannel()).resolves.toBe("unknown");
		expect(paymentLinksHiddenNow()).toBe(true);
	});

	it("fails closed on an unexpected native answer", async () => {
		invokeMock.mockResolvedValue(undefined);
		await expect(loadDistributionChannel()).resolves.toBe("unknown");
		expect(paymentLinksHiddenNow()).toBe(true);
	});
});
