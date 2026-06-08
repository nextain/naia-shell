#!/usr/bin/env node
/**
 * Charter Guard (PreToolUse on Edit|Write) — 헌장·hook·설정 파일의 AI 단독 수정 차단.
 *
 * 비판 반영(치명): F12 allowed_root_dirs에 `.agents` 포함 → AI가 `.agents/hooks/`·`.claude/settings.json`을
 *   Edit해서 하네스 자체를 무력화 가능. charter_immutability가 *선언*만 되고 강제 hook이 없었다.
 *   이 가드가 그 구멍을 막는다.
 *
 * 보호 대상: charter_files(agents-rules.json) + .agents/hooks/** + .claude/settings.json. (코어 isCharterFile)
 * 사람 승인: HUMAN_APPROVED_CHARTER_EDIT=1 일 때만 통과(정당한 헌장/hook 개발).
 * CI 보완: 원격에서 hook 파일 sha 변경을 별도 감시해야 완결(로컬은 1차 마찰).
 * ESM.
 */
import { loadConfig, isCharterFile } from "./lib/self-trust-core.mjs";

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
	if (tn !== "Edit" && tn !== "Write") process.exit(0);
	const fp = d.tool_input?.file_path || "";
	if (!fp) process.exit(0);

	const root = process.env.CHARTER_PROJECT_ROOT || process.cwd();
	let cfg;
	try {
		cfg = loadConfig(root);
	} catch {
		process.exit(0); // fail-open(로컬)
	}
	if (cfg.level === "off") process.exit(0);
	if (!isCharterFile(fp, root, cfg)) process.exit(0);
	if (process.env.HUMAN_APPROVED_CHARTER_EDIT === "1") process.exit(0); // 사람 승인 하 통과

	const reason =
		"[charter] 헌장·hook·설정 파일은 AI 단독 수정 금지 (하네스 자가-무력화 방지).\n" +
		"대상 = charter_files + .agents/hooks/** + .claude/settings.json\n" +
		"정당한 수정은 사용자 승인 하에만: 환경변수 HUMAN_APPROVED_CHARTER_EDIT=1\n" +
		"(원격 CI는 hook 파일 sha 변경을 별도 감시합니다.)";
	if (cfg.level === "advisory") {
		process.stdout.write(JSON.stringify({ systemMessage: reason }));
		process.exit(0);
	}
	process.stdout.write(JSON.stringify({ decision: "block", reason }));
	process.exit(0);
}

main().catch(() => process.exit(0));
