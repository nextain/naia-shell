import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"Web workspace OPFS test only runs when NAIA_E2E_WEB=1",
);

const FIXED_ADK_COMMIT = "13ea427991542965091f2f3211b9325a36dbd522";

function getAdkRepo(): string {
	const repo = process.env.NAIA_E2E_ADK_REPO;
	if (!repo) {
		throw new Error(
			"NAIA_E2E_ADK_REPO environment variable is required for web workspace OPFS tests",
		);
	}
	return repo;
}

test("첫 실행", async ({ browser }) => {
	const adkRepo = getAdkRepo();
	const context = await browser.newContext();
	const page = await context.newPage();

	const interceptedPaths: string[] = [];
	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];

	page.on("request", (req) => requestedUrls.push(req.url()));
	page.on("pageerror", (err) => pageErrors.push(err));

	await context.route("**/__naia_e2e_adk__/**", async (route, req) => {
		const url = req.url();
		const idx = url.indexOf("/__naia_e2e_adk__/");
		const sub = decodeURIComponent(url.slice(idx + "/__naia_e2e_adk__/".length));
		interceptedPaths.push(sub);
		try {
			const stdout = execFileSync("git", [
				"-C",
				adkRepo,
				"show",
				`${FIXED_ADK_COMMIT}:${sub}`,
			]);
			await route.fulfill({
				status: 200,
				contentType: "application/octet-stream",
				body: stdout,
			});
		} catch {
			await route.fulfill({ status: 404, body: "Not found" });
		}
	});

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

	// Condition 3: main chat input .naia-chat-area .chat-input is visible within 30s
	left = 30_000 - (Date.now() - t0);
	const input = page.locator(".naia-chat-area .chat-input");
	await expect(input).toBeVisible({
		timeout: Math.max(left, 1000),
	});

	// Onboarding and ADK setup screen count 0
	const onboardingCount = await page
		.locator('[data-testid="onboarding"]')
		.count();
	expect(
		onboardingCount,
		"Onboarding screen must not be visible on web boot",
	).toBe(0);

	const adkSetupCount = await page.locator(".adk-setup-screen").count();
	expect(
		adkSetupCount,
		"ADK setup screen must not be visible on web boot",
	).toBe(0);

	// Read initial config from OPFS naia-adk/naia-settings/config.json
	const configText = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const adkDir = await root.getDirectoryHandle("naia-adk");
		const settingsDir = await adkDir.getDirectoryHandle("naia-settings");
		const fileHandle = await settingsDir.getFileHandle("config.json");
		const file = await fileHandle.getFile();
		return await file.text();
	});

	const parsed = JSON.parse(configText);
	expect(parsed).toMatchObject({
		provider: "webllm",
		model: "Qwen3-4B-q4f16_1-MLC",
		agentName: "Naia",
		speechStyle: "casual",
		persona: "You are Naia, an AI companion. Speak casually and warmly.",
		onboardingComplete: true,
	});

	// Screenshot test-results/wo08/main-1280.png
	const screenshotPath = path.resolve("test-results/wo08/main-1280.png");
	fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.screenshot({ path: screenshotPath });

	// Ensure no external github request
	for (const url of requestedUrls) {
		expect(url).not.toContain("raw.githubusercontent.com");
	}

	expect(
		pageErrors,
		`Unexpected page errors during test:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
	).toHaveLength(0);

	await context.close();
});

test("설정 왕복", async ({ browser }) => {
	const adkRepo = getAdkRepo();
	const context = await browser.newContext();
	const page = await context.newPage();

	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];

	page.on("request", (req) => requestedUrls.push(req.url()));
	page.on("pageerror", (err) => pageErrors.push(err));

	await context.route("**/__naia_e2e_adk__/**", async (route, req) => {
		const url = req.url();
		const idx = url.indexOf("/__naia_e2e_adk__/");
		const sub = decodeURIComponent(url.slice(idx + "/__naia_e2e_adk__/".length));
		try {
			const stdout = execFileSync("git", [
				"-C",
				adkRepo,
				"show",
				`${FIXED_ADK_COMMIT}:${sub}`,
			]);
			await route.fulfill({
				status: 200,
				contentType: "application/octet-stream",
				body: stdout,
			});
		} catch {
			await route.fulfill({ status: 404, body: "Not found" });
		}
	});

	await page.goto("/");
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: 30_000,
	});

	// Write custom config with agentName E2E-ROUNDTRIP
	const writeResult = await page.evaluate(async () => {
		const internals = (
			window as unknown as {
				__TAURI_INTERNALS__: {
					invoke: (cmd: string, args: unknown) => Promise<unknown>;
				};
			}
		).__TAURI_INTERNALS__;
		const customConfig = {
			provider: "webllm",
			model: "Qwen3-4B-q4f16_1-MLC",
			agentName: "E2E-ROUNDTRIP",
			speechStyle: "casual",
			persona: "You are Naia, an AI companion. Speak casually and warmly.",
			onboardingComplete: true,
		};
		return await internals.invoke("write_naia_config", {
			adkPath: "opfs://naia-adk",
			json: JSON.stringify(customConfig),
		});
	});
	expect(writeResult).toBeNull();

	// Reload and read back
	await page.reload();
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: 30_000,
	});

	const readResult = await page.evaluate(async () => {
		const internals = (
			window as unknown as {
				__TAURI_INTERNALS__: {
					invoke: (cmd: string, args: unknown) => Promise<unknown>;
				};
			}
		).__TAURI_INTERNALS__;
		return await internals.invoke("read_naia_config", {
			adkPath: "opfs://naia-adk",
		});
	});
	expect(String(readResult)).toContain("E2E-ROUNDTRIP");

	// Invalid JSON string "{" rejected with naia_config_invalid_json
	const invalidJsonError = await page.evaluate(async () => {
		const internals = (
			window as unknown as {
				__TAURI_INTERNALS__: {
					invoke: (cmd: string, args: unknown) => Promise<unknown>;
				};
			}
		).__TAURI_INTERNALS__;
		try {
			await internals.invoke("write_naia_config", {
				adkPath: "opfs://naia-adk",
				json: "{",
			});
			return null;
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
	});
	expect(invalidJsonError).toContain("naia_config_invalid_json");

	// Mismatched path rejected with web_adk_path_mismatch:/tmp/x
	const mismatchPathError = await page.evaluate(async () => {
		const internals = (
			window as unknown as {
				__TAURI_INTERNALS__: {
					invoke: (cmd: string, args: unknown) => Promise<unknown>;
				};
			}
		).__TAURI_INTERNALS__;
		try {
			await internals.invoke("write_naia_config", {
				adkPath: "/tmp/x",
				json: JSON.stringify({ ok: true }),
			});
			return null;
		} catch (e) {
			return e instanceof Error ? e.message : String(e);
		}
	});
	expect(mismatchPathError).toContain("web_adk_path_mismatch:/tmp/x");

	for (const url of requestedUrls) {
		expect(url).not.toContain("raw.githubusercontent.com");
	}

	expect(
		pageErrors,
		`Unexpected page errors during test:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
	).toHaveLength(0);

	await context.close();
});

