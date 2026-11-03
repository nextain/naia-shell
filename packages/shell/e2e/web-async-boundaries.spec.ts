import { expect, test } from "@playwright/test";

test("cold modal, deep-link and recursive tree at 390px", async ({ page }, testInfo) => {
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (!["127.0.0.1", "localhost"].includes(url.hostname))
			return route.abort();
		if (url.pathname === "/")
			return route.fulfill({
				contentType: "text/html",
				body: '<html><body><div id="probe"></div></body></html>',
			});
		if (/\/(PermissionModal|ChatMarkdown)\.tsx/.test(url.pathname))
			await new Promise((resolve) => setTimeout(resolve, 1500));
		await route.continue();
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await page.evaluate(async () => {
		const load = (path: string) => import(/* @vite-ignore */ path);
		const refresh = await load("/@react-refresh");
		refresh.default.injectIntoGlobalHook(window);
		Object.assign(window, {
			$RefreshReg$: () => {},
			$RefreshSig$: () => (type: unknown) => type,
			__vite_plugin_react_preamble_installed__: true,
		});
		const { default: React } = await load("/node_modules/.vite/deps/react.js");
		const {
			default: { createRoot },
		} = await load("/node_modules/.vite/deps/react-dom_client.js");
		await load("/src/styles/global.css");
		const state = { decision: "", opened: "", selected: "" };
		Object.assign(window, {
			probe: state,
			__TAURI_INTERNALS__: {
				invoke: async (command: string, args: { parent: string }) => {
					if (command !== "workspace_list_dirs") return null;
					await new Promise((resolve) => setTimeout(resolve, 500));
					const entries: Record<string, unknown[]> = {
						"/work": [{ name: "src", path: "/work/src", is_dir: true }],
						"/work/src": [
							{ name: "nested", path: "/work/src/nested", is_dir: true },
						],
						"/work/src/nested": [
							{
								name: "App.tsx",
								path: "/work/src/nested/App.tsx",
								is_dir: false,
							},
						],
					};
					return entries[args.parent] || [];
				},
			},
		});
		const { appRegistry } = await load("/src/lib/app-registry.ts");
		appRegistry.getApi = () => ({
			openFile: (path: string) => {
				state.opened = path;
			},
		});
		const { PermissionModal } = await load(
			"/src/components/PermissionModal.tsx",
		);
		const { ChatMarkdown } = await load("/src/components/ChatMarkdown.tsx");
		const { FileTree } = await load("/src/apps/workspace/FileTree.tsx");
		const h = React.createElement;
		const root = createRoot(document.getElementById("probe"));
		const content = () => [
			h(ChatMarkdown, { key: "chat" }, "파일 /work/src/nested/App.tsx 확인"),
			h(FileTree, {
				key: "tree",
				workspaceRoot: "/work",
				openFilePath: "/work/src/nested/App.tsx",
				onFileSelect: (path: string) => {
					state.selected = path;
				},
			}),
		];
		root.render(
			h(
				React.Fragment,
				null,
				...content(),
				h(PermissionModal, {
					pending: {
						requestId: "r8",
						toolCallId: "t8",
						toolName: "read_file",
						args: { path: "/work/src/nested/App.tsx" },
						tier: 1,
						description: "Read file",
					},
					onDecision: (decision: string) => {
						state.decision = decision;
						root.render(h(React.Fragment, null, ...content()));
					},
				}),
			),
		);
	});
	await expect(page.locator(".permission-modal")).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("r8-permission-390.png"),
	});
	await page.keyboard.press("Alt+n");
	await expect
		.poll(() => page.evaluate(() => (window as any).probe.decision))
		.toBe("reject");
	await page
		.getByRole("button", { name: "/work/src/nested/App.tsx", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => (window as any).probe.opened))
		.toBe("/work/src/nested/App.tsx");
	const file = page.locator(".workspace-tree__node--open");
	await expect(file).toContainText("App.tsx");
	await file.focus();
	await page.keyboard.press("Enter");
	await expect
		.poll(() => page.evaluate(() => (window as any).probe.selected))
		.toBe("/work/src/nested/App.tsx");
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("r8-tree-390.png") });
});
