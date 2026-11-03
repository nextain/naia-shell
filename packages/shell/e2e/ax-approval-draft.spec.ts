import { expect, test } from "@playwright/test";
for (const width of [1100, 360])
	for (const locale of ["ko", "en"]) {
		test(`AX draft ${locale} ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await page.route("**/r7-ax-harness", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: '<!doctype html><html><body><main id="draft"></main></body></html>',
				}),
			);
			await page.goto("/r7-ax-harness");
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await page.evaluate(
				async ({ locale }) => {
					const win = window as any;
					const { default: RefreshRuntime } = await import(
						"/@react-refresh" as string
					);
					RefreshRuntime.injectIntoGlobalHook(win);
					win.$RefreshReg$ = () => {};
					win.$RefreshSig$ = () => (type: any) => type;
					win.__vite_plugin_react_preamble_installed__ = true;
					const { default: React } = await import(
						"/node_modules/.vite/deps/react.js" as string
					);
					const {
						default: { createRoot },
					} = await import(
						"/node_modules/.vite/deps/react-dom_client.js" as string
					);
					const { AxApprovalDraft } = await import(
						"/src/components/AxApprovalDraft.tsx" as string
					);
					const evidence = Object.freeze({}),
						token = Object.freeze({});
					const state = (win.__ax = {
						calls: [],
						results: [],
						authenticated: true,
						accept: true,
						active: true,
					});
					const host = {
						displayed: (id: string) => {
							state.calls.push(["displayed", id]);
							return state.active;
						},
						beginInput: (e: unknown) => {
							state.calls.push(["capture"]);
							return state.authenticated && e === evidence ? token : undefined;
						},
						submit: (t: object, input: any) => {
							state.calls.push(["submit", t === token, input]);
							return state.accept;
						},
						invalidate: () => {
							state.active = false;
							state.calls.push(["invalidate"]);
						},
						dispose: () => state.calls.push(["dispose"]),
					};
					const root = createRoot(document.getElementById("draft")),
						getEvidence = () => evidence;
					win.__renderAx = (id: string, mode = "conversation") => (
						(state.active = true),
						root.render(
							React.createElement(
								React.StrictMode,
								null,
								React.createElement(AxApprovalDraft, {
									card: {
										proposalId: id,
										requestId: "r1",
										callId: "c1",
										mode,
										expiresAt: Date.now() + 120000,
										preview:
											"Report → recipient@example.test\n" +
											"검토 내용 Reviewed payload ".repeat(12),
									},
									host,
									evidence: getEvidence,
									locale,
									onSettled: (v: boolean) => state.results.push(v),
								}),
							),
						)
					);
					win.__unmountAx = () => root.unmount();
					win.__renderAx("p1");
				},
				{ locale },
			);
			const input = page.getByRole("textbox"),
				submit = page.getByRole("button", {
					name: locale === "ko" ? "응답 제출" : "Submit response",
				});
			await expect(page.getByRole("dialog")).toBeVisible();
			await expect(submit).toBeDisabled();
			await input.fill("응");
			await input.press("Enter");
			await expect(input).toBeDisabled();
			expect(await page.evaluate(() => (window as any).__ax.results)).toEqual([
				true,
			]);
			expect(
				await page.evaluate(
					() =>
						(window as any).__ax.calls.filter((x: any[]) => x[0] === "submit")
							.length,
				),
			).toBe(1);
			await page.evaluate(() => {
				(window as any).__ax.accept = false;
				(window as any).__renderAx("p2", "code");
			});
			await expect(input).toBeEnabled();
			await input.fill("wrong code");
			await submit.click();
			expect(await page.evaluate(() => (window as any).__ax.results)).toEqual([
				true,
				false,
			]);
			await expect(page.getByRole("status")).toBeVisible();
			await page.evaluate(() => {
				(window as any).__ax.authenticated = false;
				(window as any).__renderAx("p3");
			});
			await expect(input).toBeEnabled();
			await input.fill("응");
			await expect(input).toHaveValue("");
			await expect(page.getByRole("alert")).toBeVisible();
			await expect(submit).toBeDisabled();
			await page
				.getByRole("button", { name: locale === "ko" ? "취소" : "Cancel" })
				.click();
			await expect(page.getByRole("alert")).toHaveCount(0);
			const bounds = await page.getByRole("dialog").evaluate((el) => ({
				left: el.getBoundingClientRect().left,
				right: el.getBoundingClientRect().right,
				width: document.documentElement.clientWidth,
				scroll: document.documentElement.scrollWidth,
			}));
			expect(bounds.left).toBeGreaterThanOrEqual(0);
			expect(bounds.right).toBeLessThanOrEqual(width);
			expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
			await page.screenshot({
				path: test.info().outputPath(`ax-${locale}-${width}.png`),
			});
			await page.evaluate(() => (window as any).__unmountAx());
			await expect(page.getByRole("dialog")).toHaveCount(0);
			expect(
				await page.evaluate(() =>
					(window as any).__ax.calls.some((x: any[]) => x[0] === "invalidate"),
				),
			).toBe(true);
		});
	}
