#!/usr/bin/env node
/**
 * 용어 게이트(M13-term) — glossary 연계.
 *  - 금지 신조어/자체용어(forbidden_terms) 포함 → 실패(차단).
 *  - glossary 미정의 약어(불친절한 약자) → 경고(풀어쓰거나 docs/glossary.md에 정의).
 *
 * enforcement_level: off=검사안함 / advisory·enforced에서 forbidden은 차단, 미정의 약어는 경고.
 * 사용: node scripts/check-terminology.mjs <file...>
 * ESM.
 */
import fs from "fs";
import path from "path";
import { loadConfig, checkTerminology } from "../.agents/hooks/lib/self-trust-core.mjs";

const files = process.argv.slice(2);
const root = process.env.CI_PROJECT_ROOT || process.cwd();
let cfg;
try {
	cfg = loadConfig(root);
} catch (e) {
	console.error("[용어검증 실패] 설정 로드 불가 (fail-closed): " + e.message);
	process.exit(1);
}
if (cfg.level === "off") {
	console.log("[용어검증] off");
	process.exit(0);
}

let glossaryText = "";
try {
	glossaryText = fs.readFileSync(path.join(root, cfg.terminology.glossary_file || "docs/glossary.md"), "utf8");
} catch {
	/* glossary 없으면 미정의 약어가 늘어나는 정도 */
}

let blocked = false;
const warnAcronyms = new Set();
for (const f of files) {
	let txt = "";
	try {
		txt = fs.readFileSync(path.join(root, f), "utf8");
	} catch {
		continue;
	}
	const r = checkTerminology(txt, glossaryText, cfg);
	if (r.forbidden.length) {
		blocked = true;
		console.error(`[용어검증 실패] ${f} — 금지 용어(신조어/자체용어): ${r.forbidden.join(", ")}`);
	}
	for (const a of r.undefinedAcronyms) warnAcronyms.add(a);
}

if (warnAcronyms.size) {
	console.error(`[용어검증 경고] glossary 미정의 약어: ${[...warnAcronyms].join(", ")}`);
	console.error("  → docs/glossary.md에 정의하거나 본문에서 풀어쓰세요(불친절한 약자 금지).");
}

if (blocked) process.exit(1);
console.log("[용어검증 통과]" + (warnAcronyms.size ? " (미정의 약어 경고 있음 — 위 참조)" : ""));
process.exit(0);
