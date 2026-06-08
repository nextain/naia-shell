#!/usr/bin/env node
/** M4 CI 재검증 — 검증가능 파일증거 강제(비경로·closes # 우회 차단) 검증. */
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../../scripts/ci-verify-completion.mjs");

function setupRoot(files = {}) {
	const d = mkdtempSync(join(tmpdir(), "cic-"));
	const rules = { self_trust_config: { enforcement_level: "enforced", completion: { keywords: ["완료", "done", "CLEAN", "完了"], negations: ["WIP"], evidence_patterns: ["Verified:", "Evidence:", "closes #"] } } };
	const rp = join(d, ".agents/context/agents-rules.json");
	mkdirSync(dirname(rp), { recursive: true });
	writeFileSync(rp, JSON.stringify(rules));
	for (const [p, c] of Object.entries(files)) { const fp = join(d, p); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, c); }
	return d;
}
function run(root, msg, ...changed) {
	return spawnSync("node", [SCRIPT, ...changed], { input: msg, encoding: "utf8", env: { ...process.env, CI_PROJECT_ROOT: root } }).status;
}

const reg = setupRoot({ "README.md": "기존" });
let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`); c ? pass++ : fail++; };

check("완료+증거없음 → exit 1", run(reg, "버그 수정 완료") === 1);
check("[codex①] 완료+비경로 증거 'Verified: ok' → exit 1", run(reg, "완료\nVerified: ok") === 1);
check("[codex②] 완료+'closes #1'만 → exit 1(파일증거 없음)", run(reg, "done closes #1") === 1);
check("완료+가짜 파일증거(diff에 없음) → exit 1", run(reg, "완료\nVerified: fake/result.json") === 1);
check("[핵심] 완료+기존파일 재활용(README.md) → exit 1", run(reg, "완료\nVerified: README.md") === 1);
check("완료+파일증거 diff 포함 → exit 0", run(reg, "완료\nVerified: test-results/login.json", "test-results/login.json") === 0);
check("완료+따옴표 경로 diff 포함 → exit 0", run(reg, `완료\nVerified: "test results/out.json"`, "test results/out.json") === 0);
check("완료선언 없음(chore) → exit 0", run(reg, "chore: 설정 변경") === 0);
check("WIP(부정) → exit 0", run(reg, "WIP: 작업중") === 0);
check("fail-closed: 설정 부재 → exit 1", run(mkdtempSync(join(tmpdir(), "cic-noreg-")), "완료\nVerified: x.json", "x.json") === 1);

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
