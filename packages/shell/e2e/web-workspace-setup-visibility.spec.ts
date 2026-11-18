import { expect, test, type Page } from "@playwright/test";

test.skip(process.env.NAIA_E2E_WEB !== "1", "requires the web runtime");
test.setTimeout(420_000);

// Layout/keyboard cases use one real verified bundle file to avoid repeating
// 116 OPFS writes. The final conversation case exercises the full bundle.
async function useSmallWorkspaceBundle(page: Page): Promise<void> {
	await page.route("**/web-adk/*.json", async (route) => {
		const response = await route.fetch();
		const bundle = await response.json();
		const agents = bundle.files.find((file: { path: string }) => file.path === "AGENTS.md");
		if (!agents) throw new Error("workspace bundle lacks AGENTS.md");
		await route.fulfill({ json: { ...bundle, files: [agents], dirs: [] } });
	});
}

for (const viewport of [
	{ width: 1280, height: 720 },
	{ width: 800, height: 450 },
	{ width: 390, height: 844 },
	{ width: 844, height: 390 },
]) {
	test(`workspace setup remains clickable with a tall model status (${viewport.width}x${viewport.height})`, async ({ browser }) => {
		const context = await browser.newContext({ viewport });
		const page = await context.newPage();
		await useSmallWorkspaceBundle(page);
		await page.addInitScript(() => {
			localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false }));
			localStorage.setItem("naia-web-llm-model", "Qwen3-4B-q4f32_1-MLC");
		});
		await page.goto("/");
		await expect(page.locator(".splash-screen")).toHaveCount(0);
		await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
		await expect(page.getByTestId("web-model-status")).toHaveAttribute("data-phase", "ready");
		// GPU adapter and fallback information can wrap to several lines.
		await page.getByTestId("web-model-status").evaluate((status) => {
			const detail = document.createElement("div");
			detail.textContent = "GPU adapter information ".repeat(12);
			status.append(detail);
		});
		const start = page.getByTestId("web-workspace-start-default");
		await expect(start).toBeVisible();
		const description = page.locator(".web-workspace-description");
		await expect(description).toBeVisible();
		await expect.poll(() => description.evaluate((element) => {
			const r = element.getBoundingClientRect();
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return hit === element || (hit !== null && element.contains(hit));
		})).toBe(true);
		await expect.poll(() => start.evaluate((button) => {
			const r = button.getBoundingClientRect();
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return hit === button || (hit !== null && button.contains(hit));
		})).toBe(true);
		const modelStatus = page.getByTestId("web-model-status");
		await expect(modelStatus).toHaveAttribute("tabindex", "0");
		await expect.poll(() => modelStatus.evaluate((element) => {
			const r = element.getBoundingClientRect();
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return hit === element || (hit !== null && element.contains(hit));
		})).toBe(true);
		const composer = page.locator(".naia-chat-area .chat-input");
		let composerFocused = false;
		for (let i = 0; i < 100; i++) {
			await page.keyboard.press("Tab");
			if (await composer.evaluate((element) => document.activeElement === element)) {
				composerFocused = true;
				break;
			}
		}
		expect(composerFocused).toBe(true);
		await expect.poll(() => composer.evaluate((element) => {
			const r = element.getBoundingClientRect();
			const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return hit === element || (hit !== null && element.contains(hit));
		})).toBe(true);
		// Tab can scroll the compact chat; return to the button for the real click.
		await start.scrollIntoViewIfNeeded();
		const rect = await start.boundingBox();
		if (!rect) throw new Error("workspace setup button has no bounding box");
		// A pointer click is deliberate: DOM click and forced click can mask occlusion.
		await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
		await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 300_000 }).toBe("ready");
		await expect(page.getByTestId("web-workspace-setup")).toHaveCount(0);
		await expect(page.locator(".chat-input")).toBeVisible();
		await context.close();
	});
}

