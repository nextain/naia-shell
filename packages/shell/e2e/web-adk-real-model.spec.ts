import { chromium, expect, type Page, test } from "@playwright/test";
import { startDefaultWorkspace } from "./helpers/web-workspace";

test.skip(
	process.env.NAIA_E2E_WEB_REALMODEL !== "1",
	"Real model test only runs when NAIA_E2E_WEB_REALMODEL=1",
);

const EXPECTED_COMMIT = "13ea427991542965091f2f3211b9325a36dbd522";
const EXPECTED_AGENTS_SHA = "29350557ec7bef5b9f67ad4ddc26a06a8d6e2de0";
const EXPECTED_CLAUDE_SHA = "43c994c2d3617f947bcb5adf1933e21dabe46bb5";

async function readOpfsAdkStatus(page: Page): Promise<{
	commit: string;
	agentsSize: number;
	agentsSha: string;
	claudeSize: number;
	claudeSha: string;
} | null> {
	return await page.evaluate(async () => {
		try {
			const root = await navigator.storage.getDirectory();
			const adk = await root.getDirectoryHandle("naia-adk");
			const settings = await adk.getDirectoryHandle("naia-settings");
			const sourceFile = await settings.getFileHandle(".web-adk-source.json");
			const sourceText = await (await sourceFile.getFile()).text();
			const marker = JSON.parse(sourceText);

			const gitBlobSha1 = async (bytes: Uint8Array): Promise<string> => {
				const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
				const buf = new Uint8Array(header.byteLength + bytes.byteLength);
				buf.set(header, 0);
				buf.set(bytes, header.byteLength);
				const hashBuffer = await crypto.subtle.digest("SHA-1", buf);
				const hashArray = Array.from(new Uint8Array(hashBuffer));
				return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
			};

			const agentsFile = await (await adk.getFileHandle("AGENTS.md")).getFile();
			const agentsBuf = new Uint8Array(await agentsFile.arrayBuffer());
			const agentsSha = await gitBlobSha1(agentsBuf);

			const claudeFile = await (await adk.getFileHandle("CLAUDE.md")).getFile();
			const claudeBuf = new Uint8Array(await claudeFile.arrayBuffer());
			const claudeSha = await gitBlobSha1(claudeBuf);

			return {
				commit: marker.commit,
				agentsSize: agentsFile.size,
				agentsSha,
				claudeSize: claudeFile.size,
				claudeSha,
			};
		} catch {
			return null;
		}
	});
}

test("real webllm model with OPFS ADK persona and workspace", async ({}, testInfo) => {
	test.setTimeout(16 * 60_000);

	const profileDir = process.env.NAIA_E2E_CHROME_PROFILE;
	if (!profileDir || !profileDir.startsWith("/var/mnt/hdd/")) {
		throw new Error(
			"NAIA_E2E_CHROME_PROFILE environment variable is required and must start with /var/mnt/hdd/",
		);
	}

	const args = [
		"--enable-unsafe-webgpu",
		"--enable-features=Vulkan",
		"--use-angle=vulkan",
	];
	if (process.env.NAIA_E2E_RENDER_NODE) {
		args.push(`--render-node-override=${process.env.NAIA_E2E_RENDER_NODE}`);
	}

	const context = await chromium.launchPersistentContext(profileDir, {
		args,
		headless: true,
		serviceWorkers: "block",
	});

	try {
		const page = context.pages()[0] || (await context.newPage());
		const requestedUrls: string[] = [];
		const responses200: string[] = [];

		page.on("request", (req) => requestedUrls.push(req.url()));
		page.on("response", (res) => {
			if (res.status() === 200) {
				responses200.push(res.url());
			}
		});

		// Precheck: verify /web-adk/${EXPECTED_COMMIT}.json is 200
		const precheckRes = await page.request.get(`/web-adk/${EXPECTED_COMMIT}.json`);
		expect(precheckRes.status()).toBe(200);

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

		// Workspace setup
		await startDefaultWorkspace(page);

		// Check ADK download in OPFS within 60s
		await expect(async () => {
			const opfsCheck = await readOpfsAdkStatus(page);
			expect(opfsCheck).not.toBeNull();
			expect(opfsCheck!.commit).toBe(EXPECTED_COMMIT);
			expect(opfsCheck!.agentsSize).toBe(3860);
			expect(opfsCheck!.agentsSha).toBe(EXPECTED_AGENTS_SHA);
			expect(opfsCheck!.claudeSize).toBe(11);
			expect(opfsCheck!.claudeSha).toBe(EXPECTED_CLAUDE_SHA);
		}).toPass({ timeout: 60_000 });

		// Wait for status bar ready within 10 minutes (600,000 ms)
		const readyStatus = page.locator('[data-phase="ready"]');
		await expect(readyStatus).toBeAttached({ timeout: 10 * 60_000 });

		// Write custom config with persona: "You are 루미..."
		await page.evaluate(async () => {
			const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
			if (
				typeof internals !== "object" ||
				internals === null ||
				!("invoke" in internals) ||
				typeof (internals as { invoke: unknown }).invoke !== "function"
			) {
				throw new Error("__TAURI_INTERNALS__.invoke is not available");
			}
			const invoke = (
				internals as {
					invoke: (cmd: string, args?: unknown) => Promise<unknown>;
				}
			).invoke;
			const config = {
				provider: "webllm",
				model: "Qwen3-4B-q4f32_1-MLC",
				agentName: "루미",
				speechStyle: "casual",
				persona: "You are 루미, an AI companion. Speak casually and warmly.",
				onboardingComplete: true,
				workspaceRoot: "opfs://naia-adk",
				enableTools: true,
				localVoiceEnabled: false,
				NAIA_MAIN_PROVIDER: "webllm",
				NAIA_MAIN_MODEL: "Qwen3-4B-q4f32_1-MLC",
				NAIA_AGENT_NAME: "루미",
				NAIA_SPEECH_STYLE: "casual",
			};
			await invoke("write_naia_config", {
				adkPath: "opfs://naia-adk",
				json: JSON.stringify(config),
			});
		});

		// Send chat message
		await expect(input).toBeEnabled({ timeout: 5000 });
		await input.fill("이름이 뭐야? 한 문장으로 자기소개 해줘.");
		await input.press("Enter");

		// Last assistant reply must contain "루미" within 3 minutes (180,000 ms)
		const assistantReplies = page.locator(".chat-message.assistant");
		await expect(assistantReplies.last()).toContainText("루미", {
			timeout: 3 * 60_000,
		});

		const statusText = (await page.locator("#web-model-status").textContent()) || "";
		const replyText = (await assistantReplies.last().textContent()) || "";

		testInfo.annotations.push(
			{ type: "status-text", description: statusText.trim() },
			{ type: "reply-text", description: replyText.trim() },
		);
	} finally {
		await context.close();
	}
});
