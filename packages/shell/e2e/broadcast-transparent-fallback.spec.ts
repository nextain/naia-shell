import { expect, test } from "@playwright/test";

for (const width of [360, 1100]) {
	test(`broadcast media stays transparent on failure at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 800 });
		// Load source modules without booting the unrelated app.
		await page.route("**/broadcast-hotfix", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: '<html><body><div id="test"></div></body></html>',
			}),
		);
		await page.goto("/broadcast-hotfix");
		await page.evaluate(async () => {
			const RefreshRuntime = (await import("/@react-refresh")).default;
			RefreshRuntime.injectIntoGlobalHook(window);
			(window as any).$RefreshReg$ = () => {};
			(window as any).$RefreshSig$ = () => (type: unknown) => type;
			(window as any).__vite_plugin_react_preamble_installed__ = true;
			const React = (await import("/node_modules/.vite/deps/react.js")).default;
			const { createRoot } = (
				await import("/node_modules/.vite/deps/react-dom_client.js")
			).default;
			const { ResilientVideo } = await import(
				"/src/components/ResilientVideo.tsx"
			);
			const { VideoAvatarCanvas } = await import(
				"/src/components/VideoAvatarCanvas.tsx"
			);
			localStorage.setItem("naia-adk-path", "/tmp/test-adk");
			let rejectManifest: (error: Error) => void;
			(window as any).__TAURI_INTERNALS__ = {
				transformCallback: () => 1,
				unregisterCallback: () => {},
				invoke: (cmd: string) =>
					cmd !== "read_local_binary"
						? Promise.resolve(null)
						: new Promise((_, reject) => {
								rejectManifest = reject;
							}),
			};
			HTMLMediaElement.prototype.play = () => Promise.resolve();
			const root = createRoot(document.getElementById("test")!);
			(window as any).hotfixRoot = root;
			const draw = (key: string) =>
				root.render(
					React.createElement(
						"main",
						{ key },
						React.createElement(
							"div",
							{ style: { height: 300, width: "100%" } },
							React.createElement(VideoAvatarCanvas, { nvaModel: "naia" }),
						),
						React.createElement(ResilientVideo, {
							src: "data:video/webm;base64,",
							autoPlay: true,
							"aria-label": "Preview",
						}),
						React.createElement("input", { "aria-label": "Name" }),
					),
				);
			(window as any).hotfixDraw = draw;
			(window as any).failManifest = () =>
				rejectManifest(new Error("fixture media unavailable"));
			draw("initial");
		});
		await expect(
			page.locator('[data-video-avatar-status="loading"]'),
		).toBeVisible();
		await expect(page.locator("img")).toHaveCount(0);
		await page.evaluate(() => (window as any).failManifest());
		await expect(
			page.locator('[data-video-avatar-status="error"]'),
		).toBeVisible();
		await expect(page.locator("[data-video-avatar-prebaked]")).toHaveCSS(
			"visibility",
			"hidden",
		);
		await page
			.locator('video[aria-label="Preview"]')
			.evaluate((v) => v.dispatchEvent(new Event("error")));
		await expect(page.locator('video[aria-label="Preview"]')).toBeHidden();
		await expect(page.locator("img")).toHaveCount(0);
		await page.getByRole("textbox", { name: "Name" }).focus();
		await page.keyboard.type("Broadcast remains usable");
		await expect(page.getByRole("textbox")).toHaveValue(
			"Broadcast remains usable",
		);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await page.screenshot({
			path: test.info().outputPath(`transparent-${width}.png`),
		});
		await page.evaluate(() => (window as any).hotfixDraw("retry"));
		await expect(
			page.locator('[data-video-avatar-status="loading"]'),
		).toBeVisible();
		await expect(page.locator("img")).toHaveCount(0);
	});
}
