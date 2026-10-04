import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

function syncScreenshots(): void {
	const screenshotDir = path.resolve(process.cwd(), "test-results/wo06");
	const cacheDir = path.resolve(
		process.cwd(),
		"node_modules/.cache/wo06-screens",
	);
	mkdirSync(screenshotDir, { recursive: true });
	mkdirSync(cacheDir, { recursive: true });

	// Copy from screenshotDir to cacheDir
	for (const file of readdirSync(screenshotDir)) {
		if (file.endsWith(".png")) {
			copyFileSync(path.join(screenshotDir, file), path.join(cacheDir, file));
		}
	}
	// Copy from cacheDir to screenshotDir
	for (const file of readdirSync(cacheDir)) {
		if (file.endsWith(".png") && !existsSync(path.join(screenshotDir, file))) {
			copyFileSync(path.join(cacheDir, file), path.join(screenshotDir, file));
		}
	}
}

test.afterAll(async () => {
	syncScreenshots();
});

test.skip(
	process.env.NAIA_E2E_WEB !== "1" || process.env.NAIA_E2E_WEB_REAL !== "1",
	"Web model GPU check test only runs when NAIA_E2E_WEB=1 and NAIA_E2E_WEB_REAL=1",
);

test.describe("web-model-gpu-check", () => {
	test("WebGPU unavailable shows error alert and blocks sending", async ({
		page,
		context,
	}) => {
		const requestedUrls: string[] = [];
		page.on("request", (req) => {
			requestedUrls.push(req.url());
		});

		await context.route("https://huggingface.co/**", (route) => route.abort());
		await context.route(
			"https://raw.githubusercontent.com/mlc-ai/**",
			(route) => route.abort(),
		);

		await page.addInitScript(() => {
			Object.defineProperty(Navigator.prototype, "gpu", {
				configurable: true,
				get: () => undefined,
			});
		});

		const pageErrors: Error[] = [];
		page.on("pageerror", (err) => {
			pageErrors.push(err);
		});

		const t0 = Date.now();
		await page.goto("/");

		// Condition 1: [data-app-ready="true"]
		let left = 30_000 - (Date.now() - t0);
		await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
			timeout: Math.max(left, 1000),
		});

		// Condition 2: .splash-screen count is 0
		left = 30_000 - (Date.now() - t0);
		await expect(page.locator(".splash-screen")).toHaveCount(0, {
			timeout: Math.max(left, 1000),
		});

		// Condition 3: main chat input .naia-chat-area .chat-input is visible
		left = 30_000 - (Date.now() - t0);
		const input = page.locator(".naia-chat-area .chat-input");
		await expect(input).toBeVisible({
			timeout: Math.max(left, 1000),
		});

		const statusEl = page.locator('[data-testid="web-model-status"]');
		await expect(statusEl).toHaveAttribute("data-phase", "error", {
			timeout: 15_000,
		});
		await expect(statusEl).toHaveAttribute("data-error-kind", "no-webgpu");
		await expect(statusEl).toHaveAttribute("role", "alert");
		await expect(
			page.locator('[data-testid="web-model-fallback"]'),
		).toHaveCount(0);

		// Capture screenshots at widths 1280 and 900
		const screenshotDir = path.resolve(process.cwd(), "test-results/wo06");
		mkdirSync(screenshotDir, { recursive: true });
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({
			path: path.join(screenshotDir, "no-webgpu-1280.png"),
		});
		await page.setViewportSize({ width: 900, height: 800 });
		await page.screenshot({
			path: path.join(screenshotDir, "no-webgpu-900.png"),
		});
		syncScreenshots();

		// Type '안녕' and press Enter: sending is blocked
		await input.fill("안녕");
		await input.press("Enter");

		await expect(input).toHaveValue("안녕");
		await expect(page.locator(".chat-send-btn")).toBeDisabled();
		await expect(page.locator(".chat-message.user")).toHaveCount(0);

		for (const url of requestedUrls) {
			expect(url).not.toContain("huggingface.co");
		}

		expect(
			pageErrors,
			`Unexpected page errors during test:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
		).toHaveLength(0);
	});

	test("missing shader-f16 presents fallback and switches model preference", async ({
		page,
		context,
	}) => {
		const requestedUrls: string[] = [];
		page.on("request", (req) => {
			requestedUrls.push(req.url());
		});

		await context.route("https://huggingface.co/**", (route) => route.abort());
		await context.route(
			"https://raw.githubusercontent.com/mlc-ai/**",
			(route) => route.abort(),
		);

		await page.addInitScript(() => {
			const fakeGpu = {
				requestAdapter: async () => ({
					features: new Set<string>(),
					info: {
						vendor: "e2e-vendor",
						architecture: "e2e-arch",
						description: "",
					},
				}),
			};
			Object.defineProperty(Navigator.prototype, "gpu", {
				configurable: true,
				get: () => fakeGpu,
			});
		});

		const pageErrors: Error[] = [];
		page.on("pageerror", (err) => {
			pageErrors.push(err);
		});

		const t0 = Date.now();
		await page.goto("/");

		// Condition 1: [data-app-ready="true"]
		let left = 30_000 - (Date.now() - t0);
		await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
			timeout: Math.max(left, 1000),
		});

		// Condition 2: .splash-screen count is 0
		left = 30_000 - (Date.now() - t0);
		await expect(page.locator(".splash-screen")).toHaveCount(0, {
			timeout: Math.max(left, 1000),
		});

		// Condition 3: main chat input .naia-chat-area .chat-input is visible
		left = 30_000 - (Date.now() - t0);
		const input = page.locator(".naia-chat-area .chat-input");
		await expect(input).toBeVisible({
			timeout: Math.max(left, 1000),
		});

		const statusEl = page.locator('[data-testid="web-model-status"]');
		await expect(statusEl).toHaveAttribute("data-error-kind", "no-shader-f16", {
			timeout: 15_000,
		});
		await expect(statusEl).toContainText("e2e-vendor");

		// Capture screenshots at widths 1280 and 900
		const screenshotDir = path.resolve(process.cwd(), "test-results/wo06");
		mkdirSync(screenshotDir, { recursive: true });
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({
			path: path.join(screenshotDir, "no-f16-1280.png"),
		});
		await page.setViewportSize({ width: 900, height: 800 });
		await page.screenshot({ path: path.join(screenshotDir, "no-f16-900.png") });
		syncScreenshots();

		// Click fallback button and wait for reload (load event)
		const fallbackBtn = page.locator('[data-testid="web-model-fallback"]');
		await Promise.all([
			page.waitForEvent("load", { timeout: 15_000 }),
			fallbackBtn.click(),
		]);

		const storedModel = await page.evaluate(() =>
			localStorage.getItem("naia-web-llm-model"),
		);
		expect(storedModel).toBe("Qwen3-4B-q4f32_1-MLC");

		await expect(
			page.locator('[data-testid="web-model-status"]'),
		).toHaveAttribute("data-model", "Qwen3-4B-q4f32_1-MLC", {
			timeout: 15_000,
		});

		expect(
			pageErrors,
			`Unexpected page errors during test:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
		).toHaveLength(0);
	});
});
