#!/usr/bin/env node
/**
 * M3 CI 재검증 — 공통 코어(checkStructure) 위임. 로컬 hook과 동일 로직.
 * CI는 fail-closed: 레지스트리 로드 실패는 통과가 아니라 차단.
 * 사용: node scripts/ci-verify-structure.mjs <file1> <file2> ...
 * ESM.
 */
import { loadConfig, checkStructure } from "../.agents/hooks/lib/self-trust-core.mjs";

const files = process.argv.slice(2);
const root = process.env.CI_PROJECT_ROOT || process.cwd();
try {
	const cfg = loadConfig(root);
	const v = checkStructure(files, root, cfg);
	if (v.length) {
		console.error("[CI 구조검증 실패] 미등록 경로 — F12/F13 등록 + 사용자 승인 필요:");
		for (const x of v) console.error(`  - 미등록 ${x.kind === "root-file" ? "루트파일" : "루트경로"}: ${x.file} ('${x.name}')`);
		process.exit(1);
	}
	console.log(`[CI 구조검증 통과] 변경파일 ${files.length}개 모두 등록됨`);
	process.exit(0);
} catch (e) {
	console.error("[CI 구조검증 실패] 레지스트리 로드 불가 (fail-closed): " + e.message);
	process.exit(1);
}
