import { expect, test } from "@playwright/test";

test.skip(process.env.NAIA_E2E_WEB !== "1", "requires the web runtime");

for (const viewport of [
	{ width: 1280, height: 720 },
	{ width: 800, height: 450 },
	{ width: 390, height: 844 },
	{ width: 844, height: 390 },
]) {
	test(`workspace setup remains clickable with a tall model status (${viewport.width}x${viewport.height})`, async ({ browser }) => {
		const context = await browser.newContext({ viewport });
		const page = await context.newPage();
		await page.addInitScript(() => {
			localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false }));
		});
		await page.goto("/");
		await expect(page.locator(".splash-screen")).toHaveCount(0);
		await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
		await expect(page.getByTestId("web-model-status")).toBeVisible();
		// GPU adapter and fallback information can wrap to several lines.
		await page.addStyleTag({ content: '[data-testid="web-model-status"] { min-height: 96px; }' });
		const start = page.getByTestId("web-workspace-start-default");
		await expect(start).toBeVisible();
		const description = page.locator(".web-workspace-description");
		await expect(description).toBeVisible();
		await expect.poll(() => description.evaluate((element) => {
			const r = element.getBoundingClientRect();
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return hit === element || (hit !== null && element.contains(hit));
		})).toBe(true);
		await expect.poll(() => start.evaluate((button) => {
			const r = button.getBoundingClientRect();
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return hit === button || (hit !== null && button.contains(hit));
		})).toBe(true);
		const rect = await start.boundingBox();
		if (!rect) throw new Error("workspace setup button has no bounding box");
		// A pointer click is deliberate: DOM click and forced click can mask occlusion.
		await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
		await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 90_000 }).toBe("ready");
		await expect(page.getByTestId("web-workspace-setup")).toHaveCount(0);
		await expect(page.locator(".chat-input")).toBeVisible();
		await context.close();
	});
}

test("workspace retry stays clickable after a provisioning failure", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => {
		localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false }));
	});
	await page.addInitScript(() => {
		const originalFetch = window.fetch.bind(window);
		let failOnce = true;
		window.fetch = (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (failOnce && url.includes("/web-adk/") && url.endsWith(".json")) {
				failOnce = false;
				return Promise.reject(new Error("x".repeat(512)));
			}
			return originalFetch(input, init);
		};
	});
	await page.goto("/");
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
	await page.addStyleTag({ content: 'html { font-size: 32px; }' });
	await page.getByTestId("web-workspace-start-default").click();
	await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "error");
	const retry = page.getByTestId("web-workspace-retry");
	await expect.poll(() => retry.evaluate((button) => {
		const r = button.getBoundingClientRect();
		const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return hit === button || (hit !== null && button.contains(hit));
	})).toBe(true);
	const rect = await retry.boundingBox();
	if (!rect) throw new Error("workspace retry button has no bounding box");
	await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
	await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 90_000 }).toBe("ready");
});


test("workspace setup can be started with the keyboard", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
	const start = page.getByTestId("web-workspace-start-default");
	let reached = false;
	for (let i = 0; i < 100; i++) {
		await page.keyboard.press("Tab");
		if (await start.evaluate((button) => document.activeElement === button)) {
			reached = true;
			break;
		}
	}
	expect(reached).toBe(true);
	await page.keyboard.press("Enter");
	await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 90_000 }).toBe("ready");
});


test("setup preserves a conversation after reload", async ({ page }) => {
	test.skip(process.env.VITE_NAIA_WEB_LLM !== "fake", "requires the fake model engine");
	await page.addInitScript(() => {
		localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false }));
	});
	await page.goto("/");
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await page.getByTestId("web-workspace-start-default").click();
	await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 90_000 }).toBe("ready");
	const input = page.locator(".naia-chat-area .chat-input");
	await input.fill("대화 복구 시험");
	await expect(page.locator(".naia-chat-area .chat-send-btn")).toBeEnabled();
	await input.press("Enter");
	await expect(page.getByText("웹 가짜 엔진 응답입니다.", { exact: false })).toBeVisible();
	// The finish event follows persistence; do not reload during an active turn.
	await expect(page.locator(".chat-cancel-btn")).toHaveCount(0);
	await page.reload();
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.getByText("대화 복구 시험", { exact: false })).toBeVisible();
	await expect(page.getByText("웹 가짜 엔진 응답입니다.", { exact: false })).toBeVisible();
});
