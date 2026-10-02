// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, ...args: unknown[]) => {
		if (cmd === "frontend_log") return Promise.resolve();
		if (cmd === "secure_store_get") return Promise.resolve(null);
		if (cmd === "read_naia_ui_config") return Promise.resolve("{}");
		return invokeMock(cmd, ...args);
	}),
	convertFileSrc: vi.fn((path: string) => `file://${path}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(),
}));

vi.mock("../../lib/distribution", () => ({
	useIsSteamChannel: () => true,
	isSteamChannelNow: () => true,
	usePaymentLinksHidden: () => true,
	paymentLinksHiddenNow: () => true,
	loadDistributionChannel: async () => "steam",
}));

const mockPerformSteamLogin = vi.fn();
vi.mock("../../lib/steam-auth", () => ({
	performSteamLogin: (...args: unknown[]) => mockPerformSteamLogin(...args),
}));

vi.mock("../../lib/config", () => ({
	loadConfig: () => ({}),
	saveConfig: vi.fn(),
	getAdkPath: () => "/home/user/naia-adk",
	getNaiaWebBaseUrl: () => "https://www.naia.test",
	LAB_GATEWAY_URL: "https://api.naia.test",
	hasNaiaKeySecure: async () => false,
	getNaiaKeySecure: async () => null,
	detectGpuVramGb: async () => 8,
}));

vi.mock("../../lib/secure-store", () => ({
	getSecureStorePath: () => "/home/user/.secure-store",
	hasSecretKeyAtPath: async () => false,
	saveSecretKeyAtPath: vi.fn(),
	deleteSecretKey: vi.fn(),
}));

vi.mock("../../lib/adk-store", () => ({
	getAdkPath: () => "/home/user/naia-adk",
	listNaiaAssets: vi.fn().mockResolvedValue([]),
	toAssetUrl: vi.fn(),
	toLocalBlobUrl: vi.fn(),
	writeNaiaConfig: vi.fn(),
	writeNaiaConfigAtPath: vi.fn(),
	writeAgentKeyStrictAtPath: vi.fn(),
	writeSlotsManifest: vi.fn(),
	buildNaiaConfigEnv: vi.fn(),
}));

vi.mock("../../lib/chat-service", () => ({
	activateNaiaLlm: vi.fn().mockResolvedValue({
		available: true,
		loaded: true,
		provider: "nextain",
		model: "deepseek-v4-flash",
		llm: "naia",
	}),
	sendAuthUpdate: vi.fn().mockResolvedValue(undefined),
	sendAuthUpdateStrict: vi.fn().mockResolvedValue(undefined),
	reloadAgentSettings: vi.fn().mockResolvedValue(undefined),
	isNewCore: () => false,
}));

vi.mock("../VrmPreview", () => ({
	VrmPreview: ({ modelPath }: { modelPath: string }) => (
		<div data-testid="vrm-preview" data-model={modelPath} />
	),
}));

import { OnboardingWizard } from "../OnboardingWizard";
import { setLocale } from "../../lib/i18n";

describe("OnboardingWizard on Steam edition (#729)", () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		document.body.innerHTML = "";
		await setLocale("ko");
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.runAllTimers();
		vi.useRealTimers();
		cleanup();
		document.body.innerHTML = "";
	});

	function flush() {
		act(() => {
			vi.advanceTimersByTime(400);
		});
	}

	function advanceToProvider() {
		// welcome -> agentName
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// agentName -> userName
		fireEvent.change(screen.getByPlaceholderText("Naia"), {
			target: { value: "Mochi" },
		});
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// userName -> speechStyle
		fireEvent.change(
			screen.getByPlaceholderText(/Enter a name|이름을 입력하세요/),
			{
				target: { value: "Alex" },
			},
		);
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// speechStyle -> character
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// character -> background
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();

		// background -> provider
		fireEvent.click(screen.getByRole("button", { name: /다음|Next/ }));
		flush();
	}

	it("shows 'Steam으로 계속하기' as primary and '기존 계정 연결' as secondary in provider step", () => {
		render(<OnboardingWizard onComplete={vi.fn()} />);
		advanceToProvider();

		// Now in provider / connect step
		expect(screen.getByText("Steam으로 계속하기")).toBeDefined();
		expect(screen.getByText("기존 계정 연결")).toBeDefined();
	});

	it("triggers performSteamLogin when clicking Steam button", async () => {
		mockPerformSteamLogin.mockResolvedValueOnce({
			user_id: "user-steam-1",
			is_new_user: false,
			api_key: "gw-steamkey123",
		});

		render(<OnboardingWizard onComplete={vi.fn()} />);
		advanceToProvider();

		const steamBtn = screen.getByText("Steam으로 계속하기");
		expect(steamBtn).toBeDefined();

		await act(async () => {
			fireEvent.click(steamBtn);
		});

		expect(mockPerformSteamLogin).toHaveBeenCalledWith(
			expect.objectContaining({
				boundary: expect.objectContaining({
					adkPath: "/home/user/naia-adk",
					secureStorePath: "/home/user/.secure-store",
				}),
			}),
		);
	});

	it("shows consent dialog when onConsentRequired is invoked", async () => {
		let consentCallback: (() => Promise<boolean>) | undefined;
		mockPerformSteamLogin.mockImplementationOnce(async (options) => {
			consentCallback = options.onConsentRequired;
			// simulate triggering the callback
			const consentPromise = consentCallback!();
			// Wait for UI to update with consent dialog
			return consentPromise.then((agreed) => {
				if (!agreed) throw new Error("Consent declined");
				return {
					user_id: "user-steam-new",
					is_new_user: true,
					api_key: "gw-newkey123",
				};
			});
		});

		render(<OnboardingWizard onComplete={vi.fn()} />);
		advanceToProvider();

		await act(async () => {
			fireEvent.click(screen.getByText("Steam으로 계속하기"));
		});

		// Consent dialog should now be visible
		expect(screen.getByText("서비스 이용 동의")).toBeDefined();
		expect(screen.getByText("동의하고 계속하기")).toBeDefined();

		// Click consent agree
		await act(async () => {
			fireEvent.click(screen.getByText("동의하고 계속하기"));
		});
	});
});
