#!/usr/bin/env node
// check-assembly-coverage — 조립 매트릭스가 user-scenarios의 모든 UC/S를 분류했나(미분류 0) +
// 상태≥코드 행에 fit=미평가 없나(fit 게이트) 결정론 검사. AI 판단 아닌 기계 강제.
import { readFileSync } from "node:fs";
const SRC = "docs/user-scenarios.md";
const MTX = "docs/progress/assembly-matrix-2026-06-10.md";
const src = readFileSync(SRC, "utf8");
const mtx = readFileSync(MTX, "utf8");

// user-scenarios의 S 인벤토리 = 표 행 "| S## |"
const sInv = [...src.matchAll(/^\|\s*(S\d+b?)\s*\|/gm)].map((m) => m[1]);
const sUniq = [...new Set(sInv)];
const ucInv = [...new Set([...src.matchAll(/\*\*(UC\d+[a-z-]*)/g)].map((m) => m[1]))];

const inMtx = (tok) => new RegExp(`\\b${tok.replace(/[-]/g, "\\-")}\\b`).test(mtx);
const missingS = sUniq.filter((s) => !inMtx(s));
const missingUC = ucInv.filter((u) => !inMtx(u));

// fit 게이트: 상태 코드/검증 표기 행에 "미평가" 동반 금지 (best-effort, 행 단위)
const fitViol = mtx.split("\n").filter((l) => {
  if (!/^\|/.test(l) || !/미평가/.test(l)) return false;
  const cells = l.split("|").map((c) => c.trim()).filter(Boolean);
  const status = cells[cells.length - 1] || ""; // 상태=마지막 셀만 검사(기능명 오탐 방지)
  return /(코드|검증)/.test(status);
});

let fail = 0;
console.log(`[assembly-coverage] S 인벤토리 ${sUniq.length}개 / UC ${ucInv.length}개`);
if (missingS.length) { console.log(`  ❌ 매트릭스 누락 S(${missingS.length}): ${missingS.join(", ")}`); fail = 1; }
else console.log("  ✓ 모든 S 분류됨 (미분류 0)");
if (missingUC.length) { console.log(`  ❌ 매트릭스 누락 UC(${missingUC.length}): ${missingUC.join(", ")}`); fail = 1; }
else console.log("  ✓ 모든 UC 분류됨");
if (fitViol.length) { console.log(`  ❌ fit 게이트 위반(상태≥코드인데 미평가) ${fitViol.length}행`); fail = 1; }
else console.log("  ✓ fit 게이트 OK (코드/검증 행에 미평가 없음)");
process.exit(fail);
