import { expect, test } from "@playwright/test";
import { startDefaultWorkspace } from "./helpers/web-workspace";

test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"Web CSP test only runs when NAIA_E2E_WEB=1",
);

test("enforces Web CSP policy on page and worker", async ({
	browser,
	page,
}) => {
	const pageErrors: Error[] = [];
	page.on("pageerror", (err) => {
		pageErrors.push(err);
	});

	let workerCspHeader: string | undefined;
	page.on("response", (res) => {
		if (res.url().includes("agent-worker")) {
			workerCspHeader = res.headers()["content-security-policy"];
		}
	});

	const t0 = Date.now();
	const response = await page.goto("/");
	expect(response).not.toBeNull();
	const cspHeader = response!.headers()["content-security-policy"] || "";
	expect(cspHeader).toBeTruthy();

	// script-src 지시어의 토큰 확인
	const directives = cspHeader.split(";").map((d) => d.trim());
	const scriptSrcDirective = directives.find((d) =>
		d.startsWith("script-src "),
	);
	expect(scriptSrcDirective).toBeDefined();

	const scriptSrcTokens = scriptSrcDirective!.split(/\s+/).slice(1);
	expect(scriptSrcTokens).toContain("'self'");
	expect(scriptSrcTokens).toContain("'wasm-unsafe-eval'");
	expect(scriptSrcTokens).not.toContain("'unsafe-eval'");
	expect(scriptSrcTokens).not.toContain("'unsafe-inline'");

	// meta[http-equiv="Content-Security-Policy"] content 검증
	const metaCsp = await page
		.locator('meta[http-equiv="Content-Security-Policy"]')
		.getAttribute("content");
	expect(metaCsp).toBe(cspHeader);

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

	// Page evaluate checks
	const pageEvalResult = await page.evaluate(
		"new Promise(r => setTimeout(() => { try { r(String(eval('1'))) } catch (e) { r(e.name) } }, 0))",
	);
	expect(pageEvalResult).toBe("EvalError");

	const pageFunctionResult = await page.evaluate(
		"new Promise(r => setTimeout(() => { try { r(String(new Function('return 1')())) } catch (e) { r(e.name) } }, 0))",
	);
	expect(pageFunctionResult).toBe("EvalError");

	const pageWasmResult = await page.evaluate(
		"WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => 'ok', e => e.name)",
	);
	expect(pageWasmResult).toBe("ok");

	// Trigger worker by sending a message
	await startDefaultWorkspace(page);
	await expect(input).toBeEnabled({ timeout: 5000 });
	await input.fill("안녕");
	await input.press("Enter");

	const chatArea = page.locator(".naia-chat-area");
	await expect(chatArea).toContainText("웹 가짜 엔진 응답입니다.", {
		timeout: 15_000,
	});

	const worker = page.workers().find((w) => w.url().includes("agent-worker"));
	expect(worker).toBeDefined();

	// Worker evaluate checks
	const workerEvalResult = await worker!.evaluate(
		"new Promise(r => setTimeout(() => { try { r(String(eval('1'))) } catch (e) { r(e.name) } }, 0))",
	);
	expect(workerEvalResult).toBe("EvalError");

	const workerFunctionResult = await worker!.evaluate(
		"new Promise(r => setTimeout(() => { try { r(String(new Function('return 1')())) } catch (e) { r(e.name) } }, 0))",
	);
	expect(workerFunctionResult).toBe("EvalError");

	const workerWasmResult = await worker!.evaluate(
		"WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => 'ok', e => e.name)",
	);
	expect(workerWasmResult).toBe("ok");

	expect(workerCspHeader).toBe(cspHeader);

	// Control: bypassCSP context
	const bypassContext = await browser.newContext({ bypassCSP: true });
	try {
		const bypassPage = await bypassContext.newPage();
		await bypassPage.goto("/");
		const bypassEvalResult = await bypassPage.evaluate(
			"new Promise(r => setTimeout(() => { try { r(String(eval('1'))) } catch (e) { r(e.name) } }, 0))",
		);
		expect(bypassEvalResult).toBe("1");
	} finally {
		await bypassContext.close();
	}

	// pageerror 0건인지 확인
	expect(
		pageErrors,
		`Unexpected page errors during test:\n${pageErrors.map((e) => e.message || String(e)).join("\n")}`,
	).toHaveLength(0);
});
