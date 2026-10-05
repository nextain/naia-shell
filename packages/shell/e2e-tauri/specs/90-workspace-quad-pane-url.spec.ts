import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { S } from "../helpers/selectors.js";
import { clickElement } from "../helpers/click.js";
import { safeRefresh, setNativeValue } from "../helpers/settings.js";

async function resolveRequiredAdkPath(): Promise<string> {
	let adkPath = process.env.NAIA_E2E_ADK_PATH?.trim();
	if (!adkPath || !existsSync(adkPath)) {
		const localStoragePath = await browser
			.execute(() => localStorage.getItem("naia-adk-path") ?? "")
			.catch(() => "");
		if (localStoragePath && existsSync(localStoragePath)) {
			adkPath = localStoragePath;
		}
	}
	if (!adkPath || !existsSync(adkPath)) {
		throw new Error(
			`Required ADK path could not be found or does not exist (env NAIA_E2E_ADK_PATH=${process.env.NAIA_E2E_ADK_PATH})`,
		);
	}
	return adkPath;
}

describe("90 — Workspace Quad Pane URL & Config Persistence", () => {
	let mockBoardServer: Server | null = null;
	let mockDocsServer: Server | null = null;

	before(async () => {
		// Ensure port 8896 responds for board pane iframe
		await new Promise<void>((resolve) => {
			const server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end("<!DOCTYPE html><html><body><h1>Board Server</h1></body></html>");
			});
			server.on("error", (_err: any) => {
				resolve();
			});
			server.listen(8896, () => {
				mockBoardServer = server;
				resolve();
			});
		});

		// Ensure port 3142 responds for docs pane iframe
		await new Promise<void>((resolve) => {
			const server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end("<!DOCTYPE html><html><body><h1>Docs Server</h1></body></html>");
			});
			server.on("error", (_err: any) => {
				resolve();
			});
			server.listen(3142, () => {
				mockDocsServer = server;
				resolve();
			});
		});
	});

	after(async () => {
		if (mockBoardServer) {
			await new Promise<void>((resolve) => mockBoardServer?.close(() => resolve()));
			mockBoardServer = null;
		}
		if (mockDocsServer) {
			await new Promise<void>((resolve) => mockDocsServer?.close(() => resolve()));
			mockDocsServer = null;
		}
	});
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
		const expectedDefaultBoardUrl = "http://127.0.0.1:8896/";
		const expectedDefaultDocsUrl = "http://localhost:3142/docs";

		// Board pane default URL
		const boardIframe = await $('[data-testid="quad-dashboard-iframe"]');
		await boardIframe.waitForExist({ timeout: 10_000 });
		await browser.waitUntil(
			async () => {
				const src = await boardIframe.getAttribute("src");
				return src === expectedDefaultBoardUrl;
			},
			{ timeout: 10_000, timeoutMsg: `board iframe src does not equal ${expectedDefaultBoardUrl}` },
		);
		expect(await boardIframe.getAttribute("src")).toBe(expectedDefaultBoardUrl);

		// Docs pane default URL
		const docsIframe = await $('[data-testid="quad-docs-iframe"]');
		await docsIframe.waitForExist({ timeout: 10_000 });
		await browser.waitUntil(
			async () => {
				const src = await docsIframe.getAttribute("src");
				return src === expectedDefaultDocsUrl;
			},
			{ timeout: 10_000, timeoutMsg: `docs iframe src does not equal ${expectedDefaultDocsUrl}` },
		);
		expect(await docsIframe.getAttribute("src")).toBe(expectedDefaultDocsUrl);
	});

	it("should update docs URL via UI and persist to config file", async () => {
		const targetDocsUrl = "http://127.0.0.1:3142/docs";

		// Click change URL on docs pane
		await clickElement('[data-testid="quad-docs-change-url"]', 10_000);

		const urlInput = await $('[data-testid="quad-docs-url-input"]');
		await urlInput.waitForDisplayed({ timeout: 10_000 });

		// Fill new URL
		await setNativeValue(
			'[data-testid="quad-docs-url-input"]',
			targetDocsUrl,
		);

		// Click Save
		await clickElement('[data-testid="quad-docs-url-save"]', 10_000);
		await urlInput.waitForDisplayed({ reverse: true, timeout: 10_000 });

		// Check displayed URL updated via iframe src exact comparison
		const docsIframe = await $('[data-testid="quad-docs-iframe"]');
		await docsIframe.waitForExist({ timeout: 10_000 });
		await browser.waitUntil(
			async () => {
				const src = await docsIframe.getAttribute("src");
				return src === targetDocsUrl;
			},
			{ timeout: 10_000, timeoutMsg: `docs pane did not display updated URL ${targetDocsUrl}` },
		);
		expect(await docsIframe.getAttribute("src")).toBe(targetDocsUrl);

		// Verify on disk config file (mandatory check)
		const adkPath = await resolveRequiredAdkPath();
		const uiConfigPath = resolve(adkPath, "naia-settings", "ui-config.json");
		const configPath = resolve(adkPath, "naia-settings", "config.json");
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
					`workspaceQuadDocsUrl was not written to naia-settings config in ${adkPath}`,
			},
		);
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

	it("should update board URL, verify config file, restart app via reloadSession, and restore board URL", async () => {
		const targetBoardUrl = "http://localhost:8896/";
		const adkPath = await resolveRequiredAdkPath();

		// Click change URL on board pane
		await clickElement('[data-testid="quad-dashboard-change-url"]', 10_000);

		const urlInput = await $('[data-testid="quad-dashboard-url-input"]');
		await urlInput.waitForDisplayed({ timeout: 10_000 });

		// Fill new board URL
		await setNativeValue(
			'[data-testid="quad-dashboard-url-input"]',
			targetBoardUrl,
		);

		// Click Save
		await clickElement('[data-testid="quad-dashboard-url-save"]', 10_000);
		await urlInput.waitForDisplayed({ reverse: true, timeout: 10_000 });

		// Check displayed URL updated via iframe src exact comparison
		const boardIframe = await $('[data-testid="quad-dashboard-iframe"]');
		await boardIframe.waitForExist({ timeout: 10_000 });
		await browser.waitUntil(
			async () => {
				const src = await boardIframe.getAttribute("src");
				return src === targetBoardUrl;
			},
			{ timeout: 10_000, timeoutMsg: `board pane did not display updated URL ${targetBoardUrl}` },
		);
		expect(await boardIframe.getAttribute("src")).toBe(targetBoardUrl);

		// Verify on disk config file (MANDATORY check)
		const uiConfigPath = resolve(adkPath, "naia-settings", "ui-config.json");
		const configPath = resolve(adkPath, "naia-settings", "config.json");
		await browser.waitUntil(
			() => {
				try {
					for (const p of [uiConfigPath, configPath]) {
						if (existsSync(p)) {
							const raw = readFileSync(p, "utf8");
							const parsed = JSON.parse(raw);
							if (
								parsed.uiPreferences?.workspaceQuadBoardUrl ===
								targetBoardUrl
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
					`workspaceQuadBoardUrl was not written to naia-settings config in ${adkPath}`,
			},
		);

		// Restart app via browser.reloadSession()
		await browser.reloadSession();

		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });
		await safeRefresh();

		// Navigate back to workspace
		await clickElement('button[data-app-id="workspace"]', 30_000);

		const quadView = await $('[data-testid="workspace-quad"]');
		await quadView.waitForDisplayed({ timeout: 30_000 });

		// Check that the board pane restored the persisted URL via iframe src exact comparison
		const restoredBoardIframe = await $('[data-testid="quad-dashboard-iframe"]');
		await restoredBoardIframe.waitForExist({ timeout: 15_000 });
		await browser.waitUntil(
			async () => {
				const src = await restoredBoardIframe.getAttribute("src");
				return src === targetBoardUrl;
			},
			{
				timeout: 15_000,
				timeoutMsg: `board pane did not restore updated URL ${targetBoardUrl} after reloadSession`,
			},
		);
		expect(await restoredBoardIframe.getAttribute("src")).toBe(targetBoardUrl);
	});
});

