import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

test.skip(
	process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "webllm",
	"requires web runtime and a real model readiness check",
);

async function checkComposerPlacement(input: Locator, viewport: { width: number; height: number }) {
	await expect(input).toBeVisible();
	const layout = await input.evaluate(async (textarea) => {
		const wrapper = textarea.closest(".naia-chat-wrapper")!;
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		await Promise.allSettled(wrapper.getAnimations().map((animation) => animation.finished));
		const rect = textarea.getBoundingClientRect();
		const composer = textarea.closest(".chat-input-bar")!.getBoundingClientRect();
		const chat = textarea.closest(".chat-app")!.getBoundingClientRect();
		return {
			width: window.innerWidth,
			height: window.innerHeight,
			inputTop: rect.top,
			inputBottom: rect.bottom,
			composerBottom: composer.bottom,
			chatBottom: chat.bottom,
		};
	});
	expect({ width: layout.width, height: layout.height }).toEqual(viewport);
	expect(layout.inputTop).toBeGreaterThanOrEqual(0);
	expect(layout.inputBottom).toBeLessThanOrEqual(layout.height);
	expect(layout.composerBottom).toBeCloseTo(layout.chatBottom, 0);
	return layout;
}

for (const initialViewport of WEB_BGM_VIEWPORTS) {
	test(`R44 keeps the composer on screen through a model error and resizing (${initialViewport.width}×${initialViewport.height})`, async ({ page }, testInfo) => {
		await page.setViewportSize(initialViewport);
		await page.context().route(/^https?:\/\/(?!(?:localhost|127\.0\.0\.1)(?::\d+)?\/)/, (route) => route.abort());
		await page.addInitScript(() => {
			// The browser has a WebGPU API, but it cannot obtain an adapter.
			// Hold the check so the checking and error layouts are both exercised.
			const adapter = new Promise<null>((resolve) => {
				window.addEventListener("r44-no-gpu-adapter", () => resolve(null), { once: true });
			});
			Object.defineProperty(navigator, "gpu", {
				configurable: true,
				value: { requestAdapter: () => adapter },
			});
		});
		await openWebShellWithBgm(page, { openBgm: false });

		const input = page.locator(".naia-chat-area .chat-input");
		const status = page.getByTestId("web-model-status");
		await expect(page.locator(".chat-messages .chat-message")).toHaveCount(0);
		await expect(status).toHaveAttribute("role", "status");
		await expect(status).toHaveAttribute("data-phase", "checking");
		const checking = await checkComposerPlacement(input, initialViewport);
		await page.evaluate(() => window.dispatchEvent(new Event("r44-no-gpu-adapter")));
		await expect(status).toHaveAttribute("role", "alert");
		await expect(status).toHaveAttribute("data-error-kind", "no-webgpu");
		const firstError = await checkComposerPlacement(input, initialViewport);
		const shots = process.env.NAIA_E2E_SHOTS_DIR;
		if (shots) {
			mkdirSync(shots, { recursive: true });
			await page.screenshot({ path: join(shots, `R44-${initialViewport.width}.png`) });
		}

		const retry = status.getByRole("button", { name: "다시 시도" });
		await retry.focus();
		await expect(retry).toBeFocused();
		await expect(retry).toBeInViewport();
		const details = status.locator("details");
		await details.locator("summary").press("Enter");
		await expect(details).toHaveAttribute("open", "");
		await expect.poll(() => status.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
		const expandedError = await checkComposerPlacement(input, initialViewport);

		const otherViewport = WEB_BGM_VIEWPORTS.find(({ width }) => width !== initialViewport.width)!;
		await page.setViewportSize(otherViewport);
		await expect(status).toHaveAttribute("role", "alert");
		if (otherViewport.width === 390) {
			await expect(page.locator(".naia-chat-area")).toHaveAttribute("data-mobile-sheet", "collapsed");
		}
		const resized = await checkComposerPlacement(input, otherViewport);
		await page.setViewportSize(initialViewport);
		const resizedBack = await checkComposerPlacement(input, initialViewport);

		await input.focus();
		await expect(input).toBeFocused();
		await input.press("A");
		await expect(input).toHaveValue("A");
		await page.evaluate(async () => {
			const source = "/src/lib/web-runtime/web-model-status.ts";
			const model = await import(/* @vite-ignore */ source);
			model.setWebModelStatus({ phase: "ready", model: "Qwen3-4B-q4f32_1-MLC", progress: 1 });
		});
		await expect(status).toHaveAttribute("role", "status");
		await expect(status).toHaveAttribute("data-phase", "ready");
		await expect(input).toHaveValue("A");
		const ready = await checkComposerPlacement(input, initialViewport);
		expect(ready.inputTop).toBeCloseTo(checking.inputTop, 0);
		expect(ready.inputBottom).toBeCloseTo(checking.inputBottom, 0);
		await testInfo.attach("R44 viewport geometry", {
			body: JSON.stringify({ checking, firstError, expandedError, resized, resizedBack, ready }, null, 2),
			contentType: "application/json",
		});
	});
}
