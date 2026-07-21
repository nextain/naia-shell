import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	E2E_TARGET_DIR,
	E2E_WEBVIEW2_DATA,
	assertCodexE2eIsolation,
	cleanupCodexE2eRoot,
	configureCodexE2eEnvironment,
	resetCodexE2eRoot,
	startOwnedEmbeddedApp,
	startOwnedViteServer,
	stopOwnedEmbeddedApp,
	stopOwnedViteServer,
} from "./codex-e2e-environment.js";

const EXE = process.platform === "win32" ? ".exe" : "";
const TAURI_BINARY =
	process.env.TAURI_BINARY ??
	resolve(E2E_TARGET_DIR, "debug", `naia-shell${EXE}`);
if (process.env.NAIA_E2E_AVATAR !== "1") {
	throw new Error(
		"Set NAIA_E2E_AVATAR=1 to run the real 4060 facade acceptance",
	);
}
configureCodexE2eEnvironment();

export const config = {
	runner: "local" as const,
	specs: ["./specs/94-avatar-4060-facade.spec.ts"],
	maxInstances: 1,
	hostname: "127.0.0.1",
	port: Number(process.env.NAIA_E2E_WEBDRIVER_PORT ?? "4490"),
	capabilities: [
		{
			maxInstances: 1,
			browserName: "tauri",
			"wdio:enforceWebDriverClassic": true,
			pageLoadStrategy: "eager",
			"tauri:options": { application: TAURI_BINARY },
		},
	],
	logLevel: "error",
	waitforTimeout: 30_000,
	connectionRetryTimeout: 120_000,
	connectionRetryCount: 2,
	framework: "mocha",
	mochaOpts: { ui: "bdd", timeout: 300_000 },
	reporters: ["spec"],
	async onPrepare() {
		if (!existsSync(TAURI_BINARY))
			throw new Error(`Missing embedded E2E binary: ${TAURI_BINARY}`);
		resetCodexE2eRoot();
		assertCodexE2eIsolation();
		await startOwnedViteServer();
		await startOwnedEmbeddedApp(TAURI_BINARY);
	},
	async before() {
		await browser.waitUntil(
			async () => {
				try {
					return await browser.execute(() =>
						document.location.href.startsWith("http"),
					);
				} catch {
					return false;
				}
			},
			{
				timeout: 45_000,
				timeoutMsg: "embedded Tauri webview never reached dedicated E2E Vite",
			},
		);
		if (!existsSync(E2E_WEBVIEW2_DATA))
			throw new Error(
				"WebView2 test profile was not created under the owned E2E root",
			);
	},
	async onComplete() {
		try {
			await stopOwnedEmbeddedApp();
			stopOwnedViteServer();
		} finally {
			cleanupCodexE2eRoot();
		}
	},
};
