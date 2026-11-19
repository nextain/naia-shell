import { join } from "node:path";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { writeImagePdf } from "../src/lib/slides-pptx-browser";

const base = "/app/";
const hostedPath = `${base}hosted-apps/`;
const apps = [
	{
		slug: "naia-charcard",
		id: "land.naia.charcard",
		name: "캐릭터 카드",
		control: '[data-testid="charcard-start-button"]',
	},
	{
		slug: "naia-slides",
		id: "land.naia.slides",
		name: "슬라이드",
		control: ".slides-app",
	},
	{
		slug: "ieumoffice",
		id: "land.naia.ieumoffice",
		name: "이음오피스",
		control: '[data-testid="format-xlsx"]',
	},
	{
		slug: "cafelua-tarot",
		id: "land.naia.cafelua-tarot",
		name: "카페루아 타로",
		control: "button[data-spread]",
	},
];

async function openStore(page: Page) {
	const menu = page.getByRole("button", { name: "Menu", exact: true });
	if (await menu.isVisible()) {
		await menu.click();
		await expect(menu).toHaveAttribute("aria-expanded", "true");
		await page
			.locator(".web-mobile-menu-list")
			.getByRole("button", { name: /앱스토어/ })
			.click();
	} else {
		await page.getByRole("button", { name: "앱스토어", exact: true }).click();
	}
	const store = page.getByRole("dialog", { name: "나이아 웹 미니앱 스토어" });
	await expect(store).toBeVisible();
	return store;
}

async function openPdf(page: Page, frame: FrameLocator) {
	const jpeg = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		canvas.width = 320;
		canvas.height = 180;
		const ctx = canvas.getContext("2d");
		if (!ctx)
			throw new Error("2D canvas is required to generate the Slides fixture");
		ctx.fillStyle = "#1e3a8a";
		ctx.fillRect(0, 0, 320, 180);
		ctx.fillStyle = "white";
		ctx.font = "24px sans-serif";
		ctx.fillText("Naia Slides", 28, 66);
		return canvas.toDataURL("image/jpeg").split(",")[1];
	});
	const input = frame.getByLabel(/PDF 또는 PPTX 열기|Open PDF or PPTX/);
	await expect(input).toHaveAttribute("accept", /\.pptx/);
	await input.setInputFiles({
		name: "web-store-demo.pdf",
		mimeType: "application/pdf",
		buffer: Buffer.from(
			writeImagePdf([
				{
					jpeg: Buffer.from(jpeg, "base64"),
					pixelWidth: 320,
					pixelHeight: 180,
					width: 320,
					height: 180,
				},
			]),
		),
	});
	await expect(frame.locator(".slides-app__page canvas")).toBeVisible();
}

