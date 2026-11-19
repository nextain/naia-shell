import { expect, test } from "@playwright/test";

// Mount the production component with a controlled local directory. The current
// desktop entry point does not route to this web component, so this is focused
// component evidence and not an end-to-end claim about the web product.
test("directory errors are recoverable at narrow width", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 600, height: 800 });
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/workspace-recovery-host") {
			return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><link rel="stylesheet" href="/src/styles/global.css"></head><body><div id="root"></div></body></html>' });
		}
		if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.continue();
		return route.abort();
	});
	await page.addInitScript(() => {
		Object.assign(window, {
			$RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type,
			__vite_plugin_react_preamble_installed__: true,
		});
	});
	await page.goto("/workspace-recovery-host");
	await page.evaluate(async () => {
		let calls = 0;
		let finish: ((value: IteratorResult<FileSystemHandle>) => void) | undefined;
		const dir = {
			values() {
				calls += 1;
				if (calls === 1) return (async function* () { throw new Error("read failed"); })();
				return {
					[Symbol.asyncIterator]() { return this; },
					next: () => new Promise<IteratorResult<FileSystemHandle>>((resolve) => { finish = resolve; }),
				};
			},
		};
		Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } });
		Object.assign(window, { finishDirectory: () => finish?.({ done: true, value: undefined }), directoryCalls: () => calls });
		const reactPath = "/node_modules/.vite/deps/react.js";
		const domPath = "/node_modules/.vite/deps/react-dom_client.js";
		const workspacePath = "/src/apps/workspace/WebWorkspace.tsx";
		const statusPath = "/src/lib/web-runtime/web-adk-status.ts";
		const React = (await import(reactPath)).default;
		const { createRoot } = (await import(domPath)).default;
		const { default: WebWorkspace } = await import(workspacePath);
		const { setWebAdkStatus } = await import(statusPath);
		setWebAdkStatus({ phase: "ready" });
		createRoot(document.getElementById("root")).render(React.createElement(WebWorkspace));
	});
	const alert = page.getByRole("alert");
	await expect(alert).toContainText("Could not read files.");
	const retry = page.getByRole("button", { name: "Retry" });
	await page.screenshot({ path: testInfo.outputPath("error-narrow.png") });
	await retry.focus();
	await page.keyboard.press("Enter");
	await expect(retry).toBeDisabled();
	await expect(page.getByRole("status")).toHaveText("Loading…");
	const box = await retry.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(600);
	await page.evaluate(() => (window as unknown as { finishDirectory: () => void }).finishDirectory());
	await expect(page.getByText("No files or folders to display")).toBeVisible();
	await expect(alert).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => (window as unknown as { directoryCalls: () => number }).directoryCalls())).toBe(2);
});
