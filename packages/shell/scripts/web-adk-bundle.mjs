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

// 시연판(공개 웹)에 싣는 묶음. 번들 JSON 은 누구나 받을 수 있으므로 화면 숨김이 아니라 빌드에서 거른다.
// 앱 규칙 해설(.agents/context, .users)은 그대로 두고, 저장소 맨 위 AGENTS.md·CLAUDE.md·GEMINI.md·README.md 는
// 지나가 실제로 읽는 시연용 AGENTS.md 와 겹치지 않게 naia-adk-reference/ 아래로 옮긴다.
export const KIOSK_ADK_REFERENCE_DIR = "naia-adk-reference";
const KIOSK_ADK_ALLOW = [
	/^(AGENTS|CLAUDE|GEMINI|README)\.md$/,
	/^\.agents\/context\/(agents-rules\.json|ai-work-index\.yaml|project-index\.yaml|terminology\.yaml|skills-index\.yaml|harness\.yaml|repo-structure-standard\.yaml|philosophy\.yaml|contributing\.yaml|writing-style\.json|request-contract\.json)$/,
	/^\.users\/(commands|hooks|skills|workflows)-list\.md$/,
	/^\.users\/context\/(en\/)?[^/]+\.md$/,
];
// 운영·비밀 냄새가 나는 이름은 허용 목록에 들어 있어도 뺀다.
const KIOSK_ADK_DENY = /discord|credential|secret|token|ssh|azure|internal|\.env|private|gstack|llm-config|development-model-routing/i;
const KIOSK_ADK_SECRET_CONTENT =
	/AKIA[0-9A-Z]{16}|\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{10,}/;

export function kioskAdkBundlePath(p) {
	if (KIOSK_ADK_DENY.test(p)) return null;
	if (!KIOSK_ADK_ALLOW.some((re) => re.test(p))) return null;
	return /^[A-Z]+\.md$/.test(p) ? `${KIOSK_ADK_REFERENCE_DIR}/${p}` : p;
}

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
		const outPath = options.kiosk ? kioskAdkBundlePath(p) : p;
		if (type === "blob" && (options.kiosk ? outPath : ADK_TARGET_RE.test(p))) {
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
			if (options.kiosk && KIOSK_ADK_SECRET_CONTENT.test(contentBuffer.toString("utf8"))) {
				throw new Error(`시연판 ADK 묶음에 비밀 문자열이 있습니다: ${p}`);
			}
			files.push({
				path: outPath,
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
