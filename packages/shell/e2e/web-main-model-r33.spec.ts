import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

const TERRA = "gpt-6.1-terra";
const TERRA_ANSWER = "안녕하세요. 테라입니다. 무엇을 도와드릴까요?";
const LOCAL_MODEL = "Qwen3-4B-q4f16_1-MLC";
const SHOT_DIR = process.env.NAIA_E2E_SHOTS_DIR;

test.skip(
	process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake",
	"requires the web runtime and fake WebLLM engine",
);

async function mockGateway(page: Page) {
	const models: string[] = [];
	let respond = () => {};
	const firstRequestCanClose = new Promise<void>((resolve) => { respond = resolve; });
	const headers = {
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "content-type,x-anyllm-key,authorization",
		"access-control-allow-methods": "GET,POST,OPTIONS",
	};
	await page.context().route(/^https:\/\/([a-z0-9-]+\.)*(naia\.land|nextain\.io)\//, async (route) => {
		const request = route.request();
		if (request.method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers });
			return;
		}
		const path = new URL(request.url()).pathname;
		if (path === "/v1/models") {
			await route.fulfill({
				headers,
				json: { data: [TERRA, "gpt-5.6-luna"].map((id) => ({ id, object: "model" })) },
			});
			return;
		}
		if (path !== "/v1/chat/completions") {
			await route.fulfill({ status: 404, headers, json: {} });
			return;
		}
		models.push(request.postDataJSON().model);
		let body = "";
		if (models.length === 1) {
			await firstRequestCanClose;
		} else {
			const chunk = (delta: object, finish_reason: string | null = null) =>
				"data: " + JSON.stringify({ model: TERRA, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
			body =
				chunk({ reasoning: { content: "짧은 인사를 준비합니다." } }) +
				chunk({ content: TERRA_ANSWER }) +
				chunk({}, "stop") + "data: [DONE]\n\n";
		}
		await route.fulfill({ status: 200, headers, contentType: "text/event-stream", body });
	});
	return { models, closeFirstRequest: respond };
}

async function openSettings(page: Page, mobile: boolean) {
	if (mobile) {
		await page.getByRole("button", { name: "Menu", exact: true }).click();
		await page.locator(".web-mobile-menu-list").getByRole("button", { name: /설정/ }).click();
	} else {
		await page.getByRole("button", { name: "설정", exact: true }).click();
	}
	await page.getByRole("button", { name: "두뇌", exact: true }).click();
}

async function closeSettings(page: Page, mobile: boolean) {
	await page.getByRole("button", { name: mobile ? "Close" : "설정 닫기", exact: true }).click();
	await expect(page.locator("#provider-select")).toBeHidden();
}

for (const viewport of WEB_BGM_VIEWPORTS) {
	test("R33 switches models without reloading and can retry an empty Terra stream (" + viewport.width + ")", async ({ page }) => {
		await page.setViewportSize(viewport);
		const mobile = viewport.width < 600;
		const gateway = await mockGateway(page);
		await page.addInitScript(() => {
			localStorage.setItem("naia-remote-key", "test-r33-fixture");
		});
		await openWebShellWithBgm(page, { openBgm: false });

		const pageStart = await page.evaluate(() => performance.timeOrigin);
		const expectSamePage = async () =>
			expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageStart);
		const status = page.getByTestId("web-model-status");
		const messages = page.locator(".chat-messages");
		const input = page.locator(".naia-chat-area .chat-input");
		await expect(status).toHaveAttribute("data-phase", "ready");
		await expect(messages.locator(".chat-message")).toHaveCount(0);
		await expect(input).toBeInViewport();

		await openSettings(page, mobile);
		const provider = page.getByLabel("프로바이더", { exact: true });
		const model = page.getByLabel("모델", { exact: true });
		await provider.focus();
		await expect(provider).toBeFocused();
		await expect(provider).toBeInViewport();
		await model.selectOption(LOCAL_MODEL);
		await closeSettings(page, mobile);
		await expect(status).toHaveAttribute("data-model", LOCAL_MODEL);
		await expect(status).toHaveAttribute("data-phase", "ready");
		await expectSamePage();

		await openSettings(page, mobile);
		await provider.selectOption("nextain");
		await model.selectOption(TERRA);
		await closeSettings(page, mobile);
		await expect(status).toBeHidden();
		await expectSamePage();

		await input.fill("안녕하세요, 테라.");
		await input.press("Enter");
		try {
			await expect.poll(() => gateway.models).toEqual([TERRA]);
			await expect(page.locator(".chat-cancel-btn")).toBeInViewport();
		} finally {
			gateway.closeFirstRequest();
		}
		const alert = messages.getByRole("alert");
		await expect(alert).toBeVisible();
		await alert.getByText("자세한 내용", { exact: true }).click();
		await expect(alert).toContainText("without sending any answer");
		expect(await alert.textContent()).not.toContain("reasoning without a final answer");
		const retry = alert.getByRole("button", { name: "다시 시도", exact: true });
		await retry.focus();
		await expect(retry).toBeFocused();
		await expect(retry).toBeInViewport();
		await retry.press("Enter");

		const answer = messages.getByText(TERRA_ANSWER, { exact: true });
		await expect(answer).toBeInViewport();
		expect(gateway.models).toEqual([TERRA, TERRA]);
		await expectSamePage();
		if (SHOT_DIR) {
			mkdirSync(SHOT_DIR, { recursive: true });
			await page.screenshot({ path: SHOT_DIR + "/R33-" + viewport.width + ".png" });
		}

		await openSettings(page, mobile);
		await provider.selectOption("webllm");
		await closeSettings(page, mobile);
		await expect(status).toHaveAttribute("data-phase", "ready");
		await input.fill("로컬 모델로 답해 주세요.");
		await input.press("Enter");
		await expect(messages).toContainText("웹 가짜 엔진");
		await expect(answer).toBeAttached();
		await expectSamePage();
	});
}
