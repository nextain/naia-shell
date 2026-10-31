import fs from "node:fs";
import path from "node:path";

export function resolveWebAgentDir(env) {
	const dir = env?.NAIA_WEB_AGENT_DIR;
	if (!dir || typeof dir !== "string" || !path.isAbsolute(dir)) {
		throw new Error(
			"NAIA_WEB_AGENT_DIR 필요: naia-agent 워크트리 절대 경로 (예: /path/to/naia-agent)",
		);
	}

	const cleaned = dir.replace(/\/+$/, "");
	const entryFile = path.join(cleaned, "src/main/composition/browser-agent.ts");

	if (!fs.existsSync(entryFile)) {
		throw new Error(
			`NAIA_WEB_AGENT_DIR 필요: naia-agent 워크트리 절대 경로 (파일 부재: ${entryFile})`,
		);
	}

	return cleaned;
}
