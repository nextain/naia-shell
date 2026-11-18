import { expect, test, type Locator, type Page } from "@playwright/test";

test.skip(process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake", "requires web runtime and fake model");
test.setTimeout(300_000);

async function focusWithTab(page: Page, target: Locator) {
	for (let i = 0; i < 120; i++) {
		await page.keyboard.press("Tab");
		if (await target.evaluate((element) => document.activeElement === element)) return;
	}
	throw new Error("control not reachable by Tab");
}

async function expectPointerTarget(target: Locator) {
	await expect.poll(() => target.evaluate((element) => {
		const r = element.getBoundingClientRect();
		const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return hit === element || (hit !== null && element.contains(hit));
	})).toBe(true);
}

for (const viewport of [
	{ width: 1280, height: 720 },
	{ width: 800, height: 450 },
	{ width: 1920, height: 1080 },
]) {
	test(`messages and model controls remain reachable (${viewport.width}x${viewport.height})`, async ({ browser }) => {
		const context = await browser.newContext({ viewport, locale: "ko-KR" });
		const page = await context.newPage();
		await page.route("**/web-adk/*.json", async (route) => {
			const response = await route.fetch();
			const bundle = await response.json();
			const agents = bundle.files.find((file: { path: string }) => file.path === "AGENTS.md");
			if (!agents) throw new Error("workspace bundle lacks AGENTS.md");
			await route.fulfill({ json: { ...bundle, files: [agents], dirs: [] } });
		});
		await page.addInitScript(() => {
			if (!localStorage.getItem("naia-config")) localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false, locale: "ko" }));
			if (!localStorage.getItem("naia-web-llm-model")) localStorage.setItem("naia-web-llm-model", "Qwen3-4B-q4f32_1-MLC");
		});
		await page.goto("/");
		await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
		await expect(page.locator(".splash-screen")).toHaveCount(0);
		await page.getByTestId("web-workspace-start-default").click();
		await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 120_000 }).toBe("ready");
		await page.evaluate(async () => {
			const statusSource = "/src/lib/web-runtime/web-model-status.ts";
			const chatSource = "/src/stores/chat.ts";
			const status = await import(/* @vite-ignore */ statusSource);
			status.setWebModelStatus({ phase: "ready", progress: 1, model: "Qwen3-4B-q4f32_1-MLC", adapter: { vendor: "nvidia", architecture: "ampere", description: "NVIDIA GeForce RTX 3090" }, shaderF16: false });
			const { useChatStore } = await import(/* @vite-ignore */ chatSource);
			useChatStore.setState({ messages: [{ id: "a", role: "user", content: "화면 메시지 검증", timestamp: 1 }, { id: "b", role: "assistant", content: "두 번째 대화가 보이는지 확인합니다.", timestamp: 2 }] });
		});
		const messages = page.locator(".chat-messages");
		const last = page.locator(".chat-message").last();
		await expect(last).toContainText("두 번째 대화가 보이는지 확인합니다.");
		await expect.poll(() => messages.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(64);
		// Do not scroll here: the newest message must be visible immediately
		// after it is added, before the user manipulates the chat container.
		await expectPointerTarget(last);
		const details = page.getByTestId("web-model-ready-details");
		const summary = details.locator("summary");
		await expect(summary).toContainText("대체 모델");
		await expect(details).not.toHaveAttribute("open", "");
		await summary.scrollIntoViewIfNeeded();
		if (viewport.width === 1280) {
			await expectPointerTarget(summary);
			await summary.click();
		} else {
			await focusWithTab(page, summary);
			await page.keyboard.press("Enter");
		}
		await expect(details).toHaveAttribute("open", "");
		await expect.poll(() => messages.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(64);
		await last.scrollIntoViewIfNeeded();
		await expectPointerTarget(last);
		const returnButton = page.getByTestId("web-model-back-to-default");
		await focusWithTab(page, returnButton);
		await expectPointerTarget(returnButton);
		const input = page.locator(".naia-chat-area .chat-input");
		await focusWithTab(page, input);
		await expectPointerTarget(input);
		await page.evaluate(async () => {
			const source = "/src/lib/web-runtime/web-model-status.ts";
			const status = await import(/* @vite-ignore */ source);
			status.setWebModelStatus({ phase: "error", errorKind: "no-shader-f16", errorMessage: "상세 오류 ".repeat(70), model: "Qwen3-4B-q4f16_1-MLC", shaderF16: false });
		});
		for (const control of [page.getByTestId("web-model-fallback"), page.getByTestId("web-model-retry"), page.locator("#web-model-status summary")]) {
			await focusWithTab(page, control);
			await expectPointerTarget(control);
		}
		await context.close();
	});
}