for (const viewport of [
	{ width: 1280, height: 720 },
	{ width: 390, height: 844 },
]) {
	test.describe(`${viewport.width}×${viewport.height}`, () => {
		test.use({ viewport, locale: "ko-KR" });
		test.skip(
			({ baseURL }) =>
				process.env.NAIA_E2E_WEB !== "1" || !baseURL?.endsWith(base),
			"requires the built Web Shell preview under /app/",
		);

		test("R35 opens all four built-in apps from their real production bundles", async ({
			page,
			request,
		}) => {
			await page.addInitScript(() => {
				if (window.top !== window) return;
				localStorage.setItem(
					"naia-config",
					localStorage.getItem("naia-config") ??
						JSON.stringify({
							provider: "webllm",
							model: "Qwen3-4B-q4f32_1-MLC",
							ttsEnabled: false,
							locale: "ko",
						}),
				);
			});
			await page.goto(base);
			await expect(page.locator("html")).toHaveAttribute(
				"data-naia-web",
				"true",
			);
			await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
				timeout: 60_000,
			});
			await expect
				.poll(() =>
					page.evaluate(() => navigator.serviceWorker.controller?.state),
				)
				.toBe("activated");
			const shots = process.env.NAIA_E2E_SHOTS_DIR;
			const shot = (name: string) =>
				shots
					? page.screenshot({
							path: join(shots, `${name}-${viewport.width}.png`),
						})
					: undefined;
			// Delay the first catalog response to observe loading. Continue the request
			// to the preview server and use the real app resources for each launch.
			let finishCatalog = () => {};
			const catalogReady = new Promise<void>((resolve) => {
				finishCatalog = resolve;
			});
			await page.route(
				"**/v1/apps/products",
				async (route) => {
					await catalogReady;
					await route.continue();
				},
				{ times: 1 },
			);
			const store = await openStore(page);
			try {
				await expect(
					store.getByText("미니앱 목록을 불러오는 중..."),
				).toBeVisible();
			} finally {
				finishCatalog();
			}
			for (const { id, name } of apps) {
				await expect(store.getByTestId(`web-store-item-${id}`)).toContainText(
					name,
				);
			}
			await expect(
				store.locator('[data-testid^="web-store-item-"]'),
			).toHaveCount(apps.length);
			const box = await store.boundingBox();
			expect(box && box.x >= 0 && box.x + box.width <= viewport.width).toBe(
				true,
			);
			await expect(store.getByRole("alert")).toHaveCount(0);
			await shot("R35-store");

			for (const [index, app] of apps.entries()) {
				await test.step(`Launch ${app.slug}`, async () => {
					if (index > 0) await openStore(page);
					const appPath = `${hostedPath}${app.slug}/`;
					const entryPath = `${appPath}index.html`;
					const manifest = await request.get(`${appPath}app.json`);
					expect(manifest.ok()).toBe(true);
					expect((await manifest.json()).id).toBe(app.id);
					const icon = await request.get(`${appPath}icon.svg`);
					expect(icon.ok()).toBe(true);
					expect(icon.headers()["content-type"]).toContain("image/svg+xml");

					const launch = store.getByTestId(`web-store-launch-${app.id}`);
					await expect(launch).toHaveAccessibleName("실행");
					const loaded = page.waitForResponse(
						(response) => new URL(response.url()).pathname === entryPath,
					);
					await launch.press("Enter");
					const response = await loaded;
					expect(response.ok()).toBe(true);
					expect(response.fromServiceWorker()).toBe(false);
					await expect(store).toHaveCount(0);

					const iframe = page.locator(`iframe[src$="${entryPath}"]`);
					await expect(iframe).toBeInViewport();
					await expect(iframe).toHaveAttribute(
						"sandbox",
						"allow-scripts allow-forms allow-downloads allow-popups",
					);
					const frame = iframe.contentFrame();
					await expect(frame.locator(app.control).first()).toBeVisible();
					expect(await frame.locator("body").evaluate(() => self.origin)).toBe(
						"null",
					);
					if (app.slug === "naia-slides") await openPdf(page, frame);
					if (app.slug === "ieumoffice") {
						await frame.getByTestId("format-xlsx").click();
						await expect(frame.getByTestId("editor-xlsx")).toBeVisible();
					}
					if (app.slug === "cafelua-tarot") {
						const card = frame
							.locator('img[src$="/tarot/card-back.webp"]')
							.first();
						await expect
							.poll(() =>
								card.evaluate((image: HTMLImageElement) => image.naturalWidth),
							)
							.toBeGreaterThan(0);
					}
					const close = page.getByRole("button", { name: "앱 닫기" });
					await expect(close).toBeInViewport();
					await expect(page.getByTestId("active-app-titlebar")).toContainText(
						app.name,
					);
					await shot(app.slug === "cafelua-tarot" ? "R35" : `R35-${app.slug}`);
					await close.click();
					await expect(iframe).toHaveCount(0);
				});
			}
			await openStore(page);
			const reopen = store.getByTestId(
				"web-store-launch-land.naia.cafelua-tarot",
			);
			await expect(reopen).toHaveAccessibleName("열기");
			await reopen.click();
			await expect(
				page
					.frameLocator(`iframe[src$="${hostedPath}cafelua-tarot/index.html"]`)
					.locator("button[data-spread]")
					.first(),
			).toBeVisible();
		});
	});
}
