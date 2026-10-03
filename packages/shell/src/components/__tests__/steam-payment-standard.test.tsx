// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Announcement } from "../../lib/announcements";

// Mock distribution as Standard build (IS_STEAM_BUILD: false)
vi.mock("../../lib/distribution", () => ({
	IS_STEAM_BUILD: false,
}));

const mockOpenUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
	emit: vi.fn().mockResolvedValue(undefined),
}));

// Mock config
vi.mock("../../lib/config", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		NAIA_WEB_BASE_URL: "https://naia.land",
		LAB_GATEWAY_URL: "https://api.naia.land",
		loadConfig: () => ({
			ttsProvider: "nextain",
			voice: "female",
		}),
		saveConfig: vi.fn(),
		hasNaiaKeySecure: () => Promise.resolve(true),
		getNaiaKeySecure: () => Promise.resolve("mock-key"),
	};
});

vi.mock("../../lib/naia-instance-urls", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		naiaWebUrl: (path: string, base?: string) => `${base ?? "https://naia.land"}/${path}`,
	};
});

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(true),
	convertFileSrc: (path: string) => `file://${path}`,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
	load: vi.fn().mockResolvedValue({
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	}),
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

vi.mock("../../lib/llm/logged-out-default", () => ({
	resolveLoggedOutLlm: vi.fn(async () => ({ provider: "", model: "" })),
}));

vi.mock("../../lib/voice/host-profile", () => ({
	voiceHostProfile: () =>
		Promise.resolve({
			profile: "windows_trt_6g",
			gpus: [{ index: 0, freeMib: 8192, totalMib: 8192 }],
			gpuChoiceIsMeaningful: false,
			defaultGpuIndex: 0,
		}),
	resetVoiceHostProfileCache: () => {},
}));

vi.mock("../../lib/naia-settings", () => ({
	listNaiaAssets: vi.fn().mockResolvedValue([]),
	toAssetUrl: (p: string) => p,
	toLocalBlobUrl: vi.fn().mockResolvedValue("blob:test"),
	getBackgroundMediaType: () => "image",
	DEFAULT_BG_VIDEO: "dawn-city",
	DEFAULT_AVATAR: "default",
}));

const STEAM_ALPHA_DESC =
	"현재 알파 테스트 단계로, 많은 기능이 구현 중이거나 안정화되어 있지 않아 예기치 않은 오류가 발생할 수 있습니다. 버그 리포트, 번역, 기능 제안, 코드 기여 등 다양한 방식으로 함께해 주세요.";
const STEAM_ABOUT_DESC2 =
	"현재 알파 테스트 단계로, 많은 기능이 구현 중이거나 안정화되어 있지 않아 예기치 않은 오류가 발생할 수 있습니다. 버그 리포트, 번역, 기능 제안, 코드 기여 등 다양한 방식으로 함께해 주세요.";
const STANDARD_ALPHA_DESC =
	"현재 알파 테스트 단계로, 많은 기능이 구현 중이거나 안정화되어 있지 않아 예기치 않은 오류가 발생할 수 있습니다. 버그 리포트, 번역, 기능 제안, 코드 기여, 후원 등 다양한 방식으로 함께해 주세요.";
const STANDARD_ABOUT_DESC2 =
	"현재 알파 테스트 단계로, 많은 기능이 구현 중이거나 안정화되어 있지 않아 예기치 않은 오류가 발생할 수 있습니다. 버그 리포트, 번역, 기능 제안, 코드 기여, 후원 등 다양한 방식으로 함께해 주세요.";

vi.mock("../../lib/i18n", () => ({
	getLocale: () => "ko",
	t: (key: string) => {
		const dict: Record<string, string> = {
			"announcement.details": "자세히 보기",
			"announcement.dismiss": "닫기",
			"cost.labBalance": "Naia 잔액",
			"cost.labCredits": "크레딧",
			"cost.labCharge": "크레딧 충전",
			"cost.empty": "기록 없음",
			"cost.title": "비용 요약",
			"onboard.welcome.opensourceDesc": "오픈소스 AI 데스크톱 셸 Naia에 오신 것을 환영합니다.",
			"onboard.welcome.alphaDesc": STANDARD_ALPHA_DESC,
			"onboard.welcome.alphaDescSteam": STEAM_ALPHA_DESC,
			"onboard.welcome.githubBtn": "GitHub",
			"onboard.welcome.discordBtn": "디스코드",
			"onboard.welcome.donationBtn": "후원하기",
			"about.desc1": "Naia Shell",
			"about.desc2": STANDARD_ABOUT_DESC2,
			"about.desc2Steam": STEAM_ABOUT_DESC2,
			"about.linkGithub": "GitHub",
			"about.linkDiscord": "디스코드",
			"about.linkSponsor": "스폰서",
			"appbar.appStore": "앱 스토어",
			"appbar.appStoreDesc": "앱 둘러보기",
			"chat.voiceErrorCredits": "크레딧이 부족해요 — 충전 후 다시 시도해주세요.",
			"chat.voiceErrorCreditsNoTopup": "크레딧이 부족해요.",
			"chat.voiceSubscriptionRequired": "유료 구독이 필요합니다 (BASIC 이상) — https://naia.land/ko/billing",
			"chat.voiceSubscriptionRequiredNoLink": "유료 구독이 필요합니다 (BASIC 이상).",
			"voice.ref.errCreditInsufficient": "크레딧 잔액이 부족합니다 — 설정에서 충전해주세요.",
			"voice.ref.errCreditInsufficientNoTopup": "크레딧 잔액이 부족합니다.",
		};
		return dict[key] ?? key;
	},
}));

