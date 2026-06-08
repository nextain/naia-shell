#!/usr/bin/env node
/**
 * M2 — SDLC Gate Guard (PreToolUse on Edit|Write). 판정은 공통 코어(checkSdlc)에 위임.
 * 변경 규칙(어떤 경로 변경이 어떤 산출물을 요구하는지)은 agents-rules.json change_set_rules에서 로드(경로 외부화).
 * enforcement_level: off/advisory/enforced. ESM.
 */
import { loadConfig, checkSdlc } from "./lib/self-trust-core.mjs";

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

	const root = process.env.M2_PROJECT_ROOT || process.cwd();
	let cfg;
	try {
		cfg = loadConfig(root);
	} catch {
		process.exit(0); // fail-open
	}
	if (cfg.level === "off") process.exit(0);

	const r = checkSdlc([fp], root, cfg);
	if (r.status === "ok" || r.status === "n/a" || r.status === "off") process.exit(0);

	if (r.status === "bootstrap") {
		process.stdout.write(
			JSON.stringify({
				systemMessage: `[M2 bootstrap] 산출물 부재(rule=${r.rule}) — 이 변경은 'unverified'. 산출물 작성 시 정식 게이트가 활성됩니다.`,
				hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "bootstrap" },
			}),
		);
		process.exit(0);
	}

	const miss = (r.reqs || []).filter((x) => !x.ok).map((x) => x.r).join(", ");
	const reason =
		`[M2] SDLC 게이트 미충족 (rule=${r.rule}) — 누락 산출물: ${miss}\n` +
		"코드 전에 사용자 시나리오·요구사항을 먼저 작성하세요. (원격 CI가 동일 정책으로 재검증)";
	if (cfg.level === "advisory") {
		process.stdout.write(JSON.stringify({ systemMessage: reason }));
		process.exit(0);
	}
	process.stdout.write(JSON.stringify({ decision: "block", reason }));
	process.exit(0);
}

main().catch(() => process.exit(0));
