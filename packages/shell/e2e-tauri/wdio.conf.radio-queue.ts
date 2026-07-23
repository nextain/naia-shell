import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configure, e2ePort, reset, root, start, stop, target, webview } from "./radio-queue-e2e-environment.js";

configure();
const binary = resolve(target, "debug", process.platform === "win32" ? "naia-shell.exe" : "naia-shell");
export const config = {
 runner: "local", specs: ["./specs/94-radio-bgm-queue.spec.ts"], maxInstances: 1,
 hostname: "127.0.0.1", port: e2ePort,
 capabilities: [{ maxInstances: 1, browserName: "tauri", "wdio:enforceWebDriverClassic": true, pageLoadStrategy: "eager" }],
 logLevel: "error", waitforTimeout: 30_000, connectionRetryTimeout: 90_000, connectionRetryCount: 1,
 framework: "mocha", mochaOpts: { ui: "bdd", timeout: 180_000 }, reporters: ["spec"],
 transformRequest: (request: { headers: Headers }) => { request.headers.delete("Content-Length"); return request; },
 async onPrepare() { if (!existsSync(binary)) throw new Error(`missing E2E binary: ${binary}`); reset(); await start(binary); },
 async before() { await browser.waitUntil(() => browser.execute(() => document.location.href.startsWith("http")), { timeout: 45_000, timeoutMsg: "native WebView did not reach isolated Vite" }); if (!existsSync(webview)) throw new Error(`isolated WebView profile missing under ${root}`); },
 async onComplete() { await stop(); },
};