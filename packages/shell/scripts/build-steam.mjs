#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stageRuntimeScript = resolve(__dirname, "stage-runtime.mjs");

const env = {
	...process.env,
	VITE_NAIA_DISTRIBUTION: "steam",
};

const result = spawnSync(
	process.execPath,
	[stageRuntimeScript, ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env,
	},
);

if (result.error) {
	console.error(result.error);
	process.exit(1);
}

process.exit(result.status ?? 0);
