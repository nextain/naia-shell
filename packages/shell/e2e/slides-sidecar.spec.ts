import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
	expect(browserErrors.get(page) ?? []).toEqual([]);
});

// No private deck content belongs in this fixture. IPC and speech completion are
// simulated, while React, the installed-app host, PDF.js and fullscreen are real.
function pdfBase64() {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
		...[6, 7, 8].map(
			(stream) =>
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 360] /Resources << /Font << /F1 9 0 R >> >> /Contents ${stream} 0 R >>`,
		),
		...["Main slide", "Closing slide", "Appendix"].map((title) => {
			const content = `BT /F1 32 Tf 40 200 Td (${title}) Tj ET`;
			return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
		}),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const start = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join(
			"",
		)}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
	return Buffer.from(pdf).toString("base64");
}

async function openInstalledHost(page: Page, locale = "en") {
	// A fulfilled host page has no loopback network response for Chromium's LNA
	// classification. Grant only the two origins of this disposable local fixture.
	const origin = new URL(
		test.info().project.use.baseURL ?? "http://127.0.0.1:1438",
	).origin;
	for (const target of [origin, origin.replace("127.0.0.1", "localhost")]) {
		await page
			.context()
			.grantPermissions(["local-network-access"], { origin: target });
	}
	page.on("pageerror", (error) =>
		console.error("Slides host page error:", error.message),
	);
	page.on("console", (message) => {
		if (message.type() === "error")
			console.error("Slides console:", message.text());
	});
	page.on("requestfailed", (request) =>
		console.error(
			"Slides request failed:",
			request.url(),
			request.failure()?.errorText,
		),
	);
	const payload = {
		pdfName: "deck.pdf",
		pdfBase64: pdfBase64(),
		scriptName: "deck.md",
		scriptText:
			"## 01. Main\nFirst authored note\n## 02. Closing\nLast authored note",
		scriptReadFailed: false,
	};
	await page.route("**/slides-e2e-host", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html><head><style>html,body,#host{height:100%;margin:0}.generic-installed-app__iframe{width:100%;height:100%;border:0}</style></head><body><div id="host"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
window.fixture={selection:${JSON.stringify(payload)},calls:[],speeches:[],callbacks:{},nextCallback:1};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event,id)=>{delete window.fixture.callbacks[id];}};
localStorage.setItem('naia-adk-path','C:/fixture-workspace');
localStorage.setItem('naia-config',JSON.stringify({locale:${JSON.stringify(locale)}}));
document.documentElement.style.setProperty('--bg-primary','#faf8f2');
document.documentElement.style.setProperty('--bg-secondary','#f0f3f7');
document.documentElement.style.setProperty('--text-primary','#17283d');
document.documentElement.style.setProperty('--text-secondary','#526175');
document.documentElement.style.setProperty('--border-color','#ccd5df');
document.documentElement.style.setProperty('--accent-color','#1765a1');
document.documentElement.style.setProperty('--font-family','Arial, sans-serif');
window.__TAURI_INTERNALS__={convertFileSrc:()=>location.origin.replace('127.0.0.1','localhost')+'/slides.html',invoke:async(command,args)=>{window.fixture.calls.push({command,args});if(command==='slides_open_pdf'||command==='slides_open_document'){if(window.fixture.delay)await new Promise(resolve=>window.fixture.complete=resolve);if(window.fixture.error)throw window.fixture.error;return window.fixture.selection;}if(command==='slides_recording_stop')return 'recordings/fixture.webm';if(command==='plugin:event|listen')return args.handler;return null;},transformCallback:(callback)=>{const id=window.fixture.nextCallback++;window.fixture.callbacks[id]=callback;return id;},unregisterCallback:(id)=>{delete window.fixture.callbacks[id];}};
await import('/e2e/fixtures/slides-installed-host.tsx');
</script></body></html>`,
		}),
	);
	await page.goto("/slides-e2e-host");
	await page.waitForLoadState("networkidle");
	console.log(
		"Slides frame discovery:",
		page.frames().map((frame) => frame.url()),
	);
	const frame = page.frameLocator("iframe");
	await expect(frame.getByRole("region")).toBeVisible();
	await expect(page.locator("iframe")).toHaveAttribute("allowfullscreen", "");
	return frame;
}

