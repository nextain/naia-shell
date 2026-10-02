// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd === "frontend_log") return Promise.resolve();
		if (cmd === "get_distribution_channel") return "steam";
		return undefined;
	}),
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
	LAB_GATEWAY_URL: "https://api.naia.test",
	getNaiaKeySecure: vi.fn().mockResolvedValue("gw-steam-key-123"),
	hasNaiaKeySecure: vi.fn().mockResolvedValue(true),
	loadConfig: vi.fn().mockResolvedValue({
		distributionChannel: "steam",
		ttsProvider: "naia-cloud-voice",
	}),
	saveConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/voice/ref-audio-api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../lib/voice/ref-audio-api")>();
	return {
		...actual,
		getRefAudioPresets: vi.fn(),
		getRefAudioStatus: vi.fn().mockResolvedValue({ active: null, historyCount: 0 }),
		applyRefAudioPreset: vi.fn(),
	};
});

import {
	applyRefAudioPreset,
	getRefAudioPresets,
	RefAudioApiError,
} from "../../lib/voice/ref-audio-api";
import { RefAudioSection } from "../RefAudioSection";

describe("RefAudioSection Steam edition (#729 P2 지적 12)", () => {
	const CLOUD_PRESETS = [
		{
			id: "preset-1",
			name: "여성 음색 1",
			locale: "ko",
			durationSeconds: 8,
			sampleUrl: "https://example.test/sample1.wav",
			sampleFormat: "wav",
			source: "common-voice",
			license: "cc0",
		},
	];

	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				distributionChannel: "steam",
				ttsProvider: "naia-cloud-voice",
			}),
		);
		vi.mocked(getRefAudioPresets).mockResolvedValue(CLOUD_PRESETS);
	});

	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	it("shows Steam charge button on credit-insufficient error and opens SteamPurchaseModal", async () => {
		vi.mocked(applyRefAudioPreset).mockRejectedValue(
			new RefAudioApiError("credit-insufficient", 402, "Credits insufficient"),
		);

		render(<RefAudioSection />);

		const details = document.querySelector("details");
		expect(details).not.toBeNull();
		(details as HTMLDetailsElement).open = true;
		fireEvent(details as HTMLDetailsElement, new Event("toggle"));

		await waitFor(() => {
			expect(screen.getByText("Apply")).toBeDefined();
		});

		fireEvent.click(screen.getByText("Apply"));

		await waitFor(() => {
			expect(screen.getByTestId("ref-audio-steam-charge-btn")).toBeDefined();
		});

		// Clicking Steam charge button opens the Steam purchase modal dialog
		fireEvent.click(screen.getByTestId("ref-audio-steam-charge-btn"));

		await waitFor(() => {
			expect(screen.getByRole("dialog")).toBeDefined();
		});
	});
});
