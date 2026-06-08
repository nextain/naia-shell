#!/usr/bin/env node
/** Charter Guard — 헌장·hook·설정 보호 검증. */
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, "../../.agents/hooks/charter-guard.js");

function setupRoot(level = "enforced") {
	const d = mkdtempSync(join(tmpdir(), "charter-"));
	const rules = { charter_immutability: { charter_files: ["AGENTS.md", ".agents/context/agents-rules.json", "docs/project-structure.md"] }, self_trust_config: { enforcement_level: level } };
	const rp = join(d, ".agents/context/agents-rules.json");
	mkdirSync(dirname(rp), { recursive: true });
	writeFileSync(rp, JSON.stringify(rules));
	return d;
}
function runHook(root, file_path, extraEnv = {}) {
	const r = spawnSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path } }), encoding: "utf8", env: { ...process.env, CHARTER_PROJECT_ROOT: root, ...extraEnv } });
	return { blocked: /"decision"\s*:\s*"block"/.test(r.stdout), advisory: /systemMessage/.test(r.stdout) && !/"decision"/.test(r.stdout) };
}

const reg = setupRoot();
let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`); c ? pass++ : fail++; };

check("hook 자체(.agents/hooks/x.js) Edit → 차단", runHook(reg, ".agents/hooks/structure-guard.js").blocked === true);
check(".claude/settings.json Edit → 차단", runHook(reg, ".claude/settings.json").blocked === true);
check("charter_files(AGENTS.md) Edit → 차단", runHook(reg, "AGENTS.md").blocked === true);
check("charter_files(agents-rules.json) Edit → 차단", runHook(reg, ".agents/context/agents-rules.json").blocked === true);
check("일반 소스(src/main/x.js) → 통과", runHook(reg, "src/main/x.js").blocked === false);
check("일반 문서(docs/x.md, charter 아님) → 통과", runHook(reg, "docs/x.md").blocked === false);
check("사람 승인(HUMAN_APPROVED_CHARTER_EDIT=1) + hook → 통과", runHook(reg, ".agents/hooks/x.js", { HUMAN_APPROVED_CHARTER_EDIT: "1" }).blocked === false);
check("advisory: hook 수정 → 경고만(차단X)", runHook(setupRoot("advisory"), ".agents/hooks/x.js").advisory === true);
check("off: hook 수정 → 통과", runHook(setupRoot("off"), ".agents/hooks/x.js").blocked === false);

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
