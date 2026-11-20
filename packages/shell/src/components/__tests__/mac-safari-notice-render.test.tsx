// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MacSafariNotice } from "../MacSafariNotice";
import { setLocale } from "../../lib/i18n";
import { isKioskDemo } from "../../lib/kiosk-demo/flag";
import { isWebMode } from "../../lib/web-runtime/web-assets";

vi.mock("../../lib/kiosk-demo/flag", () => ({
	isKioskDemo: vi.fn(() => false),
}));
vi.mock("../../lib/web-runtime/web-assets", () => ({
	isWebMode: vi.fn(() => true),
}));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
describe("Mac Safari notice rendering", () => {
	it("only renders in the regular web runtime and supplies translated, accessible copy", async () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
		);
		vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
		Object.defineProperty(navigator, "maxTouchPoints", {
			configurable: true,
			value: 0,
		});
		await setLocale("en");
		const view = render(<MacSafariNotice />);
		expect(screen.getByRole("link", { name: "Get Chrome" })).toHaveAttribute(
			"href",
			"https://www.google.com/chrome/",
		);
		await setLocale("ko");
		view.rerender(<MacSafariNotice />);
		expect(
			screen.getByText("Mac에서는 Chrome으로 나이아를 열어 주세요."),
		).toBeInTheDocument();
		vi.mocked(isKioskDemo).mockReturnValue(true);
		view.rerender(<MacSafariNotice />);
		expect(screen.queryByTestId("mac-safari-notice")).toBeNull();
		vi.mocked(isKioskDemo).mockReturnValue(false);
		vi.mocked(isWebMode).mockReturnValue(false);
		view.rerender(<MacSafariNotice />);
		expect(screen.queryByTestId("mac-safari-notice")).toBeNull();
	});
});
