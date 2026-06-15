#!/usr/bin/env node
/**
 * V모델 추적성 검사기 (REQ → UC → TEST-S, UC → SPEC → TEST-F).
 *
 * 목적: docs/progress 의 0N 단계별 INDEX.md registry 표를 파싱해 두 종류 결함을 검출한다.
 *   - dead-link: 존재하지 않는 ID를 참조 (예: UC가 REQ-099 참조하나 01에 없음) — 항상 결함.
 *   - orphan:    하류로 닫히지 않은 항목 (REQ에 UC/TEST-S 없음, UC에 TEST-S 없음, SPEC에 TEST-F 없음).
 *                Draft 단계엔 정상 → 기본 advisory(경고만).
 *
 * 기본 = advisory(exit 0, 보고만). `--enforce` = dead-link 있으면 exit 1.
 * `--strict-orphans` 추가 시 orphan 도 exit 1. 데드라인 비차단을 위해 orphan 은 기본 경고.
 *
 * 이 파일은 naia-template-project canonical. 프로젝트는 그대로 상속한다.
 * 한계(정직): registry 표 컬럼 기반 ID 참조만 검사. 내용 정합·유닛테스트 @spec 태그 커버리지는 미검사(코드 게이트 몫).
 */
import fs from "fs";
import path from "path";

const ROOT = process.env.TRACE_PROJECT_ROOT || process.cwd();
const PROGRESS = path.join(ROOT, "docs/progress");
const args = new Set(process.argv.slice(2));
const ENFORCE = args.has("--enforce");
const STRICT_ORPHANS = args.has("--strict-orphans");

// registry 파일 → 그 파일이 "정의"하는 엔티티 종류(1번째 컬럼 ID)
const REGISTRIES = [
	{ file: "01.requirements/INDEX.md", defines: "REQ" },
	{ file: "02.user-scenarios/INDEX.md", defines: "UC" },
	{ file: "03.uc-tests/INDEX.md", defines: "TEST-S" },
	{ file: "04.features/INDEX.md", defines: "SPEC" },
	{ file: "05.features-tests/INDEX.md", defines: "TEST-F" },
];

const ID_RE = /\b(?:REQ|UC|SPEC|TEST-S|TEST-F)-\d+\b/g;
const idsIn = (s) => (String(s).match(ID_RE) || []);

// 표 데이터 행만: '|' 로 시작 + 구분선(|---|) 아님 + 헤더(ID 텍스트) 아님
function tableRows(text) {
	return text.split("\n")
		.filter((l) => l.trim().startsWith("|") && !/^\s*\|[\s|:-]+\|?\s*$/.test(l))
		.map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
}

const defined = { REQ: new Set(), UC: new Set(), SPEC: new Set(), "TEST-S": new Set(), "TEST-F": new Set() };
const refs = [];   // {id, kind, from} — 1번째 컬럼 외 위치에서 참조된 ID
const missingFiles = [];

for (const reg of REGISTRIES) {
	const abs = path.join(PROGRESS, reg.file);
	if (!fs.existsSync(abs)) { missingFiles.push(reg.file); continue; }
	const text = fs.readFileSync(abs, "utf8");
	for (const cells of tableRows(text)) {
		if (cells.length === 0) continue;
		const own = idsIn(cells[0]);
		// 1번째 컬럼의 해당-종류 ID = 이 registry 가 정의
		for (const id of own) if (id.startsWith(reg.defines + "-")) defined[reg.defines].add(id);
		// 나머지 컬럼(또는 1열의 타종류 ID) = 참조
		const refCells = cells.slice(1).join(" ") + " " + own.filter((id) => !id.startsWith(reg.defines + "-")).join(" ");
		for (const id of idsIn(refCells)) {
			const kind = id.startsWith("TEST-S-") ? "TEST-S" : id.startsWith("TEST-F-") ? "TEST-F" : id.split("-")[0];
			refs.push({ id, kind, from: reg.file });
		}
	}
}

// ---- dead-link: 참조됐으나 정의 안 된 ID ----
const deadLinks = refs.filter((r) => defined[r.kind] && !defined[r.kind].has(r.id));

// ---- orphan: 하류로 닫히지 않음 ----
const referenced = new Set(refs.map((r) => r.id));
const orphans = [];
//  REQ 는 UC 또는 TEST-S(NFR 직결) 로 참조돼야 닫힘
for (const id of defined.REQ) if (!referenced.has(id)) orphans.push({ id, why: "REQ에 하류 UC/TEST-S 없음" });
//  UC 는 TEST-S 로 닫힘
for (const id of defined.UC) if (!referenced.has(id)) orphans.push({ id, why: "UC에 TEST-S 없음" });
//  SPEC 는 TEST-F 로 닫힘
for (const id of defined.SPEC) if (!referenced.has(id)) orphans.push({ id, why: "SPEC에 TEST-F 없음" });

// ---- 보고 ----
const pad = (n) => String(n).padStart(2);
console.log("V모델 추적성 검사 — docs/progress 0N 단계 INDEX.md");
console.log(`  정의: REQ ${pad(defined.REQ.size)} · UC ${pad(defined.UC.size)} · TEST-S ${pad(defined["TEST-S"].size)} · SPEC ${pad(defined.SPEC.size)} · TEST-F ${pad(defined["TEST-F"].size)}`);
if (missingFiles.length) console.log(`  ⚠️ registry 파일 부재: ${missingFiles.join(", ")}`);

if (deadLinks.length) {
	console.log(`\n❌ dead-link ${deadLinks.length}건 (존재하지 않는 ID 참조):`);
	for (const d of deadLinks) console.log(`   - ${d.id}  ←참조 ${d.from}`);
} else console.log("\n✅ dead-link 0");

if (orphans.length) {
	console.log(`\n⚠️ orphan ${orphans.length}건 (하류 미연결 — Draft 단계엔 정상):`);
	for (const o of orphans) console.log(`   - ${o.id}: ${o.why}`);
} else console.log("✅ orphan 0");

// ---- exit ----
let code = 0;
if (ENFORCE) {
	if (deadLinks.length) code = 1;
	if (STRICT_ORPHANS && orphans.length) code = 1;
}
if (!ENFORCE && (deadLinks.length || orphans.length)) console.log("\n(advisory — 차단 안 함. 차단하려면 --enforce [--strict-orphans])");
process.exit(code);
