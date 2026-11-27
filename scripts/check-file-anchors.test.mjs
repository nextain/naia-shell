import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const KEY = "packages/shell/src/lib/kiosk-demo/kb-compiler/interpolate-message.ts";
const MANIFEST_URL = new URL("../.agents/context/module-manifest.json", import.meta.url);
const VALID_LAYERS = new Set(["domain", "ports", "app", "adapters", "composition"]);

function loadManifest() {
	return JSON.parse(readFileSync(MANIFEST_URL, "utf8"));
}

test("kb-compiler message helper carries a file-anchor contract", () => {
	const manifest = loadManifest();
	const anchor = manifest.files?.[KEY];
	assert.ok(anchor, `${KEY} is missing from module-manifest.json files`);
	assert.ok(
		anchor.layer && VALID_LAYERS.has(anchor.layer),
		`${KEY}: layer missing or not allowed`,
	);
	assert.ok(anchor.uc, `${KEY}: uc anchor missing`);
	assert.ok(anchor.contract, `${KEY}: contract document anchor missing`);
	assert.ok(
		existsSync(new URL(`../${KEY}`, import.meta.url)),
		`${KEY}: manifest entry is stale, file not on disk`,
	);
});

test("the file-anchors gate stays green end to end", () => {
	const gate = spawnSync(process.execPath, ["scripts/check-file-anchors.mjs"], {
		encoding: "utf8",
		timeout: 120_000,
	});
	assert.ifError(gate.error);
	assert.equal(gate.status, 0, gate.stdout + gate.stderr);
});
