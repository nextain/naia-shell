import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
	checkWebAdkStartup,
	decodeBase64ToBytes,
	gitBlobSha1,
	installDefaultWebAdk,
	provisionWebAdk,
} from "../web-adk";
import { webAdkOpfsPath } from "../web-adk-path";
import { WEB_ADK_COMMIT, type WebAdkBundle } from "../web-adk-source";
import {
	getWebAdkStatus,
	resetWebAdkStatusForTests,
} from "../web-adk-status";
import { createMemoryWebFs } from "../web-fs";

function createSha1Hex(bytes: Uint8Array): string {
	const header = `blob ${bytes.byteLength}\0`;
	return crypto
		.createHash("sha1")
		.update(header)
		.update(bytes)
		.digest("hex");
}

function makeBundle(
	fileSpecs: { path: string; content: string }[],
	overrides: Partial<WebAdkBundle> = {},
): WebAdkBundle {
	const files = fileSpecs.map((f) => {
		const bytes = new TextEncoder().encode(f.content);
		const sha1 = createSha1Hex(bytes);
		const base64 = Buffer.from(bytes).toString("base64");
		return {
			path: f.path,
			size: bytes.byteLength,
			sha1,
			base64,
		};
	});

	return {
		repo: "nextain/naia-adk",
		commit: WEB_ADK_COMMIT,
		files,
		dirs: ["projects/naia-template-project"],
		...overrides,
	};
}

