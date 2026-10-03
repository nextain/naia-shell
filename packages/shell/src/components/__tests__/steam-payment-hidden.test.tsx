// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Announcement } from "../../lib/announcements";

// Mock distribution as Steam build
vi.mock("../../lib/distribution", () => ({
	IS_STEAM_BUILD: true,
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

describe("Steam build payment hiding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("hides announcements with payment URLs completely (no body, no button, no openUrl)", () => {
		const paymentAnnouncement: Announcement = {
			id: "promo-1",
			date: "2026-10-03",
			type: "info",
			priority: "high",
			title: { ko: "크레딧 충전 프로모션" },
			body: { ko: "지금 결제하고 보너스 크레딧을 받으세요!" },
			url: "https://naia.land/ko/billing?promo=bonus",
		};

		const { container } = render(
			<AnnouncementBanner
				announcements={[paymentAnnouncement]}
				onDismissAll={() => {}}
				onDismissOne={() => {}}
			/>,
		);

		// Container must be empty since the only announcement has a URL
		expect(container.firstChild).toBeNull();
		expect(screen.queryByText("크레딧 충전 프로모션")).toBeNull();
		expect(screen.queryByText("지금 결제하고 보너스 크레딧을 받으세요!")).toBeNull();
		expect(mockOpenUrl).not.toHaveBeenCalled();
	});

	it("hides arbitrary external payment URLs in announcements", () => {
		const externalCheckoutAnnouncement: Announcement = {
			id: "checkout-1",
			date: "2026-10-03",
			type: "warning",
			priority: "high",
			title: { ko: "외부 결제 안내" },
			body: { ko: "결제 페이지로 이동합니다." },
			url: "https://checkout.stripe.com/pay/cs_live_12345",
		};

		const { container } = render(
			<AnnouncementBanner
				announcements={[externalCheckoutAnnouncement]}
				onDismissAll={() => {}}
				onDismissOne={() => {}}
			/>,
		);

		expect(container.firstChild).toBeNull();
		expect(screen.queryByText("외부 결제 안내")).toBeNull();
		expect(mockOpenUrl).not.toHaveBeenCalled();
	});

	it("preserves announcements without URLs in Steam build", () => {
		const plainAnnouncement: Announcement = {
			id: "info-1",
			date: "2026-10-03",
			type: "info",
			priority: "normal",
			title: { ko: "서버 점검 완료 안내" },
			body: { ko: "서버 점검이 정상 완료되었습니다." },
			url: "",
		};

		render(
			<AnnouncementBanner
				announcements={[plainAnnouncement]}
				onDismissAll={() => {}}
				onDismissOne={() => {}}
			/>,
		);

		expect(screen.getByText("서버 점검 완료 안내")).toBeInTheDocument();
		expect(screen.getByText("서버 점검이 정상 완료되었습니다.")).toBeInTheDocument();
	});

	it("hides top-up button in CostDashboard under Steam build", async () => {
		render(<CostDashboard messages={[]} />);
		await new Promise((r) => setTimeout(r, 50));
		expect(screen.queryByText("크레딧 충전")).toBeNull();
	});

	it("hides GitHub Sponsors link in SettingsTab AboutSection under Steam build", () => {
		render(<AboutSection />);
		expect(screen.queryByText("스폰서")).toBeNull();
		expect(screen.getByText("디스코드")).toBeInTheDocument();
	});

	it("uses NoTopup wording in chat-voice-utils under Steam build", () => {
		const failMsg = voiceFailureMessage(
			{ phase: "error", reason: "credits", message: "out of credits" },
			new Error("out of credits"),
		);
		expect(failMsg).toBe("크레딧이 부족해요.");
		expect(failMsg).not.toContain("충전");

		const closeMsg = voiceCloseMessage("credits");
		expect(closeMsg).toBe("크레딧이 부족해요.");
		expect(closeMsg).not.toContain("충전");
	});
});
