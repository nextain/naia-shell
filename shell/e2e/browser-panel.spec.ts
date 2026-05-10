import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

const API_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";
if (!API_KEY) {
	throw new Error(
		"API key required: set CAFE_E2E_API_KEY or GEMINI_API_KEY (shell/.env)",
	);
}

describe("09 — Onboarding Wizard", () => {
	it("should show onboarding when config is cleared", async () => {
		await browser.execute(() => {
			localStorage.removeItem("naia-config");
		});
		await safeRefresh();

		const overlay = await $(S.onboardingOverlay);
		await overlay.waitForDisplayed({ timeout: 30_000 });
	});

	it("should show provider step with lab login area", async () => {
		const providerCard = await $(S.onboardingProviderCard);
		await providerCard.waitForDisplayed({ timeout: 10_000 });

		const hasLabCard = await browser.execute(() => {
			return !!document.querySelector(".onboarding-provider-card.lab-card");
		});
		expect(hasLabCard).toBe(true);

		const divider = await $(S.onboardingDivider);
		await divider.waitForDisplayed({ timeout: 10_000 });
	});

	it("should move to api key step after provider selection", async () => {
		await browser.execute(() => {
			const provider = document.querySelector(
				".onboarding-provider-cards .onboarding-provider-card:not(.disabled)",
			) as HTMLButtonElement | null;
			provider?.click();
		});

		const nextBtn = await $(S.onboardingNextBtn);
		await nextBtn.waitForEnabled({ timeout: 10_000 });
		await nextBtn.click();

		const apiInput = await $(S.onboardingInput);
		await apiInput.waitForDisplayed({ timeout: 10_000 });
		await apiInput.setValue(API_KEY);
		await nextBtn.click();
	});

	it("should progress through name and avatar steps to complete", async () => {
		// If still on apiKey step due transition timing, advance first.
		const validateBtn = await $(".onboarding-validate-btn");
		if (await validateBtn.isDisplayed()) {
			const apiInput = await $(S.onboardingInput);
			await apiInput.waitForDisplayed({ timeout: 10_000 });
			await apiInput.setValue(API_KEY);
			await (await $(S.onboardingNextBtn)).click();
		}

		const agentInput = await $(S.onboardingInput);
		if (await agentInput.isDisplayed()) {
			await agentInput.setValue("E2E-Agent");
			await (await $(S.onboardingNextBtn)).click();
		}

		const userInput = await $(S.onboardingInput);
		if (await userInput.isDisplayed()) {
			await userInput.setValue("E2E-User");
			await (await $(S.onboardingNextBtn)).click();
		}

		const vrmCard = await $(S.onboardingVrmCard);
		if (await vrmCard.isDisplayed()) {
			await vrmCard.click();
			await (await $(S.onboardingNextBtn)).click();
		}

		const personalityCard = await $(S.onboardingPersonalityCard);
		if (await personalityCard.isDisplayed()) {
			await personalityCard.click();
			await (await $(S.onboardingNextBtn)).click();
		}

		// Speech style step — just advance with defaults
		const speechStyleCard = await $(S.onboardingPersonalityCard);
		if (await speechStyleCard.isDisplayed()) {
			await (await $(S.onboardingNextBtn)).click();
		}
	});

	it("should complete onboarding and hide overlay", async () => {
		// Now at "complete" step
		const discordOptionalBtn = await $(
			'[data-testid="onboarding-discord-connect-btn"]',
		);
		await discordOptionalBtn.waitForDisplayed({ timeout: 10_000 });
		await discordOptionalBtn.click();
		await browser.pause(300);

		const completeBtn = await $(S.onboardingNextBtn);
		await completeBtn.waitForEnabled({ timeout: 10_000 });
		await completeBtn.click();

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

		const config = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			return raw ? JSON.parse(raw) : null;
		});
		expect(config).not.toBeNull();
		expect(config.onboardingComplete).toBe(true);
	});

	it("should restore previous config for remaining tests", async () => {
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

		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});
});
