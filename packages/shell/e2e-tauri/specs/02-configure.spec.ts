import { S } from "../helpers/selectors.js";
import { configureSettings } from "../helpers/settings.js";

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
				vrmModel: "/avatars/01-Sendagaya-Shino-uniform.vrm",
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
					() => document.querySelectorAll(".chat-tabs .chat-tab").length >= 8,
				),
			{ timeout: 15_000, timeoutMsg: "Chat tabs did not render" },
		);
	});

	it("should switch to settings tab and configure", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLButtonElement | null;
			el?.click();
		}, S.settingsTabBtn);

		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 30_000 });

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
				"skill_skill_manager",
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
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLButtonElement | null;
			el?.click();
		}, S.settingsTabBtn);

		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 10_000 });

		const hasLabSection = await browser.execute(() => {
			const dividers = document.querySelectorAll(".settings-section-divider");
			return Array.from(dividers).some((d) =>
				/Naia|Lab|계정|Account/i.test(d.textContent ?? ""),
			);
		});
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
