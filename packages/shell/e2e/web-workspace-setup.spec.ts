import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"Web workspace setup test only runs when NAIA_E2E_WEB=1",
);

const FIXED_ADK_COMMIT = "13ea427991542965091f2f3211b9325a36dbd522";

test("작업 공간 준비 흐름, 설치, 말 걸기, 새로 고침, 콘솔/외부요청 검증", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const page = await context.newPage();

	const requestedUrls: string[] = [];
	const consoleMessages: string[] = [];
	const pageErrors: Error[] = [];

	page.on("request", (req) => requestedUrls.push(req.url()));
	page.on("console", (msg) => consoleMessages.push(msg.text()));
	page.on("pageerror", (err) => pageErrors.push(err));

	const t0 = Date.now();
	await page.goto("/");

	// Condition 1: [data-app-ready="true"] within 30s
	let left = 30_000 - (Date.now() - t0);
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: Math.max(left, 1000),
	});

	// Condition 2: .splash-screen count is 0 within 30s
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

	// Setup screen is displayed with data-phase="needs-setup"
	const setup = page.locator('[data-testid="web-workspace-setup"]');
	await expect(setup).toBeVisible({ timeout: 10_000 });
	await expect(setup).toHaveAttribute("data-phase", "needs-setup");

	// Sending is blocked while workspace is not ready
	await input.fill("안녕");
	await input.press("Enter");
	await expect(input).toHaveValue("안녕");
	await expect(page.locator(".chat-send-btn")).toBeDisabled();
	await expect(page.locator(".chat-message.user")).toHaveCount(0);
	await input.clear();

	// BGM player widget must not exist in web mode
	expect(await page.locator(".bgm-player").count()).toBe(0);

	// Screenshot: needs-setup-1280.png
	const shotDir = process.env.WO11_SHOT_DIR;
	if (shotDir) {
		mkdirSync(shotDir, { recursive: true });
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({ path: path.join(shotDir, "needs-setup-1280.png") });
	}

	// Hold the bundle route to observe the installing phase
	let releaseHold: () => void = () => {};
	const holdPromise = new Promise<void>((resolve) => {
		releaseHold = resolve;
	});

	await page.route("**/web-adk/*.json", async (route) => {
		await holdPromise;
		await route.continue();
	});

	const startBtn = page.locator('[data-testid="web-workspace-start-default"]');
	await startBtn.click();

	// Setup enters "installing" phase
	await expect(setup).toHaveAttribute("data-phase", "installing", {
		timeout: 5000,
	});

	// Release route hold to allow download to complete
	releaseHold();

	// Setup screen disappears and status bar reaches ready
	await expect(setup).not.toBeVisible({ timeout: 30_000 });
	const readyStatus = page.locator('[data-phase="ready"]');
	await expect(readyStatus).toBeAttached({ timeout: 30_000 });

	// Verify all 116 files in OPFS match bundle git blob SHA-1 and sizes
	const verificationResult = await page.evaluate(async (commit) => {
		const res = await fetch(`/web-adk/${commit}.json`);
		if (!res.ok) throw new Error(`Failed to fetch bundle: ${res.status}`);
		interface BundleData {
			repo: string;
			commit: string;
			files: Array<{ path: string; size: number; sha1: string }>;
			dirs: string[];
		}
		const bundle = (await res.json()) as BundleData;

		const root = await navigator.storage.getDirectory();
		const adk = await root.getDirectoryHandle("naia-adk");
		const settings = await adk.getDirectoryHandle("naia-settings");
		const markerFile = await settings.getFileHandle(".web-adk-source.json");
		interface MarkerData {
			source: string;
			repo: string;
			commit: string;
			fileCount: number;
		}
		const marker = JSON.parse(await (await markerFile.getFile()).text()) as MarkerData;

		const gitBlobSha1 = async (bytes: Uint8Array): Promise<string> => {
			const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
			const buf = new Uint8Array(header.byteLength + bytes.byteLength);
			buf.set(header, 0);
			buf.set(bytes, header.byteLength);
			const hashBuffer = await crypto.subtle.digest("SHA-1", buf);
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
		};

		let matched = 0;
		for (const file of bundle.files) {
			const parts = file.path.split("/");
			let dir = adk;
			for (let i = 0; i < parts.length - 1; i++) {
				dir = await dir.getDirectoryHandle(parts[i]);
			}
			const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
			const f = await fileHandle.getFile();
			const buf = new Uint8Array(await f.arrayBuffer());
			const sha1 = await gitBlobSha1(buf);
			if (sha1 === file.sha1 && buf.byteLength === file.size) {
				matched++;
			}
		}

		return {
			bundleTotal: bundle.files.length,
			matched,
			marker,
		};
	}, FIXED_ADK_COMMIT);

	expect(verificationResult.bundleTotal).toBe(116);
	expect(verificationResult.matched).toBe(116);
	expect(verificationResult.marker).toEqual({
		source: "bundle",
		repo: "nextain/naia-adk",
		commit: FIXED_ADK_COMMIT,
		fileCount: 116,
	});

	// Screenshot: ready-1280.png
	if (shotDir) {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({ path: path.join(shotDir, "ready-1280.png") });
	}

	// ChatArea message can now be sent; send message and verify fake engine reply
	await input.fill("안녕");
	await expect(page.locator(".chat-send-btn")).toBeEnabled({ timeout: 5000 });
	await input.press("Enter");

	const chatArea = page.locator(".naia-chat-area");
	await expect(chatArea).toContainText("웹 가짜 엔진 응답입니다.", {
		timeout: 15_000,
	});

	// Verify no external requests to raw.githubusercontent.com or www.naia.land
	for (const url of requestedUrls) {
		expect(url).not.toContain("raw.githubusercontent.com");
		expect(url).not.toContain("www.naia.land");
	}

	// Verify no desktop BGM or sandbox logs in console
	for (const msg of consoleMessages) {
		expect(msg).not.toContain("ensure_bgm_server");
		expect(msg).not.toContain("app_sandbox_");
	}

	// Reload: ready without setup screen, 0 new bundle fetches
	let reloadedBundleFetched = false;
	page.on("request", (req) => {
		if (req.url().includes(`/web-adk/${FIXED_ADK_COMMIT}.json`)) {
			reloadedBundleFetched = true;
		}
	});

	await page.reload();
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: 30_000,
	});
	await expect(page.locator(".splash-screen")).toHaveCount(0, {
		timeout: 30_000,
	});
	expect(await page.locator('[data-testid="web-workspace-setup"]').count()).toBe(0);
	await expect(readyStatus).toBeAttached({ timeout: 30_000 });
	expect(reloadedBundleFetched).toBe(false);

	expect(pageErrors).toHaveLength(0);
	await context.close();
});

