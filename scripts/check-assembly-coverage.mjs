#!/usr/bin/env node
// check-assembly-coverage — 조립 매트릭스 전수분류(미분류 0) + fit 게이트 결정론 강제.
// gemini 2차 정정: ① 토큰이 *분류 라인 안*에 있어야(아무데나 언급=불충분) ② fit 화이트리스트(미평가뿐 아니라 빈값/임시값도 차단).
import { readFileSync } from "node:fs";
const src = readFileSync("docs/user-scenarios.md", "utf8");
const mtx = readFileSync("docs/progress/assembly-matrix-2026-06-10.md", "utf8");
const lines = mtx.split("\n");

const sInv = [...new Set([...src.matchAll(/^\|\s*(S\d+b?)\s*\|/gm)].map((m) => m[1]))];
const ucInv = [...new Set([...src.matchAll(/\*\*(UC\d+[a-z-]*)/g)].map((m) => m[1]))];

// "분류 라인" = 표 행(^|) 또는 분류 불릿(- ...). 그 라인이 분류 신호를 동반해야 진짜 분류.
const CLASS = /(이식|보충|reject|rejected|rej\b|old-auth|scenario|F0|F1|F2|F3|pending|계약|코드|검증|Port|control-plane|out-of-scope)/;
const classifiedLines = lines.filter((l) => (/^\s*\|/.test(l) || /^\s*-/.test(l)) && CLASS.test(l));
const isClassified = (tok) => {
  const re = new RegExp(`\\b${tok.replace(/-/g, "\\-")}\\b`);
  return classifiedLines.some((l) => re.test(l));
};
const missingS = sInv.filter((s) => !isClassified(s));
const missingUC = ucInv.filter((u) => !isClassified(u));

// fit 게이트: 표 행 중 상태(마지막 셀)이 코드/검증이면 fit 셀이 화이트리스트(clean|mismatch-resolved)여야.
const FIT_OK = /(clean|mismatch-resolved|resolved)/;
const FIT_TOK = /(clean|mismatch|미평가|resolved)/;          // fit 열을 가진(=fit-추적) 행만 게이트 적용
const fitViol = lines.filter((l) => {
  if (!/^\s*\|/.test(l)) return false;
  const cells = l.split("|").map((c) => c.trim()).filter(Boolean);
  const fitCell = cells.find((c) => FIT_TOK.test(c));
  if (!fitCell) return false;                              // fit 열 없는 요약 rollup 행 = 게이트 N/A
  const status = cells[cells.length - 1];
  if (!/(코드|검증)/.test(status)) return false;          // 상태≥코드인 행만
  return !FIT_OK.test(fitCell);                            // 미평가/임시 등 화이트리스트 외 = 위반
});

let fail = 0;
console.log(`[assembly-coverage] S ${sInv.length} / UC ${ucInv.length} (분류 라인 ${classifiedLines.length})`);
if (missingS.length) { console.log(`  ❌ 미분류 S(${missingS.length}): ${missingS.join(", ")}`); fail = 1; } else console.log("  ✓ 모든 S 분류(분류 라인 내)");
if (missingUC.length) { console.log(`  ❌ 미분류 UC(${missingUC.length}): ${missingUC.join(", ")}`); fail = 1; } else console.log("  ✓ 모든 UC 분류(분류 라인 내)");
if (fitViol.length) { console.log(`  ❌ fit 게이트 위반 ${fitViol.length}행 (상태≥코드인데 fit∉{clean,resolved})`); fail = 1; } else console.log("  ✓ fit 게이트 OK");
process.exit(fail);