test("workspace retry stays clickable after a provisioning failure", async ({ page }) => {
	await useSmallWorkspaceBundle(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => {
		localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false }));
	});
	await page.addInitScript(() => {
		const originalFetch = window.fetch.bind(window);
		let failOnce = true;
		window.fetch = (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (failOnce && url.includes("/web-adk/") && url.endsWith(".json")) {
				failOnce = false;
				return Promise.reject(new Error("x".repeat(512)));
			}
			return originalFetch(input, init);
		};
	});
	await page.goto("/");
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
	await page.addStyleTag({ content: 'html { font-size: 32px; }' });
	await page.getByTestId("web-workspace-start-default").click();
	await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "error");
	const retry = page.getByTestId("web-workspace-retry");
	await expect.poll(() => retry.evaluate((button) => {
		const r = button.getBoundingClientRect();
		const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return hit === button || (hit !== null && button.contains(hit));
	})).toBe(true);
	const rect = await retry.boundingBox();
	if (!rect) throw new Error("workspace retry button has no bounding box");
	await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
	await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 300_000 }).toBe("ready");
});


test("workspace setup can be started with the keyboard", async ({ page }) => {
	await useSmallWorkspaceBundle(page);
	await page.goto("/");
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
	const start = page.getByTestId("web-workspace-start-default");
	let reached = false;
	for (let i = 0; i < 100; i++) {
		await page.keyboard.press("Tab");
		if (await start.evaluate((button) => document.activeElement === button)) {
			reached = true;
			break;
		}
	}
	expect(reached).toBe(true);
	await page.keyboard.press("Enter");
	await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 300_000 }).toBe("ready");
});


test("setup preserves a conversation after reload", async ({ page }) => {
	test.setTimeout(420_000);
	test.skip(process.env.VITE_NAIA_WEB_LLM !== "fake", "requires the fake model engine");
	await page.addInitScript(() => {
		localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false }));
	});
	await page.goto("/");
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await page.getByTestId("web-workspace-start-default").click();
	await expect.poll(() => page.evaluate(() => window.__NAIA_WEB_ADK_STATUS__?.().phase), { timeout: 300_000 }).toBe("ready");
	const input = page.locator(".naia-chat-area .chat-input");
	await input.fill("대화 복구 시험");
	await expect(page.locator(".naia-chat-area .chat-send-btn")).toBeEnabled();
	await input.press("Enter");
	await expect(page.getByText("웹 가짜 엔진 응답입니다.", { exact: false })).toBeVisible();
	// The finish event follows persistence; do not reload during an active turn.
	await expect(page.locator(".chat-cancel-btn")).toHaveCount(0);
	await page.reload();
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.getByText("대화 복구 시험", { exact: false })).toBeVisible();
	await expect(page.getByText("웹 가짜 엔진 응답입니다.", { exact: false })).toBeVisible();
});

