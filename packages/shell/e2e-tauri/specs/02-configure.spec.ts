import { S } from "../helpers/selectors.js";
import {
	configureSettings,
	navigateToSettings,
	openSettingsSection,
} from "../helpers/settings.js";

const API_KEY = process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY;
if (!API_KEY) {
	throw new Error(
		"API key required: set CAFE_E2E_API_KEY or GEMINI_API_KEY (shell/.env)",
	);
}

const GATEWAY_TOKEN =
	process.env.CAFE_GATEWAY_TOKEN ||
	process.env.GATEWAY_MASTER_KEY ||
	"naia-dev-token";

describe("02 — Configure Settings", () => {
	before(async () => {
		// Bypass onboarding
		await browser.execute((key: string) => {
			const config = {
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: key,
				agentName: "Naia",
				userName: "Tester",
				vrmModel: "/avatars/01-OL_Woman.vrm",
				persona: "Friendly AI companion",
				enableTools: true,
				locale: "ko",
				onboardingComplete: true,
			};
			localStorage.setItem("naia-config", JSON.stringify(config));
		}, API_KEY);
		await browser.refresh();

		// Wait for app to load
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 15_000 });
		await browser.waitUntil(
			async () =>
				browser.execute(
					(sel: string) => !document.querySelector(sel),
					S.onboardingOverlay,
				),
			{
				timeout: 15_000,
				timeoutMsg: "Onboarding still visible in configure spec",
			},
		);
		await browser.waitUntil(
			async () =>
				browser.execute(
					// #541: 탭은 대화·기록·채널 셋뿐이다. 설정 계열은 앱 전환으로 연다.
					() => document.querySelectorAll(".chat-tabs .chat-tab").length >= 3,
				),
			{ timeout: 15_000, timeoutMsg: "Chat tabs did not render" },
		);
	});

	it("should switch to settings tab and configure", async () => {
		// #541: 설정은 앱 전환 + 내부 섹션 탭 구조. 프로바이더·키·도구는 brain 섹션.
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 30_000 });
		await openSettingsSection("brain");

		await configureSettings({
			provider: "gemini",
			apiKey: API_KEY,
			gatewayUrl: "ws://localhost:18789",
			gatewayToken: GATEWAY_TOKEN,
		});
	});

	it("should pre-approve skill tools for E2E", async () => {
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			if (!raw) return;
			const config = JSON.parse(raw);
			config.allowedTools = [
				"skill_time",
				"skill_system_status",
				"skill_memo",
				"skill_weather",
				"execute_command",
				"write_file",
				"read_file",
				"search_files",
				"sessions_spawn",
			];
			localStorage.setItem("naia-config", JSON.stringify(config));
		});
	});

	it("should show Lab section in settings", async () => {
		// #541: Naia 계정(Lab) UI 는 profile 섹션의 로그인/계정 필드로 옮겨졌다.
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });
		await openSettingsSection("profile");

		const hasLabSection = await browser.execute(
			() =>
				document.querySelector(
					'[data-testid="profile-naia-login"], [data-testid="profile-naia-account"]',
				) !== null,
		);
		expect(hasLabSection).toBe(true);
	});

	it("should enable chat input after settings saved", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLButtonElement | null;
			el?.click();
		}, S.chatTab);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});
});
