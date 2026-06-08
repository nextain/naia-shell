#!/usr/bin/env node
/** M2 SDLC Gate Guard — 코어 위임 + change_set_rules 외부화 + enforcement level 검증. */
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, "../../.agents/hooks/sdlc-gate-guard.js");
const LONG = "내용 ".repeat(40); // 100자+

function setupRoot(files = {}, level = "enforced") {
	const d = mkdtempSync(join(tmpdir(), "m2-"));
	const rules = {
		self_trust_config: {
			enforcement_level: level,
			change_set_rules: [
				{ id: "src", when_changed_glob: ["src/main/**"], requires: ["docs/user-scenarios.md", "docs/requirements.md"], exempt_glob: ["**/*.test.*", "docs/**"] },
			],
			artifact_min_meaningful_chars: 100,
		},
	};
	const rp = join(d, ".agents/context/agents-rules.json");
	mkdirSync(dirname(rp), { recursive: true });
	writeFileSync(rp, JSON.stringify(rules));
	for (const [p, c] of Object.entries(files)) {
		const fp = join(d, p);
		mkdirSync(dirname(fp), { recursive: true });
		writeFileSync(fp, c);
	}
	return d;
}
function runHook(root, file_path, level) {
	const r = spawnSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path } }), encoding: "utf8", env: { ...process.env, M2_PROJECT_ROOT: root } });
	return { blocked: /"decision"\s*:\s*"block"/.test(r.stdout), bootstrap: /bootstrap/.test(r.stdout), advisory: /systemMessage/.test(r.stdout) && !/"decision"/.test(r.stdout) };
}

let pass = 0, fail = 0;
function check(name, cond) { console.log(`${cond ? "✅ PASS" : "❌ FAIL"} — ${name}`); cond ? pass++ : fail++; }

const full = { "docs/user-scenarios.md": "## UC-1\n" + LONG, "docs/requirements.md": "## FR-1\n" + LONG };
check("UC·REQ 충실 + src/main → 통과", runHook(setupRoot(full), "src/main/app.js").blocked === false);
{ const r = runHook(setupRoot({}), "src/main/app.js"); check("산출물 없음 + src/main → bootstrap", r.blocked === false && r.bootstrap === true); }
check("UC만(부분) + src/main → 차단", runHook(setupRoot({ "docs/user-scenarios.md": "## UC-1\n" + LONG }), "src/main/app.js").blocked === true);
check("테스트 파일(exempt) → 통과", runHook(setupRoot({}), "src/main/app.test.js").blocked === false);
check("문서 파일 → 통과(rule 미트리거)", runHook(setupRoot({}), "docs/x.md").blocked === false);
check("advisory: 부분 → 경고만(차단X)", runHook(setupRoot({ "docs/user-scenarios.md": "## UC\n" + LONG }, "advisory"), "src/main/app.js").advisory === true);
{ const noReg = mkdtempSync(join(tmpdir(), "m2-noreg-")); check("fail-open: 설정 부재 → 통과", runHook(noReg, "src/main/app.js").blocked === false); }

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
