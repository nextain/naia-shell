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

// Always use PROD gateway — dev/prod split deferred.
delete env.VITE_NAIA_USE_DEV_GATEWAY;
delete env.VITE_NAIA_DEV_GATEWAY_URL;
process.stdout.write(
	`[tauri-with-mode] ${mode.toUpperCase()} — using PROD gateway\n`,
);

const r = spawnSync("pnpm", ["run", "tauri", "dev"], {
	env,
	stdio: "inherit",
	shell: true,
});
process.exit(r.status ?? 1);
