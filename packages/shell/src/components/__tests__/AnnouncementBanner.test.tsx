// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Announcement } from "../../lib/announcements";
import { resetDistributionChannelForTests } from "../../lib/distribution";
import { AnnouncementBanner } from "../AnnouncementBanner";

const mockOpenUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (cmd: string, ...args: unknown[]) => mockInvoke(cmd, ...args),
}));

describe("AnnouncementBanner — Steam and Channel distribution guards (#727)", () => {
	const billingAnnouncement: Announcement = {
		id: "billing-1",
		date: "2026-10-01",
		type: "release",
		priority: "high",
		title: { ko: "새 요금제 안내", en: "New Billing Plan" },
		body: { ko: "충전 페이지로 이동합니다", en: "Visit the billing page" },
		url: "https://naia.land/ko/billing",
	};

	const maintenanceAnnouncement: Announcement = {
		id: "maint-1",
		date: "2026-10-02",
		type: "maintenance",
		priority: "normal",
		title: { ko: "점검 안내", en: "Maintenance Notice" },
		body: { ko: "정기 점검이 예정되어 있습니다", en: "Scheduled maintenance soon" },
	};

	beforeEach(() => {
		mockOpenUrl.mockClear();
		mockInvoke.mockReset();
		resetDistributionChannelForTests();
	});

	afterEach(() => {
		cleanup();
		resetDistributionChannelForTests();
	});

	it("hides announcements with URLs while channel lookup is pending (fail-closed initial state)", async () => {
		// Mock invoke to never resolve during this test to simulate in-flight/pending lookup
		mockInvoke.mockImplementation(() => new Promise(() => {}));

		render(
			<AnnouncementBanner
				announcements={[billingAnnouncement, maintenanceAnnouncement]}
				onDismissAll={vi.fn()}
				onDismissOne={vi.fn()}
			/>,
		);

		// The billing announcement with URL must NOT be shown
		expect(screen.queryByText(/새 요금제 안내|New Billing Plan/)).toBeNull();
		expect(screen.queryByText(/충전 페이지로 이동합니다|Visit the billing page/)).toBeNull();
		expect(screen.queryByRole("button", { name: /자세히 보기|Details/ })).toBeNull();

		// The subsequent announcement WITHOUT URL must be displayed
		expect(screen.getByText(/점검 안내|Maintenance Notice/)).toBeDefined();
		expect(screen.getByText(/정기 점검이 예정되어 있습니다|Scheduled maintenance soon/)).toBeDefined();

		// openUrl must not be called
		expect(mockOpenUrl).toHaveBeenCalledTimes(0);
	});

	it("hides announcements with URLs on IPC failure (unknown channel)", async () => {
		mockInvoke.mockRejectedValue(new Error("IPC failed"));

		render(
			<AnnouncementBanner
				announcements={[billingAnnouncement, maintenanceAnnouncement]}
				onDismissAll={vi.fn()}
				onDismissOne={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.queryByText(/새 요금제 안내|New Billing Plan/)).toBeNull();
		});

		expect(screen.getByText(/점검 안내|Maintenance Notice/)).toBeDefined();
		expect(screen.queryByRole("button", { name: /자세히 보기|Details/ })).toBeNull();
		expect(mockOpenUrl).toHaveBeenCalledTimes(0);
	});

	it("hides announcements with URLs on unexpected channel response", async () => {
		mockInvoke.mockResolvedValue("epic_games_store");

		render(
			<AnnouncementBanner
				announcements={[billingAnnouncement, maintenanceAnnouncement]}
				onDismissAll={vi.fn()}
				onDismissOne={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.queryByText(/새 요금제 안내|New Billing Plan/)).toBeNull();
		});

		expect(screen.getByText(/점검 안내|Maintenance Notice/)).toBeDefined();
		expect(screen.queryByRole("button", { name: /자세히 보기|Details/ })).toBeNull();
		expect(mockOpenUrl).toHaveBeenCalledTimes(0);
	});

	it("completely omits announcement body and button on Steam, and openUrl is called 0 times", async () => {
		mockInvoke.mockResolvedValue("steam");

		const { container } = render(
			<AnnouncementBanner
				announcements={[billingAnnouncement]}
				onDismissAll={vi.fn()}
				onDismissOne={vi.fn()}
			/>,
		);

		await waitFor(() => {
			// Entire banner should be null since only the URL announcement was in the list
			expect(container.firstChild).toBeNull();
		});

		expect(screen.queryByText(/새 요금제 안내|New Billing Plan/)).toBeNull();
		expect(screen.queryByText(/충전 페이지로 이동합니다|Visit the billing page/)).toBeNull();
		expect(screen.queryByRole("button", { name: /자세히 보기|Details/ })).toBeNull();
		expect(mockOpenUrl).toHaveBeenCalledTimes(0);
	});

	it("shows announcement with URL and link button on standard channel, opening URL on click", async () => {
		mockInvoke.mockResolvedValue("standard");

		render(
			<AnnouncementBanner
				announcements={[billingAnnouncement, maintenanceAnnouncement]}
				onDismissAll={vi.fn()}
				onDismissOne={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText(/새 요금제 안내|New Billing Plan/)).toBeDefined();
		});

		expect(screen.getByText(/충전 페이지로 이동합니다|Visit the billing page/)).toBeDefined();
		const linkBtn = screen.getByRole("button", { name: /자세히 보기|Details/ });
		expect(linkBtn).toBeDefined();

		fireEvent.click(linkBtn);
		expect(mockOpenUrl).toHaveBeenCalledTimes(1);
		expect(mockOpenUrl).toHaveBeenCalledWith("https://naia.land/ko/billing");
	});
});
