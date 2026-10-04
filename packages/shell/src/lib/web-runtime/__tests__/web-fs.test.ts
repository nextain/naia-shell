import { describe, expect, it } from "vitest";
import {
	createMemoryWebFs,
	createOpfsWebFs,
	validateAndSplitPath,
} from "../web-fs";

describe("web-fs", () => {
	describe("path validation", () => {
		it("accepts valid relative paths", () => {
			expect(validateAndSplitPath("a/b/c.txt")).toEqual(["a", "b", "c.txt"]);
			expect(
				validateAndSplitPath("naia-adk/naia-settings/config.json"),
			).toEqual(["naia-adk", "naia-settings", "config.json"]);
		});

		it("rejects empty path or invalid segments", () => {
			expect(() => validateAndSplitPath("")).toThrow("web_fs_invalid_path:");
			expect(() => validateAndSplitPath("/a/b")).toThrow(
				"web_fs_invalid_path:/a/b",
			);
			expect(() => validateAndSplitPath("a//b")).toThrow(
				"web_fs_invalid_path:a//b",
			);
			expect(() => validateAndSplitPath("a/./b")).toThrow(
				"web_fs_invalid_path:a/./b",
			);
			expect(() => validateAndSplitPath("a/../b")).toThrow(
				"web_fs_invalid_path:a/../b",
			);
			expect(() => validateAndSplitPath("a/b/")).toThrow(
				"web_fs_invalid_path:a/b/",
			);
		});
	});

	describe("MemoryWebFs", () => {
		it("performs read and write roundtrip", async () => {
			const fs = createMemoryWebFs();
			expect(await fs.readText("test/file.txt")).toBeNull();
			expect(await fs.exists("test/file.txt")).toBe(false);

			await fs.writeBytes("test/file.txt", "hello world");
			expect(await fs.readText("test/file.txt")).toBe("hello world");
			expect(await fs.exists("test/file.txt")).toBe(true);
			expect(await fs.exists("test")).toBe(true);
		});

		it("supports uint8array writes", async () => {
			const fs = createMemoryWebFs();
			const bytes = new TextEncoder().encode("binary content");
			await fs.writeBytes("dir/sub/binary.bin", bytes);

			expect(await fs.readText("dir/sub/binary.bin")).toBe("binary content");
			expect(await fs.exists("dir/sub/binary.bin")).toBe(true);
			expect(await fs.exists("dir/sub")).toBe(true);
		});

		it("creates intermediate directories and handles ensureDir", async () => {
			const fs = createMemoryWebFs();
			await fs.ensureDir("projects/naia-template-project");

			expect(await fs.exists("projects")).toBe(true);
			expect(await fs.exists("projects/naia-template-project")).toBe(true);
			expect(await fs.exists("projects/other")).toBe(false);

			const snap = fs.snapshot();
			expect(snap["projects/naia-template-project"]).toBe("<dir>");
		});
	});

	describe("OpfsWebFs with mock handles", () => {
		interface MockFileHandle {
			kind: "file";
			name: string;
			getFile(): Promise<{ text(): Promise<string> }>;
			createWritable(): Promise<{
				write(data: unknown): Promise<void>;
				close(): Promise<void>;
			}>;
		}

		interface MockDirHandle {
			kind: "directory";
			name: string;
			getDirectoryHandle(
				name: string,
				options?: { create?: boolean },
			): Promise<MockDirHandle>;
			getFileHandle(
				name: string,
				options?: { create?: boolean },
			): Promise<MockFileHandle>;
		}

		it("returns null on NotFoundError during readText and exists", async () => {
			const notFoundError = new DOMException("Not found", "NotFoundError");

			const mockRoot: MockDirHandle = {
				kind: "directory",
				name: "root",
				async getDirectoryHandle() {
					throw notFoundError;
				},
				async getFileHandle() {
					throw notFoundError;
				},
			};

			const fs = createOpfsWebFs(() =>
				Promise.resolve(mockRoot as unknown as FileSystemDirectoryHandle),
			);
			expect(await fs.readText("missing/dir/file.txt")).toBeNull();
			expect(await fs.exists("missing/dir/file.txt")).toBe(false);
		});

		it("throws non-NotFoundError from getDirectoryHandle or getFileHandle", async () => {
			const diskError = new Error("Disk hardware failure");

			const mockRoot: MockDirHandle = {
				kind: "directory",
				name: "root",
				async getDirectoryHandle() {
					throw diskError;
				},
				async getFileHandle() {
					throw diskError;
				},
			};

			const fs = createOpfsWebFs(() =>
				Promise.resolve(mockRoot as unknown as FileSystemDirectoryHandle),
			);
			await expect(fs.readText("dir/file.txt")).rejects.toThrow(
				"Disk hardware failure",
			);
			await expect(fs.exists("dir/file.txt")).rejects.toThrow(
				"Disk hardware failure",
			);
		});

		it("writes bytes via createWritable and closes", async () => {
			let writtenData: unknown = null;
			let closed = false;

			const mockFile: MockFileHandle = {
				kind: "file",
				name: "data.txt",
				async getFile() {
					return {
						async text() {
							return String(writtenData);
						},
					};
				},
				async createWritable() {
					return {
						async write(data: unknown) {
							writtenData = data;
						},
						async close() {
							closed = true;
						},
					};
				},
			};

			const mockSubDir: MockDirHandle = {
				kind: "directory",
				name: "sub",
				async getDirectoryHandle() {
					throw new DOMException("Not found", "NotFoundError");
				},
				async getFileHandle(name: string) {
					if (name === "data.txt") return mockFile;
					throw new DOMException("Not found", "NotFoundError");
				},
			};

			const mockRoot: MockDirHandle = {
				kind: "directory",
				name: "root",
				async getDirectoryHandle(name: string) {
					if (name === "sub") return mockSubDir;
					throw new DOMException("Not found", "NotFoundError");
				},
				async getFileHandle() {
					throw new DOMException("Not found", "NotFoundError");
				},
			};

			const fs = createOpfsWebFs(() =>
				Promise.resolve(mockRoot as unknown as FileSystemDirectoryHandle),
			);
			await fs.writeBytes("sub/data.txt", "mock content");
			expect(writtenData).toBe("mock content");
			expect(closed).toBe(true);

			const text = await fs.readText("sub/data.txt");
			expect(text).toBe("mock content");
			expect(await fs.exists("sub/data.txt")).toBe(true);
		});
	});
});