async function finishSpeech(page: Page, index: number) {
	await page.evaluate((index) => {
		const fixture = (window as unknown as { fixture: { speeches: unknown[] } })
			.fixture;
		const frame = document.querySelector("iframe")!;
		frame.contentWindow!.postMessage(
			{
				type: "naia-slides:speech-result",
				detail: { ...(fixture.speeches[index] as object), status: "finished" },
			},
			new URL(frame.src).origin,
		);
	}, index);
}

test("installed iframe loads sidecar, toggles notes and fullscreen, and loops only the authored range", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const frame = await openInstalledHost(page);
	await frame.getByLabel(/PDF 열기|Open PDF/).click();
	await expect(frame.locator("canvas")).toBeVisible();
	await expect(frame.getByTestId("slides-current-note")).toHaveText(
		"First authored note",
	);
	await expect(
		frame.getByLabel(/발표 종료 페이지|Presentation end page/),
	).toHaveValue("2");
	await frame.getByRole("button", { name: /발표문 닫기|Hide notes/ }).click();
	await expect(frame.getByRole("complementary")).toHaveCount(0);
	await frame.getByRole("button", { name: /발표문 열기|Show notes/ }).click();
	await expect(frame.getByTestId("slides-current-note")).toHaveText(
		"First authored note",
	);
	await frame
		.getByRole("button", { name: /^(전체 화면|Full screen)$/ })
		.click();
	await expect(
		frame.getByRole("button", { name: /전체 화면 종료|Exit full screen/ }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		frame.getByRole("button", { name: /발표 종료|Stop/ }),
	).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("viewer-fullscreen.png") });
	await frame
		.getByRole("button", { name: /전체 화면 종료|Exit full screen/ })
		.click();
	await expect(
		frame.getByRole("button", { name: /^(전체 화면|Full screen)$/ }),
	).toHaveAttribute("aria-pressed", "false");
	const repeat = frame.getByRole("button", { name: /반복 재생|Repeat/ });
	await repeat.focus();
	await page.keyboard.press("Space");
	await expect(repeat).toHaveAttribute("aria-pressed", "true");
	await frame
		.getByRole("button", { name: /발표 시작|Start presenting/ })
		.click();
	await expect
		.poll(() => page.evaluate(() => (window as any).fixture.speeches.length))
		.toBe(1);
	await finishSpeech(page, 0);
	await expect
		.poll(() => page.evaluate(() => (window as any).fixture.speeches.length))
		.toBe(2);
	await finishSpeech(page, 1);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as any).fixture.speeches.map(
					(speech: { page: number }) => speech.page,
				),
			),
		)
		.toEqual([1, 2, 1]);
	await frame.getByRole("button", { name: /발표 종료|Stop/ }).click();
	await finishSpeech(page, 2);
	await expect(
		frame.getByRole("button", { name: /발표 시작|Start presenting/ }),
	).toBeVisible();
	expect(
		await page.evaluate(() => (window as any).fixture.speeches.length),
	).toBe(3);
	expect(errors).toEqual([]);
});

