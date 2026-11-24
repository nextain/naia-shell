import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

const ACCOUNT_KEY = "test-r45-fixture";
const MODELS = [
	{ id: "gpt-6.1-terra", name: "Terra", answer: "테라에서 답변합니다." },
	{ id: "gpt-5.6-luna", name: "Luna", answer: "루나에서 답변합니다." },
] as const;
const EXTERNAL_URL = /^https?:\/\/(?!(?:localhost|127\.0\.0\.1)(?::\d+)?\/)/;
const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-headers": "content-type,x-anyllm-key,authorization",
	"access-control-allow-methods": "GET,POST,OPTIONS",
};

test.skip(
	process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake",
	"requires the web runtime with a fake local model and isolated Naia gateway",
);

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R45 sends an authenticated turn after applying Terra and Luna (${viewport.width}×${viewport.height})`, async ({ page }) => {
		await page.setViewportSize(viewport);
		const mobile = viewport.width === 390;
		await page.context().route(EXTERNAL_URL, (route) => {
			const request = route.request();
			if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS_HEADERS });
			if (new URL(request.url()).pathname === "/v1/models") {
				return route.fulfill({
					headers: CORS_HEADERS,
					json: { data: MODELS.map(({ id }) => ({ id, object: "model" })) },
				});
			}
			return route.fulfill({ status: 404, headers: CORS_HEADERS });
		});
		const requests: { model: string; authenticated: boolean }[] = [];
		let releaseTerra!: () => void;
		const terraCanRespond = new Promise<void>((resolve) => { releaseTerra = resolve; });
		await page.context().route("**/v1/chat/completions", async (route) => {
			const request = route.request();
			if (request.method() === "OPTIONS") {
				await route.fulfill({ status: 204, headers: CORS_HEADERS });
				return;
			}
			const modelId = request.postDataJSON().model;
			const authenticated = (await request.headerValue("x-anyllm-key")) === `Bearer ${ACCOUNT_KEY}`;
			requests.push({ model: modelId, authenticated });
			const model = MODELS.find(({ id }) => id === modelId);
			if (!model || !authenticated) {
				await route.fulfill({ status: 401, headers: CORS_HEADERS });
				return;
			}
			if (model === MODELS[0]) await terraCanRespond;
			const chunk = (delta: object, finish_reason: "stop" | null) =>
				`data: ${JSON.stringify({ model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			await route.fulfill({
				headers: CORS_HEADERS,
				contentType: "text/event-stream",
				body: `${chunk({ content: model.answer }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
			});
		});
		await page.addInitScript((key) => localStorage.setItem("naia-remote-key", key), ACCOUNT_KEY);
		await openWebShellWithBgm(page, { openBgm: false });

		const startedAt = await page.evaluate(() => performance.timeOrigin);
		const messages = page.locator(".chat-messages");
		const input = page.locator(".naia-chat-area .chat-input");
		await expect(messages.locator(".chat-message")).toHaveCount(0);
		await expect(input).toBeInViewport();

		for (const model of MODELS) {
			if (mobile) {
				await page.getByRole("button", { name: "Menu", exact: true }).click();
				await page.locator(".web-mobile-menu-list").getByRole("button", { name: /설정/ }).click();
			} else {
				await page.getByRole("button", { name: "설정", exact: true }).click();
			}
			await page.getByRole("button", { name: "두뇌", exact: true }).click();
			const provider = page.getByLabel("프로바이더", { exact: true });
			if (model === MODELS[0]) await provider.selectOption("nextain");
			await expect(provider).toHaveValue("nextain");
			await page.getByLabel("메인 모델", { exact: true }).selectOption(model.id);
			const apply = page.getByRole("button", { name: "적용", exact: true });
			await apply.click();
			await expect(page.getByRole("button", { name: "적용됨!", exact: true })).toBeInViewport();
			await page.getByRole("button", { name: mobile ? "Close" : "설정 닫기", exact: true }).click();
			await expect(provider).toBeHidden();
			await expect(page.getByTestId("web-model-status")).toBeHidden();

			await input.fill(`안녕하세요, ${model.name}.`);
			await expect(input).toBeFocused();
			await input.press("Enter");
			if (model === MODELS[0]) {
				try {
					await expect.poll(() => requests[0]).toEqual({ model: model.id, authenticated: true });
					await expect(page.locator(".chat-cancel-btn")).toBeInViewport();
				} finally {
					releaseTerra();
				}
			}
			await expect(messages.getByText(model.answer, { exact: true })).toBeInViewport();
			await expect(page.locator(".chat-cancel-btn")).toBeHidden();
			expect(await page.evaluate(() => performance.timeOrigin)).toBe(startedAt);
		}
		expect(requests).toEqual(MODELS.map(({ id }) => ({ model: id, authenticated: true })));
		await expect(messages.getByRole("alert")).toHaveCount(0);
		const shots = process.env.NAIA_E2E_SHOTS_DIR;
		if (shots) {
			mkdirSync(shots, { recursive: true });
			await page.screenshot({ path: join(shots, `R45-${viewport.width}.png`) });
		}
	});
}
