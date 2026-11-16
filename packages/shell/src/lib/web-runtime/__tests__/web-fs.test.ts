import { describe, expect, it } from "vitest";
import {
	createMemoryWebFs,
	createOpfsWebFs,
	validateAndSplitPath,
	type WebFsDirectoryHandle,
	type WebFsFileHandle,
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
		interface MockFileHandle extends WebFsFileHandle {
			kind?: "file";
			name: string;
		}

		interface MockDirHandle extends WebFsDirectoryHandle {
			kind?: "directory";
			name: string;
			getDirectoryHandle(
				name: string,
				options?: { create?: boolean },
			): Promise<MockDirHandle>;
			getFileHandle(
				name: string,
				options?: { create?: boolean },
			): Promise<MockFileHandle>;
			removeEntry(name: string): Promise<void>;
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
				async removeEntry() {},
			};

			const fs = createOpfsWebFs(() => Promise.resolve(mockRoot));
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
				async removeEntry() {},
			};

			const fs = createOpfsWebFs(() => Promise.resolve(mockRoot));
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
				async removeEntry() {},
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
				async removeEntry() {},
			};

			const fs = createOpfsWebFs(() => Promise.resolve(mockRoot));
			await fs.writeBytes("sub/data.txt", "mock content");
			expect(writtenData).toBe("mock content");
			expect(closed).toBe(true);

			const text = await fs.readText("sub/data.txt");
			expect(text).toBe("mock content");
			expect(await fs.exists("sub/data.txt")).toBe(true);
		});

		it("cleans up newly created file if createWritable fails so exists is false", async () => {
			let failWritable = true;
			const files = new Map<string, { text: string }>();

			const createMockFile = (name: string): MockFileHandle => ({
				kind: "file",
				name,
				async getFile() {
					const f = files.get(name);
					if (!f) throw new DOMException("Not found", "NotFoundError");
					return {
						async text() {
							return f.text;
						},
					};
				},
				async createWritable() {
					if (failWritable) {
						throw new Error("createWritable failed");
					}
					return {
						async write(data: unknown) {
							files.set(name, { text: String(data) });
						},
						async close() {},
					};
				},
			});

			const mockDir: MockDirHandle = {
				kind: "directory",
				name: "root",
				async getDirectoryHandle() {
					throw new DOMException("Not found", "NotFoundError");
				},
				async getFileHandle(name: string, options?: { create?: boolean }) {
					if (!files.has(name)) {
						if (options?.create) {
							files.set(name, { text: "" });
						} else {
							throw new DOMException("Not found", "NotFoundError");
						}
					}
					return createMockFile(name);
				},
				async removeEntry(name: string) {
					if (!files.has(name)) {
						throw new DOMException("Not found", "NotFoundError");
					}
					files.delete(name);
				},
			};

			const fs = createOpfsWebFs(() => Promise.resolve(mockDir));

			await expect(fs.writeBytes("new-file.txt", "content")).rejects.toThrow(
				"createWritable failed",
			);
			expect(await fs.exists("new-file.txt")).toBe(false);
		});

		it("preserves pre-existing file if createWritable fails", async () => {
			let failWritable = false;
			const files = new Map<string, { text: string }>();

			const createMockFile = (name: string): MockFileHandle => ({
				kind: "file",
				name,
				async getFile() {
					const f = files.get(name);
					if (!f) throw new DOMException("Not found", "NotFoundError");
					return {
						async text() {
							return f.text;
						},
					};
				},
				async createWritable() {
					if (failWritable) {
						throw new Error("createWritable failed");
					}
					return {
						async write(data: string | Blob) {
							files.set(name, { text: String(data) });
						},
						async close() {},
					};
				},
			});

			const mockDir: MockDirHandle = {
				kind: "directory",
				name: "root",
				async getDirectoryHandle() {
					throw new DOMException("Not found", "NotFoundError");
				},
				async getFileHandle(name: string, options?: { create?: boolean }) {
					if (!files.has(name)) {
						if (options?.create) {
							files.set(name, { text: "" });
						} else {
							throw new DOMException("Not found", "NotFoundError");
						}
					}
					return createMockFile(name);
				},
				async removeEntry(name: string) {
					if (!files.has(name)) {
						throw new DOMException("Not found", "NotFoundError");
					}
					files.delete(name);
				},
			};

			const fs = createOpfsWebFs(() => Promise.resolve(mockDir));

			await fs.writeBytes("existing-file.txt", "initial content");
			expect(await fs.exists("existing-file.txt")).toBe(true);

			failWritable = true;
			await expect(
				fs.writeBytes("existing-file.txt", "updated content"),
			).rejects.toThrow("createWritable failed");
			expect(await fs.exists("existing-file.txt")).toBe(true);
			expect(await fs.readText("existing-file.txt")).toBe("initial content");
		});

		it("preserves write error when both write and close fail, closes once, and cleans up new file", async () => {
			const writeErr = new Error("write failed");
			const closeErr = new Error("close failed");
			let closeCalls = 0;
			const files = new Map<string, { text: string }>();

			const createMockFile = (name: string): MockFileHandle => ({
				kind: "file",
				name,
				async getFile() {
					const f = files.get(name);
					if (!f) throw new DOMException("Not found", "NotFoundError");
					return {
						async text() {
							return f.text;
						},
					};
				},
				async createWritable() {
					return {
						async write() {
							throw writeErr;
						},
						async close() {
							closeCalls++;
							throw closeErr;
						},
					};
				},
			});

			const mockDir: MockDirHandle = {
				kind: "directory",
				name: "root",
				async getDirectoryHandle() {
					throw new DOMException("Not found", "NotFoundError");
				},
				async getFileHandle(name: string, options?: { create?: boolean }) {
					if (!files.has(name)) {
						if (options?.create) {
							files.set(name, { text: "" });
						} else {
							throw new DOMException("Not found", "NotFoundError");
						}
					}
					return createMockFile(name);
				},
				async removeEntry(name: string) {
					if (!files.has(name)) {
						throw new DOMException("Not found", "NotFoundError");
					}
					files.delete(name);
				},
			};

			const fs = createOpfsWebFs(() => Promise.resolve(mockDir));

			await expect(
				fs.writeBytes("new-file-both-fail.txt", "content"),
			).rejects.toBe(writeErr);
			expect(closeCalls).toBe(1);
			expect(await fs.exists("new-file-both-fail.txt")).toBe(false);
		});

		it("preserves close error when write succeeds but close fails, and cleans up new file", async () => {
			const closeErr = new Error("close failed only");
			let closeCalls = 0;
			const files = new Map<string, { text: string }>();

			const createMockFile = (name: string): MockFileHandle => ({
				kind: "file",
				name,
				async getFile() {
					const f = files.get(name);
					if (!f) throw new DOMException("Not found", "NotFoundError");
					return {
						async text() {
							return f.text;
						},
					};
				},
				async createWritable() {
					return {
						async write(data: string | Blob) {
							files.set(name, { text: String(data) });
						},
						async close() {
							closeCalls++;
							throw closeErr;
						},
					};
				},
			});

			const mockDir: MockDirHandle = {
				kind: "directory",
				name: "root",
				async getDirectoryHandle() {
					throw new DOMException("Not found", "NotFoundError");
				},
				async getFileHandle(name: string, options?: { create?: boolean }) {
					if (!files.has(name)) {
						if (options?.create) {
							files.set(name, { text: "" });
						} else {
							throw new DOMException("Not found", "NotFoundError");
						}
					}
					return createMockFile(name);
				},
				async removeEntry(name: string) {
					if (!files.has(name)) {
						throw new DOMException("Not found", "NotFoundError");
					}
					files.delete(name);
				},
			};

			const fs = createOpfsWebFs(() => Promise.resolve(mockDir));

			await expect(
				fs.writeBytes("new-file-close-fail.txt", "content"),
			).rejects.toBe(closeErr);
			expect(closeCalls).toBe(1);
			expect(await fs.exists("new-file-close-fail.txt")).toBe(false);
		});

		it("implements listEntries and removeFile through OpfsWebFs directory handles", async () => {
			interface InMemoryDirNode {
				dirs: Map<string, InMemoryDirNode>;
				files: Map<string, string>;
			}
			const makeDirNode = (): InMemoryDirNode => ({
				dirs: new Map(),
				files: new Map(),
			});
			const rootNode = makeDirNode();

			const toHandle = (
				node: InMemoryDirNode,
				dirName: string,
			): MockDirHandle => ({
				kind: "directory",
				name: dirName,
				async getDirectoryHandle(
					subName: string,
					options?: { create?: boolean },
				) {
					let child = node.dirs.get(subName);
					if (!child) {
						if (options?.create) {
							child = makeDirNode();
							node.dirs.set(subName, child);
						} else {
							throw new DOMException("Not found", "NotFoundError");
						}
					}
					return toHandle(child, subName);
				},
				async getFileHandle(fileName: string, options?: { create?: boolean }) {
					if (!node.files.has(fileName)) {
						if (options?.create) {
							node.files.set(fileName, "");
						} else {
							throw new DOMException("Not found", "NotFoundError");
						}
					}
					return {
						kind: "file",
						name: fileName,
						async getFile() {
							const textVal = node.files.get(fileName);
							if (textVal === undefined) {
								throw new DOMException("Not found", "NotFoundError");
							}
							return {
								async text() {
									return textVal;
								},
							};
						},
						async createWritable() {
							return {
								async write(data: unknown) {
									if (data instanceof Blob) {
										node.files.set(fileName, await data.text());
									} else {
										node.files.set(fileName, String(data));
									}
								},
								async close() {},
							};
						},
					};
				},
				async removeEntry(entryName: string) {
					if (node.files.has(entryName)) {
						node.files.delete(entryName);
						return;
					}
					if (node.dirs.has(entryName)) {
						node.dirs.delete(entryName);
						return;
					}
					throw new DOMException("Not found", "NotFoundError");
				},
				async *keys() {
					for (const k of node.dirs.keys()) yield k;
					for (const k of node.files.keys()) yield k;
				},
			});

			const opfs = createOpfsWebFs(() =>
				Promise.resolve(toHandle(rootNode, "root")),
			);

			// Missing directory returns empty array
			expect(await opfs.listEntries?.("naia-adk/conversations")).toEqual([]);

			// Write two conversation files via OpfsWebFs and list them
			await opfs.writeBytes(
				"naia-adk/conversations/chat-b.jsonl",
				'{"role":"user","content":"b"}\n',
			);
			await opfs.writeBytes(
				"naia-adk/conversations/chat-a.jsonl",
				'{"role":"user","content":"a"}\n',
			);
			expect(await opfs.listEntries?.("naia-adk/conversations")).toEqual([
				"chat-a.jsonl",
				"chat-b.jsonl",
			]);

			// Remove one file and verify listEntries + exists
			await opfs.removeFile?.("naia-adk/conversations/chat-a.jsonl");
			expect(await opfs.exists("naia-adk/conversations/chat-a.jsonl")).toBe(
				false,
			);
			expect(await opfs.listEntries?.("naia-adk/conversations")).toEqual([
				"chat-b.jsonl",
			]);

			// Removing an already-missing file does not throw
			await expect(
				opfs.removeFile?.("naia-adk/conversations/chat-a.jsonl"),
			).resolves.toBeUndefined();
		});
	});
});
