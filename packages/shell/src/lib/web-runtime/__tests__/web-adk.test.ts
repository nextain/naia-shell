import { describe, expect, it } from "vitest";
import {
	gitBlobSha1,
	provisionWebAdk,
	WEB_ADK_SOURCE,
	type WebAdkSource,
} from "../web-adk";
import {
	createMemoryWebFs,
	createOpfsWebFs,
	type WebFsDirectoryHandle,
	type WebFsFileHandle,
} from "../web-fs";

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

	it("recovers from write failure without leaving empty file that bypasses subsequent provisioning", async () => {
		let failWritable = false;

		class MockDirHandle implements WebFsDirectoryHandle {
			kind = "directory" as const;
			name: string;
			files = new Map<string, Uint8Array>();
			dirs = new Map<string, MockDirHandle>();

			constructor(name = "") {
				this.name = name;
			}

			async getDirectoryHandle(
				name: string,
				options?: { create?: boolean },
			): Promise<MockDirHandle> {
				let dir = this.dirs.get(name);
				if (!dir) {
					if (options?.create) {
						dir = new MockDirHandle(name);
						this.dirs.set(name, dir);
					} else {
						throw new DOMException(
							`Directory not found: ${name}`,
							"NotFoundError",
						);
					}
				}
				return dir;
			}

			async getFileHandle(
				name: string,
				options?: { create?: boolean },
			): Promise<WebFsFileHandle> {
				const hasFile = this.files.has(name);
				if (!hasFile) {
					if (options?.create) {
						this.files.set(name, new Uint8Array(0));
					} else {
						throw new DOMException(`File not found: ${name}`, "NotFoundError");
					}
				}

				const parent = this;
				return {
					async getFile() {
						const data = parent.files.get(name);
						if (data === undefined) {
							throw new DOMException(`File not found: ${name}`, "NotFoundError");
						}
						return {
							async text() {
								return new TextDecoder().decode(data);
							},
						};
					},
					async createWritable() {
						if (failWritable) {
							throw new Error("simulated createWritable failure");
						}
						return {
							async write(data: unknown) {
								let bytes: Uint8Array;
								if (typeof data === "string") {
									bytes = new TextEncoder().encode(data);
								} else if (data instanceof Uint8Array) {
									bytes = data;
								} else if (data instanceof ArrayBuffer) {
									bytes = new Uint8Array(data);
								} else if (ArrayBuffer.isView(data)) {
									bytes = new Uint8Array(
										data.buffer,
										data.byteOffset,
										data.byteLength,
									);
								} else if (
									typeof Blob !== "undefined" &&
									data instanceof Blob
								) {
									const ab = await data.arrayBuffer();
									bytes = new Uint8Array(ab);
								} else {
									bytes = new Uint8Array(0);
								}
								parent.files.set(name, bytes);
							},
							async close() {},
						};
					},
				};
			}

			async removeEntry(name: string): Promise<void> {
				if (this.files.has(name)) {
					this.files.delete(name);
					return;
				}
				if (this.dirs.has(name)) {
					this.dirs.delete(name);
					return;
				}
				throw new DOMException(`Entry not found: ${name}`, "NotFoundError");
			}
		}

		const mockRoot = new MockDirHandle("root");
		const fs = createOpfsWebFs(() => Promise.resolve(mockRoot));

		const agentsContent = new TextEncoder().encode("# Test Agents\nValid content");
		const agentsSha1 = await gitBlobSha1(agentsContent);
		const claudeContent = new TextEncoder().encode("@AGENTS.md\n");
		const claudeSha1 = await gitBlobSha1(claudeContent);

		const testSource: WebAdkSource = {
			repo: "nextain/naia-adk",
			commit: "test-commit-recovery",
			files: [
				{
					path: "AGENTS.md",
					size: agentsContent.byteLength,
					sha1: agentsSha1,
				},
				{
					path: "CLAUDE.md",
					size: claudeContent.byteLength,
					sha1: claudeSha1,
				},
			],
			dirs: ["projects/naia-template-project"],
		};

		const mockFetch = async (url: string) => {
			if (url.endsWith("AGENTS.md")) {
				return {
					ok: true,
					status: 200,
					arrayBuffer: async () => agentsContent.buffer,
				};
			}
			if (url.endsWith("CLAUDE.md")) {
				return {
					ok: true,
					status: 200,
					arrayBuffer: async () => claudeContent.buffer,
				};
			}
			return {
				ok: false,
				status: 404,
				arrayBuffer: async () => new ArrayBuffer(0),
			};
		};

		// 1. Fail switch ON during first provisioning
		failWritable = true;
		const firstRes = await provisionWebAdk({
			fs,
			fetch: mockFetch,
			base: "https://example.com/base/",
			source: testSource,
		});

		expect(firstRes.ok).toBe(false);
		expect(
			await fs.exists("naia-adk/naia-settings/.web-adk-source.json"),
		).toBe(false);

		// 2. Fail switch OFF during second provisioning
		failWritable = false;
		const secondRes = await provisionWebAdk({
			fs,
			fetch: mockFetch,
			base: "https://example.com/base/",
			source: testSource,
		});

		expect(secondRes.ok).toBe(true);
		expect(
			await fs.exists("naia-adk/naia-settings/.web-adk-source.json"),
		).toBe(true);

		const agentsText = await fs.readText("naia-adk/AGENTS.md");
		expect(agentsText).not.toBe("");
		expect(agentsText).toBe("# Test Agents\nValid content");
	});
});

