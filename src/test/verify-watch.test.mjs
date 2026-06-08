#!/usr/bin/env node
/** verify-watch — 주기 검증 러너의 (1) 안전 계약(enforce 에 --fix 절대 안 넘김, 자동수정 없음)
 *  (2) 런타임 동작(once/accept/status/cron, baseline-delta) 검증.
 *  안전-치명 문자열의 부재는 source 단언(시크릿 검사와 같은 성격), 동작은 실제 실행으로 확인. */
import { readFileSync, mkdtempSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SH = resolve(ROOT, "scripts/verify-watch.sh");
const SRC = readFileSync(SH, "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`); c ? pass++ : fail++; };
// 격리된 WORK_DIR — 실제 .agents/work baseline 을 건드리지 않음
const WORK = mkdtempSync(join(tmpdir(), "vw-"));
const run = (args) => {
	try {
		const out = execFileSync("bash", [SH, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, VERIFY_WORK_DIR: WORK, VERIFY_DOCS_EXEMPT: "progress" } });
		return { code: 0, out };
	} catch (e) { return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") }; }
};

// ── 1) 안전 계약 (source) — enforce 를 --fix 로 부르지 않는다 (rm -rf 백그라운드 노출 차단) ──
check("enforce 호출에 --fix 없음 (자동 rm -rf 차단)", !/enforce-root-structure\.sh[^\n]*--fix/.test(SRC));
check("자동수정 없음 — mirror 실제번역(쓰기)·--fix 미사용, --check 만", /--check/.test(SRC) && !/mirror-translate\.mjs"?\s+"\$[a-z]+"\s*$/m.test(SRC));
check("flock 으로 중복 start 차단", /flock/.test(SRC));
check("PID 재활용 방어 (kill -0 + cmdline 확인)", /kill -0/.test(SRC) && /\/proc\/\$p\/cmdline/.test(SRC));
check("로그 rotation 존재 (무한증식 방지)", /rotate_log|LOG_MAX_BYTES/.test(SRC));
check("미러 scope = yaml/yml/md 만 (json=charter 제외)", /-name '\*\.yaml'/.test(SRC) && !/-name '\*\.json'/.test(SRC));

// ── 2) 런타임 동작 (실제 실행, 격리 WORK_DIR) ──
// once = 메커니즘 검증(host 청결도에 결합 안 함): 일관된 보고 + 정상 exit(0=clean / 1=신규delta)
{ const r = run(["once"]); check("once 실행 → 일관 보고(깨끗 또는 delta) + 정상 exit(0|1)", (r.code === 0 || r.code === 1) && /위반|깨끗/.test(r.out)); }
// cron 라인은 once 를 쓰고 --fix 안 씀
{ const r = run(["cron"]); check("cron 라인 = once 사용, --fix 없음", /verify-watch\.sh once/.test(r.out) && !/--fix/.test(r.out)); }
// accept → baseline 기록, status 가 실행여부+상태 보고
{ run(["accept"]); const r = run(["status"]); check("status → 실행여부+최신상태 보고", /실행 중|아님/.test(r.out)); }
// 잘못된 서브커맨드 → 비제로
{ const r = run(["bogus"]); check("미지원 서브커맨드 → 비제로", r.code !== 0); }

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
