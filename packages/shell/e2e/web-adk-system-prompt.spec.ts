import { mkdirSync } from "node:fs";
import { type BrowserContext, expect, type Page, test, type Worker } from "@playwright/test";
import { getAdkRepo, routeWebAdkRepo } from "./helpers/web-adk-route";

test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"Web ADK system prompt test only runs when NAIA_E2E_WEB=1",
);

const INITIAL_CONFIG = {
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
};

async function writeConfig(
	page: Page,
	config: Record<string, unknown>,
): Promise<void> {
	await page.evaluate(async (cfg) => {
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
		await invoke("write_naia_config", {
			adkPath: "opfs://naia-adk",
			json: JSON.stringify(cfg),
		});
		localStorage.setItem("naia-config", JSON.stringify(cfg));
	}, config);

	const readBack = await page.evaluate(async () => {
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
		return await invoke("read_naia_config", {
			adkPath: "opfs://naia-adk",
		});
	});

	const parsed = JSON.parse(String(readBack));
	expect(parsed.agentName).toBe(config.agentName);
	expect(parsed.persona).toBe(config.persona);
}

async function getAgentWorker(page: Page): Promise<Worker> {
	await expect(async () => {
		const workers = page
			.workers()
			.filter((w) => w.url().includes("agent-worker"));
		expect(workers.length).toBe(1);
	}).toPass({ timeout: 15_000 });
	return page.workers().find((w) => w.url().includes("agent-worker"))!;
}

async function prepareWebAdkPage(
	context: BrowserContext,
	page: Page,
	requestedUrls: string[],
	pageErrors: Error[],
): Promise<void> {
	getAdkRepo(); // throws if NAIA_E2E_ADK_REPO is not set

	page.on("request", (req) => requestedUrls.push(req.url()));
	page.on("pageerror", (err) => pageErrors.push(err));

	await routeWebAdkRepo(context);

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

	// OPFS marker naia-adk/naia-settings/.web-adk-source.json within 30s
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
	}).toPass({ timeout: 30_000 });

	// Status bar data-phase="ready" within 15s
	await expect(page.locator('[data-phase="ready"]')).toBeAttached({
		timeout: 15_000,
	});
}

function verifyNoExternalRequests(requestedUrls: string[]): void {
	for (const url of requestedUrls) {
		expect(url).not.toContain("raw.githubusercontent.com");
		expect(url).not.toContain("huggingface.co");
	}
}

test("ADK 페르소나와 워크스페이스가 시스템 메시지에 들어가고 답이 대화창에 나온다", async ({
	browser,
}, testInfo) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];
	let systemPromptText = "";

	try {
		await prepareWebAdkPage(context, page, requestedUrls, pageErrors);

		await writeConfig(page, {
			...INITIAL_CONFIG,
			agentName: "루미",
			NAIA_AGENT_NAME: "루미",
			persona: "You are 루미, an AI companion. E2E-PERSONA-1",
		});

		const input = page.locator(".naia-chat-area .chat-input");
		await expect(input).toBeEnabled({ timeout: 5000 });
		await input.fill("안녕");
		await input.press("Enter");

		const chatArea = page.locator(".naia-chat-area");
		await expect(chatArea).toContainText("웹 가짜 엔진 응답입니다.", {
			timeout: 15_000,
		});

		mkdirSync("test-results/wo09", { recursive: true });
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({ path: "test-results/wo09/reply-1280.png" });

		const worker = await getAgentWorker(page);
		const requests = await worker.evaluate(
			() => globalThis.__naiaFakeEngineRequests,
		);
		expect(requests).toBeDefined();
		expect(requests!.length).toBeGreaterThanOrEqual(1);

		const lastReq = requests![requests!.length - 1];
		expect(lastReq.length).toBeGreaterThanOrEqual(2);

		const firstMsg = lastReq[0];
		expect(firstMsg.role).toBe("system");
		systemPromptText = firstMsg.content ?? "";

		expect(systemPromptText).toContain("E2E-PERSONA-1");
		expect(systemPromptText).toContain("루미");
		expect(systemPromptText).toContain("Workspace root: opfs://naia-adk");
		expect(systemPromptText).toContain("Entrypoint: AGENTS.md");
		expect(systemPromptText).toContain("Projects (1): naia-template-project");

		const userMsg = lastReq.find((m) => m.role === "user");
		expect(userMsg).toBeDefined();
		expect(userMsg!.content).not.toContain("E2E-PERSONA-1");

		expect(pageErrors).toHaveLength(0);
		verifyNoExternalRequests(requestedUrls);
	} catch (err) {
		console.error(
			`[Test 1 System Prompt Output]\n${systemPromptText || "(none)"}\n`,
		);
		testInfo.annotations.push({
			type: "system-prompt-failure",
			description: systemPromptText || "(empty)",
		});
		throw err;
	} finally {
		await context.close();
	}
});