test("가짜 실패와 다시 시도", async ({ browser }) => {
	const context = await browser.newContext();
	const page = await context.newPage();

	let shouldFail = true;
	await page.route("**/web-adk/*.json", async (route) => {
		if (shouldFail) {
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ error: "Simulated bundle download error" }),
			});
		} else {
			await route.continue();
		}
	});

	const t0 = Date.now();
	await page.goto("/");

	let left = 30_000 - (Date.now() - t0);
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: Math.max(left, 1000),
	});

	const setup = page.locator('[data-testid="web-workspace-setup"]');
	await expect(setup).toBeVisible({ timeout: 10_000 });
	await expect(setup).toHaveAttribute("data-phase", "needs-setup");

	const startBtn = page.locator('[data-testid="web-workspace-start-default"]');
	await startBtn.click();

	// Setup transitions to "error" phase with retry button
	await expect(setup).toHaveAttribute("data-phase", "error", { timeout: 15_000 });
	const retryBtn = page.locator('[data-testid="web-workspace-retry"]');
	await expect(retryBtn).toBeVisible({ timeout: 5000 });

	// Unblock route and click retry
	shouldFail = false;
	await retryBtn.click();

	// Transitions through installing to ready
	await expect(setup).not.toBeVisible({ timeout: 30_000 });
	await expect(page.locator('[data-phase="ready"]')).toBeAttached({
		timeout: 30_000,
	});

	await context.close();
});
