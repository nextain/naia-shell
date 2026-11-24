import { readFileSync } from "node:fs";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import {
	WEB_BGM_VIEWPORTS,
	openWebShellWithBgm,
	waitWebWorkspaceReady,
} from "./helpers/web-bgm";
import { captureWebRequirement } from "./helpers/web-settings";

test.skip(process.env.NAIA_E2E_WEB !== "1", "requires the web runtime");
test.use({ locale: "ko-KR", serviceWorkers: "block" });
test.describe.configure({ timeout: 180_000 });

const samplePng =
	"src/apps/charcard/package-public/samples/clockwork-tinker.png";

async function openWebShell(page: Page, context: BrowserContext) {
	await context.route(
		/^https?:\/\/(?!(?:localhost|127\.0\.0\.1)(?::\d+)?\/)/,
		(route) =>
			route.fulfill({
				status: 404,
				headers: { "access-control-allow-origin": "*" },
				json: {},
			}),
	);
	await openWebShellWithBgm(page, { openBgm: false });
}

async function openCharacterCards(page: Page, width: number) {
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	if (width === 390) {
		await page.getByRole("button", { name: "Menu", exact: true }).click();
		await page.getByTestId("web-character-card-mobile-btn").click();
	} else {
		await page.getByTestId("web-character-card-quick-btn").click();
	}
	const frame = page.locator('iframe[src*="/hosted-apps/naia-charcard/"]');
	await expect(frame).toBeVisible();
	await expect(frame).toHaveAttribute(
		"src",
		new URL("hosted-apps/naia-charcard/index.html", page.url()).href,
	);
	await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
	return frame.contentFrame();
}

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R11 restores an imported card and its picture after refreshing at ${viewport.width}px`, async ({
		page,
		context,
	}) => {
		await page.setViewportSize(viewport);
		await openWebShell(page, context);
		const app = await openCharacterCards(page, viewport.width);
		const addFile = app.getByRole("button", { name: "파일 추가", exact: true });
		const library = app.getByTestId("charcard-list");
		const card = library.getByRole("button", { name: /^한도윤 불러옴/ });
		const banner = app.getByTestId("charcard-memory-banner");
		const input = app.getByTestId("charcard-file-input");

		await expect(addFile).toBeEnabled();
		await expect(addFile).toBeInViewport();
		await expect(library.getByRole("button")).toHaveCount(4);
		await expect(banner).toHaveCount(0, { timeout: 3_000 });
		await expect(card).toHaveCount(0);

		// Hold the local file read so the progress state is observable.
		await input.evaluate(() => {
			const readFile = File.prototype.arrayBuffer;
			const ready = new Promise<void>((resolve) => {
				document.addEventListener("test:read-card", () => resolve(), {
					once: true,
				});
			});
			File.prototype.arrayBuffer = async function () {
				await ready;
				return readFile.call(this);
			};
		});
		const fileChooser = page.waitForEvent("filechooser");
		await addFile.press("Enter");
		await (await fileChooser).setFiles(samplePng);
		await expect(
			app.getByRole("status").filter({ hasText: "카드를 추가하는 중…" }),
		).toBeVisible();
		await expect(addFile).toBeDisabled();
		await expect(
			app.getByRole("button", { name: "적용", exact: true }),
		).toBeDisabled();
		await expect(card).toHaveCount(0);
		await input.evaluate(() =>
			document.dispatchEvent(new Event("test:read-card")),
		);

		await expect(card).toHaveAttribute("aria-pressed", "true");
		await expect(addFile).toBeEnabled();
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitWebWorkspaceReady(page);
		const restored = await openCharacterCards(page, viewport.width);
		await expect(restored.getByTestId("charcard-import-button")).toBeEnabled();
		const restoredRow = restored
			.getByTestId("charcard-list")
			.getByRole("button", { name: /^한도윤 불러옴/ });
		await expect(restoredRow).toBeInViewport();
		await restoredRow.focus();
		await expect(restoredRow).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(restoredRow).toHaveAttribute("aria-pressed", "true");
		await expect(restored.getByTestId("charcard-detail-name")).toHaveText(
			"한도윤",
		);
		const picture = restored.getByTestId("charcard-avatar-img");
		await expect(picture).toHaveAttribute("src", /^blob:/);
		await expect
			.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
			.toBeGreaterThan(0);
		await expect(picture).toBeInViewport();
		await expect(restored.getByTestId("charcard-memory-banner")).toHaveCount(0);
		await captureWebRequirement(page, "R11");

		await restored.getByTestId("charcard-file-input").setInputFiles({
			name: "oversized-card.png",
			mimeType: "image/png",
			buffer: Buffer.concat([
				readFileSync(samplePng),
				Buffer.alloc(6 * 1024 * 1024),
			]),
		});
		const alert = restored.getByRole("alert");
		await expect(alert).toContainText("카드가 너무 큽니다");
		await expect(alert).toBeInViewport();
		const chooseAnother = alert.getByRole("button", {
			name: "다른 파일 고르기",
		});
		await chooseAnother.scrollIntoViewIfNeeded();
		const replacement = page.waitForEvent("filechooser");
		await chooseAnother.press("Enter");
		await (await replacement).setFiles({
			name: "smaller-card.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify({ name: "작은 카드" })),
		});
		await expect(restored.getByTestId("charcard-detail-name")).toHaveText(
			"작은 카드",
		);
		await expect(alert).toHaveCount(0);
	});

	test(`R11 explains temporary storage when the shell card library is unavailable at ${viewport.width}px`, async ({
		page,
		context,
	}) => {
		await page.setViewportSize(viewport);
		await context.addInitScript(() => {
			if (window !== window.top) return;
			const open = IDBFactory.prototype.open;
			IDBFactory.prototype.open = function (name, version) {
				if (name === "naia-installed-app-storage") {
					throw new DOMException("Blocked for this test", "SecurityError");
				}
				return open.call(this, name, version);
			};
		});
		await openWebShell(page, context);
		const app = await openCharacterCards(page, viewport.width);
		const notice = app
			.getByRole("status")
			.filter({ hasText: "카드를 저장할 수 없어" });
		await expect(notice).toContainText(
			"새로 고침하거나 창을 닫으면 사라집니다",
		);
		await expect(notice).toBeInViewport();
		await expect(app.getByTestId("charcard-import-button")).toBeEnabled();
		await app.getByTestId("charcard-file-input").setInputFiles({
			name: "temporary.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify({ name: "임시 보관 카드" })),
		});
		await expect(app.getByTestId("charcard-detail-name")).toHaveText(
			"임시 보관 카드",
		);

		await page.reload({ waitUntil: "domcontentloaded" });
		await waitWebWorkspaceReady(page);
		const reopened = await openCharacterCards(page, viewport.width);
		await expect(reopened.getByTestId("charcard-import-button")).toBeEnabled();
		await expect(
			reopened.getByRole("button", { name: /^임시 보관 카드/ }),
		).toHaveCount(0);
		await expect(reopened.getByTestId("charcard-memory-banner")).toBeVisible();
	});
}
