#!/usr/bin/env node
/**
 * mirror-sync — PostToolUse on Edit|Write.
 *
 * When a curated `.agents/` context file (yaml|yml|md; json = charter, translate-excluded)
 * is edited, regenerate its `.users/` Korean mirror via a LIGHT model (gemini flash lite),
 * DECOUPLED from the main coding session ("the separate cron/light AI" — not the main loop
 * doing it by hand). Non-blocking: spawns detached and returns immediately so edits never wait.
 *
 * mirror-translate.mjs internally compares the source hash embedded in the mirror and SKIPS
 * (no LLM call) when the source is unchanged — so firing on every `.agents/` edit is cheap.
 *
 * Model: MIRROR_LLM_CLI=gemini, MIRROR_SUB_MODEL=gemini-3.1-flash-lite (overridable via env).
 * fail-open on any error (never blocks the edit).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "..", "scripts", "mirror-translate.mjs");
const ROOT = path.join(__dirname, "..", "..");

async function main() {
	let input = "";
	for await (const c of process.stdin) input += c;
	let d;
	try {
		d = JSON.parse(input);
	} catch {
		process.exit(0);
	}
	const tn = d.tool_name || "";
	if (tn !== "Edit" && tn !== "Write") process.exit(0);
	const fp = d.tool_input?.file_path || "";
	if (!fp) process.exit(0);

	const rel = path.relative(ROOT, path.resolve(ROOT, fp)).replace(/\\/g, "/");
	// curated .agents context only; json = charter (not translated)
	if (!rel.startsWith(".agents/")) process.exit(0);
	if (!/\.(ya?ml|md)$/i.test(rel)) process.exit(0);

	const child = spawn("node", [SCRIPT, rel], {
		cwd: ROOT,
		env: {
			...process.env,
			MIRROR_LLM_CLI: process.env.MIRROR_LLM_CLI || "gemini",
			MIRROR_SUB_MODEL: process.env.MIRROR_SUB_MODEL || "gemini-3.1-flash-lite",
		},
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	process.exit(0);
}

main().catch(() => process.exit(0));
