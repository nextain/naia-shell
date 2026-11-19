import { type Page, expect, test } from "@playwright/test";

// R3 (one catalog for the in-shell store and the web store) and R4 (apps an
// admin registers on the portal appear through GET /api/apps).  Web runtime
// only: run with NAIA_E2E_WEB=1 and `vite --mode web`.
test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"web app store catalog test only runs when NAIA_E2E_WEB=1",
);
test.setTimeout(180_000);

const SHOTS = process.env.NAIA_E2E_SHOTS_DIR;
const CORS = { "Access-Control-Allow-Origin": "*" };

async function bootWeb(page: Page, adminApps: unknown[] | "down") {
	await page.route("**/v1/apps/products", (route) =>
		route.fulfill({ status: 503, headers: CORS, json: { error: "down" } }),
	);
	await page.route("**/api/apps", (route) =>
		adminApps === "down"
			? route.abort("connectionrefused")
			: route.fulfill({
					status: 200,
					headers: CORS,
					json: { apps: adminApps },
				}),
	);
	await page.route("**/hosted-apps/land.naia.quiz/index.html", (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html><html><body><h1 id=quiz>Admin quiz is running</h1></body></html>",
		}),
	);
	await page.addInitScript(() => {
		if (!localStorage.getItem("naia-config")) {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "webllm",
					model: "Qwen3-4B-q4f32_1-MLC",
					ttsEnabled: false,
					locale: "ko",
				}),
			);
		}
	});
	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("data-naia-web", "true");
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: 60_000,
	});
}

async function openStore(page: Page) {
	const button = page.getByRole("button", { name: "앱스토어" }).first();
	if (await button.isVisible().catch(() => false)) {
		await button.click();
	} else {
		// Narrow layouts fold the app bar; the store drawer listens for the same event.
		await page.evaluate(() =>
			window.dispatchEvent(
				new CustomEvent("naia-open-web-store-drawer", { cancelable: true }),
			),
		);
	}
	await expect(page.getByTestId("web-app-store-modal")).toBeVisible();
}

const BUILTIN = [
	"land.naia.charcard",
	"land.naia.slides",
	"land.naia.ieumoffice",
	"land.naia.cafelua-tarot",
];

for (const viewport of [
	{ name: "desktop", width: 1280, height: 720 },
	{ name: "mobile", width: 390, height: 844 },
]) {
	test(`R3 R4 store merges built-in and admin apps and launches an admin app (${viewport.name} ${viewport.width}x${viewport.height})`, async ({
		browser,
	}) => {
		const context = await browser.newContext({ viewport, locale: "ko-KR" });
		const page = await context.newPage();
		await bootWeb(page, [
			{
				id: "land.naia.quiz",
				name: "Quiz",
				icon: "❓",
				description: "어드민이 등록한 퀴즈 앱",
				version: "0.3.0",
				visibility: "public",
			},
			{ id: "land.naia.hidden", name: "Hidden", visibility: "draft" },
			{
				id: "land.naia.slides",
				name: "가짜 슬라이드",
				url: "https://evil.example/slides",
			},
		]);
		await openStore(page);
		const modal = page.getByTestId("web-app-store-modal");
		for (const id of [...BUILTIN, "land.naia.quiz"]) {
			await expect(modal.getByTestId(`web-store-item-${id}`)).toBeVisible();
		}
		await expect(
			modal.getByTestId("web-store-item-land.naia.hidden"),
		).toHaveCount(0);
		await expect(
			modal.getByTestId("web-store-item-land.naia.slides"),
		).toContainText("슬라이드");
		await expect(
			modal.getByTestId("web-store-item-land.naia.slides"),
		).not.toContainText("가짜");
		await expect(
			modal.getByTestId("web-store-item-land.naia.quiz"),
		).toContainText("어드민이 등록한 퀴즈 앱");
		const box = await modal.boundingBox();
		expect(box && box.x >= 0 && box.x + box.width <= viewport.width).toBe(true);
		if (SHOTS)
			await page.screenshot({ path: `${SHOTS}/R3-${viewport.width}.png` });

		await modal.getByTestId("web-store-launch-land.naia.quiz").click();
		await expect(modal).toHaveCount(0);
		const frame = page.frameLocator(
			'iframe[src*="/hosted-apps/land.naia.quiz/"]',
		);
		await expect(frame.locator("#quiz")).toHaveText("Admin quiz is running");
		if (SHOTS)
			await page.screenshot({ path: `${SHOTS}/R4-${viewport.width}.png` });
		await context.close();
	});
}

test("R3 R4 store shows only built-in apps when the portal catalog is unreachable", async ({
	browser,
}) => {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 720 },
		locale: "ko-KR",
	});
	const page = await context.newPage();
	await bootWeb(page, "down");
	await openStore(page);
	const items = page
		.getByTestId("web-app-store-modal")
		.locator('[data-testid^="web-store-item-"]');
	await expect(items).toHaveCount(BUILTIN.length);
	await expect(
		page.getByTestId("web-app-store-modal").getByRole("alert"),
	).toHaveCount(0);
	await context.close();
});