test("cancel, missing sidecar and narrow-screen script controls preserve the PDF workflow", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 560, height: 900 });
	const frame = await openInstalledHost(page);
	await frame.getByLabel(/Open PDF/).click();
	await expect(frame.locator("canvas")).toBeVisible();
	await frame.getByRole("button", { name: "Edit current slide script" }).click();
	await frame.getByRole("textbox", { name: "Current slide script editor" }).fill("Narrow draft");
	await page.screenshot({ path: testInfo.outputPath("script-editor-narrow.png") });
	await frame.getByRole("button", { name: "Cancel script edit" }).click();
	await frame.getByLabel(/PDF 열기|Open PDF/).click();
	await expect(frame.locator("canvas")).toBeVisible();
	await page.evaluate(() => {
		(window as any).fixture.selection = null;
	});
	await frame.getByLabel(/PDF 열기|Open PDF/).click();
	await expect(frame.getByLabel(/PDF 열기|Open PDF/)).toBeEnabled();
	await expect(frame.getByTestId("slides-current-note")).toHaveText(
		"First authored note",
	);
	await frame.getByRole("button", { name: /발표문 닫기|Hide notes/ }).click();
	await expect(
		frame.getByRole("button", { name: /발표문 열기|Show notes/ }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("viewer-narrow-notes-closed.png"),
	});
	const size = await frame
		.getByRole("region")
		.evaluate((element) => ({
			width: element.clientWidth,
			scroll: element.scrollWidth,
		}));
	expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
	await page.evaluate((pdf) => {
		(window as any).fixture.selection = {
			pdfName: "other.pdf",
			pdfBase64: pdf,
			scriptName: null,
			scriptText: null,
			scriptReadFailed: true,
		};
	}, pdfBase64());
	await frame.getByLabel(/PDF 열기|Open PDF/).click();
	await expect(frame.getByRole("alert")).toBeVisible();
	await expect(
		frame.getByLabel(/발표 종료 페이지|Presentation end page/),
	).toHaveValue("3");
	await expect(frame.getByLabel(/발표 스크립트|Speaker script/)).toBeEnabled();
});

test("installed Slides follows live host language and theme and records through the host ADK", async ({ page }, testInfo) => {
	const frame = await openInstalledHost(page, "ko");
	await expect(frame.getByLabel(/PDF.*열기/)).toBeVisible();
	await expect(frame.locator(".slides-app")).toHaveCSS("background-color", "rgb(250, 248, 242)");
	await frame.getByLabel(/PDF.*열기/).click();
	await expect(frame.locator("canvas")).toBeVisible();
	await expect(frame.getByTestId("slides-current-note")).toHaveText("First authored note");
	await page.evaluate(async () => {
		const i18n = await import("/src/lib/i18n.ts");
		await i18n.setLocale("en");
		window.dispatchEvent(new CustomEvent("naia:locale-change", { detail: "en" }));
		document.documentElement.style.setProperty("--bg-primary", "#142332");
		document.documentElement.style.setProperty("--bg-secondary", "#1b2735");
		document.documentElement.style.setProperty("--text-primary", "#e6edf5");
		document.documentElement.style.setProperty("--text-secondary", "#c2cad3");
		document.documentElement.style.setProperty("--border-color", "#33465a");
		document.documentElement.style.setProperty("--accent-color", "#3b8bd1");
	});
	await expect(frame.getByLabel(/Open PDF/)).toBeVisible();
	await expect(frame.locator(".slides-app")).toHaveCSS("background-color", "rgb(20, 35, 50)");
	await expect(frame.locator(".slides-app")).toHaveCSS("color", "rgb(230, 237, 245)");
	await expect(frame.getByTestId("slides-current-note")).toHaveText("First authored note");
	await frame.getByRole("button", { name: /Record MP4/ }).click();
	await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_recording_start"))).toEqual([{ command: "slides_recording_start", args: { adkPath: "C:/fixture-workspace" } }]);
	await frame.getByRole("button", { name: /Stop recording/ }).click();
	await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_recording_stop").length)).toBe(1);
	const frameAdk = await frame.locator(".slides-app").evaluate(() => localStorage.getItem("naia-adk-path"));
	expect(frameAdk).toBeNull();
	await page.screenshot({ path: testInfo.outputPath("host-language-theme-recording.png") });
});