test("ADK 받기", async ({ browser }) => {
	const adkRepo = getAdkRepo();
	const context = await browser.newContext();
	const page = await context.newPage();

	const interceptedPaths: string[] = [];
	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];

	page.on("request", (req) => requestedUrls.push(req.url()));
	page.on("pageerror", (err) => pageErrors.push(err));

	await context.route("**/__naia_e2e_adk__/**", async (route, req) => {
		const url = req.url();
		const idx = url.indexOf("/__naia_e2e_adk__/");
		const sub = decodeURIComponent(url.slice(idx + "/__naia_e2e_adk__/".length));
		interceptedPaths.push(sub);
		try {
			const stdout = execFileSync("git", [
				"-C",
				adkRepo,
				"show",
				`${FIXED_ADK_COMMIT}:${sub}`,
			]);
			await route.fulfill({
				status: 200,
				contentType: "application/octet-stream",
				body: stdout,
			});
		} catch {
			await route.fulfill({ status: 404, body: "Not found" });
		}
	});

	await page.goto("/");
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: 30_000,
	});

	// Wait up to 30s for .web-adk-source.json to exist in OPFS
	await expect(async () => {
		const marker = await page.evaluate(async () => {
			try {
				const root = await navigator.storage.getDirectory();
				const adk = await root.getDirectoryHandle("naia-adk");
				const settings = await adk.getDirectoryHandle("naia-settings");
				const fileHandle = await settings.getFileHandle(
					".web-adk-source.json",
				);
				const file = await fileHandle.getFile();
				return JSON.parse(await file.text());
			} catch {
				return null;
			}
		});
		expect(marker).not.toBeNull();
		expect(marker.commit).toBe(FIXED_ADK_COMMIT);
	}).toPass({ timeout: 30_000 });

	const { agentsSize, claudeText, hasTemplateProject } = await page.evaluate(
		async () => {
			const root = await navigator.storage.getDirectory();
			const adk = await root.getDirectoryHandle("naia-adk");

			const agentsHandle = await adk.getFileHandle("AGENTS.md");
			const agentsFile = await agentsHandle.getFile();

			const claudeHandle = await adk.getFileHandle("CLAUDE.md");
			const claudeFile = await claudeHandle.getFile();

			const projectsDir = await adk.getDirectoryHandle("projects");
			let hasProj = false;
			try {
				await projectsDir.getDirectoryHandle("naia-template-project");
				hasProj = true;
			} catch {
				hasProj = false;
			}

			return {
				agentsSize: agentsFile.size,
				claudeText: await claudeFile.text(),
				hasTemplateProject: hasProj,
			};
		},
	);

	expect(agentsSize).toBe(3860);
	expect(claudeText.startsWith("@AGENTS.md")).toBe(true);
	expect(hasTemplateProject).toBe(true);

	expect(interceptedPaths.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);

	// Reloading the same context should not trigger new fetch requests
	const initialInterceptedCount = interceptedPaths.length;
	await page.reload();
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: 30_000,
	});
	expect(interceptedPaths.length).toBe(initialInterceptedCount);

	for (const url of requestedUrls) {
		expect(url).not.toContain("raw.githubusercontent.com");
	}

	expect(
		pageErrors,
		`Unexpected page errors during test:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
	).toHaveLength(0);

	await context.close();
});
