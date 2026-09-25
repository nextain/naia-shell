import { existsSync } from "node:fs";
import { transformRequest } from "./node26-request.js";
import { resolve } from "node:path";
import {
	E2E_TARGET_DIR,
	E2E_WEBDRIVER_PORT,
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

/**
 * 70c 전용 실행 conf — 실 기본 프로바이더(nextain/deepseek-v4-flash) 라이브 대화.
 * voice-6g conf 와 같은 codex-e2e-environment 소유 앱/vite 기동을 재사용한다.
 * NAIA_API_KEY(gw- 유료 테스트 회원 키) 없이는 실행 불가(라이브 전용).
 */
const EXE = process.platform === "win32" ? ".exe" : "";
const TAURI_BINARY =
	process.env.TAURI_BINARY ??
	resolve(E2E_TARGET_DIR, "debug", `naia-shell${EXE}`);
if (!process.env.NAIA_API_KEY?.startsWith("gw-"))
	throw new Error(
		"NAIA_API_KEY must contain a paid test member gateway key",
	);
configureCodexE2eEnvironment();

export const config = {
	transformRequest,
	runner: "local" as const,
	specs: ["./specs/70c-nextain-default-chat.spec.ts"],
	maxInstances: 1,
	hostname: "127.0.0.1",
	port: E2E_WEBDRIVER_PORT,
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
	connectionRetryTimeout: 300_000,
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
			{ timeout: 45_000, timeoutMsg: "Tauri webview did not reach E2E Vite" },
		);
		if (!existsSync(E2E_WEBVIEW2_DATA))
			throw new Error("isolated WebView2 profile was not created");
		await browser.waitUntil(
			() => browser.execute(() => document.querySelector(".app-root") !== null),
			{ timeout: 30_000, timeoutMsg: "Shell app root did not render" },
		);
		await browser.pause(1_500);
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
