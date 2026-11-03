import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	WEB_ADK_COMMIT,
	WEB_ADK_DIRS,
	WEB_ADK_REPO,
} from "../src/lib/web-runtime/web-adk-source.ts";

export const ADK_TARGET_RE =
	/^(AGENTS\.md|CLAUDE\.md|GEMINI\.md|README\.md|\.agents\/context\/.+|\.agents\/skills\/[^/]+\/SKILL\.md|\.users\/context\/.+|\.users\/skills\/.+)$/;

export function resolveWebAdkRepo(env = process.env) {
	const repo = env?.NAIA_WEB_ADK_REPO;
	if (!repo || typeof repo !== "string" || !path.isAbsolute(repo)) {
		throw new Error(
			"NAIA_WEB_ADK_REPO 필요: naia-adk 저장소 절대 경로 (예: /path/to/naia-adk)",
		);
	}
	const cleaned = repo.replace(/\/+$/, "");
	if (!fs.existsSync(cleaned)) {
		throw new Error(
			`NAIA_WEB_ADK_REPO 필요: naia-adk 저장소 경로가 존재하지 않습니다: ${cleaned}`,
		);
	}
	return cleaned;
}

export function buildWebAdkBundle(options = {}) {
	const repo =
		options.repo !== undefined
			? options.repo
			: resolveWebAdkRepo(options.env ?? process.env);
	if (!repo || typeof repo !== "string" || !path.isAbsolute(repo)) {
		throw new Error(
			"NAIA_WEB_ADK_REPO 필요: naia-adk 저장소 절대 경로 (예: /path/to/naia-adk)",
		);
	}
	if (!fs.existsSync(repo)) {
		throw new Error(
			`NAIA_WEB_ADK_REPO 필요: naia-adk 저장소 경로가 존재하지 않습니다: ${repo}`,
		);
	}

	const commit = options.commit ?? WEB_ADK_COMMIT;
	let lsTreeOutput;
	try {
		lsTreeOutput = execFileSync("git", [
			"-C",
			repo,
			"ls-tree",
			"-r",
			"-l",
			"-z",
			commit,
		]);
	} catch (err) {
		throw new Error(
			`커밋을 찾을 수 없습니다: ${commit} (${err instanceof Error ? err.message : String(err)})`,
		);
	}

	const lines = lsTreeOutput.toString().split("\0").filter(Boolean);
	const files = [];

	for (const line of lines) {
		const [meta, p] = line.split("\t");
		if (!meta || !p) continue;
		const [, type, id, sizeStr] = meta.trim().split(/\s+/);
		if (type === "blob" && ADK_TARGET_RE.test(p)) {
			let contentBuffer;
			try {
				contentBuffer = execFileSync("git", ["-C", repo, "cat-file", "blob", id], {
					maxBuffer: 20 * 1024 * 1024,
				});
			} catch (err) {
				throw new Error(
					`파일 내용을 읽을 수 없습니다: ${p} (${err instanceof Error ? err.message : String(err)})`,
				);
			}
			files.push({
				path: p,
				size: Number(sizeStr),
				sha1: id,
				base64: contentBuffer.toString("base64"),
			});
		}
	}

	if (files.length === 0) {
		throw new Error(`웹 ADK 번들 대상 파일이 0개입니다: ${repo} (${commit})`);
	}

	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	return {
		repo: options.repoName ?? WEB_ADK_REPO,
		commit,
		files,
		dirs: [...(options.dirs ?? WEB_ADK_DIRS)],
	};
}
