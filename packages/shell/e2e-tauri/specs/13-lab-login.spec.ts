import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

describe("13 — Lab Login Flow", () => {
	let savedConfig: string | null = null;

	it("should save current config and clear for onboarding", async () => {
		// Save current config to restore later
		savedConfig = await browser.execute(() => {
			return localStorage.getItem("naia-config");
		});

		// Clear config to trigger onboarding
		await browser.execute(() => {
			localStorage.removeItem("naia-config");
		});
		await safeRefresh();

		const overlay = await $(S.onboardingOverlay);
		await overlay.waitForDisplayed({ timeout: 30_000 });
	});

	it("should navigate to provider step", async () => {
		// Current onboarding starts at Provider step.
		const providerCard = await $(S.onboardingProviderCard);
		await providerCard.waitForDisplayed({ timeout: 10_000 });

		const labBtn = await $(S.onboardingLabBtn);
		await labBtn.waitForDisplayed({ timeout: 10_000 });
	});

	it("should inject naiaKey and verify config persistence", async () => {
		// Note: Tauri deep-link events (listen/emit) cannot be simulated
		// in WebDriver E2E. Instead, we directly inject naiaKey into
		// localStorage to test the downstream UI flow.
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.naiaKey = "e2e-test-lab-key-12345";
			config.naiaUserId = "e2e-lab-user";
			config.provider = "gemini";
			config.model = "gemini-2.5-flash";
			config.onboardingComplete = true;
			localStorage.setItem("naia-config", JSON.stringify(config));
		});

		// Reload to pick up the new config
		await safeRefresh();

		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });

		// Verify naiaKey is persisted
		const config = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			return raw ? JSON.parse(raw) : null;
		});
		expect(config).not.toBeNull();
		expect(config.naiaKey).toBe("e2e-test-lab-key-12345");
		expect(config.naiaUserId).toBe("e2e-lab-user");
	});

	it("should show Lab balance section in cost dashboard with naiaKey", async () => {
		// With naiaKey set, cost dashboard should show Lab balance section
		// First need a message exchange to show the cost badge
		// If cost badge is not visible, the dashboard won't be accessible
		const hasCostBadge = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.costBadge,
		);

		if (hasCostBadge) {
			const costBadge = await $(S.costBadge);
			await costBadge.click();

			const dashboard = await $(S.costDashboard);
			await dashboard.waitForDisplayed({ timeout: 10_000 });

			// Lab balance row should be present (loading state is fine)
			const hasLabBalance = await browser.execute(
				(sel: string) => !!document.querySelector(sel),
				S.labBalanceRow,
			);
			expect(hasLabBalance).toBe(true);

			// Close dashboard
			await costBadge.click();
		}
	});

	it("should restore original config for remaining tests", async () => {
		if (savedConfig) {
			await browser.execute((cfg: string) => {
				localStorage.setItem("naia-config", cfg);
			}, savedConfig);
		} else {
			// Fallback: restore with API key
			const apiKey = process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY;
			const gatewayToken = process.env.CAFE_GATEWAY_TOKEN || "naia-dev-token";

			await browser.execute(
				(key: string, token: string) => {
					const config = {
						provider: "gemini",
						apiKey: key,
						gatewayUrl: "ws://localhost:18789",
						gatewayToken: token,
						onboardingComplete: true,
						allowedTools: [
							"skill_time",
							"skill_system_status",
							"skill_memo",
							"execute_command",
							"write_file",
							"read_file",
							"search_files",
						],
					};
					localStorage.setItem("naia-config", JSON.stringify(config));
				},
				apiKey || "",
				gatewayToken,
			);
		}
		await safeRefresh();

		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });

		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});
});
