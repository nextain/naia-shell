#!/usr/bin/env node
/** CI charter 자가보호 — hook/workflow/charter 변경 감시 + 사람 승인 검증. */
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../../scripts/ci-verify-charter.mjs");

function setupRoot() {
	const d = mkdtempSync(join(tmpdir(), "cichar-"));
	const rules = { charter_immutability: { charter_files: ["AGENTS.md", ".agents/context/agents-rules.json"] }, self_trust_config: {} };
	const rp = join(d, ".agents/context/agents-rules.json");
	mkdirSync(dirname(rp), { recursive: true });
	writeFileSync(rp, JSON.stringify(rules));
	return d;
}
function run(root, changed, approved = false) {
	const env = { ...process.env, CI_PROJECT_ROOT: root };
	if (approved) env.CHARTER_APPROVED = "1";
	else delete env.CHARTER_APPROVED;
	return spawnSync("node", [SCRIPT, ...changed], { encoding: "utf8", env }).status;
}

const reg = setupRoot();
let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`); c ? pass++ : fail++; };

check("일반 파일만(src/main/a.js) → exit 0", run(reg, ["src/main/a.js", "docs/x.md"]) === 0);
check("hook 변경(.agents/hooks/x.js) → exit 1", run(reg, ["src/main/a.js", ".agents/hooks/structure-guard.js"]) === 1);
check("CI workflow 변경(.github/workflows/self-trust-gates.yml) → exit 1", run(reg, [".github/workflows/self-trust-gates.yml"]) === 1);
check("charter(agents-rules.json) 변경 → exit 1", run(reg, [".agents/context/agents-rules.json"]) === 1);
check(".claude/settings.json 변경 → exit 1", run(reg, [".claude/settings.json"]) === 1);
check("hook 변경 + CHARTER_APPROVED=1 → exit 0(사람 승인)", run(reg, [".agents/hooks/x.js"], true) === 1 ? false : true);
check("fail-closed: 설정 부재 → exit 1", run(mkdtempSync(join(tmpdir(), "cichar-noreg-")), [".agents/hooks/x.js"]) === 1);

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
