import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { openWebShellWithBgm, waitWebWorkspaceReady } from "./helpers/web-bgm";

test.skip(
	process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake",
	"requires the local web shell and the fake model",
);
test.use({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" });
test.setTimeout(240_000);

const videoName = "naia-autumn-office-live.mp4";
const userVideo = `opfs://naia-adk/naia-settings/background/${videoName}`;
const background = (page: Page) => page.getByTestId("settings-bg-select");

async function openSettings(page: Page, tab: "general" | "avatar") {
	const tabs = page.locator(".settings-tab-bar");
	if (!(await tabs.isVisible())) await page.locator(".app-bar-settings").click();
	await tabs.locator(`[data-settings-tab="${tab}"]`).click();
}

async function expectPlayback(video: Locator) {
	await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
		.toBeGreaterThan(0.02);
	const firstTime = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
	await expect.poll(async () => Math.abs(
		await video.evaluate((el: HTMLVideoElement) => el.currentTime) - firstTime,
	)).toBeGreaterThan(0.02);
}

test("web Settings applies and restores user NVA, PNG and MP4", async ({ page, baseURL }) => {
	const origin = new URL(baseURL ?? "http://localhost:1420").origin;
	await page.route(/^https?:\/\//, (route) =>
		new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
	);
	await openWebShellWithBgm(page, { openBgm: false });
	await openSettings(page, "general");

	await page.getByTestId("settings-bg-web-file-input").setInputFiles({
		name: "settings-ui.png",
		mimeType: "image/png",
		buffer: Buffer.from([
			137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0,
			0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13,
			73, 68, 65, 84, 120, 218, 99, 252, 207, 192, 80, 15, 0, 4, 133, 1,
			128, 132, 169, 140, 33, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96,
			130,
		]),
	});
	const png = "opfs://naia-adk/naia-settings/background/settings-ui.png";
	const image = page.locator(".app-bg-image[src^='blob:']");
	await expect(background(page)).toHaveValue(png);
	await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
	await page.reload();
	await waitWebWorkspaceReady(page);
	await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
	await openSettings(page, "general");
	await expect(background(page)).toHaveValue(png);

	// The user file has the bundled file's name and different contents.
	await page.getByTestId("settings-bg-web-file-input").setInputFiles({
		name: videoName,
		mimeType: "video/mp4",
		buffer: readFileSync("public/backgrounds/naia-rainy-studio-live.mp4"),
	});
	await expect(background(page)).toHaveValue(userVideo);
	const bundledOption = background(page).locator(`option[value="/backgrounds/${videoName}"]`);
	const userOption = background(page).locator(`option[value="${userVideo}"]`);
	expect(await userOption.textContent()).not.toBe(await bundledOption.textContent());
	await background(page).selectOption(`/backgrounds/${videoName}`);
	await expect(page.locator(".app-bg-video")).toHaveAttribute("src", new RegExp(videoName));
	await background(page).selectOption(userVideo);
	const userMovie = page.locator(".app-bg-video[src^='blob:']");
	await expectPlayback(userMovie);

	await openSettings(page, "avatar");
	await page.locator("#avatar-provider").selectOption("naia-video-avatar");
	await page.getByTestId("settings-nva-web-file-input").setInputFiles({
		name: "settings-ui.nva",
		mimeType: "application/zip",
		buffer: Buffer.from(zipSync({
			"manifest.json": strToU8(JSON.stringify({
				nva_version: "0.2",
				canvas: { width: 720, height: 1280 },
				animations: { idle: { clip: "clips/idle.webm", loop: true } },
			})),
			"clips/idle.webm": readFileSync("public/nva/minho/clips/idle.webm"),
		})),
	});
	const avatar = page.locator("[data-video-avatar]");
	await expect(avatar).toHaveAttribute("data-nva-model", "settings-ui.nva");
	await expect(avatar).toHaveAttribute("data-video-avatar-loaded", "true");
	await expectPlayback(avatar.locator("video"));

	await page.reload();
	await waitWebWorkspaceReady(page);
	await expect(avatar).toHaveAttribute("data-nva-model", "settings-ui.nva");
	await expect(avatar).toHaveAttribute("data-video-avatar-loaded", "true");
	await expectPlayback(avatar.locator("video"));
	await expectPlayback(userMovie);
	await openSettings(page, "general");
	await expect(background(page)).toHaveValue(userVideo);
});
