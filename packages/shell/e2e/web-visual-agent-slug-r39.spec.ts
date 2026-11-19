import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

const SHOT_DIR = process.env.NAIA_E2E_SHOTS_DIR;
const SLUG = "r39-visual-agent-address-test-01";
const DEFAULT_URL = "https://naia.land/visual-agent/naia";
const PUBLIC_URL = `https://naia.land/visual-agent/${SLUG}`;

test.skip(
	process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake",
	"requires the web runtime and fake WebLLM engine",
);

async function openProfile(page: Page, width: number) {
	if (width < 600) {
		await page.getByRole("button", { name: "Menu", exact: true }).click();
		await page.locator(".web-mobile-menu-list").getByRole("button", { name: /설정/ }).click();
	} else {
		await page.getByRole("button", { name: "설정", exact: true }).click();
	}
	await page.getByRole("button", { name: "프로파일", exact: true }).click();
}

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R39 web settings validate, save and copy a public agent address at ${viewport.width}×${viewport.height}`, async ({ page, context }) => {
		test.setTimeout(300_000);
		await page.setViewportSize(viewport);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());

		let releaseRead!: () => void;
		const readPending = new Promise<void>((resolve) => { releaseRead = resolve; });
		let saved = "naia";
		let readStatus = 401;
		const writes: string[] = [];
		let releaseSave!: () => void;
		const savePending = new Promise<void>((resolve) => { releaseSave = resolve; });
		await page.route("**/api/visual-agent/settings", async (route) => {
			const request = route.request();
			if (request.method() === "GET") {
				await readPending;
				return route.fulfill({ status: readStatus, json: { slug: saved } });
			}
			const { slug } = request.postDataJSON();
			writes.push(slug);
			if (slug === "taken-r39") return route.fulfill({ status: 409, json: {} });
			await savePending;
			saved = slug;
			return route.fulfill({ json: { slug: saved } });
		});
		await openWebShellWithBgm(page, { openBgm: false });
		await openProfile(page, viewport.width);

		const slug = page.getByRole("textbox", { name: "비주얼 에이전트 슬러그" });
		const panel = page.locator(".visual-agent-slug-settings");
		const preview = panel.getByTestId("visual-agent-public-url");
		const save = panel.getByRole("button", { name: "주소 저장" });
		const copy = panel.getByRole("button", { name: "주소 복사" });

		try {
			await expect(panel.getByRole("status")).toHaveText("주소를 불러오는 중…");
			await expect(slug).toBeDisabled();
		} finally {
			releaseRead();
		}
		await expect(panel.getByRole("button", { name: "로그인하여 주소 변경" })).toBeVisible();
		await expect(slug).toBeDisabled();
		await expect(preview).toHaveText(DEFAULT_URL);

		readStatus = 503;
		await page.getByRole("button", { name: viewport.width < 600 ? "Close" : "설정 닫기", exact: true }).click();
		await expect(panel).toBeHidden();
		await openProfile(page, viewport.width);
		await expect(panel.getByRole("alert")).toContainText("주소를 불러오지 못했어요");
		readStatus = 200;
		await panel.getByRole("button", { name: "다시 시도" }).click();

		await expect(slug).toHaveValue("naia");
		await expect(slug).toBeEnabled();
		await slug.fill("Invalid_R39");
		await slug.press("Enter");
		await expect(slug).toHaveAttribute("aria-invalid", "true");
		await expect(panel.getByRole("alert")).toContainText("3~32자");
		expect(writes).toEqual([]);

		await slug.fill("taken-r39");
		await save.click();
		await expect(panel.getByRole("alert")).toContainText("이미 사용 중인 주소예요");
		await slug.fill(SLUG);
		await expect(preview).toHaveText(PUBLIC_URL);
		await expect(copy).toBeDisabled();
		await slug.press("Enter");
		try {
			await expect(panel.getByRole("status")).toHaveText("저장 중…");
			await expect(slug).toBeDisabled();
			await expect(save).toBeDisabled();
		} finally {
			releaseSave();
		}
		await expect(panel.getByRole("status")).toHaveText("주소를 저장했어요.");
		expect(writes).toEqual(["taken-r39", SLUG]);

		await copy.focus();
		await expect(copy).toBeFocused();
		await copy.press("Enter");
		await expect(panel.getByRole("status")).toHaveText("주소를 복사했어요.");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PUBLIC_URL);
		expect(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		await expect(copy).toBeInViewport();

		if (SHOT_DIR) {
			mkdirSync(SHOT_DIR, { recursive: true });
			await page.screenshot({ path: join(SHOT_DIR, `R39-${viewport.width}.png`) });
		}

		await page.goto(`/app/?visualAgent=${SLUG}`);
		await expect(page).toHaveTitle(new RegExp(SLUG));
		await openProfile(page, viewport.width);
		await expect(slug).toHaveValue(SLUG);
		await expect(preview).toHaveText(PUBLIC_URL);
	});
}
