#!/usr/bin/env node
/**
 * file-anchor-guard — PreToolUse on Write|Edit. 파일단위 계약 앵커 강제(라이브).
 *
 * 루트 구조검사(structure-guard, F12/F13)는 src 가 허용 루트라 `src/main/**` 안의
 * 신규 미계약 파일을 못 잡는다(UC12 provider-resolver.ts 가 이렇게 샘). 이 가드는
 * `src/main/*.ts` 를 만들거나 고치기 전에 그 파일이 .agents/context/module-manifest.json
 * 에 {layer,uc,contract} 로 등록됐는지 본다 — 미등록이면 차단(계약 먼저, 코드 나중).
 *
 * 로컬 = fail-open(매니페스트 로드 실패 시 경고만). enforcement_level: off/advisory/block.
 * 진짜 강제는 원격 CI + cron(verify-watch). ESM.
 */
import { readFileSync } from "node:fs";
import { join, isAbsolute, relative, normalize } from "node:path";
import { loadConfig } from "./lib/self-trust-core.mjs";

async function main() {
	let input = "";
	for await (const c of process.stdin) input += c;
	let d;
	try {
		d = JSON.parse(input);
	} catch {
		process.exit(0);
	}
	const tn = d.tool_name || "";
	if (tn !== "Write" && tn !== "Edit") process.exit(0);
	const fp = d.tool_input?.file_path || "";
	if (!fp) process.exit(0);

	const root = process.env.M3_PROJECT_ROOT || process.cwd();
	const rel = isAbsolute(fp) ? relative(root, fp) : normalize(fp);
	// 범위: 이 repo 의 src/main/*.ts 만 (.d.ts·테스트·외부 제외).
	if (!rel.startsWith("src/main/") || !rel.endsWith(".ts") || rel.endsWith(".d.ts")) process.exit(0);

	// enforcement level (structure-guard 와 동일 소스).
	let level = "block";
	try {
		level = loadConfig(root).level || "block";
	} catch {
		/* fail-open below */
	}
	if (level === "off") process.exit(0);

	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(root, ".agents", "context", "module-manifest.json"), "utf8"));
	} catch {
		process.stdout.write(JSON.stringify({ systemMessage: "[file-anchor] 경고: module-manifest.json 로드 실패 — 파일앵커 검사 생략(fail-open)." }));
		process.exit(0);
	}
	const files = manifest.files || {};
	if (Object.prototype.hasOwnProperty.call(files, rel)) process.exit(0); // 등록됨 → 통과

	const reason =
		`[file-anchor] 미계약 코드 차단: '${rel}' 가 module-manifest.json 에 없습니다.\n` +
		`계약 먼저 — .agents/context/module-manifest.json 에 {layer,uc,contract} 앵커를 선언한 뒤 생성하세요.\n` +
		`(루트 구조검사가 못 잡는 드리프트 클래스. cron(verify-watch)·원격 CI 가 재검증.)`;
	if (level === "advisory") {
		process.stdout.write(JSON.stringify({ systemMessage: reason }));
		process.exit(0);
	}
	process.stdout.write(JSON.stringify({ decision: "block", reason }));
	process.exit(0);
}
main();
