import { cleanup, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Steam build (#727): the native side reports the "steam" channel, so the
// balance stays visible but the credit top-up entry point must not render.
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) =>
		cmd === "get_distribution_channel" ? "steam" : undefined,
	),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../lib/config", () => ({
	LAB_GATEWAY_URL: "https://example.test",
	getNaiaKeySecure: vi.fn().mockResolvedValue("gw-good-key"),
	hasNaiaKeySecure: vi.fn().mockResolvedValue(true),
}));

import { resetDistributionChannelForTests } from "../../lib/distribution";
import { clearCachedLabCredits } from "../../lib/lab-balance";
import { CostDashboard } from "../CostDashboard";

describe("CostDashboard on the Steam build", () => {
	beforeEach(() => {
		clearCachedLabCredits();
		resetDistributionChannelForTests();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ balance: 1_250_000 }),
			}),
		);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("shows the balance but hides the charge button", async () => {
		render(<CostDashboard messages={[]} />);
		await screen.findByText(/12\.50/);
		// Let the channel lookup settle, then assert the button is still absent.
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByText("Charge Credits")).toBeNull();
	});
});
