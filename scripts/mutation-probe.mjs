#!/usr/bin/env node
/**
 * mutation-probe — 가짜 QA 동적 검출 (반증가능성). 패널(claude①·codex③) 합의.
 *
 * 원리: 핵심 산출물을 *망가뜨려도* 테스트가 그대로 통과하면 → 그 테스트는 결과를 검증하지 않는다(가짜 QA).
 *   "테스트가 도메인을 언급하나"(정적)로는 못 잡는다 — 언급해도 출력검증을 안 할 수 있으니. 실제로 변이를 가해
 *   테스트가 *red 가 되는지*만이 falsifiable 한 증거다.
 *
 * 동작: baseline 테스트 통과 확인 → 대상 파일의 비-0 값 토큰 N개를 각각 변이 → 매번 테스트 재실행 →
 *   변이가 통과를 '생존'시키면 그 토큰은 미검증. 생존율 > 0 = RED(가짜 QA). 파일은 항상 원복.
 *
 * 사용: node scripts/mutation-probe.mjs <대상파일> -- <테스트명령...>
 *   예: node scripts/mutation-probe.mjs src/engine/font/glyph_data.c -- make test
 * exit 0 = 변이 전부 검출됨(테스트 견고) / 1 = 생존(가짜 QA). ESM.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const target = argv[0];
const cmd = (sep >= 0 ? argv.slice(sep + 1) : argv.slice(1)).join(" ");
if (!target || !cmd) {
	console.error("사용: mutation-probe.mjs <대상파일> -- <테스트명령...>");
	process.exit(2);
}
const N = 4; // 변이 시도 수

function runTests() {
	try {
		execSync(cmd, { stdio: "ignore", timeout: 120000 });
		return true; // 통과
	} catch {
		return false; // 실패(=변이 검출)
	}
}

const orig = fs.readFileSync(target, "utf8");
// 변이 후보: 비-0 hex 바이트 (핵심 데이터). 균등 분산 N개.
const hexRe = /0x(?!00\b)[0-9A-Fa-f]{2}\b/g;
const sites = [];
let m;
while ((m = hexRe.exec(orig))) sites.push({ idx: m.index, tok: m[0] });
if (sites.length === 0) {
	console.error(`[mutation-probe] ${target}: 변이할 비-0 hex 토큰 없음.`);
	process.exit(2);
}
const picks = Array.from({ length: Math.min(N, sites.length) }, (_, i) => sites[Math.floor((i + 0.5) * sites.length / Math.min(N, sites.length))]);

console.log(`[mutation-probe] 대상=${target}  테스트="${cmd}"`);
if (!runTests()) {
	console.error("  baseline 테스트가 이미 red — 변이 의미 없음. 중단.");
	process.exit(2);
}
console.log(`  baseline green. 변이 ${picks.length}회 시도...`);

let survived = 0;
try {
	for (const s of picks) {
		const val = parseInt(s.tok.slice(2), 16);
		const mutant = "0x" + (val ^ 0xff).toString(16).padStart(2, "0").toUpperCase(); // 비트 전반전
		const patched = orig.slice(0, s.idx) + mutant + orig.slice(s.idx + s.tok.length);
		fs.writeFileSync(target, patched);
		const pass = runTests();
		fs.writeFileSync(target, orig); // 즉시 원복
		if (pass) {
			survived++;
			console.log(`  ⚠ 생존: ${s.tok}→${mutant} 인데 테스트 통과 = 이 값 미검증`);
		} else {
			console.log(`  ✓ 검출: ${s.tok}→${mutant} 시 테스트 red`);
		}
	}
} finally {
	fs.writeFileSync(target, orig); // 안전 원복
}

console.log("");
if (survived > 0) {
	console.log(`VERDICT=FAIL — 변이 ${survived}/${picks.length} 생존. 테스트가 ${target} 의 핵심 값을 검증하지 않음 = 가짜 QA.`);
	process.exit(1);
}
console.log(`VERDICT=PASS — 변이 ${picks.length}/${picks.length} 검출. 테스트가 반증가능(견고).`);
process.exit(0);
