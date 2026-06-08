#!/usr/bin/env node
/**
 * M4 CI 재검증 — 완료선언 + 증거 교차검증(검증 가능한 파일 증거 강제). fail-closed.
 *
 * 규칙(라운드5 codex 지적 반영):
 *  - 완료선언이면 'Verified:/Evidence:'로 **검증 가능한 파일 경로 1개 이상**을 대야 하고,
 *    그 파일은 **이번 diff에 포함**돼야 한다.
 *  - 비경로 증거 문자열('Verified: ok')·'closes #N'만으로는 불충분(GitHub가 이슈를 작업증거로 검증하지 않음).
 *    → 이로써 "ok"·"closes #1" 우회를 차단.
 *
 * 사용: git log -1 --format=%B | node scripts/ci-verify-completion.mjs <changed_file...>
 * (workflow는 PR 범위 커밋 전체에 대해 이 검사를 반복한다.)
 * ESM.
 */
import { loadConfig, checkCompletion } from "../.agents/hooks/lib/self-trust-core.mjs";

function extractEvidencePaths(msg) {
	const out = [];
	const re = /(?:Verified|Evidence)\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/gi;
	let m;
	while ((m = re.exec(msg)) !== null) {
		const t = (m[1] || m[2] || m[3] || "").normalize("NFC");
		if (/\//.test(t) || /\.\w{2,5}$/.test(t)) out.push(t); // 파일 경로 형태만
	}
	return out;
}

let input = "";
for await (const c of process.stdin) input += c;
const changedFiles = process.argv.slice(2).map((f) => f.normalize("NFC"));
const root = process.env.CI_PROJECT_ROOT || process.cwd();

let cfg;
try {
	cfg = loadConfig(root);
} catch (e) {
	console.error("[CI 완료검증 실패] 설정 로드 불가 (fail-closed): " + e.message);
	process.exit(1);
}

const r = checkCompletion(input, cfg);

// 완료선언이 아니면 통과
if (["off", "완료선언 아님", "부정문(미완료)"].includes(r.reason)) {
	console.log("[CI 완료검증 통과] " + r.reason);
	process.exit(0);
}
// 완료선언인데 증거 패턴 자체가 없음
if (!r.ok) {
	console.error("[CI 완료검증 실패] " + r.reason + " — 증거가 필요합니다.");
	process.exit(1);
}
// 증거 패턴은 있음 → 검증 가능한 파일 증거(diff 포함) 1개 이상 강제
const evPaths = extractEvidencePaths(input);
if (evPaths.length === 0) {
	console.error(
		"[CI 완료검증 실패] 완료선언에 검증 가능한 '파일 증거'가 없습니다.\n" +
			"'Verified:/Evidence:'는 이번 diff에 포함된 파일 경로여야 합니다. ('closes #N'·비경로 문자열만으론 불충분.)",
	);
	process.exit(1);
}
for (const p of evPaths) {
	if (!changedFiles.includes(p)) {
		console.error(`[CI 완료검증 실패] 증거 파일 '${p}'이 이번 변경(diff)에 없습니다 — 기존 파일 재활용/위조 의심.`);
		process.exit(1);
	}
}
console.log(`[CI 완료검증 통과] 검증 가능한 파일 증거 ${evPaths.length}건 diff 교차검증 완료`);
process.exit(0);
