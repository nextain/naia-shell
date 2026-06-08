#!/usr/bin/env node
/**
 * CI charter 자가보호 — 변경 파일 중 헌장·hook·CI workflow가 있으면 사람 승인 없이 차단.
 *
 * 목적(라운드4 치명 대응): AI가 `.github/workflows/self-trust-gates.yml`이나 `.agents/hooks/**`를
 *   수정하는 PR로 게이트 자체를 삭제·우회하는 것을, 게이트가 도는 CI(중앙)에서 막는다.
 *   로컬 charter-guard는 우회 가능(env 스푸핑)하므로 최종 방어선은 여기.
 *
 * 사람 승인: 환경변수 CHARTER_APPROVED=1 (CI에서 PR 'charter-approved' 라벨 → env로 매핑) 일 때만 통과.
 * fail-closed. 사용: node scripts/ci-verify-charter.mjs <changed_file...>
 * ESM.
 */
import { loadConfig, isCharterFile } from "../.agents/hooks/lib/self-trust-core.mjs";

const files = process.argv.slice(2);
const root = process.env.CI_PROJECT_ROOT || process.cwd();

let cfg;
try {
	cfg = loadConfig(root);
} catch (e) {
	console.error("[CI charter검증 실패] 설정 로드 불가 (fail-closed): " + e.message);
	process.exit(1);
}

const touched = files.filter((f) => isCharterFile(f, root, cfg));
if (touched.length === 0) {
	console.log("[CI charter검증 통과] 헌장·hook·workflow 변경 없음");
	process.exit(0);
}
if (process.env.CHARTER_APPROVED === "1") {
	console.log(`[CI charter검증] 사람 승인(CHARTER_APPROVED) — 다음 ${touched.length}건 허용:`);
	for (const t of touched) console.log("  - " + t);
	process.exit(0);
}
console.error("[CI charter검증 실패] 헌장·hook·CI workflow 변경에는 사람 승인이 필요합니다 ('charter-approved' 라벨 / CHARTER_APPROVED=1):");
for (const t of touched) console.error("  - " + t);
process.exit(1);
