// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsSteam = vi.fn(() => false);
vi.mock("../../lib/distribution", () => ({
	isSteamChannelNow: () => mockIsSteam(),
	paymentLinksHiddenNow: () => false,
}));

import {
	openSteamPurchaseModal,
	voiceFailureMessage,
} from "../chat-voice-utils";

describe("chat-voice-utils (#729 P2 지적 12)", () => {
	beforeEach(() => {
		mockIsSteam.mockReturnValue(false);
		vi.clearAllMocks();
	});

	it("openSteamPurchaseModal dispatches open-steam-purchase event", () => {
		const listener = vi.fn();
		window.addEventListener("open-steam-purchase", listener);

		openSteamPurchaseModal();

		expect(listener).toHaveBeenCalledTimes(1);
		window.removeEventListener("open-steam-purchase", listener);
	});

	it("voiceFailureMessage dispatches open-steam-purchase when phase is error with reason credits on Steam channel", () => {
		mockIsSteam.mockReturnValue(true);
		const listener = vi.fn();
		window.addEventListener("open-steam-purchase", listener);

		const msg = voiceFailureMessage(
			{ phase: "error", reason: "credits" } as any,
			new Error("out of credits"),
		);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(typeof msg).toBe("string");
		expect(msg.length).toBeGreaterThan(0);

		window.removeEventListener("open-steam-purchase", listener);
	});

	it("voiceFailureMessage does NOT dispatch open-steam-purchase when not on Steam channel", () => {
		mockIsSteam.mockReturnValue(false);
		const listener = vi.fn();
		window.addEventListener("open-steam-purchase", listener);

		const msg = voiceFailureMessage(
			{ phase: "error", reason: "credits" } as any,
			new Error("out of credits"),
		);

		expect(listener).not.toHaveBeenCalled();
		expect(typeof msg).toBe("string");

		window.removeEventListener("open-steam-purchase", listener);
	});
});
