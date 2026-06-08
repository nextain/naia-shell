#!/usr/bin/env node
/**
 * M3 — Structure Guard (PreToolUse on Write|Edit). 판정은 공통 코어(checkStructure)에 위임.
 * F12/F13 레지스트리는 agents-rules.json에서 동적 로드. 경로 정규화(NFC/트래버설)는 코어가 처리.
 * 로컬은 fail-open+경고, enforcement_level 지원. ESM.
 */
import { loadConfig, checkStructure } from "./lib/self-trust-core.mjs";

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
	let cfg;
	try {
		cfg = loadConfig(root);
	} catch {
		process.stdout.write(JSON.stringify({ systemMessage: "[M3] 경고: F12/F13 레지스트리 로드 실패 — 구조검사 생략(fail-open)." }));
		process.exit(0);
	}
	if (cfg.level === "off") process.exit(0);

	const v = checkStructure([fp], root, cfg);
	if (v.length === 0) process.exit(0);

	const x = v[0];
	const label = x.kind === "root-file" ? "루트 파일" : "루트 디렉토리";
	const reg = x.kind === "root-file" ? "F13 allowed_root_files" : "F12 allowed_root_dirs";
	const reason = `[M3] 미등록 ${label} '${x.name}' 생성 차단.\n${reg}에 등록 후 사용자 승인 → 생성. (원격 CI가 재검증)`;
	if (cfg.level === "advisory") {
		process.stdout.write(JSON.stringify({ systemMessage: reason }));
		process.exit(0);
	}
	process.stdout.write(JSON.stringify({ decision: "block", reason }));
	process.exit(0);
}

main().catch(() => process.exit(0));
