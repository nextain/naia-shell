// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitKioskVoiceState } from "../../lib/tts/kiosk-voice-gate";
import { KIOSK_VOICE_NOTICE_MS, KioskVoiceNotice } from "../KioskVoiceNotice";

describe("KioskVoiceNotice", () => {
	afterEach(() => vi.useRealTimers());

	it("shows busy and fallback states, hides on ok and after the timeout", () => {
		vi.useFakeTimers();
		render(<KioskVoiceNotice />);
		expect(screen.queryByTestId("kiosk-voice-notice")).toBeNull();

		act(() => emitKioskVoiceState("busy"));
		expect(screen.getByTestId("kiosk-voice-notice")).toHaveAttribute(
			"data-voice-state",
			"busy",
		);
		act(() => emitKioskVoiceState("ok"));
		expect(screen.queryByTestId("kiosk-voice-notice")).toBeNull();

		act(() => emitKioskVoiceState("fallback"));
		expect(screen.getByTestId("kiosk-voice-notice")).toHaveAttribute(
			"data-voice-state",
			"fallback",
		);
		act(() => vi.advanceTimersByTime(KIOSK_VOICE_NOTICE_MS));
		expect(screen.queryByTestId("kiosk-voice-notice")).toBeNull();
	});
});