describe("web-adk provisioning and startup checks", () => {
	beforeEach(() => {
		resetWebAdkStatusForTests();
	});

	it("computes git blob sha-1 for CLAUDE.md content", async () => {
		const claudeContent = new TextEncoder().encode("@AGENTS.md\n");
		expect(claudeContent.byteLength).toBe(11);

		const hash = await gitBlobSha1(claudeContent);
		expect(hash).toBe("43c994c2d3617f947bcb5adf1933e21dabe46bb5");
	});

	it("decodes base64 string to Uint8Array accurately", () => {
		const text = "hello world\n";
		const base64 = Buffer.from(text).toString("base64");
		const decoded = decodeBase64ToBytes(base64);
		expect(new TextDecoder().decode(decoded)).toBe(text);
	});

	it("provisions adk bundle successfully with valid source and writes marker", async () => {
		const fs = createMemoryWebFs();
		const bundle = makeBundle([
			{ path: "AGENTS.md", content: "# Agents\n" },
			{ path: "CLAUDE.md", content: "@AGENTS.md\n" },
		]);

		let fetchCalled = false;
		const mockFetch = async (url: string) => {
			fetchCalled = true;
			expect(url).toContain(`web-adk/${WEB_ADK_COMMIT}.json`);
			return {
				ok: true,
				status: 200,
				json: async () => bundle,
			};
		};

		const res = await provisionWebAdk({
			fs,
			fetch: mockFetch,
		});

		expect(res.ok).toBe(true);
		expect(fetchCalled).toBe(true);

		// Assert files written
		const agentsText = await fs.readText(webAdkOpfsPath("AGENTS.md"));
		expect(agentsText).toBe("# Agents\n");

		const claudeText = await fs.readText(webAdkOpfsPath("CLAUDE.md"));
		expect(claudeText).toBe("@AGENTS.md\n");

		// Assert dir created
		expect(
			await fs.exists(webAdkOpfsPath("projects/naia-template-project")),
		).toBe(true);

		// Assert marker written with source: "bundle", repo, commit, fileCount
		const markerText = await fs.readText(
			webAdkOpfsPath("naia-settings/.web-adk-source.json"),
		);
		expect(markerText).not.toBeNull();
		const marker = JSON.parse(markerText!);
		expect(marker).toEqual({
			source: "bundle",
			repo: "nextain/naia-adk",
			commit: WEB_ADK_COMMIT,
			fileCount: 2,
		});
	});

	it("does not overwrite already existing files in OPFS", async () => {
		const fs = createMemoryWebFs();
		// Pre-existing file
		await fs.writeBytes(
			webAdkOpfsPath("AGENTS.md"),
			new TextEncoder().encode("user-modified-content"),
		);

		const bundle = makeBundle([
			{ path: "AGENTS.md", content: "bundle-content" },
			{ path: "CLAUDE.md", content: "claude-content" },
		]);

		const res = await provisionWebAdk({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
		});

		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.written).toEqual(["CLAUDE.md"]);
		}

		// AGENTS.md must retain user bytes
		const agents = await fs.readText(webAdkOpfsPath("AGENTS.md"));
		expect(agents).toBe("user-modified-content");

		// CLAUDE.md was newly written
		const claude = await fs.readText(webAdkOpfsPath("CLAUDE.md"));
		expect(claude).toBe("claude-content");
	});

	it("does not write file and fails if size mismatch occurs", async () => {
		const fs = createMemoryWebFs();
		const bundle = makeBundle([
			{ path: "AGENTS.md", content: "valid content" },
		]);
		// Corrupt size
		bundle.files = [
			{
				...bundle.files[0],
				size: bundle.files[0].size + 10,
			},
		];

		const res = await provisionWebAdk({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
		});

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.failed[0].reason).toBe("size_mismatch");
		}
		expect(await fs.exists(webAdkOpfsPath("AGENTS.md"))).toBe(false);
	});

	it("does not write file and fails if sha1 mismatch occurs", async () => {
		const fs = createMemoryWebFs();
		const bundle = makeBundle([
			{ path: "AGENTS.md", content: "valid content" },
		]);
		// Corrupt sha1
		bundle.files = [
			{
				...bundle.files[0],
				sha1: "0000000000000000000000000000000000000000",
			},
		];

		const res = await provisionWebAdk({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
		});

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.failed[0].reason).toBe("sha1_mismatch");
		}
		expect(await fs.exists(webAdkOpfsPath("AGENTS.md"))).toBe(false);
	});

	it("rejects bundle with duplicate paths", async () => {
		const fs = createMemoryWebFs();
		const bundle = makeBundle([
			{ path: "AGENTS.md", content: "agents 1" },
			{ path: "AGENTS.md", content: "agents 2" },
		]);

		const res = await provisionWebAdk({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
		});

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.failed[0].reason).toBe("duplicate_path");
		}
	});

	it("handles HTTP failure gracefully", async () => {
		const fs = createMemoryWebFs();
		const res = await provisionWebAdk({
			fs,
			fetch: async () => ({
				ok: false,
				status: 500,
				json: async () => ({}),
			}),
		});

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.failed[0].reason).toBe("http_500");
		}
	});

	it("invokes progress callback as files are processed", async () => {
		const fs = createMemoryWebFs();
		const bundle = makeBundle([
			{ path: "file1.txt", content: "1" },
			{ path: "file2.txt", content: "2" },
			{ path: "file3.txt", content: "3" },
		]);

		const progressUpdates: [number, number][] = [];
		const res = await provisionWebAdk({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
			onProgress: (done, total) => progressUpdates.push([done, total]),
		});

		expect(res.ok).toBe(true);
		expect(progressUpdates).toEqual([
			[0, 3],
			[1, 3],
			[2, 3],
			[3, 3],
		]);
	});

	it("does not modify pre-existing config.json or ui-config.json", async () => {
		const fs = createMemoryWebFs();
		const initialConfig = JSON.stringify({ custom: "preserved-config" });
		const initialUiConfig = JSON.stringify({ theme: "dark" });
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/config.json"),
			initialConfig,
		);
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/ui-config.json"),
			initialUiConfig,
		);

		const bundle = makeBundle([{ path: "AGENTS.md", content: "hello" }]);

		const res = await provisionWebAdk({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
		});

		expect(res.ok).toBe(true);
		expect(
			await fs.readText(webAdkOpfsPath("naia-settings/config.json")),
		).toBe(initialConfig);
		expect(
			await fs.readText(webAdkOpfsPath("naia-settings/ui-config.json")),
		).toBe(initialUiConfig);
	});

	// ── Startup check branches ──────────────────────────────────────────────

	it("startup check: fresh profile -> needs-setup", async () => {
		const fs = createMemoryWebFs();
		let fetchCount = 0;
		const status = await checkWebAdkStartup({
			fs,
			fetch: async () => {
				fetchCount++;
				return { ok: true, status: 200, json: async () => ({}) };
			},
		});

		expect(status.phase).toBe("needs-setup");
		expect(getWebAdkStatus().phase).toBe("needs-setup");
		expect(fetchCount).toBe(0);
	});

	it("startup check: config.json only -> needs-setup", async () => {
		const fs = createMemoryWebFs();
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/config.json"),
			JSON.stringify({ provider: "webllm" }),
		);

		let fetchCount = 0;
		const status = await checkWebAdkStartup({
			fs,
			fetch: async () => {
				fetchCount++;
				return { ok: true, status: 200, json: async () => ({}) };
			},
		});

		expect(status.phase).toBe("needs-setup");
		expect(getWebAdkStatus().phase).toBe("needs-setup");
		expect(fetchCount).toBe(0);
	});

	it("startup check: bundle and same commit marker -> ready with 0 fetch", async () => {
		const fs = createMemoryWebFs();
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/.web-adk-source.json"),
			JSON.stringify({
				source: "bundle",
				repo: "nextain/naia-adk",
				commit: WEB_ADK_COMMIT,
				fileCount: 116,
			}),
		);

		let fetchCount = 0;
		const status = await checkWebAdkStartup({
			fs,
			fetch: async () => {
				fetchCount++;
				return { ok: true, status: 200, json: async () => ({}) };
			},
		});

		expect(status.phase).toBe("ready");
		expect(getWebAdkStatus().phase).toBe("ready");
		expect(fetchCount).toBe(0);
	});

	it("startup check: bundle and different commit marker -> fills missing files, preserves config.json", async () => {
		const fs = createMemoryWebFs();
		const initialConfig = JSON.stringify({ custom: "preserve-me" });
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/config.json"),
			initialConfig,
		);
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/.web-adk-source.json"),
			JSON.stringify({
				source: "bundle",
				repo: "nextain/naia-adk",
				commit: "old-commit-sha",
				fileCount: 1,
			}),
		);
		await fs.writeBytes(
			webAdkOpfsPath("AGENTS.md"),
			"custom-agents-content",
		);

		const bundle = makeBundle([
			{ path: "AGENTS.md", content: "new-agents-content" },
			{ path: "CLAUDE.md", content: "new-claude-content" },
		]);

		const status = await checkWebAdkStartup({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
		});

		expect(status.phase).toBe("ready");
		// AGENTS.md was not overwritten
		expect(await fs.readText(webAdkOpfsPath("AGENTS.md"))).toBe(
			"custom-agents-content",
		);
		// CLAUDE.md was filled
		expect(await fs.readText(webAdkOpfsPath("CLAUDE.md"))).toBe(
			"new-claude-content",
		);
		// Marker updated
		const marker = JSON.parse(
			(await fs.readText(webAdkOpfsPath("naia-settings/.web-adk-source.json")))!
		);
		expect(marker.commit).toBe(WEB_ADK_COMMIT);
		// config.json preserved
		expect(
			await fs.readText(webAdkOpfsPath("naia-settings/config.json")),
		).toBe(initialConfig);
	});

	it("startup check: marker without source (round 2 style) -> fills missing files, preserves config.json", async () => {
		const fs = createMemoryWebFs();
		const initialConfig = JSON.stringify({ custom: "preserve-me" });
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/config.json"),
			initialConfig,
		);
		// Round 2 marker: commit matches, but has NO source property
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/.web-adk-source.json"),
			JSON.stringify({
				repo: "nextain/naia-adk",
				commit: WEB_ADK_COMMIT,
				files: ["AGENTS.md", "CLAUDE.md"],
				dirs: ["projects/naia-template-project"],
			}),
		);
		await fs.writeBytes(webAdkOpfsPath("AGENTS.md"), "agents-content");

		const bundle = makeBundle([
			{ path: "AGENTS.md", content: "bundle-agents" },
			{ path: "CLAUDE.md", content: "bundle-claude" },
			{ path: "GEMINI.md", content: "bundle-gemini" },
		]);

		const status = await checkWebAdkStartup({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
		});

		expect(status.phase).toBe("ready");
		expect(await fs.readText(webAdkOpfsPath("AGENTS.md"))).toBe(
			"agents-content",
		);
		expect(await fs.readText(webAdkOpfsPath("GEMINI.md"))).toBe(
			"bundle-gemini",
		);
		const marker = JSON.parse(
			(await fs.readText(webAdkOpfsPath("naia-settings/.web-adk-source.json")))!
		);
		expect(marker.source).toBe("bundle");
		expect(
			await fs.readText(webAdkOpfsPath("naia-settings/config.json")),
		).toBe(initialConfig);
	});

	it("startup check: no marker but AGENTS.md exists -> fills missing files, preserves config.json", async () => {
		const fs = createMemoryWebFs();
		const initialConfig = JSON.stringify({ custom: "preserve-me" });
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/config.json"),
			initialConfig,
		);
		await fs.writeBytes(webAdkOpfsPath("AGENTS.md"), "agents-only");

		const bundle = makeBundle([
			{ path: "AGENTS.md", content: "bundle-agents" },
			{ path: "CLAUDE.md", content: "bundle-claude" },
		]);

		const status = await checkWebAdkStartup({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
		});

		expect(status.phase).toBe("ready");
		expect(await fs.readText(webAdkOpfsPath("AGENTS.md"))).toBe("agents-only");
		expect(await fs.readText(webAdkOpfsPath("CLAUDE.md"))).toBe(
			"bundle-claude",
		);
		const marker = JSON.parse(
			(await fs.readText(webAdkOpfsPath("naia-settings/.web-adk-source.json")))!
		);
		expect(marker.source).toBe("bundle");
		expect(
			await fs.readText(webAdkOpfsPath("naia-settings/config.json")),
		).toBe(initialConfig);
	});

	it("startup check: invalid JSON marker and no AGENTS.md -> needs-setup", async () => {
		const fs = createMemoryWebFs();
		await fs.writeBytes(
			webAdkOpfsPath("naia-settings/.web-adk-source.json"),
			"broken-json-{",
		);

		let fetchCount = 0;
		const status = await checkWebAdkStartup({
			fs,
			fetch: async () => {
				fetchCount++;
				return { ok: true, status: 200, json: async () => ({}) };
			},
		});

		expect(status.phase).toBe("needs-setup");
		expect(fetchCount).toBe(0);
	});

	it("installDefaultWebAdk sets installing, ready, and error states", async () => {
		const fs = createMemoryWebFs();
		const bundle = makeBundle([{ path: "AGENTS.md", content: "ok" }]);

		const okResult = await installDefaultWebAdk({
			fs,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => bundle,
			}),
		});
		expect(okResult.ok).toBe(true);
		expect(getWebAdkStatus().phase).toBe("ready");

		// Failure case
		const failResult = await installDefaultWebAdk({
			fs,
			fetch: async () => ({
				ok: false,
				status: 500,
				json: async () => ({}),
			}),
		});
		expect(failResult.ok).toBe(false);
		expect(getWebAdkStatus().phase).toBe("error");
		expect(getWebAdkStatus().reason).toBe("http_500");
	});
});