test("model error details remain keyboard accessible during workspace setup", async ({ page }) => {
	await useSmallWorkspaceBundle(page);
	await page.addInitScript(() => {
		localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f16_1-MLC", ttsEnabled: false }));
	});
	await page.goto("/");
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
	await expect(page.getByTestId("web-model-status")).toHaveAttribute("data-phase", "ready");
	// This suite runs against the Vite web dev server; inject the error state so
	// the real status component renders its fallback, retry, and details actions.
	await page.evaluate(async () => {
		const source = "/src/lib/web-runtime/web-model-status.ts";
		const status = await import(/* @vite-ignore */ source);
		status.setWebModelStatus({ phase: "error", errorKind: "load-failed", errorMessage: "error ".repeat(50), shaderF16: false });
	});
	await page.addStyleTag({ content: "html { font-size: 32px; }" });
	const status = page.getByTestId("web-model-status");
	await expect(status).toHaveAttribute("data-phase", "error");
	await expect(status).toHaveAttribute("tabindex", "0");
	for (const target of [status, page.getByTestId("web-model-fallback"), page.getByTestId("web-model-retry"), status.locator("summary")]) {
		let reached = false;
		for (let i = 0; i < 100; i++) {
			await page.keyboard.press("Tab");
			if (await target.evaluate((element) => document.activeElement === element)) {
				reached = true;
				break;
			}
		}
		expect(reached).toBe(true);
		if (target === status) {
			await page.keyboard.press("End");
			await expect.poll(() => status.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		}
	}
	await page.keyboard.press("Enter");
	await expect(status.locator("details")).toHaveAttribute("open", "");
});

test("portrait setup stays open across message resets and respects deliberate collapse", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
	const area = page.locator(".naia-chat-area");
	await expect(area).toHaveAttribute("data-mobile-sheet", "half");
	await page.evaluate(async () => {
		const source = "/src/stores/chat.ts";
		const { useChatStore } = await import(/* @vite-ignore */ source);
		useChatStore.setState({ messages: [{ id: "restored", role: "user", content: "restored", timestamp: 1 }] });
	});
	await expect(area).toHaveAttribute("data-mobile-sheet", "half");
	await page.waitForTimeout(200); // let the message-restoration effect observe the first state
	await page.evaluate(async () => {
		const source = "/src/stores/chat.ts";
		const { useChatStore } = await import(/* @vite-ignore */ source);
		useChatStore.setState({ messages: [] });
	});
	await expect(area).toHaveAttribute("data-mobile-sheet", "half");
	const handle = page.locator(".web-mobile-sheet-handle");
	await handle.click();
	await expect(area).toHaveAttribute("data-mobile-sheet", "expanded");
	await handle.click();
	await expect(area).toHaveAttribute("data-mobile-sheet", "collapsed");
	await page.setViewportSize({ width: 844, height: 390 });
	await expect(page.locator("html")).toHaveAttribute("data-layout-orientation", "landscape");
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator("html")).toHaveAttribute("data-layout-orientation", "portrait");
	await expect(area).toHaveAttribute("data-mobile-sheet", "collapsed");
	// A deliberate choice remains in effect through install/error and message churn.
	for (const phase of ["installing", "error"]) {
		await page.evaluate(async (phase) => {
			const source = "/src/lib/web-runtime/web-adk-status.ts";
			const { setWebAdkStatus } = await import(/* @vite-ignore */ source);
			setWebAdkStatus({ phase, reason: phase === "error" ? "test error" : undefined });
		}, phase);
		await page.evaluate(async () => {
			const source = "/src/stores/chat.ts";
			const { useChatStore } = await import(/* @vite-ignore */ source);
			useChatStore.setState({ messages: [{ id: "restored", role: "user", content: "restored", timestamp: 1 }] });
		});
		await page.waitForTimeout(200);
		await page.evaluate(async () => {
			const source = "/src/stores/chat.ts";
			const { useChatStore } = await import(/* @vite-ignore */ source);
			useChatStore.setState({ messages: [] });
		});
		await page.waitForTimeout(200);
		await expect(area).toHaveAttribute("data-mobile-sheet", "collapsed");
	}
	await handle.focus();
	await page.keyboard.press("Enter");
	await expect(area).toHaveAttribute("data-mobile-sheet", "half");
	await page.keyboard.press("Space");
	await expect(area).toHaveAttribute("data-mobile-sheet", "expanded");
});

test("kiosk CSS keeps pending setup scrollable in a short landscape window", async ({ page }) => {
	await page.setViewportSize({ width: 800, height: 450 });
	await page.addInitScript(() => {
		localStorage.setItem("naia-config", JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC", ttsEnabled: false }));
	});
	await page.goto("/");
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.getByTestId("web-workspace-setup")).toHaveAttribute("data-phase", "needs-setup");
	// Exercise the actual kiosk stylesheet and selector without starting the kiosk visit.
	await page.addStyleTag({ url: "/src/components/KioskDemoGate.css" });
	await page.locator(".app-root").evaluate((root) => root.setAttribute("data-kiosk-demo", "true"));
	const chat = page.locator(".chat-app--workspace-pending");
	await expect(chat).toHaveCSS("overflow-y", "auto");
	await expect(page.getByTestId("web-workspace-start-default")).toBeVisible();
});