test("script edits pause narration, cancel safely, protect replacement, and download a Markdown copy", async ({ page }, testInfo) => {
	const frame = await openInstalledHost(page);
	await frame.getByLabel(/Open PDF/).click();
	await expect(frame.locator("canvas")).toBeVisible();
	await frame.getByRole("button", { name: "Edit current slide script" }).click();
	const editor = frame.getByRole("textbox", { name: "Current slide script editor" });
	await editor.fill("Discard this draft");
	await frame.getByRole("button", { name: "Cancel script edit" }).click();
	await expect(frame.getByTestId("slides-current-note")).toHaveText("First authored note");
	await frame.getByRole("button", { name: "Start presenting" }).click();
	await expect.poll(() => page.evaluate(() => (window as any).fixture.speeches.length)).toBe(1);
	await frame.getByRole("button", { name: "Edit current slide script" }).click();
	await expect(frame.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
	await editor.fill("Edited first note — 한글 수정");
	await frame.getByRole("button", { name: "Apply script edit" }).click();
	await expect(frame.getByTestId("slides-current-note")).toHaveText("Edited first note — 한글 수정");
	await page.screenshot({ path: testInfo.outputPath("script-edited-unsaved.png") });
	page.once("dialog", async (dialog) => { expect(dialog.type()).toBe("confirm"); await dialog.dismiss(); });
	await frame.getByLabel(/Open PDF/).click();
	await expect(frame.getByTestId("slides-current-note")).toHaveText("Edited first note — 한글 수정");
	await expect(frame.getByTestId("slides-script-unexported")).toBeVisible();
	const downloadReady = page.waitForEvent("download");
	await frame.getByRole("button", { name: "Download edited Markdown" }).click();
	const download = await downloadReady;
	expect(await download.failure()).toBeNull();
	expect(download.suggestedFilename()).toMatch(/edited.*\.md$/);
	const content = await readFile((await download.path())!, "utf8");
	expect(content).toContain("Edited first note — 한글 수정");
	expect(content).not.toContain("First authored note");
	expect(content).toContain("## 01. Main");
	expect(content.match(/^##\s+0*1(?:[.)]|\s|$)/gm)).toHaveLength(1);
	expect(content).toContain("Last authored note");
	expect(content).toContain("## 02. Closing");
	await expect(frame.getByText("Edited script has not been downloaded.")).toHaveCount(0);
});

test("import progress, cancellation, late results and converter errors retain the current deck", async ({ page }, testInfo) => {
	const frame = await openInstalledHost(page);
	await frame.getByLabel(/Open PDF/).click();
	await expect(frame.locator("canvas")).toBeVisible();
	await page.evaluate(() => { (window as any).fixture.delay = true; });
	await frame.getByLabel(/Open PDF/).click();
	await expect(frame.getByTestId("slides-import-status")).toBeVisible();
	await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_open_document").length)).toBe(2);
	await page.evaluate(() => {
		const fixture = (window as any).fixture;
		const call = fixture.calls.filter((item: any) => item.command === "slides_open_document").at(-1);
		const subscription = fixture.calls.filter((item: any) => item.command === "plugin:event|listen" && item.args.event === "naia-slides:import-progress").at(-1);
		fixture.callbacks[subscription.args.handler]({ event: subscription.args.event, id: subscription.args.handler, payload: { requestId: call.args.requestId, phase: "converting" } });
	});
	await expect(frame.getByTestId("slides-import-status")).toContainText("Converting PPTX to PDF");
	await page.screenshot({ path: testInfo.outputPath("import-converting.png") });
	await frame.getByTestId("slides-cancel-import").click();
	await expect(frame.getByTestId("slides-import-status")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_cancel_open").length)).toBe(1);
	await page.evaluate(() => {
		const fixture = (window as any).fixture;
		fixture.selection = { ...fixture.selection, pdfName: "late.pptx", scriptText: "## 1.\nMust not replace current notes" };
		fixture.delay = false;
		fixture.complete();
	});
	await expect(frame.getByTestId("slides-current-note")).toHaveText("First authored note");
	await page.evaluate(() => { (window as any).fixture.error = "slides_converter_unavailable"; });
	await frame.getByLabel(/Open PDF/).click();
	await expect(frame.getByRole("alert")).toContainText(/LibreOffice/);
	await expect(frame.getByLabel(/Open PDF/)).toBeEnabled();
	await expect(frame.getByTestId("slides-current-note")).toHaveText("First authored note");
	await page.screenshot({ path: testInfo.outputPath("import-converter-unavailable.png") });
});

test("an iframe document navigation cannot retain recording or file-picker authority", async ({ page }) => {
	const frame = await openInstalledHost(page);
	await frame.getByLabel(/Open PDF/).click();
	await expect(frame.locator("canvas")).toBeVisible();
	await frame.getByRole("button", { name: "Record MP4" }).click();
	await frame.getByRole("button", { name: "Stop recording" }).click();
	await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_recording_stop").length)).toBe(1);
	const originalSrc = await page.locator("iframe").getAttribute("src");
	await page.evaluate(() => { (window as any).fixture.delay = true; });
	await frame.getByLabel(/Open PDF/).click();
	await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_open_document").length)).toBe(2);
	await page.route("**/slides-e2e-rogue", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Navigation fixture</title><p>Different document at the same asset origin</p>" }));
	const child = page.frames().find(item => item.url().includes("/slides.html"))!;
	await child.goto(new URL("/slides-e2e-rogue", child.url()).href);
	expect(await page.locator("iframe").getAttribute("src")).toBe(originalSrc);
	await child.evaluate(() => {
		(window as any).receivedFileMessages = [];
		window.addEventListener("message", (event) => {
			if (event.data?.type !== "naia-slides:files") return;
			(window as any).receivedFileMessages.push(event.data);
			if (event.data.action === "available") {
				window.parent.postMessage({ type: "naia-slides:files", action: "open", id: "rogue-cap-open", capability: event.data.capability }, "*");
			}
		});
		window.parent.postMessage({ type: "naia-slides:host", action: "hello", id: "rogue-hello" }, "*");
		window.parent.postMessage({ type: "naia-slides:host", action: "recording-start", id: "rogue-start" }, "*");
		window.parent.postMessage({ type: "naia-slides:files", action: "probe", id: "rogue-probe" }, "*");
		window.parent.postMessage({ type: "naia-slides:files", action: "open", id: "rogue-open" }, "*");
	});
	await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_cancel_open").length)).toBe(1);
	await page.evaluate(() => { (window as any).fixture.complete(); });
	// The legitimate recording above warmed the same native wrapper. Allow its
	// asynchronous request path to settle before asserting absence of authority.
	await page.waitForTimeout(300);
	expect(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_recording_start").length)).toBe(1);
	expect(await page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_open_document").length)).toBe(2);
	expect(await child.evaluate(() => (window as any).receivedFileMessages)).toEqual([]);
});

test("a pending file result cannot reach a replacement document before its load event", async ({ page }) => {
	const frame = await openInstalledHost(page);
	await frame.getByLabel(/Open PDF/).click();
	await expect(frame.locator("canvas")).toBeVisible();
	await page.evaluate(() => { (window as any).fixture.delay = true; });
	await frame.getByLabel(/Open PDF/).click();
	await expect.poll(() => page.evaluate(() => (window as any).fixture.calls.filter((call: any) => call.command === "slides_open_document").length)).toBe(2);
	let releaseLoad!: () => void;
	const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
	await page.route("**/slides-e2e-load-blocker", async route => {
		await loadGate;
		await route.fulfill({ status: 204, body: "" });
	});
	await page.route("**/slides-e2e-pending-document", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Replacement pending load</title><script>window.received=[];window.addEventListener("message",event=>window.received.push(event.data));</script><img src="/slides-e2e-load-blocker">' }));
	const child = page.frames().find(item => item.url().includes("/slides.html"))!;
	try {
		await child.goto(new URL("/slides-e2e-pending-document", child.url()).href, { waitUntil: "commit" });
		await expect.poll(() => child.evaluate(() => document.title)).toBe("Replacement pending load");
		expect(await child.evaluate(() => document.readyState)).not.toBe("complete");
		await page.evaluate(() => { (window as any).fixture.complete(); });
		await page.waitForTimeout(200);
		expect(await child.evaluate(() => (window as any).received.filter((data: any) => data?.type === "naia-slides:files"))).toEqual([]);
	} finally {
		releaseLoad();
	}
	await child.waitForLoadState("load");
});
