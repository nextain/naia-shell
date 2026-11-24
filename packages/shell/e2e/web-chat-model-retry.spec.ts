import { expect, type Page, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";

test.skip(process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake", "requires the fake browser engine");

const f16 = "Qwen3-4B-q4f16_1-MLC";
const f32 = "Qwen3-4B-q4f32_1-MLC";

async function openDeviceChat(page: Page, model = f32) {
	await openWebShellWithBgm(page, { openBgm: false });
	// A fresh workspace starts in cloud mode. Set up an explicit on-device
	// choice before exercising the recovery controls themselves.
	await page.evaluate(async (selection) => {
		const configPath = "/src/lib/config.ts";
		const storePath = "/src/lib/adk-store.ts";
		const bridgePath = "/src/lib/web-runtime/agent-bridge.ts";
		const startPath = "/src/lib/web-runtime/model-start.ts";
		const [config, store, agent, runtime] = await Promise.all([
			import(configPath), import(storePath), import(bridgePath), import(startPath),
		]);
		const current = config.loadConfig();
		if (!current) throw new Error("expected persisted cloud defaults before picking a device model");
		const role = { ...current.llmRoles?.main, provider: "webllm", model: selection };
		const next = { ...current, ...role, llmRoles: { ...current.llmRoles, main: role }, webAutoDefaultModel: false };
		config.saveConfig(next);
		await store.writeNaiaConfig(next);
		localStorage.setItem("naia-web-llm-model", selection);
		await runtime.startWebModel({
			gpu: undefined, storage: localStorage, engineKind: "fake", preferredModel: selection,
			bridge: agent.getStartableAgentBridge(),
		});
	}, model);
	await expect(page.getByTestId("web-model-status")).toHaveAttribute("data-model", model);
}

test("restarts the same device model in the worker and keeps the open draft", async ({ page }) => {
	await page.context().route(/^https?:\/\/(?!(?:localhost|127\.0\.0\.1)(?::\d+)?\/)/, (route) => route.abort());
	await openDeviceChat(page);
	const status = page.getByTestId("web-model-status");
	const input = page.locator(".naia-chat-area .chat-input");
	await expect(status).toHaveAttribute("data-phase", "ready");
	await input.fill("draft across worker retry");
	await page.evaluate(async () => {
		const source = "/src/lib/web-runtime/web-model-status.ts";
		const model = await import(/* @vite-ignore */ source);
		model.setWebModelStatus({ phase: "error", errorKind: "device-lost", errorMessage: "fixture" });
	});
	await expect(input).toBeDisabled();
	let navigations = 0;
	page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
	await status.getByTestId("web-model-retry").click();
	await expect(status).toHaveAttribute("data-phase", "ready");
	await expect(input).toBeEnabled();
	await expect(input).toHaveValue("draft across worker retry");
	expect(navigations).toBe(0);
});

test('compatible model preserves and sends the draft through a fresh worker', async ({ page }) => {
  const blocked: string[] = [];
  await page.context().route(/^https?:\/\/(?!(?:localhost|127\.0\.0\.1)(?::\d+)?\/)/, route => { blocked.push(route.request().url()); return route.abort(); });
  await openDeviceChat(page, f16);
  const status = page.getByTestId('web-model-status');
  const input = page.locator('.naia-chat-area .chat-input');
  await expect(status).toHaveAttribute('data-phase','ready');
  await expect(status).toHaveAttribute('data-model',f16);
  await expect(input).toBeEnabled();
  await expect.poll(() => page.workers().filter(w => w.url().includes('agent-worker')).length).toBe(1);
  let worker = page.workers().find(w => w.url().includes('agent-worker'))!;
  const draft = '호환 모델 전환 전 초안 — exact 20261120';
  await input.fill(draft);
  await page.evaluate(async () => { const source='/src/lib/web-runtime/web-model-status.ts'; const m=await import(/* @vite-ignore */ source); m.setWebModelStatus({phase:'error',errorKind:'no-shader-f16',shaderF16:false,errorMessage:'fixture'}); });
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue(draft);
  let navigations=0; page.on('framenavigated', f => {if(f===page.mainFrame()) navigations++;});
  let oldClosed = false; worker.on('close', () => { oldClosed=true; });
  await status.getByTestId('web-model-fallback').click();
  await expect.poll(() => oldClosed).toBe(true);
  await expect(status).toHaveAttribute('data-phase','ready');
  await expect(status).toHaveAttribute('data-model',f32);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('naia-web-llm-model'))).toBe(f32);
  await expect(input).toBeEnabled(); await expect(input).toHaveValue(draft);
  await expect.poll(() => page.workers().filter(w => w.url().includes('agent-worker')).length).toBe(1);
  const compatible = page.workers().find(w => w.url().includes('agent-worker'))!;
  expect(compatible).not.toBe(worker); worker=compatible;
  await input.press('Enter');
  await expect(page.locator('.naia-chat-area')).toContainText('[naia-fake-webllm-engine] 웹 가짜 엔진 응답입니다.');
  await expect(async () => {
    const requests = await worker.evaluate(() => (globalThis as any).__naiaFakeEngineRequests) as Array<Array<{role:string;content?:string}>>;
    expect(requests).toHaveLength(1);
    expect(requests[0].filter(m=>m.role==='user').map(m=>m.content)).toEqual([draft]);
  }).toPass({timeout:15000});
  expect(navigations).toBe(0);
  console.log(JSON.stringify({draft,model:f32,fakeRequests:1,exactUserMessages:1,mainNavigations:navigations,blockedExternalRequests:blocked}));
});

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`returns to the default device model in the current conversation (${viewport.width}px)`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.context().route(/^https?:\/\/(?!(?:localhost|127\.0\.0\.1)(?::\d+)?\/)/, (route) => route.abort());
		await openDeviceChat(page, f32);
		const status = page.getByTestId("web-model-status");
		const input = page.locator(".naia-chat-area .chat-input");
		await expect(status).toHaveAttribute("data-phase", "ready");
		await expect(status).toHaveAttribute("data-model", f32);
		const startedAt = await page.evaluate(() => performance.timeOrigin);
		const worker = page.workers().find((worker) => worker.url().includes("agent-worker"));
		expect(worker).toBeDefined();

		const first = "A reply before changing the device model.";
		await input.fill(first);
		await input.press("Enter");
		const replies = page
			.locator(".chat-message.assistant:not(.streaming)")
			.filter({ hasText: "웹 가짜 엔진 응답입니다." });
		await expect(replies).toHaveCount(1, { timeout: 15_000 });

		const draft = "A draft to send after returning to the default model.";
		await input.fill(draft);
		await status.getByTestId("web-model-ready-details").locator("summary").click();
		await status.getByTestId("web-model-back-to-default").click();
		await expect(status).toHaveAttribute("data-model", f16);
		await expect(status).toHaveAttribute("data-phase", "ready");
		await expect(replies).toHaveCount(1);
		await expect(input).toHaveValue(draft);
		expect(await page.evaluate(() => performance.timeOrigin)).toBe(startedAt);
		expect(page.workers()).toContain(worker);

		await input.press("Enter");
		await expect(replies).toHaveCount(2, { timeout: 15_000 });
		await expect.poll(() => worker!.evaluate(
			() => globalThis.__naiaFakeEngineRequests?.map((turn) => turn.at(-1)?.content),
		)).toEqual([first, draft]);
	});
}
