import { expect, test } from "@playwright/test";
import { startDefaultWorkspace } from "./helpers/web-workspace";

test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"Web agent chat test only runs when NAIA_E2E_WEB=1",
);

test("sends chat message and receives fake webllm engine response", async ({
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

	// Workspace setup
	await startDefaultWorkspace(page);

	// First message
	await expect(input).toBeEnabled({ timeout: 5000 });
	await input.fill("안녕");
	await input.press("Enter");

	// 15초 안에 .naia-chat-area 에 웹 가짜 엔진 응답입니다. 가 보인다.
	const chatArea = page.locator(".naia-chat-area");
	await expect(chatArea).toContainText("웹 가짜 엔진 응답입니다.", {
		timeout: 15_000,
	});

	// page.workers() 중 주소에 agent-worker 가 든 것이 정확히 1개
	const agentWorkersFirst = page
		.workers()
		.filter((w) => w.url().includes("agent-worker"));
	expect(agentWorkersFirst).toHaveLength(1);

	// 두 번째 메시지 두 번째 를 보내고 같은 문구가 2번 이상 보일 때까지 기다린다.
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

	// 그 뒤에도 agent-worker Worker 는 정확히 1개
	const agentWorkersSecond = page
		.workers()
		.filter((w) => w.url().includes("agent-worker"));
	expect(agentWorkersSecond).toHaveLength(1);

	// 모은 요청 주소에 huggingface.co, raw.githubusercontent.com, api.nextain.io 가 하나도 없다
	for (const url of requestedUrls) {
		expect(url).not.toContain("huggingface.co");
		expect(url).not.toContain("raw.githubusercontent.com");
		expect(url).not.toContain("api.nextain.io");
	}

	// pageerror 0건인지 확인
	expect(
		pageErrors,
		`Unexpected page errors during test:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
	).toHaveLength(0);
});
