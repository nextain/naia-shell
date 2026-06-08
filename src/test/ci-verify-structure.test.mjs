#!/usr/bin/env node
/** M3 CI 재검증 — CLI exit code + fail-closed 검증. */
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../../scripts/ci-verify-structure.mjs");

function rootWithRules() {
	const d = mkdtempSync(join(tmpdir(), "cis-"));
	const rp = join(d, ".agents/context/agents-rules.json");
	mkdirSync(dirname(rp), { recursive: true });
	writeFileSync(rp, JSON.stringify({ F12: { allowed_root_dirs: [".agents", "docs", "src", "scripts"] }, F13: { allowed_root_files: ["README.md"] }, self_trust_config: {} }));
	return d;
}
function run(root, ...files) {
	const r = spawnSync("node", [SCRIPT, ...files], { encoding: "utf8", env: { ...process.env, CI_PROJECT_ROOT: root } });
	return r.status;
}

const reg = rootWithRules();
let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`); c ? pass++ : fail++; };

check("등록 경로들 → exit 0", run(reg, "src/main/a.js", "docs/x.md", "README.md") === 0);
check("미등록 루트경로 → exit 1", run(reg, "experiments/x.js") === 1);
check("미등록 루트파일 → exit 1", run(reg, "random.txt") === 1);
check("fail-closed: 레지스트리 부재 → exit 1", run(mkdtempSync(join(tmpdir(), "cis-noreg-")), "src/x.js") === 1);

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