vi.mock("../../lib/lab-balance", () => ({
	readCachedLabCredits: () => ({ value: 100 }),
	fetchLabBalancePayload: vi.fn(),
	isLabBalanceUnauthorized: () => false,
	markNaiaKeyUnauthorized: vi.fn(),
	onNaiaKeyUnauthorized: () => () => {},
	parseLabCredits: () => 100,
	primeLabCredits: vi.fn(),
	clearCachedLabCredits: vi.fn(),
}));

import { AnnouncementBanner } from "../AnnouncementBanner";
import { CostDashboard } from "../CostDashboard";
import { OnboardingWizard } from "../OnboardingWizard";
import { AboutSection } from "../SettingsTab";
import { voiceCloseMessage, voiceFailureMessage } from "../chat-voice-utils";

describe("Standard build payment links visibility", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it("shows announcements with URLs and invokes openUrl on click in standard build", () => {
		const paymentAnnouncement: Announcement = {
			id: "promo-1",
			date: "2026-10-03",
			type: "info",
			priority: "high",
			title: { ko: "크레딧 충전 프로모션" },
			body: { ko: "지금 결제하고 보너스 크레딧을 받으세요!" },
			url: "https://naia.land/ko/billing?promo=bonus",
		};

		render(
			<AnnouncementBanner
				announcements={[paymentAnnouncement]}
				onDismissAll={() => {}}
				onDismissOne={() => {}}
			/>,
		);

		expect(screen.getByText("크레딧 충전 프로모션")).toBeInTheDocument();
		expect(screen.getByText("지금 결제하고 보너스 크레딧을 받으세요!")).toBeInTheDocument();

		const linkBtn = screen.getByRole("button", { name: "자세히 보기" });
		fireEvent.click(linkBtn);
		expect(mockOpenUrl).toHaveBeenCalledWith("https://naia.land/ko/billing?promo=bonus");
	});

	it("shows top-up button in CostDashboard and calls openUrl when clicked", async () => {
		render(<CostDashboard messages={[]} />);
		const chargeBtn = await screen.findByRole("button", { name: "크레딧 충전" });
		expect(chargeBtn).toBeInTheDocument();

		fireEvent.click(chargeBtn);
		expect(mockOpenUrl).toHaveBeenCalledWith("https://naia.land/ko/billing");
	});

	it("shows GitHub Sponsors link in SettingsTab AboutSection and calls openUrl when clicked", async () => {
		render(<AboutSection />);
		const sponsorLink = screen.getByRole("link", { name: "스폰서" });
		expect(sponsorLink).toBeInTheDocument();

		fireEvent.click(sponsorLink);
		await new Promise((r) => setTimeout(r, 50));
		expect(mockOpenUrl).toHaveBeenCalledWith("https://github.com/sponsors/nextain");
	});

	it("uses standard top-up wording in chat-voice-utils under standard build", () => {
		const failMsg = voiceFailureMessage(
			{ phase: "error", reason: "credits", message: "out of credits" },
			new Error("out of credits"),
		);
		expect(failMsg).toBe("크레딧이 부족해요 — 충전 후 다시 시도해주세요.");

		const closeMsg = voiceCloseMessage("credits");
		expect(closeMsg).toBe("크레딧이 부족해요 — 충전 후 다시 시도해주세요.");
	});

	it("renders OnboardingWizard welcome screen with standard wording containing donation request", () => {
		render(<OnboardingWizard onComplete={() => {}} />);
		const desc = screen.getByText(STANDARD_ALPHA_DESC);
		expect(desc).toBeInTheDocument();
		expect(desc.textContent).toContain("후원");
	});

	it("renders AboutSection with standard wording containing sponsorship request", () => {
		render(<AboutSection />);
		const desc = screen.getByText(STANDARD_ABOUT_DESC2);
		expect(desc).toBeInTheDocument();
		expect(desc.textContent).toContain("후원");
	});
});
