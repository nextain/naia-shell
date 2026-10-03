// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
			"onboard.welcome.discordBtn": "디스코드",
			"onboard.welcome.donationBtn": "후원하기",
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
import { AboutSection } from "../SettingsTab";
import { voiceCloseMessage, voiceFailureMessage } from "../chat-voice-utils";

describe("Standard build payment links visibility", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
});
