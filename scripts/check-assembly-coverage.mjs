#!/usr/bin/env node
// check-assembly-coverage — 전수분류(미분류 0, per-S 행 검증) + fit 게이트 + backlog 가시화 + 활성 선언.
// AI "한 축만 생각" 방지 = 기계 강제. (codex·gemini·GLM 교차 반영)
import { readFileSync } from "node:fs";
const src = readFileSync("docs/user-scenarios.md", "utf8");
const mtx = readFileSync("docs/progress/99.dev-comm/assembly-matrix-2026-06-10.md", "utf8"); // V모델 이전 시 99.dev-comm/ 로 이동
const lines = mtx.split("\n");

const sInv = [...new Set([...src.matchAll(/^\|\s*\*{0,2}(S\d+b?)\b/gm)].map((m) => m[1]))]; // bold(**S71**) 포함
const ucInv = [...new Set([...src.matchAll(/\*\*(UC\d+[a-z-]*)/g)].map((m) => m[1]))];

// per-S: 각 S 는 *자기 표 행*(| S## | ... |)을 갖고 이식/보충/rej 분류 동반해야 (GLM C-2: 불릿 그룹 우회 차단)
const CLASSIFY = /(이식|보충|reject|rejected|rej\b)/;
const sRow = (tok) => lines.find((l) => new RegExp(`^\\|\\s*${tok}\\s*\\|`).test(l));
const missingS = sInv.filter((s) => {
  const r = sRow(s); if (!r || !CLASSIFY.test(r)) return true;
  return r.split("|").map((c)=>c.trim()).filter(Boolean).length < 6; // S|기능|UC|이식/보충|포트|권위|상태 ≈ 7칸(여유 6)
});
// UC: 분류 라인 내 존재
const CLASS = /(이식|보충|reject|rejected|old-auth|scenario|F0|F1|F2|F3|pending|계약|코드|검증|Port|control-plane|out-of-scope)/;
const classifiedLines = lines.filter((l) => (/^\s*\|/.test(l) || /^\s*-/.test(l)) && CLASS.test(l));
const missingUC = ucInv.filter((u) => !classifiedLines.some((l) => new RegExp(`\\b${u.replace(/-/g,"\\-")}\\b`).test(l)));

// fit 게이트: fit-추적 행(미평가/clean/mismatch 토큰 보유) 중 상태(마지막 셀) 코드/검증인데 fit∉{clean,resolved}
const FIT_TOK = /(clean|mismatch|미평가|resolved)/, FIT_OK = /(clean|mismatch-resolved|resolved)/;
const fitRows = lines.filter((l) => /^\s*\|/.test(l) && FIT_TOK.test(l));
const fitViol = fitRows.filter((l) => {
  const cells = l.split("|").map((c) => c.trim()).filter(Boolean);
  const status = cells[cells.length - 1];
  const fitCell = cells.find((c) => FIT_TOK.test(c)) || "";
  return /(코드|검증)/.test(status) && !FIT_OK.test(fitCell);
});
const backlog = fitRows.filter((l) => /미평가/.test(l)).length;       // 가시화(영구 은닉 금지)
const hasActive = /## 현재 활성/.test(mtx);

let fail = 0;
console.log(`[assembly-coverage] S ${sInv.length} / UC ${ucInv.length}`);
if (missingS.length) { console.log(`  ❌ 미분류/미분류상태 S(${missingS.length}): ${missingS.join(", ")}`); fail = 1; } else console.log("  ✓ 모든 S = 자기 행 + 이식/보충/rej 분류");
if (missingUC.length) { console.log(`  ❌ 미분류 UC(${missingUC.length}): ${missingUC.join(", ")}`); fail = 1; } else console.log("  ✓ 모든 UC 분류");
if (fitViol.length) { console.log(`  ❌ fit 게이트 위반 ${fitViol.length}행`); fail = 1; } else console.log("  ✓ fit 게이트 OK");
if (!hasActive) { console.log("  ❌ 활성 슬라이스 선언 없음"); fail = 1; } else console.log("  ✓ 활성 슬라이스 선언됨");
console.log(`  ⓘ fit=미평가 backlog: ${backlog}행 (진전 필요 — 영구 정체 금지)`);
process.exit(fail);
