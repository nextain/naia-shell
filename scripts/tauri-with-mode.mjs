#!/usr/bin/env node
/**
 * tauri-with-mode.mjs — `pnpm run tauri:dev` / `pnpm run tauri:prod` wrapper.
 *
 * Sets VITE_NAIA_USE_DEV_GATEWAY + VITE_NAIA_DEV_GATEWAY_URL at process spawn
 * time so the shell's config.ts:542 routes lab proxy calls to the right
 * Naia Gateway (dev or prod). This is mode resolution at run-time of the dev
 * server — NOT at Vite build time — because Tauri dev shares one Vite mode.
 *
 * Used by:
 *   tauri:dev  → node tauri-with-mode.mjs dev   (Cloud Run dev gateway)
 *   tauri:prod → node tauri-with-mode.mjs prod  (Cloud Run prod gateway, default)
 *
 * E2E is unaffected — wdio.conf.ts loads .env.e2e directly (see #333).
 */

import { spawnSync } from "node:child_process";

const mode = process.argv[2] === "dev" ? "dev" : "prod";
const env = { ...process.env };

if (mode === "dev") {
	env.VITE_NAIA_USE_DEV_GATEWAY = "1";
	env.VITE_NAIA_DEV_GATEWAY_URL =
		env.VITE_NAIA_DEV_GATEWAY_URL ||
		"https://naia-gateway-dev-181404717065.asia-northeast3.run.app";
	// #337 §2.3 — naia-agent auth-store.getCurrentMode() reads NAIA_AGENT_MODE
	// for fall-back when an IPC handler does not pass mode explicitly. Without
	// this, lab_proxy_request and any internal path defaults to "prod" and
	// reads the wrong encrypted auth file (<ADK>/naia-settings/auth/prod.json.enc
	// instead of dev.json.enc) on the dev-mode shell.
	env.NAIA_AGENT_MODE = "dev";
	process.stdout.write(
		`[tauri-with-mode] DEV — VITE_NAIA_DEV_GATEWAY_URL=${env.VITE_NAIA_DEV_GATEWAY_URL}\n`,
	);
} else {
	// prod — explicitly clear so a leaked `.env.local` cannot route to dev
	delete env.VITE_NAIA_USE_DEV_GATEWAY;
	delete env.VITE_NAIA_DEV_GATEWAY_URL;
	env.NAIA_AGENT_MODE = "prod";
	process.stdout.write(
		"[tauri-with-mode] PROD — using _PROD_GATEWAY default in config.ts\n",
	);
}

const r = spawnSync("pnpm", ["run", "tauri", "dev"], {
	env,
	stdio: "inherit",
	shell: true,
});
process.exit(r.status ?? 1);
