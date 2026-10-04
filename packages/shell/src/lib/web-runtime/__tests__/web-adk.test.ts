import { describe, expect, it } from "vitest";
import {
	gitBlobSha1,
	provisionWebAdk,
	WEB_ADK_SOURCE,
	type WebAdkSource,
} from "../web-adk";
import { createMemoryWebFs } from "../web-fs";

describe("web-adk", () => {
	it("computes git blob sha-1 for CLAUDE.md content", async () => {
		const claudeContent = new TextEncoder().encode("@AGENTS.md\n");
		expect(claudeContent.byteLength).toBe(11);

		const hash = await gitBlobSha1(claudeContent);
		expect(hash).toBe("43c994c2d3617f947bcb5adf1933e21dabe46bb5");
	});

	it("provisions adk files successfully with valid source and writes source marker", async () => {
		const fs = createMemoryWebFs();
		const testBytes = new TextEncoder().encode("test-content\n");
		const testHash = await gitBlobSha1(testBytes);

		const testSource: WebAdkSource = {
			repo: "nextain/naia-adk",
			commit: "test-commit-sha",
			files: [
				{
					path: "test-file.md",
					size: testBytes.byteLength,
					sha1: testHash,
				},
			],
			dirs: ["test-dir"],
		};

		let fetchCalls = 0;
		const mockFetch = async (url: string) => {
			fetchCalls++;
			expect(url).toBe("https://example.com/base/test-file.md");
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () => testBytes.buffer,
			};
		};

		const res = await provisionWebAdk({
			fs,
			fetch: mockFetch,
			base: "https://example.com/base/",
			source: testSource,
		});

		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.written).toEqual(["test-file.md"]);
		}
		expect(fetchCalls).toBe(1);

		expect(await fs.exists("naia-adk/test-file.md")).toBe(true);
		expect(await fs.exists("naia-adk/test-dir")).toBe(true);
		expect(
			await fs.exists("naia-adk/naia-settings/.web-adk-source.json"),
		).toBe(true);

		const markerRaw = await fs.readText(
			"naia-adk/naia-settings/.web-adk-source.json",
		);
		const marker = JSON.parse(markerRaw || "{}");
		expect(marker.commit).toBe("test-commit-sha");
		expect(marker.files).toEqual(["test-file.md"]);
		expect(marker.dirs).toEqual(["test-dir"]);
	});

	it("skips provisioning if matching commit marker exists (0 fetch calls)", async () => {
		const fs = createMemoryWebFs();
		await fs.ensureDir("naia-adk/naia-settings");
		await fs.writeBytes(
			"naia-adk/naia-settings/.web-adk-source.json",
			JSON.stringify({
				repo: "nextain/naia-adk",
				commit: WEB_ADK_SOURCE.commit,
				files: ["AGENTS.md", "CLAUDE.md"],
				dirs: ["projects/naia-template-project"],
			}),
		);

		let fetchCalls = 0;
		const mockFetch = async () => {
			fetchCalls++;
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () => new ArrayBuffer(0),
			};
		};

		const res = await provisionWebAdk({
			fs,
			fetch: mockFetch,
			base: "https://example.com/base/",
		});

		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.written).toEqual([]);
		}
		expect(fetchCalls).toBe(0);
	});

	it("does not fetch files that already exist in storage", async () => {
		const fs = createMemoryWebFs();
		await fs.writeBytes("naia-adk/existing.txt", "already there");

		const testSource: WebAdkSource = {
			repo: "nextain/naia-adk",
			commit: "c1",
			files: [
				{
					path: "existing.txt",
					size: 13,
					sha1: "sha",
				},
			],
			dirs: [],
		};

		let fetchCalls = 0;
		const mockFetch = async () => {
			fetchCalls++;
			return {
				ok: true,
				status: 200,
				arrayBuffer: async () => new ArrayBuffer(0),
			};
		};

		const res = await provisionWebAdk({
			fs,
			fetch: mockFetch,
			base: "https://example.com/base/",
			source: testSource,
		});

		expect(res.ok).toBe(true);
		expect(fetchCalls).toBe(0);
	});

	it("handles http 404, size mismatch, sha1 mismatch, and thrown errors without writing file or marker", async () => {
		const validBytes = new TextEncoder().encode("content");
		const validHash = await gitBlobSha1(validBytes);

		// 1. HTTP 404
		{
			const fs = createMemoryWebFs();
			const res = await provisionWebAdk({
				fs,
				fetch: async () => ({
					ok: false,
					status: 404,
					arrayBuffer: async () => new ArrayBuffer(0),
				}),
				base: "https://example.com/base/",
				source: {
					repo: "r",
					commit: "c",
					files: [{ path: "f1.txt", size: 7, sha1: validHash }],
					dirs: [],
				},
			});
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.failed).toEqual([{ path: "f1.txt", reason: "http_404" }]);
			}
			expect(await fs.exists("naia-adk/f1.txt")).toBe(false);
			expect(
				await fs.exists("naia-adk/naia-settings/.web-adk-source.json"),
			).toBe(false);
		}

		// 2. Size mismatch
		{
			const fs = createMemoryWebFs();
			const res = await provisionWebAdk({
				fs,
				fetch: async () => ({
					ok: true,
					status: 200,
					arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
				}),
				base: "https://example.com/base/",
				source: {
					repo: "r",
					commit: "c",
					files: [{ path: "f2.txt", size: 7, sha1: validHash }],
					dirs: [],
				},
			});
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.failed).toEqual([
					{ path: "f2.txt", reason: "size_mismatch" },
				]);
			}
			expect(await fs.exists("naia-adk/f2.txt")).toBe(false);
			expect(
				await fs.exists("naia-adk/naia-settings/.web-adk-source.json"),
			).toBe(false);
		}

		// 3. SHA-1 mismatch
		{
			const fs = createMemoryWebFs();
			const res = await provisionWebAdk({
				fs,
				fetch: async () => ({
					ok: true,
					status: 200,
					arrayBuffer: async () => validBytes.buffer,
				}),
				base: "https://example.com/base/",
				source: {
					repo: "r",
					commit: "c",
					files: [{ path: "f3.txt", size: validBytes.byteLength, sha1: "wrong" }],
					dirs: [],
				},
			});
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.failed).toEqual([
					{ path: "f3.txt", reason: "sha1_mismatch" },
				]);
			}
			expect(await fs.exists("naia-adk/f3.txt")).toBe(false);
			expect(
				await fs.exists("naia-adk/naia-settings/.web-adk-source.json"),
			).toBe(false);
		}

		// 4. Fetch throws exception
		{
			const fs = createMemoryWebFs();
			const res = await provisionWebAdk({
				fs,
				fetch: async () => {
					throw new Error("Network error");
				},
				base: "https://example.com/base/",
				source: {
					repo: "r",
					commit: "c",
					files: [{ path: "f4.txt", size: validBytes.byteLength, sha1: validHash }],
					dirs: [],
				},
			});
			expect(res.ok).toBe(false);
			if (!res.ok) {
				expect(res.failed).toEqual([
					{ path: "f4.txt", reason: "Network error" },
				]);
			}
			expect(await fs.exists("naia-adk/f4.txt")).toBe(false);
			expect(
				await fs.exists("naia-adk/naia-settings/.web-adk-source.json"),
			).toBe(false);
		}
	});
});
