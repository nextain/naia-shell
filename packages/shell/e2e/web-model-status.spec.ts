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
	process.env.NAIA_E2E_WEB !== "1",
	"Web model status test only runs when NAIA_E2E_WEB=1",
);

test("verifies web model status lifecycle, worker startup, and mock chat", async ({
	page,
}) => {
	const requestedUrls: string[] = [];
	page.on("request", (req) => {
		requestedUrls.push(req.url());
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

	// Before sending a message: agent-worker is exactly 1 within 10s
	await expect(async () => {
		const agentWorkers = page
			.workers()
			.filter((w) => w.url().includes("agent-worker"));
		expect(agentWorkers).toHaveLength(1);
	}).toPass({ timeout: 10_000 });

	// web-model-status element reaches ready phase within 15s
	const statusEl = page.locator('[data-testid="web-model-status"]');
	await expect(statusEl).toHaveAttribute("data-phase", "ready", {
		timeout: 15_000,
	});
	await expect(statusEl).toHaveAttribute("role", "status");
	await expect(statusEl).toHaveAttribute("data-model", "Qwen3-8B-q4f16_1-MLC");

	// Capture screenshots at widths 1280 and 900
	const screenshotDir = path.resolve(process.cwd(), "test-results/wo06");
	mkdirSync(screenshotDir, { recursive: true });
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.screenshot({ path: path.join(screenshotDir, "ready-1280.png") });
	await page.setViewportSize({ width: 900, height: 800 });
	await page.screenshot({ path: path.join(screenshotDir, "ready-900.png") });
	syncScreenshots();

	// Send message '안녕' and verify response
	await expect(input).toBeEnabled({ timeout: 5000 });
	await input.fill("안녕");
	await input.press("Enter");

	const chatArea = page.locator(".naia-chat-area");
	await expect(chatArea).toContainText("웹 가짜 엔진 응답입니다.", {
		timeout: 15_000,
	});

	// Check huggingface.co is not requested
	for (const url of requestedUrls) {
		expect(url).not.toContain("huggingface.co");
	}

	expect(
		pageErrors,
		`Unexpected page errors during test:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
	).toHaveLength(0);
});
