import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWebAdkBundle } from "../web-adk-bundle.mjs";

describe("web-adk-bundle script", () => {
	let tempRepo: string;

	beforeEach(() => {
		tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "wo11-test-repo-"));
		execFileSync("git", ["init", "-b", "main"], { cwd: tempRepo });
		execFileSync("git", ["config", "user.email", "test@example.com"], {
			cwd: tempRepo,
		});
		execFileSync("git", ["config", "user.name", "Test User"], {
			cwd: tempRepo,
		});
	});

	afterEach(() => {
		if (tempRepo && fs.existsSync(tempRepo)) {
			fs.rmSync(tempRepo, { recursive: true, force: true });
		}
	});

	function commitFiles(files: Record<string, string>): string {
		for (const [filePath, content] of Object.entries(files)) {
			const fullPath = path.join(tempRepo, filePath);
			fs.mkdirSync(path.dirname(fullPath), { recursive: true });
			fs.writeFileSync(fullPath, content);
		}
		execFileSync("git", ["add", "-A"], { cwd: tempRepo });
		execFileSync("git", ["commit", "-m", "test commit"], { cwd: tempRepo });
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRepo })
			.toString()
			.trim();
	}

	it("filters target files matching rules, sorts paths, and calculates blob sha1", () => {
		const filesToCommit: Record<string, string> = {
			// Included targets
			"README.md": "# Readme",
			"AGENTS.md": "# Agents",
			"CLAUDE.md": "@AGENTS.md\n",
			"GEMINI.md": "@AGENTS.md\n",
			".agents/context/process.json": '{"status": "ok"}',
			".agents/skills/tool_a/SKILL.md": "# Skill A",
			".users/context/user.json": '{"name": "test"}',
			".users/skills/custom/skill.txt": "custom skill",

			// Excluded targets
			"sub/README.md": "# Nested Readme",
			".agents/skills/tool_a/extra.txt": "extra",
			".agents/skills/tool_b/nested/SKILL.md": "nested",
			"hooks/pre-commit": "exit 0",
			"packages/shell/index.ts": "export {}",
			"media/logo.png": "binary",
			"naia-settings/config.json": '{"ok": true}',
			"projects/template/file.ts": "code",
		};

		const commit = commitFiles(filesToCommit);

		const bundle = buildWebAdkBundle({
			repo: tempRepo,
			commit,
		});

		expect(bundle.commit).toBe(commit);
		expect(bundle.dirs).toEqual(["projects/naia-template-project"]);

		const paths = bundle.files.map((f) => f.path);
		expect(paths).toEqual([
			".agents/context/process.json",
			".agents/skills/tool_a/SKILL.md",
			".users/context/user.json",
			".users/skills/custom/skill.txt",
			"AGENTS.md",
			"CLAUDE.md",
			"GEMINI.md",
			"README.md",
		]);

		// Paths must be sorted ascending
		const sortedPaths = [...paths].sort((a, b) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		expect(paths).toEqual(sortedPaths);

		// Verify SHA1 and base64 for each included file
		for (const file of bundle.files) {
			const expectedContent = filesToCommit[file.path];
			const contentBuf = Buffer.from(expectedContent);
			expect(file.size).toBe(contentBuf.length);
			expect(Buffer.from(file.base64, "base64").toString("utf8")).toBe(
				expectedContent,
			);

			// Git blob SHA1 verification
			const gitHeader = `blob ${contentBuf.length}\0`;
			const expectedSha1 = crypto
				.createHash("sha1")
				.update(gitHeader)
				.update(contentBuf)
				.digest("hex");
			expect(file.sha1).toBe(expectedSha1);

			// Match git cat-file blob id
			const gitBlobId = execFileSync(
				"git",
				["-C", tempRepo, "rev-parse", `${commit}:${file.path}`],
			)
				.toString()
				.trim();
			expect(file.sha1).toBe(gitBlobId);
		}
	});

	it("throws Korean error when NAIA_WEB_ADK_REPO is missing or invalid", () => {
		expect(() => buildWebAdkBundle({ repo: "" })).toThrowError(
			/NAIA_WEB_ADK_REPO 필요/,
		);
		expect(() => buildWebAdkBundle({ repo: "relative/path" })).toThrowError(
			/NAIA_WEB_ADK_REPO 필요/,
		);
		expect(() =>
			buildWebAdkBundle({ repo: "/non/existent/path/for/sure" }),
		).toThrowError(/존재하지 않습니다/);
	});

	it("throws Korean error when commit does not exist", () => {
		commitFiles({ "AGENTS.md": "hello" });
		const invalidCommit = "0000000000000000000000000000000000000000";
		expect(() =>
			buildWebAdkBundle({
				repo: tempRepo,
				commit: invalidCommit,
			}),
		).toThrowError(/커밋을 찾을 수 없습니다/);
	});

	it("throws Korean error when 0 target files match", () => {
		const commit = commitFiles({ "unrelated.txt": "not a target" });
		expect(() =>
			buildWebAdkBundle({
				repo: tempRepo,
				commit,
			}),
		).toThrowError(/웹 ADK 번들 대상 파일이 0개입니다/);
	});
});
