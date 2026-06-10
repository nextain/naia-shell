import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

const API_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";

/**
 * 67 — Onboarding Config Save
 *
 * Verifies that userName, agentName, and webhook URLs entered during
 * onboarding are correctly persisted to localStorage config.
 *
 * Bug: userName showed "Tester" instead of user-entered value,
 * discordWebhookUrl was not passed to settings after onboarding.
 */
describe("67 — Onboarding Config Save", () => {
	const TEST_USER_NAME = "마스터";
	const TEST_AGENT_NAME = "낸-E2E";
	const TEST_DISCORD_WEBHOOK =
		"https://discord.com/api/webhooks/000000/fake-token";

	it("should clear config to trigger onboarding", async () => {
		await browser.execute(() => {
			localStorage.removeItem("naia-config");
		});
		await safeRefresh();

		const overlay = await $(S.onboardingOverlay);
		await overlay.waitForDisplayed({ timeout: 30_000 });
	});

	it("should select provider and enter API key", async () => {
		// Select first available (non-disabled) provider
		await browser.execute(() => {
			const provider = document.querySelector(
				".onboarding-provider-cards .onboarding-provider-card:not(.disabled)",
			) as HTMLButtonElement | null;
			provider?.click();
		});
		const nextBtn = await $(S.onboardingNextBtn);
		await nextBtn.waitForEnabled({ timeout: 10_000 });
		await nextBtn.click();

		// API key step
		const apiInput = await $(S.onboardingInput);
		await apiInput.waitForDisplayed({ timeout: 10_000 });
		await apiInput.setValue(API_KEY);
		await nextBtn.click();
	});

	it("should enter agent name and user name", async () => {
		// Agent name step
		const agentInput = await $(S.onboardingInput);
		await agentInput.waitForDisplayed({ timeout: 10_000 });

		// Use native setter to ensure React state updates
		await browser.execute(
			(sel: string, val: string) => {
				const el = document.querySelector(sel) as HTMLInputElement;
				if (el) {
					const setter = Object.getOwnPropertyDescriptor(
						HTMLInputElement.prototype,
						"value",
					)?.set;
					setter?.call(el, val);
					el.dispatchEvent(new Event("input", { bubbles: true }));
					el.dispatchEvent(new Event("change", { bubbles: true }));
				}
			},
			S.onboardingInput,
			TEST_AGENT_NAME,
		);
		await (await $(S.onboardingNextBtn)).click();

		// User name step
		const userInput = await $(S.onboardingInput);
		await userInput.waitForDisplayed({ timeout: 10_000 });
		await browser.execute(
			(sel: string, val: string) => {
				const el = document.querySelector(sel) as HTMLInputElement;
				if (el) {
					const setter = Object.getOwnPropertyDescriptor(
						HTMLInputElement.prototype,
						"value",
					)?.set;
					setter?.call(el, val);
					el.dispatchEvent(new Event("input", { bubbles: true }));
					el.dispatchEvent(new Event("change", { bubbles: true }));
				}
			},
			S.onboardingInput,
			TEST_USER_NAME,
		);
		await (await $(S.onboardingNextBtn)).click();
	});

	it("should select character and personality", async () => {
		// Character (VRM) step
		const vrmCard = await $(S.onboardingVrmCard);
		await vrmCard.waitForDisplayed({ timeout: 10_000 });
		await vrmCard.click();
		await (await $(S.onboardingNextBtn)).click();

		// Personality step
		const personalityCard = await $(S.onboardingPersonalityCard);
		await personalityCard.waitForDisplayed({ timeout: 10_000 });
		await personalityCard.click();
		await (await $(S.onboardingNextBtn)).click();

		// Speech style step — advance with defaults
		const speechStyleCard = await $(S.onboardingPersonalityCard);
		if (await speechStyleCard.isDisplayed()) {
			await (await $(S.onboardingNextBtn)).click();
		}
	});

	it("should enter discord webhook in webhooks step", async () => {
		// Webhooks step — enter Discord webhook URL
		const discordInput = await $("#discord-webhook");
		await discordInput.waitForDisplayed({ timeout: 10_000 });

		await browser.execute((val: string) => {
			const el = document.querySelector("#discord-webhook") as HTMLInputElement;
			if (el) {
				const setter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set;
				setter?.call(el, val);
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
			}
		}, TEST_DISCORD_WEBHOOK);

		await (await $(S.onboardingNextBtn)).click();
	});

	it("should complete onboarding and verify config is saved", async () => {
		// Now at "complete" step — click finish button
		const completeBtn = await $(S.onboardingNextBtn);
		await completeBtn.waitForEnabled({ timeout: 10_000 });
		await completeBtn.click();

		// Wait for overlay to disappear
		await browser.waitUntil(
			async () =>
				browser.execute(
					(sel: string) => !document.querySelector(sel),
					S.onboardingOverlay,
				),
			{
				timeout: 15_000,
				timeoutMsg: "Onboarding overlay did not disappear after complete",
			},
		);

		// Verify saved config
		const config = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			return raw ? JSON.parse(raw) : null;
		});

		expect(config).not.toBeNull();
		expect(config.onboardingComplete).toBe(true);
		expect(config.userName).toBe(TEST_USER_NAME);
		expect(config.agentName).toBe(TEST_AGENT_NAME);
		expect(config.discordWebhookUrl).toBe(TEST_DISCORD_WEBHOOK);
	});

	it("should restore config for remaining tests", async () => {
		const apiKey = process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY;
		const gatewayToken = process.env.CAFE_GATEWAY_TOKEN || "naia-dev-token";

		await browser.execute(
			(key: string, token: string) => {
				const raw = localStorage.getItem("naia-config");
				const config = raw ? JSON.parse(raw) : {};
				config.provider = "gemini";
				config.model = config.model || "gemini-2.5-flash";
				config.apiKey = key;
				config.gatewayUrl = "ws://localhost:18789";
				config.gatewayToken = token;
				config.onboardingComplete = true;
				config.enableTools = true;
				config.disabledSkills = [];
				localStorage.setItem("naia-config", JSON.stringify(config));
			},
			apiKey || "",
			gatewayToken,
		);
		await safeRefresh();

		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });
	});
});
