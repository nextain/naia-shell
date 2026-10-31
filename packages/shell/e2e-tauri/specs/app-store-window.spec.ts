const STORE_BUTTON = "button.app-bar-tab--utility";
const RESPONSE_LIMIT_MS = 10_000;

async function within<T>(operation: Promise<T>, description: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${description} exceeded 10 seconds`)), RESPONSE_LIMIT_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function isFocused(label: string): Promise<boolean> {
	return browser.execute(async (windowLabel: string) => {
		const internals = (window as unknown as {
			__TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<boolean> };
		}).__TAURI_INTERNALS__;
		return internals.invoke("plugin:window|is_focused", { label: windowLabel });
	}, label);
}

describe("Windows native app store window [UC-FIX-024-I1]", function () {
	// The Windows in-app WebDriver exposes Tauri window labels as handles.
	before(function () {
		if (process.platform !== "win32") this.skip();
	});

	it("opens, refocuses and closes one store window while the main window responds", async function () {
		this.timeout(90_000);
		const main = await browser.getWindowHandle();
		expect(main).toBe("main");
		const button = await $(STORE_BUTTON);
		await button.waitForDisplayed({ timeout: 30_000 });
		expect(await browser.getWindowHandles()).not.toContain("app-store");

		// The former synchronous Windows command can deadlock WebView2 here; the bounded main-window probe must fail.
		await within(button.click(), "opening the store from the main window");
		const rootExists = await within(browser.execute(() => Boolean(document.querySelector("#root"))), "main window response after opening");
		expect(rootExists).toBe(true);
		await within(browser.waitUntil(async () => (await browser.getWindowHandles()).includes("app-store"), {
			timeout: RESPONSE_LIMIT_MS,
			timeoutMsg: "app-store window was not created",
		}), "app-store window creation");
		const handles = await within(browser.getWindowHandles(), "window enumeration");
		expect(handles.filter((handle) => handle === "app-store")).toHaveLength(1);
		expect(handles).toHaveLength(2);

		await within(browser.switchToWindow("app-store"), "switching to the store window");
		await within(browser.waitUntil(async () => {
			const url = await browser.getUrl();
			return /^https:\/\/(?:www\.)?(?:naia\.land|naia\.nextain\.io)\/[a-z-]+\/apps(?:[/?#]|$)/i.test(url)
				|| /^https:\/\/dev\.naia\.land\/[a-z-]+\/apps(?:[/?#]|$)/i.test(url);
		}, { timeout: RESPONSE_LIMIT_MS, timeoutMsg: "store webview did not navigate to the store URL" }), "store URL navigation");
		await within(browser.waitUntil(
			() => browser.execute(() => document.readyState === "complete"),
			{ timeout: RESPONSE_LIMIT_MS, timeoutMsg: "store document did not finish loading" },
		), "store document readiness");
		// The store is an external site; require visible text and child elements rather than a site-specific selector.
		await within(browser.waitUntil(
			() => browser.execute(() => Boolean(document.body?.children.length && document.body.innerText.trim())),
			{ timeout: RESPONSE_LIMIT_MS, timeoutMsg: "store document has no visible content" },
		), "store content rendering");

		await within(browser.switchToWindow(main), "switching to the main window");
		// A WebDriver context switch alone does not bring a native window to the foreground.
		await within(browser.execute(() => window.focus()), "requesting main window focus");
		await within(browser.waitUntil(() => isFocused(main), {
			timeout: RESPONSE_LIMIT_MS,
			timeoutMsg: "main window did not gain native focus before the second click",
		}), "main window focus");
		expect(await within(isFocused("app-store"), "checking previous store focus")).toBe(false);
		await within(button.click(), "reopening the store");
		await within(browser.waitUntil(() => isFocused("app-store"), {
			timeout: RESPONSE_LIMIT_MS,
			timeoutMsg: "the existing store window did not regain native focus",
		}), "existing store focus");
		const reopenedHandles = await within(browser.getWindowHandles(), "window enumeration after reopening");
		expect(reopenedHandles.sort()).toEqual(handles.sort());

		// Close through the actual Tauri window API, allowing normal close events to run.
		await within(browser.execute(async () => {
			const internals = (window as unknown as {
				__TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<void> };
			}).__TAURI_INTERNALS__;
			await internals.invoke("plugin:window|close", { label: "app-store" });
		}), "closing the store window");
		await within(browser.waitUntil(async () => !(await browser.getWindowHandles()).includes("app-store"), {
			timeout: RESPONSE_LIMIT_MS,
			timeoutMsg: "app-store window remained after close",
		}), "store window close");
		expect(await within(browser.execute(() => Boolean(document.querySelector("#root"))), "main window response after closing")).toBe(true);
	});
});
