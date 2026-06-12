#!/usr/bin/env node
/**
 * check-file-anchors — 파일단위 계약 앵커 검출기 (드리프트 자동차단 1단계).
 *
 * 문제: ci-verify-structure 는 루트 dir(F12)만 검사 → `src/main/**` 안에 새 파일을
 * 추가하면 어느 계약/UC 에도 안 묶여도 통과. (UC12 provider-resolver.ts 가 이렇게 샘.)
 *
 * 규칙(계약 먼저, 코드 나중): `src/main` 의 모든 .ts 는 module-manifest.json 에
 * {layer, uc, contract} 앵커와 함께 등록돼야 한다.
 *   - 디스크 파일 ∉ manifest  → RED (미계약 코드 = 드리프트)
 *   - manifest 항목 파일 부재  → RED (stale)
 *   - manifest.files 비어있음  → fail-closed RED (빈 매니페스트가 "drift 0" 위장 차단)
 *   - 앵커 필드(layer/uc/contract) 누락 → RED
 *
 * exit 0 = 모든 파일이 계약에 앵커됨. exit 1 = 드리프트.
 * 0 토큰·결정론·LLM 없음. PostToolUse 훅 + cron 에서 호출.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.CI_PROJECT_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, ".agents", "context", "module-manifest.json");
const SCAN_DIR = "src/main";
const VALID_LAYERS = new Set(["domain", "ports", "app", "adapters", "composition"]);

function listTs(absDir, relBase) {
	const out = [];
	let entries;
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const rel = relBase ? `${relBase}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...listTs(join(absDir, e.name), rel));
		else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(rel);
	}
	return out;
}

function main() {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
	} catch {
		console.error(`[file-anchors] RED fail-closed: ${MANIFEST} 없음/손상.`);
		process.exit(1);
	}
	const files = manifest.files || {};
	const keys = Object.keys(files);
	if (keys.length === 0) {
		console.error("[file-anchors] RED fail-closed: manifest.files 비어있음 (빈 매니페스트=inert 위장 금지).");
		process.exit(1);
	}

	const disk = listTs(join(ROOT, SCAN_DIR), SCAN_DIR).sort();
	const registered = new Set(keys);
	const errs = [];

	// 1. 미계약: 디스크에 있는데 manifest 에 없음 = 드리프트.
	for (const f of disk) if (!registered.has(f)) errs.push(`미계약 코드(앵커 없음): ${f} — module-manifest.json 에 {layer,uc,contract} 선언 먼저.`);
	// 2. stale: manifest 에 있는데 디스크에 없음.
	const diskSet = new Set(disk);
	for (const f of keys) if (!diskSet.has(f)) errs.push(`stale 앵커(파일 없음): ${f}`);
	// 3. 앵커 필드 완전성.
	for (const f of keys) {
		const a = files[f] || {};
		if (!a.layer || !VALID_LAYERS.has(a.layer)) errs.push(`${f}: layer 누락/미허용 (${[...VALID_LAYERS].join("|")})`);
		if (!a.uc) errs.push(`${f}: uc 앵커 누락`);
		if (!a.contract) errs.push(`${f}: contract 문서 앵커 누락`);
	}

	if (errs.length) {
		console.error(`[file-anchors] RED — ${errs.length}건 드리프트:`);
		for (const e of errs) console.error("  ✗ " + e);
		process.exit(1);
	}
	console.log(`[file-anchors] OK — ${disk.length} 파일 전부 계약 앵커됨 (${SCAN_DIR}).`);
	process.exit(0);
}
main();
