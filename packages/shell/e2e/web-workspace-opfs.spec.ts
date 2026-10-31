import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startDefaultWorkspace } from "./helpers/web-workspace";

test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"Web workspace OPFS test only runs when NAIA_E2E_WEB=1",
);

const FIXED_ADK_COMMIT = "13ea427991542965091f2f3211b9325a36dbd522";

test("첫 실행", async ({ browser }) => {
	const context = await browser.newContext();
	const page = await context.newPage();

	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];

	page.on("request", (req) => requestedUrls.push(req.url()));
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
	expect(parsed).toEqual({
		provider: "webllm",
		model: "Qwen3-4B-q4f16_1-MLC",
		agentName: "Naia",
		speechStyle: "casual",
		persona: "You are Naia, an AI companion. Speak casually and warmly.",
		onboardingComplete: true,
		workspaceRoot: "opfs://naia-adk",
		enableTools: true,
		localVoiceEnabled: false,
		NAIA_MAIN_PROVIDER: "webllm",
		NAIA_MAIN_MODEL: "Qwen3-4B-q4f16_1-MLC",
		NAIA_AGENT_NAME: "Naia",
		NAIA_SPEECH_STYLE: "casual",
	});

	const shotDir = process.env.WO08_SHOT_DIR;
	if (shotDir) {
		fs.mkdirSync(shotDir, { recursive: true });
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({ path: path.join(shotDir, "main-1280.png") });
		await page.setViewportSize({ width: 900, height: 800 });
		await page.screenshot({ path: path.join(shotDir, "main-900.png") });
	}

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
	const context = await browser.newContext();
	const page = await context.newPage();

	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];

	page.on("request", (req) => requestedUrls.push(req.url()));
	page.on("pageerror", (err) => pageErrors.push(err));

	await page.goto("/");
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: 30_000,
	});

	// Write custom config with agentName E2E-ROUNDTRIP
	const writeResult = await page.evaluate(async () => {
		const internals = Reflect.get(window, "__TAURI_INTERNALS__") as {
			invoke: (cmd: string, args: unknown) => Promise<unknown>;
		};
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
		const internals = Reflect.get(window, "__TAURI_INTERNALS__") as {
			invoke: (cmd: string, args: unknown) => Promise<unknown>;
		};
		return await internals.invoke("read_naia_config", {
			adkPath: "opfs://naia-adk",
		});
	});
	expect(String(readResult)).toContain("E2E-ROUNDTRIP");

	// Invalid JSON string "{" rejected with naia_config_invalid_json
	const invalidJsonError = await page.evaluate(async () => {
		const internals = Reflect.get(window, "__TAURI_INTERNALS__") as {
			invoke: (cmd: string, args: unknown) => Promise<unknown>;
		};
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
		const internals = Reflect.get(window, "__TAURI_INTERNALS__") as {
			invoke: (cmd: string, args: unknown) => Promise<unknown>;
		};
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
	const context = await browser.newContext();
	const page = await context.newPage();

	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];

	page.on("request", (req) => requestedUrls.push(req.url()));
	page.on("pageerror", (err) => pageErrors.push(err));

	await page.goto("/");
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: 30_000,
	});

	// Install default workspace via UI
	await startDefaultWorkspace(page);

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

		let hasTemplate = false;
		try {
			const projDir = await adk.getDirectoryHandle("projects");
			await projDir.getDirectoryHandle("naia-template-project");
			hasTemplate = true;
		} catch {
			hasTemplate = false;
		}

		return {
			bundleTotal: bundle.files.length,
			matched,
			marker,
			hasTemplate,
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
	expect(verificationResult.hasTemplate).toBe(true);

	// Reloading the same context should not trigger new bundle fetch
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
	await startDefaultWorkspace(page);
	expect(reloadedBundleFetched).toBe(false);

	for (const url of requestedUrls) {
		expect(url).not.toContain("raw.githubusercontent.com");
	}

	expect(
		pageErrors,
		`Unexpected page errors during test:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
	).toHaveLength(0);

	await context.close();
});
