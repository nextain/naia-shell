#!/usr/bin/env node
/**
 * M2 CI 재검증 — 공통 코어(checkSdlc) 위임. 로컬 hook과 동일 로직. fail-closed.
 * 사용: node scripts/ci-verify-sdlc.mjs <file1> <file2> ...
 * ESM.
 */
import { loadConfig, checkSdlc } from "../.agents/hooks/lib/self-trust-core.mjs";

const files = process.argv.slice(2);
const root = process.env.CI_PROJECT_ROOT || process.cwd();
try {
	const cfg = loadConfig(root);
	const r = checkSdlc(files, root, cfg);
	if (r.status === "violation") {
		const miss = (r.reqs || []).filter((x) => !x.ok).map((x) => x.r).join(", ");
		console.error(`[CI SDLC검증 실패] rule=${r.rule} — 누락 산출물: ${miss}`);
		process.exit(1);
	}
	if (r.status === "bootstrap") console.log(`[CI SDLC검증] bootstrap(rule=${r.rule}) — unverified, 산출물 작성 시 정식 게이트 활성`);
	else console.log(`[CI SDLC검증 통과] status=${r.status}`);
	process.exit(0);
} catch (e) {
	console.error("[CI SDLC검증 실패] (fail-closed): " + e.message);
	process.exit(1);
}
