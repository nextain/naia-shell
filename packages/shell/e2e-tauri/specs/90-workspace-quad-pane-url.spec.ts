import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { S } from "../helpers/selectors.js";
import { clickElement } from "../helpers/click.js";
import { safeRefresh, setNativeValue } from "../helpers/settings.js";

describe("90 — Workspace Quad Pane URL & Config Persistence", () => {
	it("should display the app root and navigate to workspace", async () => {
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });
		await safeRefresh();

		// Switch to workspace tab
		await clickElement('button[data-app-id="workspace"]', 30_000);

		// Wait for 3-pane quad layout to be visible
		const quadView = await $('[data-testid="workspace-quad"]');
		await quadView.waitForDisplayed({ timeout: 30_000 });
	});

	it("should verify default URLs for board (8896) and docs (3142) panes", async () => {
		// Board pane default URL
		const boardPane = await $('[data-testid="quad-pane-dashboard"]');
		await boardPane.waitForDisplayed({ timeout: 10_000 });
		await browser.waitUntil(
			async () => {
				const text = await browser.execute(() => {
					const el = document.querySelector(
						'[data-testid="quad-pane-dashboard"] .workspace-quad__pane-url',
					);
					return el?.textContent ?? "";
				});
				return text.includes("8896");
			},
			{ timeout: 10_000, timeoutMsg: "board pane url does not contain 8896" },
		);

		// Docs pane default URL
		const docsPane = await $('[data-testid="quad-pane-docs"]');
		await docsPane.waitForDisplayed({ timeout: 10_000 });
		await browser.waitUntil(
			async () => {
				const text = await browser.execute(() => {
					const el = document.querySelector(
						'[data-testid="quad-pane-docs"] .workspace-quad__pane-url',
					);
					return el?.textContent ?? "";
				});
				return text.includes("3142");
			},
			{ timeout: 10_000, timeoutMsg: "docs pane url does not contain 3142" },
		);
	});

	it("should update docs URL via UI and persist to config file", async () => {
		// Click change URL on docs pane
		await clickElement('[data-testid="quad-docs-change-url"]', 10_000);

		const urlInput = await $('[data-testid="quad-docs-url-input"]');
		await urlInput.waitForDisplayed({ timeout: 10_000 });

		// Fill new URL
		await setNativeValue(
			'[data-testid="quad-docs-url-input"]',
			"http://127.0.0.1:3142/docs",
		);

		// Click Save
		await clickElement('[data-testid="quad-docs-url-save"]', 10_000);
		await urlInput.waitForDisplayed({ reverse: true, timeout: 10_000 });

		// Check displayed URL updated
		await browser.waitUntil(
			async () => {
				const text = await browser.execute(() => {
					const el = document.querySelector(
						'[data-testid="quad-pane-docs"] .workspace-quad__pane-url',
					);
					return el?.textContent ?? "";
				});
				return text.includes("127.0.0.1:3142/docs");
			},
			{ timeout: 10_000, timeoutMsg: "docs pane did not display updated URL" },
		);

		// Verify on disk config file if NAIA_E2E_ADK_PATH is set
		const rawAdkPath = process.env.NAIA_E2E_ADK_PATH?.trim();
		if (rawAdkPath) {
			const uiConfigPath = resolve(rawAdkPath, "naia-settings", "ui-config.json");
			const configPath = resolve(rawAdkPath, "naia-settings", "config.json");
			await browser.waitUntil(
				() => {
					try {
						for (const p of [uiConfigPath, configPath]) {
							if (existsSync(p)) {
								const raw = readFileSync(p, "utf8");
								const parsed = JSON.parse(raw);
								if (
									parsed.uiPreferences?.workspaceQuadDocsUrl ===
									"http://127.0.0.1:3142/docs"
								) {
									return true;
								}
							}
						}
						return false;
					} catch {
						return false;
					}
				},
				{
					timeout: 10_000,
					timeoutMsg:
						"workspaceQuadDocsUrl was not written to naia-settings config",
				},
			);
		}
	});

	it("should reject invalid URL and display role=alert error message", async () => {
		await clickElement('[data-testid="quad-docs-change-url"]', 10_000);

		const urlInput = await $('[data-testid="quad-docs-url-input"]');
		await urlInput.waitForDisplayed({ timeout: 10_000 });

		// Enter invalid external URL
		await setNativeValue(
			'[data-testid="quad-docs-url-input"]',
			"http://example.com",
		);

		await clickElement('[data-testid="quad-docs-url-save"]', 10_000);

		// Expect role="alert" error element to be displayed
		const errorAlert = await $('[data-testid="quad-docs-url-error"]');
		await errorAlert.waitForDisplayed({ timeout: 10_000 });
		const role = await browser.execute(
			() =>
				document
					.querySelector('[data-testid="quad-docs-url-error"]')
					?.getAttribute("role") ?? "",
		);
		expect(role).toBe("alert");

		// Cancel to reset
		await clickElement('[data-testid="quad-docs-url-cancel"]', 10_000);
		await urlInput.waitForDisplayed({ reverse: true, timeout: 10_000 });
	});
});

