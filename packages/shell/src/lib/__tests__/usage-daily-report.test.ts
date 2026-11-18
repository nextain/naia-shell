import { describe, expect, it } from "vitest";
import {
	type DailyUsageEvent,
	type DailyUsageSource,
	calculateDailyUsageReport,
} from "../usage-daily-report";

const known = (
	source: string,
	events: readonly DailyUsageEvent[],
): DailyUsageSource => ({ status: "known", source, events });

function row(
	name: string,
	occurred_at: string,
	fields: Partial<DailyUsageEvent> = {},
): DailyUsageEvent {
	return { name, occurred_at, ...fields };
}

describe("daily usage report (T-07 synthetic rows)", () => {
	it("counts a retry with the same event_id and sequence once (T-06)", () => {
		const retry = row(
			"app-bar.open-app-store-5.click",
			"2026-11-18T10:00:00.000Z",
			{
				event_id: "same-retry-event-id",
				installation_id: "shell-install-a",
				sequence: 42,
			},
		);
		const report = calculateDailyUsageReport(
			"2026-11-18",
			"2026-11-19T01:00:00Z",
			{
				web: known("synthetic web rows", []),
				webgpu: known("synthetic webgpu rows", []),
				shell: known("synthetic shell retries", [retry, { ...retry }]),
			},
		);

		expect(report.shell.appStoreOpenClickCount).toBe(1);
	});

	it("uses the KST half-open day, deduplicates events, and keeps click layers separate", () => {
		const web = [
			row("login_view", "2026-11-18T14:59:59.000Z", {
				event_id: "web-view-edge",
			}),
			row("login_view", "2026-11-18T14:59:59.000Z", {
				event_id: "web-view-edge",
			}),
			row("login_view", "2026-11-18T09:00:00.000Z"),
			row("login_view", "2026-11-18T15:00:00.000Z", {
				event_id: "web-view-next-day",
			}),
			row("login_click", "2026-11-18T10:00:00.000Z", {
				event_id: "web-click-1",
			}),
			row("login_click", "2026-11-18T10:00:01.000Z"),
			row("login_oauth_done", "2026-11-18T10:01:00.000Z", {
				event_id: "web-done-1",
			}),
		];

		const webgpu = [
			row("webgpu_model_download_start", "2026-11-18T14:59:59.000Z", {
				event_id: "gpu-start",
			}),
			row("webgpu_model_download_start", "2026-11-18T14:59:59.000Z", {
				event_id: "gpu-start",
			}),
			row("webgpu_model_download_complete", "2026-11-18T10:00:00.000Z"),
			row("webgpu_model_download_fail", "2026-11-18T15:00:00.000Z"),
			row("webgpu_unsupported", "2026-11-18T09:30:00.000Z"),
			row("webgpu_first_reply", "2026-11-18T10:10:00.000Z", {
				event_id: "gpu-reply-1",
				elapsed_seconds: 1.2,
			}),
			row("webgpu_first_reply", "2026-11-18T10:10:00.000Z", {
				event_id: "gpu-reply-1",
				elapsed_seconds: 1.2,
			}),
			row("webgpu_first_reply", "2026-11-18T11:10:00.000Z", {
				installation_id: "gpu-install-2",
				sequence: 9,
				elapsed_seconds: 3.8,
			}),
			row("webgpu_first_reply", "2026-11-18T15:00:00.000Z", {
				event_id: "gpu-reply-next-day",
				elapsed_seconds: 99,
			}),
			row("webgpu_model_ready", "2026-11-18T10:00:00.000Z"),
		];

		const shell = [
			row("shell.launch.start", "2026-11-18T09:00:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "shell-a-launch",
				sequence: 1,
			}),
			row("shell.launch.start", "2026-11-18T09:00:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "shell-a-launch",
				sequence: 1,
			}),
			row("shell.launch.start", "2026-11-18T09:00:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "shell-a-launch-other-id",
				sequence: 1,
			}),
			row("shell.launch.start", "2026-11-18T14:59:59.000Z", {
				installation_id: "shell-install-b",
				event_id: "shell-b-launch",
				sequence: 1,
			}),
			row("shell.launch.start", "2026-11-18T15:00:00.000Z", {
				installation_id: "shell-install-c",
				event_id: "shell-c-next-day",
				sequence: 1,
			}),
			row("intro.screen.view", "2026-11-18T09:01:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "intro-a-welcome",
				sequence: 2,
				screen: "welcome",
			}),
			row("intro.screen.view", "2026-11-18T09:01:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "intro-a-welcome",
				sequence: 2,
				screen: "welcome",
			}),
			row("intro.screen.view", "2026-11-18T09:02:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "intro-a-agent-name",
				sequence: 3,
				screen: "agentName",
			}),
			row("intro.screen.view", "2026-11-18T14:59:00.000Z", {
				installation_id: "shell-install-b",
				event_id: "intro-b-welcome",
				sequence: 2,
				screen: "welcome",
			}),
			row("login.credentials.saved", "2026-11-18T09:05:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "login-saved-a",
				sequence: 4,
			}),
			row("chat.reply.first", "2026-11-18T09:10:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "shell-a-first-reply",
				sequence: 5,
			}),
			row("chat.reply.first", "2026-11-18T14:58:00.000Z", {
				installation_id: "shell-install-b",
				event_id: "shell-b-first-reply",
				sequence: 3,
			}),
			row("app-bar.open-app-store-5.click", "2026-11-18T09:20:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "store-open-a-1",
				sequence: 6,
			}),
			row("app-bar.open-app-store-5.click", "2026-11-18T09:21:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "store-open-a-2",
				sequence: 7,
			}),
			row("home.shortcut.click", "2026-11-18T09:22:00.000Z", {
				installation_id: "shell-install-a",
				event_id: "semantic-store-entry",
				sequence: 8,
			}),
			row("login.attempt.fail", "2026-11-18T09:30:00.000Z", {
				installation_id: "shell-install-b",
				event_id: "login-failed-b",
				sequence: 4,
			}),
		];

		const report = calculateDailyUsageReport(
			"2026-11-18",
			"2026-11-19T01:00:00Z",
			{
				web: known("synthetic web rows", web),
				webgpu: known("synthetic webgpu rows", webgpu),
				shell: known("synthetic shell rows", shell),
			},
		);

		expect(report.timezone).toBe("Asia/Seoul");
		expect(report.interval).toEqual({
			startInclusive: "2026-11-18T00:00:00+09:00",
			endExclusive: "2026-11-19T00:00:00+09:00",
		});
		expect(report.web).toMatchObject({
			status: "확인",
			loginViewCount: 2,
			loginClickCount: 2,
			loginOauthDoneCount: 1,
			loginSuccessRate: {
				numerator: 1,
				denominator: 2,
				value: 0.5,
				status: "확인",
			},
		});
		expect(report.webgpu).toMatchObject({
			status: "확인",
			modelDownloadStartCount: 1,
			modelDownloadCompleteCount: 1,
			modelDownloadFailCount: 0,
			unsupportedCount: 1,
			firstReplyCount: 2,
			firstReplyMedianSeconds: 2.5,
			firstReplyMedianStatus: "확인",
		});
		expect(report.shell).toEqual({
			source: "synthetic shell rows",
			status: "확인",
			dailyActiveInstallations: 2,
			firstIntroEntryInstallations: 2,
			loginCredentialsSavedCount: 1,
			firstReplyInstallations: 2,
			appStoreOpenClickCount: 2,
			loginAttemptFailCount: 1,
		});
		expect(report.sampleNote).toContain("동의한 통계 표본만 포함");
		expect(report.sampleNote).toContain("다운로드와 설치를 연결하지 않음");
	});

	it("shows zero, no denominator, and unknown as different states", () => {
		const report = calculateDailyUsageReport(
			"2026-11-18",
			"2026-11-19T01:00:00Z",
			{
				web: known("synthetic empty web rows", []),
				webgpu: known("synthetic empty webgpu rows", []),
				shell: { status: "unknown", source: "not verified" },
			},
		);

		expect(report.web.loginViewCount).toBe(0);
		expect(report.web.loginClickCount).toBe(0);
		expect(report.web.loginOauthDoneCount).toBe(0);
		expect(report.web.loginSuccessRate).toEqual({
			numerator: 0,
			denominator: 0,
			value: null,
			status: "분모 없음",
		});
		expect(report.web.status).toBe("확인");
		expect(report.webgpu.modelDownloadStartCount).toBe(0);
		expect(report.webgpu.status).toBe("확인");
		expect(report.webgpu.firstReplyCount).toBe(0);
		expect(report.webgpu.firstReplyMedianSeconds).toBeNull();
		expect(report.webgpu.firstReplyMedianStatus).toBe("분모 없음");
		expect(report.shell).toEqual({
			source: "not verified",
			status: "미확인",
			dailyActiveInstallations: null,
			firstIntroEntryInstallations: null,
			loginCredentialsSavedCount: null,
			firstReplyInstallations: null,
			appStoreOpenClickCount: null,
			loginAttemptFailCount: null,
		});
	});

	it("marks an unmeasured median as unknown and rejects invalid dates", () => {
		const report = calculateDailyUsageReport(
			"2026-11-18",
			"2026-11-19T01:00:00Z",
			{
				web: known("web", []),
				webgpu: known("webgpu", [
					row("webgpu_first_reply", "2026-11-18T10:00:00Z", {
						event_id: "reply-without-time",
					}),
				]),
				shell: known("shell", []),
			},
		);
		expect(report.webgpu.firstReplyCount).toBe(1);
		expect(report.webgpu.firstReplyMedianSeconds).toBeNull();
		expect(report.webgpu.firstReplyMedianStatus).toBe("미확인");
		expect(() =>
			calculateDailyUsageReport("2026-02-30", "2026-11-19T01:00:00Z", {
				web: known("web", []),
				webgpu: known("webgpu", []),
				shell: known("shell", []),
			}),
		).toThrow(RangeError);
	});
});
