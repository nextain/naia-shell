#!/usr/bin/env node
/**
 * tauri-with-mode.mjs — `pnpm run tauri:dev` / `pnpm run tauri:prod` wrapper.
 *
 * Loads the mode-specific env file (shell/.env.dev | shell/.env.prod) and
 * injects its VITE_* vars at process-spawn time so the shell's config.ts
 * (LAB_GATEWAY_URL) routes lab/realtime calls to the right any-llm gateway.
 * This is mode resolution at run-time of the dev server — NOT at Vite build
 * time — because Tauri dev shares one Vite mode, so a flag (not the Vite mode)
 * has to carry the dev/prod choice.
 *
 * URLs live in the .env.{mode} files, never here, so nothing is hardcoded:
 *   tauri:dev  → shell/.env.dev   (VITE_NAIA_USE_DEV_GATEWAY=1 + dev VM URL)
 *   tauri:prod → shell/.env.prod  (no dev flag → Cloud Run prod default)
 *
 * In prod mode the dev-gateway vars are force-cleared so a stale shell env can
 * never silently route a prod-login user to the dev gateway (would 401).
 *
 * E2E is unaffected — wdio.conf.ts loads .env.e2e directly (see #333).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "dev" ? "dev" : "prod";
const env = { ...process.env };

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", "shell", `.env.${mode}`);

/** Parse a minimal KEY=VALUE env file (comments + blank lines skipped). */
function loadEnvFile(path) {
	const vars = {};
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (key) vars[key] = val;
	}
	return vars;
}

// Prod must never carry the dev-gateway flag, regardless of the ambient shell.
if (mode === "prod") {
	delete env.VITE_NAIA_USE_DEV_GATEWAY;
	delete env.VITE_NAIA_DEV_GATEWAY_URL;
}

let injected = 0;
try {
	const vars = loadEnvFile(envPath);
	for (const [k, v] of Object.entries(vars)) {
		env[k] = v;
		injected++;
	}
	process.stdout.write(
		`[tauri-with-mode] ${mode.toUpperCase()} — injected ${injected} var(s) from .env.${mode}\n`,
	);
} catch {
	process.stdout.write(
		`[tauri-with-mode] ${mode.toUpperCase()} — no .env.${mode}; using config.ts default (prod gateway)\n`,
	);
}

const r = spawnSync("pnpm", ["run", "tauri", "dev"], {
	env,
	stdio: "inherit",
	shell: true,
});
process.exit(r.status ?? 1);
