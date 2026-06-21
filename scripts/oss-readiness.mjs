#!/usr/bin/env node
// oss-readiness — deterministic OSS quality gate (content-based, not semantic).
// Hard gates (secrets/PII/personal-paths/internal-leak = must be 0) + onboarding checklist (score).
// usage: node oss-readiness.mjs <repo-path>
// Scans only tracked files (git ls-files) — i.e. what is actually public.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repo = process.argv[2];
if (!repo) { console.error("usage: node oss-readiness.mjs <repo-path>"); process.exit(2); }

const sh = (cmd) => { try { return execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
const tracked = sh("git ls-files").split("\n").map((s) => s.trim()).filter(Boolean);

const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|eot|mp[34]|wav|zip|gz|wasm|node|lock)$/i;
const SKIP_FILE = /(pnpm-lock\.yaml|package-lock\.json|Cargo\.lock|yarn\.lock|oss-readiness\.mjs|\.gitignore)$/;
const DUMMY = /(example|dummy|placeholder|sample|your[-_]|<[A-Z_]+>|x{6,}|0{6,}|redacted|changeme|test[-_]|fake|REPLACE|deadbeef)/i;
const NUL = String.fromCharCode(0);

const SECRET_RULES = [
  ["gateway-key(hex32.token)", /\b[a-f0-9]{32}\.[A-Za-z0-9_-]{12,}\b/g, false],
  ["openai/anthropic key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, false],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g, false],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, false],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g, false],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, false],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, false],
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, false],
  ["assigned-secret", /(?:api[_-]?key|secret|token|passwd|password|bearer|gwkey|gw_?key)["'\s:=]{1,4}["']([A-Za-z0-9_\-.\/+=]{24,})["']/gi, "ctx"],
  ["quoted-long-hex(token)", /["']([a-f0-9]{44,})["']/g, "ctx"], // 점없는 순수hex 토큰(고엔트로피 룰 사각 — 크로스리뷰 발견)
  ["high-entropy-token(40+)", /\b[A-Za-z0-9_-]{40,}\b/g, "entropy"],
];
const PATH_RULES = [
  ["unix-home", /\/(?:var\/)?home\/(?!runner\b|user\b|node\b|ubuntu\b)[a-z][a-z0-9_-]{1,}\//g],
  ["macos-home", /\/Users\/(?!runner\b|shared\b)[a-z][a-z0-9_-]{1,}\//g],
  ["windows-home", /[A-Z]:\\\\?Users\\\\?(?!Public\b|Default\b)[A-Za-z][A-Za-z0-9_ -]{1,}/g],
];
const LEAK_RULES = [
  ["cloud-run-url", /\bhttps?:\/\/[a-z0-9][a-z0-9-]*\.[a-z0-9-]+\.run\.app\b/g],
  ["gcp-project-num", /\bprojects\/\d{9,}\b/g],
  ["biz-reg-no(KR)", /\b\d{3}-\d{2}-\d{5}\b/g],
  ["private/cloud-ip", /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|34\.\d{1,3}|35\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g],
  ["tailscale-host", /\b[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net\b/g],
  ["internal-project-slug", /\bcafelua(?:-prod|-dev|-db)?\b/g], // 메인테이너 내부 GCP 프로젝트 슬러그(bare — 크로스리뷰 발견)
];

function entropy(s) {
  const m = {}; for (const c of s) m[c] = (m[c] || 0) + 1;
  return -Object.values(m).reduce((a, n) => a + (n / s.length) * Math.log2(n / s.length), 0);
}
function decodesToText(tok) {
  // base64 → 출력가능 ASCII 텍스트(공백/단어 포함)면 인코딩된 텍스트/공개키 → 시크릿 아님.
  try {
    if (!/^[A-Za-z0-9+/]+=*$/.test(tok) || tok.length % 4 !== 0) return false;
    const d = Buffer.from(tok, "base64").toString("latin1");
    if (d.length < 6) return false;
    const printable = [...d].filter((c) => c >= " " && c <= "~").length / d.length;
    return printable > 0.85 && /[a-z]{3,}/i.test(d); // 단어 같은 게 보이면 텍스트
  } catch { return false; }
}
function looksSecret(tok) {
  if (DUMMY.test(tok)) return false;
  if (tok.includes("/")) return false;                 // 경로
  if ((tok.match(/-/g) || []).length >= 3) return false; // kebab 식별자(FR-COMPACT-...)
  if (decodesToText(tok)) return false;                // minisign/공개키·인코딩 텍스트
  const hasU = /[A-Z]/.test(tok), hasL = /[a-z]/.test(tok), hasD = /\d/.test(tok);
  if (!(hasU && hasL && hasD)) return false; // exclude pure-hex SHA / lowercase IDs
  return entropy(tok) >= 4.2;
}
const DUMMY_BIZ = new Set(["123-45-67890", "000-00-00000", "111-11-11111", "123-45-67891"]);

const findings = { secrets: [], paths: [], leaks: [] };
const emailByFile = {};
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

for (const f of tracked) {
  if (SKIP_EXT.test(f) || SKIP_FILE.test(f)) continue;
  const p = join(repo, f);
  let body; try { if (statSync(p).size > 2_000_000) continue; body = readFileSync(p, "utf8"); } catch { continue; }
  if (body.indexOf(NUL) !== -1) continue; // binary (nul byte)
  body.split("\n").forEach((line, i) => {
    const isPubkey = /pub(lic)?[_-]?key/i.test(line); // 공개키 라인 = 시크릿 아님
    if (!isPubkey) for (const [name, re, mode] of SECRET_RULES) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(line))) {
        const val = m[1] ?? m[0];
        if (mode === "entropy" && !looksSecret(val)) continue;
        if (mode === "ctx" && DUMMY.test(val)) continue;
        // quoted-long-hex: 표준 해시(SHA-1=40, SHA-256=64) 또는 해시 컨텍스트 = 시크릿 아님(탐지용 다이제스트).
        if (name === "quoted-long-hex(token)" && (val.length === 40 || val.length === 64 || /sha-?\d|hash|digest|checksum|fingerprint|integrity/i.test(line))) continue;
        findings.secrets.push({ file: f, line: i + 1, rule: name, val: val.slice(0, 10) + "..." });
        break;
      }
    }
    for (const [name, re] of PATH_RULES) { re.lastIndex = 0; if (re.test(line)) findings.paths.push({ file: f, line: i + 1, rule: name, val: line.trim().slice(0, 60) }); }
    for (const [name, re] of LEAK_RULES) {
      re.lastIndex = 0; const hit = line.match(re);
      if (hit && !(name === "biz-reg-no(KR)" && DUMMY_BIZ.has(hit[0]))) findings.leaks.push({ file: f, line: i + 1, rule: name, val: hit[0].slice(0, 48) });
    }
  });
  const emails = [...new Set((body.match(EMAIL) || []).filter((e) => !/(example|test|noreply|your|sample)\./i.test(e)))];
  if (emails.length) emailByFile[f] = emails;
}
const piiFiles = Object.entries(emailByFile).filter(([, e]) => e.length >= 4);

const has = (rel) => existsSync(join(repo, rel));
const pkg = (() => { try { return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")); } catch { return null; } })();
const wf = sh("git ls-files .github/workflows").split("\n").filter(Boolean);
const wfBody = wf.map((w) => { try { return readFileSync(join(repo, w), "utf8"); } catch { return ""; } }).join("\n");
const remote = sh("git remote get-url origin").trim();
const contribPath = has("CONTRIBUTING.md") ? "CONTRIBUTING.md" : has(".github/CONTRIBUTING.md") ? ".github/CONTRIBUTING.md" : null;
const contrib = contribPath ? readFileSync(join(repo, contribPath), "utf8") : "";
const cloneUrl = (contrib.match(/git clone\s+(\S+)/) || [])[1];
const remoteSlug = remote.replace(/\.git$/, "").replace(/^https?:\/\//, "");
const checklist = [
  ["LICENSE 존재", has("LICENSE") || has("LICENSE.md")],
  ["README 존재", has("README.md")],
  ["CONTRIBUTING 존재", !!contribPath],
  ["전제조건 고정(engines/.nvmrc/toolchain)", !!(pkg?.engines || has(".nvmrc") || has(".node-version") || has("rust-toolchain.toml"))],
  ["CI가 테스트 실행", /(pnpm (run )?test|vitest|npm test|cargo test|playwright test)\b/.test(wfBody)],
  [".env.example 존재", has(".env.example") || has(".env.sample")],
  ["clone URL = remote 일치", !cloneUrl || (remoteSlug && cloneUrl.replace(/\.git$/, "").includes(remoteSlug))],
];

const hard = {
  "secret(키/토큰)": findings.secrets,
  "personal-path(개인 절대경로)": findings.paths,
  "3rd-party-PII(이메일 명단)": piiFiles.map(([f, e]) => ({ file: f, line: 0, rule: e.length + " emails", val: e.slice(0, 2).join(",") })),
  "internal-leak(URL/IP/proj/biz/tailscale)": findings.leaks,
};
const repoName = remote.split("/").pop()?.replace(/\.git$/, "") || repo;
console.log("\n====== OSS-READINESS: " + repoName + " ======");
let hardFail = 0;
console.log("\n[HARD GATE — 전부 0 이어야 공개 가능]");
for (const [k, arr] of Object.entries(hard)) {
  if (arr.length) hardFail += arr.length;
  console.log("  " + (arr.length === 0 ? "PASS " : "FAIL ") + k + ": " + arr.length + "건");
  arr.slice(0, 6).forEach((x) => console.log("       - " + x.file + (x.line ? ":" + x.line : "") + " [" + x.rule + "] " + x.val));
  if (arr.length > 6) console.log("       ... +" + (arr.length - 6) + "건");
}
console.log("\n[온보딩 체크리스트 — 품질]");
let pass = 0;
for (const [k, ok] of checklist) { if (ok) pass++; console.log("  " + (ok ? "[x] " : "[ ] ") + k); }
console.log("\n  품질: " + pass + "/" + checklist.length + "  |  하드게이트: " + (hardFail === 0 ? "PASS" : "FAIL(" + hardFail + ")"));
console.log("  판정: " + (hardFail > 0 ? "공개 불가(하드게이트 미달)" : pass >= 6 ? "공개 가능(품질 양호)" : "공개 가능하나 품질 보완") + "\n");
process.exit(hardFail > 0 ? 1 : 0);
