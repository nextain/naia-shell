#!/usr/bin/env node
/** SEC — 보안 데이터 구조 검증: data-private 등록·gitignore + 추적 경로 시크릿/개인정보 부재 + F-SEC01 규칙. */
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

let pass = 0, fail = 0;
function check(name, cond) { console.log(`${cond ? "✅ PASS" : "❌ FAIL"} — ${name}`); cond ? pass++ : fail++; }

// --- 자산 로드 ---
const rules = JSON.parse(readFileSync(resolve(ROOT, ".agents/context/agents-rules.json"), "utf8"));
const gitignore = existsSync(resolve(ROOT, ".gitignore")) ? readFileSync(resolve(ROOT, ".gitignore"), "utf8") : "";

// 1) F12 에 보안 디렉터리(data-private) 등록 — 안 그러면 enforce --fix 가 삭제
const f12 = rules.F12?.allowed_root_dirs || [];
check("F12 에 data-private 등록됨 (삭제 방지)", f12.includes("data-private"));

// 2) data-private 내용이 gitignore 됨 (README 마커 제외)
const ignoresDir = /(^|\n)\s*data-private\/\s*(\n|$)/.test(gitignore);
check("data-private/ 가 .gitignore 에 있음 (내용 추적 금지)", ignoresDir);
// 실제 git 동작으로도 검증 (가짜 시크릿은 ignore, README 는 추적)
let ignoreOk = false;
try {
	execSync(`git -C "${ROOT}" check-ignore data-private/__probe.env`, { stdio: "pipe" });
	ignoreOk = true; // exit 0 = ignored
} catch { ignoreOk = false; }
check("git check-ignore: data-private/*.env 실제 무시됨", ignoreOk);

// 3) F-SEC01 규칙 존재 (시크릿 추적 금지)
const hasSec = (rules.forbidden_actions || []).some((x) => x.id === "F-SEC01");
check("agents-rules F-SEC01 (no_secrets_in_tracked_paths) 존재", hasSec);

// 4) ★ 추적 경로에 시크릿/개인정보 패턴 부재 — 실제 git-tracked 파일 스캔
let tracked = [];
try {
	tracked = execSync(`git -C "${ROOT}" ls-files`, { encoding: "utf8" }).split("\n").filter(Boolean);
} catch { /* not a git repo (template clone) — skip path-name scan */ }

// 파일명 기반 위험 패턴 (내용 스캔은 CI 의 secret-scanner 영역; 여기선 경로/이름)
const NAME_PATTERNS = [
	/\.env$/i, /\.env\.[^.]+$/i, /(^|\/)secrets?\.(json|ya?ml|txt)$/i,
	/(^|\/)credentials?\./i, /\.pem$/i, /\.key$/i, /id_rsa/i,
	/llm[-_]?keys?/i, /api[-_]?keys?\./i,
];
const offenders = tracked.filter((f) => NAME_PATTERNS.some((re) => re.test(f))
	// .env.example / *.example 류는 허용
	&& !/\.example$/i.test(f));
check(`추적 경로에 시크릿류 파일명 0 (발견: ${offenders.slice(0,3).join(", ") || "없음"})`, offenders.length === 0);

// data-private 내용이 추적되지 않는지 (README 만 허용)
const dpTracked = tracked.filter((f) => f.startsWith("data-private/") && f !== "data-private/README.md");
check(`data-private/ 추적은 README 마커뿐 (위반: ${dpTracked.slice(0,3).join(", ") || "없음"})`, dpTracked.length === 0);

console.log(`\n${fail === 0 ? "✅" : "❌"} security.test: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
