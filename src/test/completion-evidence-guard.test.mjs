#!/usr/bin/env node
/**
 * M4 Completion Evidence Guard — 자체 검증 (코어 위임 + 설정 외부화 + enforcement level + 다국어).
 * 실행: node src/test/completion-evidence-guard.test.mjs
 */
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, "../../.agents/hooks/completion-evidence-guard.js");

function setupRoot(level = "enforced") {
	const d = mkdtempSync(join(tmpdir(), "m4-"));
	const rules = {
		self_trust_config: {
			enforcement_level: level,
			completion: {
				keywords: ["완료", "통과", "done", "complete", "completed", "shipped", "CLEAN", "完了"],
				negations: ["미완료", "incomplete", "WIP", "wip"],
				evidence_patterns: ["Verified:", "Evidence:", "closes #", "sha256"],
			},
		},
	};
	const rp = join(d, ".agents/context/agents-rules.json");
	mkdirSync(dirname(rp), { recursive: true });
	writeFileSync(rp, JSON.stringify(rules));
	return d;
}

function runHook(root, command) {
	const r = spawnSync("node", [HOOK], {
		input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
		encoding: "utf8",
		env: { ...process.env, M4_PROJECT_ROOT: root },
	});
	return {
		blocked: /"decision"\s*:\s*"block"/.test(r.stdout),
		advisory: /systemMessage/.test(r.stdout) && !/"decision"/.test(r.stdout),
		stdout: r.stdout,
	};
}

const enforced = setupRoot("enforced");
let pass = 0, fail = 0;
function check(name, cond) { console.log(`${cond ? "✅ PASS" : "❌ FAIL"} — ${name}`); cond ? pass++ : fail++; }

check("한국어 '완료'+증거없음 → 차단", runHook(enforced, `git commit -m "로그인 수정 완료"`).blocked === true);
check("일본어 '完了'+증거없음 → 차단", runHook(enforced, `git commit -m "修正 完了"`).blocked === true);
check("'완료'+Verified → 통과", runHook(enforced, `git commit -m "완료" -m "Verified: test.json"`).blocked === false);
check("'Closes #' → 통과", runHook(enforced, `git commit -m "fix. Closes #42"`).blocked === false);
check("완료선언 없음(wip) → 통과", runHook(enforced, `git commit -m "wip: 저장"`).blocked === false);
check("'미완료' 부정문 → 통과", runHook(enforced, `git commit -m "로그인 미완료"`).blocked === false);
check("CLEAN+증거없음 → 차단", runHook(enforced, `git commit -m "all pass, CLEAN"`).blocked === true);
check("git commit 아님 → 통과", runHook(enforced, `ls -la`).blocked === false);

// enforcement level
check("advisory: 완료+증거없음 → 차단 아님(경고만)", (() => { const r = runHook(setupRoot("advisory"), `git commit -m "완료"`); return r.blocked === false && r.advisory === true; })());
check("off: 완료+증거없음 → 통과", runHook(setupRoot("off"), `git commit -m "완료"`).blocked === false);

// fail-open: 설정(agents-rules.json) 없는 root → 로컬은 막지 않음
{
	const noReg = mkdtempSync(join(tmpdir(), "m4-noreg-"));
	check("fail-open: 설정 부재 → 통과", runHook(noReg, `git commit -m "완료"`).blocked === false);
}
// -F/--file 커밋 메시지 파싱 (opencode 지적: -F 우회 차단)
{
	const r = setupRoot("enforced");
	writeFileSync(join(r, "msg.txt"), "버그 수정 완료");
	check("-F 파일 메시지(완료+증거없음) → 차단", runHook(r, "git commit -F msg.txt").blocked === true);
	writeFileSync(join(r, "msg2.txt"), "완료\nVerified: out.json");
	check("-F 파일 메시지(완료+증거) → 통과", runHook(r, "git commit --file msg2.txt").blocked === false);
}

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
