#!/usr/bin/env node
/** M13-mirror — 경로매핑 + 변경감지(해시) 결정론 검증. (LLM 번역 자체는 비결정이라 제외) */
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { mapToUsers, translateNeeded } from "../../scripts/mirror-translate.mjs";

let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`); c ? pass++ : fail++; };

// 1) 경로 매핑
check(".agents/context/x.yaml → .users/context/x.md", mapToUsers(".agents/context/x.yaml") === ".users/context/x.md");
check(".agents/context/agents-rules.json → .users/context/agents-rules.md", mapToUsers(".agents/context/agents-rules.json") === ".users/context/agents-rules.md");
check(".agents 밖 경로 → null", mapToUsers("docs/x.md") === null);

// 2) 변경감지
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
function setup(files = {}) {
	const d = mkdtempSync(join(tmpdir(), "mirror-"));
	for (const [p, c] of Object.entries(files)) { const fp = join(d, p); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, c); }
	return d;
}
const SRC = "key: value\nlist:\n  - a\n  - b\n";
const H = sha(SRC);

{ const d = setup({ ".agents/context/x.yaml": SRC }); check("미러 없음 → 번역 필요(no-mirror)", translateNeeded(".agents/context/x.yaml", d).needed === true); }
{ const d = setup({ ".agents/context/x.yaml": SRC, ".users/context/x.md": `<!-- src-sha: ${H} -->\n번역본` }); check("해시 일치 → 최신(번역 불필요)", translateNeeded(".agents/context/x.yaml", d).needed === false); }
{ const d = setup({ ".agents/context/x.yaml": SRC, ".users/context/x.md": "<!-- src-sha: deadbeef -->\n옛 번역" }); check("해시 불일치(stale) → 번역 필요", translateNeeded(".agents/context/x.yaml", d).needed === true); }
{ const d = setup({ ".agents/context/x.yaml": SRC, ".users/context/x.md": "해시주석 없는 번역본" }); check("해시 주석 없음 → 번역 필요", translateNeeded(".agents/context/x.yaml", d).needed === true); }
{ const d = setup({ "docs/x.md": "x" }); check(".agents 밖 → 번역 불필요(non-.agents)", translateNeeded("docs/x.md", d).needed === false); }

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
