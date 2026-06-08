#!/usr/bin/env node
/** users-index-model — `.users/` 의 skills/hooks/commands/workflows 는 **단일 색인(*-list.md)** 모델.
 *  per-item 복사 디렉터리(`.users/<kind>/`)는 **위반**(중복·drift — SoT 는 .agents/<kind>/, 사람용은 색인 한 장).
 *  + gen-lists 결정론 검증 + 색인이 생성기 출력과 일치. */
import { existsSync, statSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildList } from "../../scripts/gen-lists.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`); c ? pass++ : fail++; };

const KINDS = ["skills", "hooks", "commands", "workflows"];

// 1) per-item 복사 디렉터리 금지 (잘못된 모델 — 하네스가 잡아야 한다)
for (const k of KINDS) {
	check(`.users/${k}/ per-item 디렉터리 없음`, !isDir(join(ROOT, ".users", k)));
}

// 2) 단일 색인 *-list.md 존재 + 생성기 출력과 일치 (drift 0)
for (const k of KINDS) {
	const out = join(ROOT, ".users", `${k}-list.md`);
	check(`.users/${k}-list.md 색인 존재`, existsSync(out));
	const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
	check(`${k}-list.md 가 gen-lists 출력과 일치(최신)`, cur === buildList(k, ROOT));
}

// 3) buildList 결정론 — 항목 없는 kind → '없음' 행 (크래시 아님)
{
	process.env.LISTS_PROJECT_ROOT = join(ROOT, "node_modules", "__nope__");
	check("SoT 부재 → '없음' 표 (크래시 아님)", /등록된 .* 없음/.test(buildList("skills", join(ROOT, "node_modules", "__nope__"))));
}

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
