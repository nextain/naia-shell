import { type BrowserContext, expect, type Page, test, type Worker } from "@playwright/test";
import { startDefaultWorkspace } from "./helpers/web-workspace";

test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"Web ADK read tools test only runs when NAIA_E2E_WEB=1",
);

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
	page.on("request", (req) => requestedUrls.push(req.url()));
	page.on("pageerror", (err) => pageErrors.push(err));

	const t0 = Date.now();
	await page.goto("/");

	let left = 30_000 - (Date.now() - t0);
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: Math.max(left, 1000),
	});

	left = 30_000 - (Date.now() - t0);
	await expect(page.locator(".splash-screen")).toHaveCount(0, {
		timeout: Math.max(left, 1000),
	});

	left = 30_000 - (Date.now() - t0);
	const input = page.locator(".naia-chat-area .chat-input");
	await expect(input).toBeVisible({
		timeout: Math.max(left, 1000),
	});

	await startDefaultWorkspace(page);

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

	await expect(page.locator('[data-phase="ready"]')).toBeAttached({
		timeout: 15_000,
	});
}

async function getAdkCommit(page: Page): Promise<string> {
	const marker = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const adk = await root.getDirectoryHandle("naia-adk");
		const settings = await adk.getDirectoryHandle("naia-settings");
		const fileHandle = await settings.getFileHandle(".web-adk-source.json");
		const file = await fileHandle.getFile();
		return JSON.parse(await file.text()) as { commit: string };
	});
	return marker.commit;
}

function verifyNoExternalRequests(requestedUrls: string[]): void {
	for (const url of requestedUrls) {
		expect(url).not.toContain("raw.githubusercontent.com");
		expect(url).not.toContain("huggingface.co");
	}
}

test("WO13B-E1 [fake-tool:read AGENTS.md] reads AGENTS.md and responds with first line", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];

	try {
		await prepareWebAdkPage(context, page, requestedUrls, pageErrors);

		const commit = await getAdkCommit(page);
		const bundleResp = await page.request.get(`/web-adk/${commit}.json`);
		expect(bundleResp.ok()).toBe(true);
		const bundleJson = (await bundleResp.json()) as {
			files: Array<{ path: string; base64: string }>;
		};
		const agentsEntry = bundleJson.files.find((f) => f.path === "AGENTS.md");
		expect(agentsEntry).toBeDefined();
		const agentsContent = Buffer.from(agentsEntry!.base64, "base64").toString(
			"utf8",
		);
		const firstLine = agentsContent.split("\n")[0] ?? "";
		expect(firstLine.length).toBeGreaterThan(0);

		const input = page.locator(".naia-chat-area .chat-input");
		await expect(input).toBeEnabled({ timeout: 5000 });
		await input.fill("[fake-tool:read AGENTS.md] 저장소 이름");
		await input.press("Enter");

		const chatArea = page.locator(".naia-chat-area");
		await expect(chatArea).toContainText(`도구 결과 받음: ${firstLine}`, {
			timeout: 15_000,
		});

		const worker = await getAgentWorker(page);
		let requests: Array<Array<{ role: string; content?: string }>> | undefined;
		await expect(async () => {
			requests = await worker.evaluate(
				() => globalThis.__naiaFakeEngineRequests,
			);
			expect(requests).toBeDefined();
			expect(requests!.length).toBeGreaterThanOrEqual(2);
		}).toPass({ timeout: 15_000 });

		const firstReq = requests![0];
		const sysMsg = firstReq.find((m) => m.role === "system");
		expect(sysMsg).toBeDefined();
		expect(sysMsg!.content).toContain("<tools>");
		expect(sysMsg!.content).toContain('"read_file"');
		expect(sysMsg!.content).not.toContain("continue_speaking");

		const secondReq = requests![1];
		const lastMsg = secondReq[secondReq.length - 1];
		expect(lastMsg.role).toBe("user");
		expect(lastMsg.content?.startsWith("<tool_response>")).toBe(true);

		await expect(page.locator(".permission-modal")).toHaveCount(0);
		expect(pageErrors).toHaveLength(0);
		verifyNoExternalRequests(requestedUrls);
	} finally {
		await context.close();
	}
});

test("WO13B-E2 [fake-tool:list agents/context] suggests correct path", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];

	try {
		await prepareWebAdkPage(context, page, requestedUrls, pageErrors);

		const input = page.locator(".naia-chat-area .chat-input");
		await expect(input).toBeEnabled({ timeout: 5000 });
		await input.fill("[fake-tool:list agents/context]");
		await input.press("Enter");

		const chatArea = page.locator(".naia-chat-area");
		await expect(chatArea).toContainText(
			/도구 결과 받음: not found: agents\/context\. Did you mean:\s*\.agents\/context\?/,
			{ timeout: 15_000 },
		);

		const worker = await getAgentWorker(page);
		let requests: Array<Array<{ role: string; content?: string }>> | undefined;
		await expect(async () => {
			requests = await worker.evaluate(
				() => globalThis.__naiaFakeEngineRequests,
			);
			expect(requests).toBeDefined();
			expect(requests!.length).toBeGreaterThanOrEqual(2);
		}).toPass({ timeout: 15_000 });

		const secondReq = requests![1];
		const lastMsg = secondReq[secondReq.length - 1];
		expect(lastMsg.role).toBe("user");
		expect(lastMsg.content).toBe(
			"<tool_response>\nnot found: agents/context. Did you mean: .agents/context?\n</tool_response>",
		);

		await expect(page.locator(".permission-modal")).toHaveCount(0);
		expect(pageErrors).toHaveLength(0);
		verifyNoExternalRequests(requestedUrls);
	} finally {
		await context.close();
	}
});

test("WO13B-E3 [fake-tool:read .env] denies sensitive path", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const requestedUrls: string[] = [];
	const pageErrors: Error[] = [];

	try {
		await prepareWebAdkPage(context, page, requestedUrls, pageErrors);

		const input = page.locator(".naia-chat-area .chat-input");
		await expect(input).toBeEnabled({ timeout: 5000 });
		await input.fill("[fake-tool:read .env]");
		await input.press("Enter");

		const chatArea = page.locator(".naia-chat-area");
		await expect(chatArea).toContainText(
			"도구 결과 받음: denied: sensitive path",
			{ timeout: 15_000 },
		);

		const worker = await getAgentWorker(page);
		let requests: Array<Array<{ role: string; content?: string }>> | undefined;
		await expect(async () => {
			requests = await worker.evaluate(
				() => globalThis.__naiaFakeEngineRequests,
			);
			expect(requests).toBeDefined();
			expect(requests!.length).toBeGreaterThanOrEqual(2);
		}).toPass({ timeout: 15_000 });

		const secondReq = requests![1];
		const lastMsg = secondReq[secondReq.length - 1];
		expect(lastMsg.role).toBe("user");
		expect(lastMsg.content).toBe(
			"<tool_response>\ndenied: sensitive path\n</tool_response>",
		);

		await expect(page.locator(".permission-modal")).toHaveCount(0);
		expect(pageErrors).toHaveLength(0);
		verifyNoExternalRequests(requestedUrls);
	} finally {
		await context.close();
	}
});
