import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

const API_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "";

describe("01 — App Launch", () => {
	it("should display the app root", async () => {
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });
	});

	it("should bypass onboarding via localStorage config", async () => {
		// Set minimum config to skip onboarding
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

		await safeRefresh();

		// After reload with config, onboarding should NOT appear
		await browser.waitUntil(
			async () => {
				return browser.execute(
					(sel: string) => !document.querySelector(sel),
					S.onboardingOverlay,
				);
			},
			{
				timeout: 15_000,
				timeoutMsg: "Onboarding still visible after config set",
			},
		);

		// Main app should be visible
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 10_000 });
	});
});
