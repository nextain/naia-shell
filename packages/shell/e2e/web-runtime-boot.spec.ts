import { expect, test } from "@playwright/test";

test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"Web runtime boot test only runs when NAIA_E2E_WEB=1",
);

test("web bootstrap does not call the native workspace cache through its compatibility shim", async ({ page }) => {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("data-naia-web", "true");
	expect(await page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(true);
	await expect(page.getByRole("button", { name: /기본 작업 공간으로 시작|Start with default workspace/ })).toBeVisible({ timeout: 60_000 });
	await expect(page.getByText("Cannot read workspace selection", { exact: false })).toHaveCount(0);
	expect(errors.filter((message) => message.includes("desktop_only:read_naia_path_cache"))).toEqual([]);
});

test("boots into main screen within 10s without uncaught page errors in web mode", async ({
	page,
}) => {
	const pageErrors: Error[] = [];
	page.on("pageerror", (err) => {
		pageErrors.push(err);
	});

	const t0 = Date.now();
	await page.goto("/");

	// Condition 1: [data-app-ready="true"]
	let left = 10_000 - (Date.now() - t0);
	expect(left).toBeGreaterThan(0);
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: left,
	});

	// Condition 2: .splash-screen count is 0
	left = 10_000 - (Date.now() - t0);
	expect(left).toBeGreaterThan(0);
	await expect(page.locator(".splash-screen")).toHaveCount(0, {
		timeout: left,
	});

	// Condition 3: main chat input .naia-chat-area .chat-input is visible
	left = 10_000 - (Date.now() - t0);
	expect(left).toBeGreaterThan(0);
	await expect(page.locator(".naia-chat-area .chat-input")).toBeVisible({
		timeout: left,
	});

	// Total elapsed time check
	expect(Date.now() - t0).toBeLessThanOrEqual(10_000);

	// No page errors allowed at this moment
	expect(
		pageErrors,
		`Unexpected page errors during boot:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
	).toHaveLength(0);

	// Neither onboarding nor ADK setup screen should be visible
	const onboardingCount = await page
		.locator('[data-testid="onboarding"]')
		.count();
	expect(
		onboardingCount,
		"Onboarding screen must not be visible on first web boot",
	).toBe(0);

	const adkSetupCount = await page.locator(".adk-setup-screen").count();
	expect(
		adkSetupCount,
		"ADK setup screen must not be visible on first web boot",
	).toBe(0);
});
