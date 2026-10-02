// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, ...args: unknown[]) => {
		if (cmd === "frontend_log") return Promise.resolve();
		return invokeMock(cmd, ...args);
	}),
}));

const mockAuthHandlers = new Set<(event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
		if (eventName === "steam_microtxn_authorization") {
			mockAuthHandlers.add(handler);
		}
		return () => {
			mockAuthHandlers.delete(handler);
		};
	}),
}));

vi.mock("../../lib/config", () => ({
	LAB_GATEWAY_URL: "https://api.naia.test",
	getNaiaKeySecure: vi.fn(async () => "gw-testkey123"),
}));

const mockFetchSteamPacks = vi.fn();
const mockCreateSteamOrder = vi.fn();
const mockFinalizeSteamOrder = vi.fn();
const mockListenToSteamAuthorization = vi.fn();
const mockOpenSteamUrl = vi.fn(async (_url?: string) => {});

vi.mock("../../lib/steam-billing", () => ({
	fetchSteamPacks: (...args: any[]) => mockFetchSteamPacks(...args),
	createSteamOrder: (...args: any[]) => mockCreateSteamOrder(...args),
	finalizeSteamOrder: (...args: any[]) => mockFinalizeSteamOrder(...args),
	listenToSteamAuthorization: (...args: any[]) => mockListenToSteamAuthorization(...args),
	openSteamUrl: (url: string) => mockOpenSteamUrl(url),
}));

import { SteamPurchaseModal } from "../SteamPurchaseModal";
import { setLocale } from "../../lib/i18n";

describe("SteamPurchaseModal component (#729)", () => {
	const defaultPacks = [
		{ id: "pack-100", price_cents: 999, currency: "USD", credits: 1000 },
		{ id: "pack-250", price_cents: 1999, currency: "USD", credits: 2500 },
	];

	beforeEach(async () => {
		document.body.innerHTML = "";
		await setLocale("ko");
		vi.clearAllMocks();
		mockAuthHandlers.clear();
		mockFetchSteamPacks.mockResolvedValue(defaultPacks);
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = "";
	});

	it("renders nothing when isOpen is false", () => {
		const { container } = render(
			<SteamPurchaseModal isOpen={false} onClose={vi.fn()} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders modal and loads packs when isOpen is true", async () => {
		render(<SteamPurchaseModal isOpen={true} onClose={vi.fn()} />);

		expect(screen.getByRole("dialog")).toBeDefined();
		await waitFor(() => {
			expect(mockFetchSteamPacks).toHaveBeenCalled();
			expect(screen.getByText("1000 크레딧")).toBeDefined();
			expect(screen.getByText("2500 크레딧")).toBeDefined();
		});
	});

	it("allows selecting a pack and starting client purchase flow", async () => {
		let authCallbacks: { onAuthorized: () => void; onCancelled: () => void } | undefined;
		mockCreateSteamOrder.mockResolvedValueOnce({
			order_id: "order-12345",
			status: "INITIATED",
			flow: "client",
			steamurl: null,
			pack: defaultPacks[1],
		});
		mockListenToSteamAuthorization.mockImplementationOnce(async (_orderId, cbs) => {
			authCallbacks = cbs;
			return () => {};
		});
		mockFinalizeSteamOrder.mockResolvedValueOnce({
			status: "GRANTED",
			granted_now: true,
		});

		const onPurchaseSuccess = vi.fn();
		render(
			<SteamPurchaseModal
				isOpen={true}
				onClose={vi.fn()}
				onPurchaseSuccess={onPurchaseSuccess}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("2500 크레딧")).toBeDefined();
		});

		// Select the second pack
		fireEvent.click(screen.getByText("2500 크레딧"));

		// Click purchase button
		const buyBtn = screen.getByText("구매하기");
		fireEvent.click(buyBtn);

		await waitFor(() => {
			expect(mockCreateSteamOrder).toHaveBeenCalledWith(
				"gw-testkey123",
				"pack-250",
				expect.objectContaining({ gatewayUrl: undefined }),
			);
			expect(mockListenToSteamAuthorization).toHaveBeenCalledWith(
				"order-12345",
				expect.anything(),
			);
			expect(screen.getByText("Steam 오버레이에서 결제를 승인해주세요.")).toBeDefined();
		});

		// Simulate authorization callback from Steam
		authCallbacks?.onAuthorized();

		await waitFor(() => {
			expect(mockFinalizeSteamOrder).toHaveBeenCalledWith(
				"gw-testkey123",
				"order-12345",
				expect.anything(),
			);
			expect(onPurchaseSuccess).toHaveBeenCalled();
			expect(screen.getByText("크레딧 충전이 완료되었습니다!")).toBeDefined();
		});
	});

	it("handles web flow with external link and manual finalize button", async () => {
		mockCreateSteamOrder.mockResolvedValueOnce({
			order_id: "order-web-999",
			status: "INITIATED",
			flow: "web",
			steamurl: "https://store.steampowered.com/checkout/order-web-999",
			pack: defaultPacks[0],
		});
		mockFinalizeSteamOrder.mockResolvedValueOnce({
			status: "GRANTED",
			granted_now: true,
		});

		render(<SteamPurchaseModal isOpen={true} onClose={vi.fn()} />);

		await waitFor(() => {
			expect(screen.getByText("1000 크레딧")).toBeDefined();
		});

		fireEvent.click(screen.getByText("구매하기"));

		await waitFor(() => {
			expect(mockOpenSteamUrl).toHaveBeenCalledWith(
				"https://store.steampowered.com/checkout/order-web-999",
			);
			expect(screen.getByText("결제를 완료했어요")).toBeDefined();
		});

		// Click manual finalize button
		fireEvent.click(screen.getByText("결제를 완료했어요"));

		await waitFor(() => {
			expect(mockFinalizeSteamOrder).toHaveBeenCalledWith(
				"gw-testkey123",
				"order-web-999",
				expect.anything(),
			);
			expect(screen.getByText("크레딧 충전이 완료되었습니다!")).toBeDefined();
		});
	});

	it("closes on cancel or close button click", async () => {
		const onClose = vi.fn();
		render(<SteamPurchaseModal isOpen={true} onClose={onClose} />);

		await waitFor(() => {
			expect(screen.getByText("취소")).toBeDefined();
		});

		fireEvent.click(screen.getByText("취소"));
		expect(onClose).toHaveBeenCalled();
	});
});
