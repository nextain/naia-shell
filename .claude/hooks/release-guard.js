#!/usr/bin/env node
/**
 * Release Guard Hook (PreToolUse on Bash)
 *
 * Blocks release commands unless the user has explicitly approved via flag file.
 *
 * Release workflow (must be followed in order):
 *   1. 개발
 *   2. 검수용 설치 파일 전달 (local build)
 *   3. 유저 검수완료
 *   4. 릴리즈 노트 작성
 *   5. 릴리즈 유저 허가 → create .agents/release-approved
 *   6. 릴리즈 진행 (hook allows, then deletes flag)
 *
 * Blocked commands (without approval flag):
 *   - git push origin v*          (tag push → triggers CI release)
 *   - git push origin refs/tags/* (tag push alternate form)
 *   - gh release create           (direct GitHub release creation)
 *   - git tag v* && git push      (combined tag+push)
 */

const fs = require("fs");
const path = require("path");

const APPROVAL_FLAG = ".agents/release-approved";

const RELEASE_PATTERNS = [
	// git push origin v1.2.3 or git push origin v*
	/git\s+push\s+\S+\s+v\d/,
	// git push origin refs/tags/v*
	/git\s+push\s+\S+\s+refs\/tags\/v/,
	// gh release create
	/gh\s+release\s+create/,
];

async function main() {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
	}

	let data;
	try {
		data = JSON.parse(input);
	} catch {
		process.exit(0);
	}

	const toolName = data.tool_name || "";
	const command = data.tool_input?.command || "";

	if (toolName !== "Bash") {
		process.exit(0);
	}

	const isReleaseCommand = RELEASE_PATTERNS.some((p) => p.test(command));
	if (!isReleaseCommand) {
		process.exit(0);
	}

	// Check for approval flag
	const cwd = data.cwd || process.cwd();
	const flagPath = path.join(cwd, APPROVAL_FLAG);

	if (!fs.existsSync(flagPath)) {
		const result = {
			decision: "block",
			reason: [
				"[Release Guard] 릴리즈 승인 플래그가 없습니다.",
				"",
				"릴리즈 워크플로우를 완료해야 합니다:",
				"  1. 개발",
				"  2. 검수용 설치 파일 전달 (로컬 빌드)",
				"  3. 유저 검수완료",
				"  4. 릴리즈 노트 작성",
				"  5. 릴리즈 유저 허가 → .agents/release-approved 파일 생성",
				"  6. 릴리즈 진행 (이 단계)",
				"",
				"사용자가 5단계 승인 후 다음 명령을 직접 실행해야 합니다:",
				`  echo "approved" > ${APPROVAL_FLAG}`,
			].join("\n"),
		};
		process.stdout.write(JSON.stringify(result));
		process.exit(0);
	}

	// Flag exists — allow and delete it (one-time use)
	try {
		fs.unlinkSync(flagPath);
	} catch {
		// ignore
	}

	// Allow the command to proceed
	process.exit(0);
}

main().catch(() => process.exit(0));