test("턴 사이에 바꾼 페르소나가 다음 요청에 들어간다", async ({
	browser,
}, testInfo) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];
	let lastSystemPrompt = "";

	try {
		await prepareWebAdkPage(context, page, requestedUrls, pageErrors);

		// First turn with E2E-PERSONA-1
		await writeConfig(page, {
			...INITIAL_CONFIG,
			agentName: "루미",
			NAIA_AGENT_NAME: "루미",
			persona: "You are 루미, an AI companion. E2E-PERSONA-1",
		});

		const input = page.locator(".naia-chat-area .chat-input");
		await expect(input).toBeEnabled({ timeout: 5000 });
		await input.fill("안녕");
		await input.press("Enter");

		const chatArea = page.locator(".naia-chat-area");
		await expect(chatArea).toContainText("웹 가짜 엔진 응답입니다.", {
			timeout: 15_000,
		});

		// Second turn with E2E-PERSONA-2 without reloading
		await writeConfig(page, {
			...INITIAL_CONFIG,
			agentName: "루미",
			NAIA_AGENT_NAME: "루미",
			persona: "You are 루미, an AI companion. E2E-PERSONA-2",
		});

		await expect(input).toBeEnabled({ timeout: 5000 });
		await input.fill("두 번째");
		await input.press("Enter");

		await expect(async () => {
			const count = await page.locator(".naia-chat-area").evaluate((el) => {
				const text = el.textContent || "";
				const matches = text.match(/웹 가짜 엔진 응답입니다\./g);
				return matches ? matches.length : 0;
			});
			expect(count).toBeGreaterThanOrEqual(2);
		}).toPass({ timeout: 15_000 });

		const worker = await getAgentWorker(page);
		let requests: unknown[][] | undefined;
		await expect(async () => {
			requests = await worker.evaluate(
				() => globalThis.__naiaFakeEngineRequests,
			);
			expect(requests).toBeDefined();
			expect(requests!.length).toBeGreaterThanOrEqual(2);
		}).toPass({ timeout: 5000 });

		const secondReq = requests![1];
		expect(secondReq.length).toBeGreaterThanOrEqual(2);
		expect(secondReq[0].role).toBe("system");
		lastSystemPrompt = secondReq[0].content ?? "";

		expect(lastSystemPrompt).toContain("E2E-PERSONA-2");
		expect(lastSystemPrompt).not.toContain("E2E-PERSONA-1");

		expect(pageErrors).toHaveLength(0);
		verifyNoExternalRequests(requestedUrls);
	} catch (err) {
		console.error(
			`[Test 2 System Prompt Output]\n${lastSystemPrompt || "(none)"}\n`,
		);
		testInfo.annotations.push({
			type: "system-prompt-failure",
			description: lastSystemPrompt || "(empty)",
		});
		throw err;
	} finally {
		await context.close();
	}
});

test("이름만 바꾸면 지금은 본문 이름이 그대로다(현행 동작 고정)", async ({
	browser,
}, testInfo) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];
	let systemPromptText = "";

	try {
		await prepareWebAdkPage(context, page, requestedUrls, pageErrors);

		// Only change agentName to 루미, keep persona as default
		await writeConfig(page, {
			...INITIAL_CONFIG,
			agentName: "루미",
			NAIA_AGENT_NAME: "루미",
		});

		const input = page.locator(".naia-chat-area .chat-input");
		await expect(input).toBeEnabled({ timeout: 5000 });
		await input.fill("안녕");
		await input.press("Enter");

		const chatArea = page.locator(".naia-chat-area");
		await expect(chatArea).toContainText("웹 가짜 엔진 응답입니다.", {
			timeout: 15_000,
		});

		const worker = await getAgentWorker(page);
		const requests = await worker.evaluate(
			() => globalThis.__naiaFakeEngineRequests,
		);
		expect(requests).toBeDefined();
		expect(requests!.length).toBeGreaterThanOrEqual(1);

		const lastReq = requests![requests!.length - 1];
		expect(lastReq.length).toBeGreaterThanOrEqual(2);
		expect(lastReq[0].role).toBe("system");
		systemPromptText = lastReq[0].content ?? "";

		expect(systemPromptText).toContain("You are Naia, an AI companion.");
		expect(systemPromptText).not.toContain("루미");

		expect(pageErrors).toHaveLength(0);
		verifyNoExternalRequests(requestedUrls);
	} catch (err) {
		console.error(
			`[Test 3 System Prompt Output]\n${systemPromptText || "(none)"}\n`,
		);
		testInfo.annotations.push({
			type: "system-prompt-failure",
			description: systemPromptText || "(empty)",
		});
		throw err;
	} finally {
		await context.close();
	}
});
