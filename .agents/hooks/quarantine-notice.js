#!/usr/bin/env node
/**
 * Quarantine Notice (SessionStart) — 보류 격리 자산 중 **만료·아카이브되어 사용자 처분을 기다리는**
 *   항목(pending_notice)을 첫 세션 진입 시 surface 한다. "이런 게 바뀌었다 — 권한 유저에게 질의".
 *
 * cron/verify-watch 가 만료 자산을 자동 압축(비파괴)까지만 처리하고 멈춘다. 삭제(파괴)는
 *   이 hook 이 띄운 알림을 보고 AI 가 **권한 유저에게 질의**(삭제/연장/복원)해 결정한다.
 *   → 백그라운드 자동 삭제 금지 + 파괴는 사람 게이트, 라는 불변원칙의 사람-루프 진입점.
 *
 * 비차단(절대 block 안 함) — additionalContext 로 알리기만. ESM, fail-open.
 * env: QUARANTINE_PROJECT_ROOT (기본 cwd).
 */
import fs from "fs";
import path from "path";

async function main() {
	// SessionStart 입력은 소비만(있으면) — 판단엔 manifest 만 쓴다.
	try {
		for await (const _ of process.stdin) { /* drain */ }
	} catch { /* no stdin */ }

	const root = process.env.QUARANTINE_PROJECT_ROOT || process.cwd();
	const manifestPath = path.join(root, "quarantine", "MANIFEST.json");
	if (!fs.existsSync(manifestPath)) process.exit(0);

	let m;
	try {
		m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	} catch {
		process.exit(0); // 깨진 manifest 로 세션 막지 않는다
	}
	const pending = (m.quarantined || []).filter((e) => e.pending_notice);
	if (!pending.length) process.exit(0);

	const lines = pending.map(
		(e) => `  - ${e.name} (격리 ${e.quarantined_date}, 보관 ${e.retention_months}개월 만료, ${e.compressed ? "tar.gz 압축됨" : "미압축"}) — 사유: ${e.reason || "—"}`,
	);
	const ctx =
		`[Quarantine] 보류 격리 자산 ${pending.length}건이 보관기간 만료로 자동 아카이브됨 — 권한 유저의 처분이 필요합니다(이런 게 바뀌었습니다):\n` +
		lines.join("\n") +
		`\n권한 유저에게 각 항목을 질의하세요: 삭제(\`node scripts/quarantine.mjs purge <name>\`) / 연장(\`extend <name> <개월>\`) / 복원(\`restore <name>\`). ` +
		`백그라운드는 절대 삭제하지 않습니다 — 삭제는 사용자 승인 후에만.`;

	process.stdout.write(
		JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }),
	);
	process.exit(0);
}

main().catch(() => process.exit(0));
