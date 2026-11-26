// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	webMode: true,
	kiosk: false,
	key: "naia_key" as string | undefined,
	fetchBalance: vi.fn(),
	setActiveApp: vi.fn(),
	paymentHidden: false,
}));

vi.mock("../../lib/web-runtime/web-assets", () => ({
	isWebMode: () => mocks.webMode,
}));
vi.mock("../../lib/kiosk-demo/flag", () => ({
	isKioskDemo: () => mocks.kiosk,
}));
vi.mock("../../lib/config", () => ({
	LAB_GATEWAY_URL: "https://gw.test",
	NAIA_WEB_BASE_URL: "https://naia.land",
	getNaiaKeySecure: async () => mocks.key,
}));
vi.mock("../../lib/distribution", () => ({
	usePaymentLinksHidden: () => mocks.paymentHidden,
}));
vi.mock("../../lib/i18n", () => ({
	getLocale: () => "ko",
	t: (k: string) => k,
}));
vi.mock("../../lib/lab-balance", async (orig) => ({
	...(await orig<typeof import("../../lib/lab-balance")>()),
	fetchLabBalancePayload: (...a: unknown[]) => mocks.fetchBalance(...a),
}));
vi.mock("../../stores/app", () => ({
	useAppStore: (
		sel: (s: { setActiveApp: typeof mocks.setActiveApp }) => unknown,
	) => sel({ setActiveApp: mocks.setActiveApp }),
}));

import { WebCreditChip, webCreditLevel } from "../WebCreditChip";

describe("webCreditLevel", () => {
	it("maps balance to SP-00 colors", () => {
		expect(webCreditLevel(200)).toBe("ok");
		expect(webCreditLevel(50)).toBe("ok");
		expect(webCreditLevel(49.9)).toBe("low");
		expect(webCreditLevel(0)).toBe("empty");
		expect(webCreditLevel(-1)).toBe("empty");
	});
});

