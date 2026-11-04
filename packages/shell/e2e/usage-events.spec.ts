import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ context }) => {
	await context.addInitScript(() => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				locale: "en",
				onboardingComplete: true,
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		(window as any).__TAURI_INTERNALS__ = {
			metadata: {
				currentWindow: { label: "main" },
				currentWebview: { windowLabel: "main", label: "main" },
			},
			transformCallback: () => 1,
			unregisterCallback: () => {},
			convertFileSrc: (path: string) => path,
			invoke: async (cmd: string) => {
				if (cmd === "get_distribution_channel") return "steam";
				if (cmd === "read_naia_config")
					return localStorage.getItem("naia-config");
				return undefined;
			},
		};
	});
	await context.addInitScript(`${TAURI_BASE_MOCK_FALLBACK}\n${SEED_ADK_PATH}`);
});

test("asks before collecting, keyboard decline continues and stays off after restart", async ({
	page,
}, testInfo) => {
	const requests: string[] = [];
	page.on("request", (req) => {
		if (req.url().includes("/v2.1/track")) requests.push(req.url());
	});
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Optional usage statistics" }),
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("naia-usage-state-v1")),
		)
		.toBeNull();
	await page.setViewportSize({ width: 360, height: 740 });
	await expect(
		page.getByRole("button", { name: "Do not allow", exact: true }),
	).toBeInViewport();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("consent-narrow-en.png") });
	await page.getByRole("button", { name: "Do not allow", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect(page.locator(".chat-app")).toBeVisible();
	await page.reload();
	await expect(page.locator(".chat-app")).toBeVisible();
	expect(requests).toEqual([]);
	expect(
		await page.evaluate(() => localStorage.getItem("naia-usage-state-v1")),
	).toBeNull();
});

test("batches allowlisted clicks, uses Steam channel and stops immediately from General settings", async ({
	page,
	context,
}) => {
	const payloads: any[][] = [];
	const headers: Record<string, string>[] = [];
	await context.route(
		"https://*.applicationinsights.azure.com/v2.1/track",
		async (route) => {
			if (route.request().method() === "OPTIONS") {
				await route.fulfill({
					status: 204,
					headers: {
						"access-control-allow-origin": "*",
						"access-control-allow-headers": "content-type",
					},
				});
				return;
			}
			payloads.push(route.request().postDataJSON());
			headers.push(route.request().headers());
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				headers: { "access-control-allow-origin": "*" },
				body: '{"itemsAccepted":3}',
			});
		},
	);
	await page.goto("/");
	await page
		.getByRole("button", { name: "Allow usage statistics", exact: true })
		.click();
	await expect(page.locator(".chat-app")).toBeVisible();
	await page.locator(".app-bar-settings").click();
	await page.locator('[data-settings-tab="general"]').click();
	await expect(
		page.getByRole("checkbox", { name: "Send usage statistics", exact: true }),
	).toBeChecked();
	await expect.poll(() => payloads.length).toBeGreaterThan(0);
	const properties = payloads.flat().map((e) => e.data.baseData.properties);
	expect(properties[0].name).toBe("shell.start.observed");
	expect(properties[0].sequence).toBe("1");
	expect(properties.every((e) => e.channel === "steam")).toBe(true);
	expect(properties.some((e) => e.name.startsWith("app-bar."))).toBe(true);
	for (const h of headers) {
		expect(h.authorization).toBeUndefined();
		expect(h.cookie).toBeUndefined();
		expect(h.referer).toBeUndefined();
		expect(h["x-naia-instance-id"]).toBeUndefined();
	}
	// Same profile in a second real browser tab shares consent and atomic state.
	const second = await context.newPage();
	await second.goto("/");
	await expect(second.locator(".chat-app")).toBeVisible();
	await page
		.getByRole("checkbox", { name: "Send usage statistics", exact: true })
		.uncheck();
	const count = payloads.length;
	await second.locator(".app-bar-settings").click();
	await page.locator('[data-settings-tab="profile"]').click();
	await page.locator('[data-settings-tab="general"]').click();
	await expect(
		page.getByRole("checkbox", { name: "Send usage statistics", exact: true }),
	).not.toBeChecked();
	await page.waitForTimeout(5500);
	expect(payloads).toHaveLength(count);
	await second.close();
});

test("storage failure explains recovery and permits continuing with statistics off", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key.startsWith("naia-usage-"))
				throw new Error("injected denied storage");
			return original.call(this, key, value);
		};
	});
	await page.goto("/");
	await page
		.getByRole("button", { name: "Allow usage statistics", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"Usage statistics remain off",
	);
	await page
		.getByRole("button", { name: "Continue with statistics off" })
		.click();
	await expect(page.locator(".chat-app")).toBeVisible();
	expect(
		await page.evaluate(() => localStorage.getItem("naia-usage-state-v1")),
	).toBeNull();
});

test("Korean consent states the optional data and renders without overflow", async ({
	page,
}, testInfo) => {
	await page.addInitScript(() => {
		const config = JSON.parse(localStorage.getItem("naia-config") || "{}");
		config.locale = "ko";
		localStorage.setItem("naia-config", JSON.stringify(config));
	});
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "선택적 사용 통계" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "허용 안 함", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "사용 통계 허용", exact: true }),
	).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("consent-ko.png") });
	expect(
		await page.evaluate(() => localStorage.getItem("naia-usage-state-v1")),
	).toBeNull();
});
