#!/usr/bin/env node
/**
 * conform-gate — PostToolUse on Edit|Write.
 *
 * TypeScript edits run the fail-closed file-contract oracle immediately.
 * After each edit of a registered C source/header or TypeScript module, runs the DETERMINISTIC contract<->code
 * conform check (scripts/conform/check.py, 0 tokens, no LLM) on the region the
 * file belongs to. Regions are declared in scripts/conform/manifest.json.
 *   - drift (1..N-1 edits) → block: "reconcile before adding more"
 *   - halt  (>=N edits)    → block + reason: "STOP, you are looping on a drifted base"
 *
 * Purpose: stop an uncommitted agent from flailing for hours on a drifted base
 * (the false-success class). The signal interrupts the loop from outside.
 * TypeScript oracle errors block; the legacy C extractor remains fail-open.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(__dirname, "..", "..", "scripts", "conform", "check.py");

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
	// TypeScript uses the repository's file-contract oracle, then continues to the
	// nonempty file-contract manifest (scripts/conform/check.py) for .ts/.md regions.
	if (/\.tsx?$/.test(fp)) {
		try {
			execFileSync(process.execPath, [path.join(__dirname, "../../scripts/check-file-anchors.mjs")], {
				cwd: path.join(__dirname, "../.."),
				stdio: "pipe",
				timeout: 10000,
			});
		} catch {
			process.stdout.write(JSON.stringify({ decision: "block", reason: "TypeScript 파일 계약 앵커 검사 실패: node scripts/check-file-anchors.mjs 실행 후 미계약 파일을 정리하세요." }));
			process.exit(0);
		}
	}
	if (!/\.(c|h|ts|md)$/.test(fp)) process.exit(0); // C/TS/MD extractor; widen per language

	let out;
	try {
		out = execFileSync("python3", [CHECK, "--file", fp], { encoding: "utf8", timeout: 10000 });
	} catch {
		process.exit(0);
	}
	let v;
	try {
		v = JSON.parse(out.trim().split("\n").pop());
	} catch {
		process.exit(0);
	}

	if (v.status === "halt") {
		process.stdout.write(JSON.stringify({ decision: "block", reason: v.message }));
	} else if (v.status === "drift") {
		process.stdout.write(JSON.stringify({ decision: "block", reason: v.message }));
	}
	process.exit(0);
}

main().catch(() => process.exit(0));
