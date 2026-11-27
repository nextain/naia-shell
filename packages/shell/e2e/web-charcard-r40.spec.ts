import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";
import { captureWebRequirement, openWebSettings } from "./helpers/web-settings";

test.skip(process.env.NAIA_E2E_WEB !== "1", "requires the web runtime");
test.use({ locale: "ko-KR" });

const samplePng = join(
	"src/apps/charcard/package-public/samples/clockwork-tinker.png",
);

async function expectImage(image: Locator, source: RegExp) {
	await expect(image).toHaveAttribute("src", source);
	await expect
		.poll(() =>
			image.evaluate((element: HTMLImageElement) => element.naturalWidth),
		)
		.toBeGreaterThan(0);
}

async function expectActionRow(buttons: Locator[]) {
	for (const button of buttons) await expect(button).toBeInViewport();
	const bounds = await Promise.all(
		buttons.map((button) => button.boundingBox()),
	);
	const y = bounds[0]!.y;
	for (const box of bounds) expect(Math.abs(box!.y - y)).toBeLessThan(4);
}

const bundledFallbackPortrait =
	/\/(?:hosted-apps\/naia-charcard\/assets|src\/apps\/charcard)\/fallback-avatar(?:-[\w-]+)?\.webp$/;

test("decodes both JSON sample fallback portraits inside the hosted sandbox", async ({
	page,
}) => {
	await openWebShellWithBgm(page, { openBgm: false });
	await page.getByTestId("web-character-card-quick-btn").click();
	const iframe = page.locator('iframe[src*="/hosted-apps/naia-charcard/"]');
	await expect(iframe).not.toHaveAttribute("sandbox", /allow-same-origin/);
	const app = iframe.contentFrame();
	for (const id of ["clockwork-tinker-json-v3", "starlight-archivist-v2"]) {
		const portrait = app
			.getByTestId(`charcard-item-sample:${id}`)
			.getByTestId("charcard-list-image");
		await expectImage(portrait, bundledFallbackPortrait);
	}
});

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R40 adds cards, shows their pictures and applies from the first screen at ${viewport.width}px`, async ({
		page,
		context,
	}) => {
		await page.setViewportSize(viewport);
		await context.route(/^https?:\/\//, async (route) => {
			const url = new URL(route.request().url());
			if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
				return route.continue();
			return route.fulfill({
				status: 404,
				headers: { "access-control-allow-origin": "*" },
				json: {},
			});
		});
		await openWebShellWithBgm(page, { openBgm: false });
		const originalUrl = page.url();
		const menu = page.getByRole("button", { name: "Menu", exact: true });
		if (await menu.isVisible()) {
			await menu.click();
			await page.getByTestId("web-character-card-mobile-btn").click();
		} else {
			await page.getByTestId("web-character-card-quick-btn").click();
		}
		const iframe = page.locator('iframe[src*="/hosted-apps/naia-charcard/"]');
		await expect(iframe).toBeVisible();
		await expect(iframe).not.toHaveAttribute("sandbox", /allow-same-origin/);
		const app = iframe.contentFrame();
		const create = app.getByRole("button", { name: "만들기", exact: true });
		const addFile = app.getByRole("button", { name: "파일 추가", exact: true });
		const apply = app.getByTestId("charcard-start-button");
		await expect(addFile).toBeEnabled();
		await expectActionRow([create, addFile, apply]);
		const library = app.getByTestId("charcard-list");
		await expect(library.getByRole("button")).toHaveCount(4);
		const input = app.getByTestId("charcard-file-input");
		await input.setInputFiles({
			name: "invalid.json",
			mimeType: "application/json",
			buffer: Buffer.from("{"),
		});
		await expect(app.getByRole("alert")).toContainText(
			"캐릭터 카드를 불러오지 못했습니다",
		);
		await expect(addFile).toBeEnabled();

		await input.setInputFiles(samplePng);
		const picture = app.getByTestId("charcard-avatar-img");
		await expect(app.getByTestId("charcard-detail-name")).toHaveText("한도윤");
		const selected = library.getByRole("button", { pressed: true });
		await expect(selected).toContainText("한도윤");
		await expectImage(selected.getByTestId("charcard-list-image"), /^blob:/);
		await expectImage(picture, /^blob:/);
		await expect(picture).toBeInViewport();
		await expectActionRow([create, addFile, apply]);
		await captureWebRequirement(page, "R40");

		await create.click();
		const form = app.getByRole("form", { name: "만들기" });
		await form.getByLabel("캐릭터 이름").fill("가람");
		await form
			.getByLabel("첫 인사", { exact: true })
			.fill("안녕하세요, 가람입니다.");
		await form.getByRole("button", { name: "카드 저장" }).click();
		await expect(app.getByTestId("charcard-detail-name")).toHaveText("가람");
		await expectImage(
			selected.getByTestId("charcard-list-image"),
			/\/avatars\/.*\.webp$/,
		);
		await expectImage(picture, /\/avatars\/.*\.webp$/);

		for (const version of [2, 3]) {
			await input.setInputFiles({
				name: `card-v${version}.json`,
				mimeType: "application/json",
				buffer: Buffer.from(
					JSON.stringify({
						spec: `chara_card_v${version}`,
						spec_version: `${version}.0`,
						data: {
							name: `웹 카드 ${version}`,
							first_mes: "웹 카드 첫 인사입니다.",
						},
					}),
				),
			});
			await expect(app.getByTestId("charcard-detail-name")).toHaveText(
				`웹 카드 ${version}`,
			);
		}
		const row = library.getByRole("button", { name: /^웹 카드 2/ });
		await row.focus();
		await row.press("Enter");
		await expect(row).toHaveAttribute("aria-pressed", "true");
		await expect(app.getByTestId("charcard-detail-name")).toHaveText(
			"웹 카드 2",
		);
		await expectActionRow([create, addFile, apply]);
		await apply.press("Enter");
		await expect(page.locator(".chat-messages")).toContainText(
			"웹 카드 첫 인사입니다.",
		);
		expect(page.url()).toBe(originalUrl);

		await page.getByTestId("active-app-titlebar").getByRole("button").click();
		await openWebSettings(page);
		await page.locator('[data-settings-tab="persona"]').click();
		const persona = page.locator(".character-theme-settings");
		const personaActions = [
			persona.getByRole("button", { name: "만들기", exact: true }),
			persona.getByRole("button", { name: "파일 추가", exact: true }),
			persona.getByTestId("charcard-apply-btn"),
		];
		await expectActionRow(personaActions);
		await persona.locator("#character-card-file").setInputFiles(samplePng);
		await expectImage(
			persona.getByTestId("charcard-preview-image"),
			/^data:image\/png;base64,/,
		);
		await expectActionRow(personaActions);
		await personaActions[2].click();
		const personaRow = persona
			.locator(".character-card-library")
			.getByRole("button", { name: "한도윤" });
		await expect(personaRow).toHaveAttribute("aria-pressed", "true");
		await expectImage(personaRow.locator("img"), /^data:image\/png;base64,/);
	});

	test(`R40 shows larger Persona card pictures at ${viewport.width}px`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await openWebShellWithBgm(page, { openBgm: false });
		await openWebSettings(page);
		await page.locator('[data-settings-tab="persona"]').click();
		const persona = page.locator(".character-theme-settings");
		const actions = [
			persona.getByRole("button", { name: "만들기", exact: true }),
			persona.getByRole("button", { name: "파일 추가", exact: true }),
			persona.getByTestId("charcard-apply-btn"),
		];
		await persona.locator("#character-card-file").setInputFiles(samplePng);
		const personaPreview = persona.getByTestId("charcard-preview-image");
		await expectImage(personaPreview, /^data:image\/png;base64,/);
		await expect(personaPreview).toHaveCSS("width", "88px");
		await expect(personaPreview).toHaveCSS("height", "88px");
		await expect(personaPreview).toHaveCSS("object-fit", "contain");
		await expectActionRow(actions);
		await actions[2].click();
		const personaThumbnail = persona.locator(".character-card-library")
			.getByRole("button", { name: "한도윤", pressed: true }).locator("img");
		await expectImage(personaThumbnail, /^data:image\/png;base64,/);
		await expect(personaThumbnail).toHaveCSS("width", "48px");
		await expect(personaThumbnail).toHaveCSS("height", "48px");
		for (const image of [personaPreview, personaThumbnail]) {
			const bounds = await image.boundingBox();
			expect(bounds!.x).toBeGreaterThanOrEqual(0);
			expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
		}
		expect(await persona.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await captureWebRequirement(page, "R40-Persona");

		const longName = "character_card_export_".repeat(4);
		await persona.getByTestId("charcard-field-name").fill(longName);
		await actions[2].click();
		const longRow = persona.locator(".character-card-library")
			.getByRole("button", { name: longName, pressed: true });
		await expect(longRow.locator("img")).toHaveCSS("width", "48px");
		expect(await persona.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	});
}
