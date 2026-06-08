#!/usr/bin/env node
/** M3 Structure Guard — 코어 위임 + F12/F13 동적로드 + enforcement level + fail-open 검증. */
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, "../../.agents/hooks/structure-guard.js");

function setupRoot(level = "enforced") {
	const d = mkdtempSync(join(tmpdir(), "m3-"));
	const rules = {
		F12: { allowed_root_dirs: [".agents", ".claude", ".github", "docs", "scripts", "src", "benchmark"] },
		F13: { allowed_root_files: ["AGENTS.md", "README.md", ".gitignore", "package.json"] },
		self_trust_config: { enforcement_level: level },
	};
	const rp = join(d, ".agents/context/agents-rules.json");
	mkdirSync(dirname(rp), { recursive: true });
	writeFileSync(rp, JSON.stringify(rules));
	return d;
}
function runHook(root, file_path, toolName = "Write") {
	const r = spawnSync("node", [HOOK], { input: JSON.stringify({ tool_name: toolName, tool_input: { file_path } }), encoding: "utf8", env: { ...process.env, M3_PROJECT_ROOT: root } });
	return { blocked: /"decision"\s*:\s*"block"/.test(r.stdout), failOpen: /로드 실패/.test(r.stdout), advisory: /systemMessage/.test(r.stdout) && !/"decision"/.test(r.stdout) };
}

const reg = setupRoot();
let pass = 0, fail = 0;
function check(name, cond) { console.log(`${cond ? "✅ PASS" : "❌ FAIL"} — ${name}`); cond ? pass++ : fail++; }

check("허용 하위(src/main/x.js) → 통과", runHook(reg, "src/main/x.js").blocked === false);
check("허용 루트파일(README.md) → 통과", runHook(reg, "README.md").blocked === false);
check("허용 깊은 하위(docs/progress/x.md) → 통과", runHook(reg, "docs/progress/x.md").blocked === false);
check("미등록 루트 디렉토리(experiments/x.js) → 차단", runHook(reg, "experiments/x.js").blocked === true);
check("미등록 루트 파일(random.txt) → 차단", runHook(reg, "random.txt").blocked === true);
check("절대경로 허용 하위 → 통과", runHook(reg, join(reg, "src/main/x.js")).blocked === false);
check("트래버설(../outside) → 통과(범위밖)", runHook(reg, "../outside.txt").blocked === false);
check("기존 헌장파일 Edit(AGENTS.md) → 통과", runHook(reg, "AGENTS.md", "Edit").blocked === false);
check("advisory: 미등록 → 경고만(차단X)", runHook(setupRoot("advisory"), "experiments/x.js").advisory === true);
{ const noReg = mkdtempSync(join(tmpdir(), "m3-noreg-")); const r = runHook(noReg, "experiments/x.js"); check("fail-open: 레지스트리 부재 → 통과+경고", r.blocked === false && r.failOpen === true); }

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