describe("WebCreditChip", () => {
	beforeEach(() => {
		mocks.webMode = true;
		mocks.kiosk = false;
		mocks.key = "naia_key";
		mocks.fetchBalance.mockReset();
		mocks.setActiveApp.mockReset();
		mocks.paymentHidden = false;
		vi.spyOn(window, "open").mockImplementation(() => null);
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("shows the balance and opens billing and usage in a new tab", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 200 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /webCredit.title/ });
		expect(chip.className).toContain("web-credit__chip--ok");
		expect(mocks.fetchBalance).toHaveBeenCalledWith(
			"https://gw.test",
			"naia_key",
			expect.anything(),
		);

		fireEvent.click(chip);
		fireEvent.click(screen.getByText("cost.labCharge"));
		expect(window.open).toHaveBeenCalledWith(
			"https://naia.land/ko/billing",
			"_blank",
			"noopener",
		);
		fireEvent.click(screen.getByText("webCredit.usage"));
		expect(window.open).toHaveBeenCalledWith(
			"https://naia.land/ko/usage",
			"_blank",
			"noopener",
		);
	});

	it("R42 shows grouped credit amounts in the accessible chip and balance popover", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 1234 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /1,234 Cr/ });
		expect(chip).toHaveTextContent("1,234 Cr");
		fireEvent.click(chip);
		expect(screen.getAllByText("1,234 Cr")).toHaveLength(2);
	});

	it("marks a low balance orange", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 12 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /webCredit.title/ });
		expect(chip.className).toContain("web-credit__chip--low");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows the zero-credit card and hides it on close", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 0 });
		render(<WebCreditChip />);
		const card = await screen.findByRole("alert");
		expect(screen.getByRole("button", { name: /0 Cr/ })).toBeInTheDocument();
		expect(card.textContent).toContain("webCredit.emptyTitle");
		fireEvent.click(screen.getByText("webCredit.dismiss"));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("re-reads the balance when the tab regains focus", async () => {
		mocks.fetchBalance
			.mockResolvedValueOnce({ credits: 0 })
			.mockResolvedValue({ credits: 500 });
		render(<WebCreditChip />);
		await screen.findByRole("alert");
		window.dispatchEvent(new Event("focus"));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(
			screen.getByRole("button", { name: /webCredit.title/ }).className,
		).toContain("--ok");
	});

	it("renders nothing without a login key, outside web mode, or in the kiosk demo", async () => {
		mocks.key = undefined;
		const { container, unmount } = render(<WebCreditChip />);
		await new Promise((r) => setTimeout(r, 0));
		expect(container.innerHTML).toBe("");
		unmount();

		mocks.key = "naia_key";
		mocks.webMode = false;
		mocks.fetchBalance.mockResolvedValue({ credits: 10 });
		const desktop = render(<WebCreditChip />);
		await new Promise((r) => setTimeout(r, 0));
		expect(desktop.container.innerHTML).toBe("");
		desktop.unmount();

		mocks.webMode = true;
		mocks.kiosk = true;
		const kiosk = render(<WebCreditChip />);
		await new Promise((r) => setTimeout(r, 0));
		expect(kiosk.container.innerHTML).toBe("");
		expect(mocks.fetchBalance).not.toHaveBeenCalled();
	});

	it("opens the usage dashboard in a new tab when the chip is clicked", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 200 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /webCredit.title/ });
		fireEvent.click(chip);
		expect(window.open).toHaveBeenCalledTimes(1);
		expect(window.open).toHaveBeenCalledWith(
			"https://naia.land/ko/usage",
			"_blank",
			"noopener",
		);
		// The balance detail popover and the separate charge path stay reachable.
		expect(
			screen.getByRole("button", { name: /webCredit.title/ }),
		).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("cost.labCharge")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "webCredit.usage" })).toHaveAttribute(
			"href",
			"https://naia.land/ko/usage",
		);
	});

	it("provides a keyboard-activated usage link if opening a new tab is blocked", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 200 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /webCredit.title/ });
		fireEvent.click(chip);

		const usageLink = screen.getByRole("link", { name: "webCredit.usage" });
		expect(usageLink).toHaveAttribute("href", "https://naia.land/ko/usage");
		usageLink.focus();
		expect(document.activeElement).toBe(usageLink);
		fireEvent.keyDown(usageLink, { key: "Enter" });
		expect(usageLink).toHaveAttribute("target", "_blank");
		expect(usageLink).toHaveAttribute("rel", "noopener noreferrer");
	});

	it("does not open another tab when the chip closes the popover", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 200 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /webCredit.title/ });
		fireEvent.click(chip);
		expect(window.open).toHaveBeenCalledTimes(1);
		fireEvent.click(chip);
		expect(window.open).toHaveBeenCalledTimes(1);
		expect(
			screen.getByRole("button", { name: /webCredit.title/ }),
		).toHaveAttribute("aria-expanded", "false");
	});

	it("chip is a keyboard-focusable native button on the same activation path", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 200 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /webCredit.title/ });
		expect(chip.tagName).toBe("BUTTON");
		expect(chip).not.toHaveAttribute("tabindex", "-1");
		(chip as HTMLElement).focus();
		expect(document.activeElement).toBe(chip);
		// Native Enter/Space activation fires click in browsers; prove the
		// shared path opens usage once.
		fireEvent.click(chip);
		expect(window.open).toHaveBeenCalledWith(
			"https://naia.land/ko/usage",
			"_blank",
			"noopener",
		);
	});

	it("still opens usage from the chip when payment links are hidden", async () => {
		mocks.paymentHidden = true;
		mocks.fetchBalance.mockResolvedValue({ credits: 200 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /webCredit.title/ });
		fireEvent.click(chip);
		expect(window.open).toHaveBeenCalledTimes(1);
		expect(window.open).toHaveBeenCalledWith(
			"https://naia.land/ko/usage",
			"_blank",
			"noopener",
		);
		expect(screen.queryByText("cost.labCharge")).toBeNull();
		expect(screen.getByText("webCredit.usage")).toBeInTheDocument();
	});

	it("opens usage from the chip at a low balance too", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 12 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /webCredit.title/ });
		expect(chip.className).toContain("web-credit__chip--low");
		fireEvent.click(chip);
		expect(window.open).toHaveBeenCalledTimes(1);
		expect(window.open).toHaveBeenCalledWith(
			"https://naia.land/ko/usage",
			"_blank",
			"noopener",
		);
	});

	it("opens usage, not billing, from the chip at zero balance", async () => {
		mocks.fetchBalance.mockResolvedValue({ credits: 0 });
		render(<WebCreditChip />);
		const chip = await screen.findByRole("button", { name: /0 Cr/ });
		fireEvent.click(chip);
		expect(window.open).toHaveBeenCalledTimes(1);
		expect(window.open).toHaveBeenCalledWith(
			"https://naia.land/ko/usage",
			"_blank",
			"noopener",
		);
		expect(window.open).not.toHaveBeenCalledWith(
			expect.stringContaining("/billing"),
			expect.anything(),
			expect.anything(),
		);
		// The zero-credit card with local-continue stays on screen.
		expect(await screen.findByRole("alert")).toBeInTheDocument();
	});
});
