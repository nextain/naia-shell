import { describe, expect, it } from "vitest";
import {
	type AdkSnapshot,
	type DirLike,
	EMPTY_ADK_SNAPSHOT,
	type FileLike,
	makeSnapshotFs,
	readAdkSnapshot,
} from "../adk-snapshot-fs";

class MockNotFoundError extends Error {
	constructor(message = "Not found") {
		super(message);
		this.name = "NotFoundError";
	}
}

describe("adk-snapshot-fs", () => {
	describe("readAdkSnapshot", () => {
		it("reads full snapshot when all entries exist", async () => {
			const mockConfigFile: FileLike = {
				async getFile() {
					return {
						async text() {
							return JSON.stringify({ agentName: "루미" });
						},
					};
				},
			};

			const mockSettingsDir: DirLike = {
				async getDirectoryHandle() {
					throw new MockNotFoundError();
				},
				async getFileHandle(name: string) {
					if (name === "config.json") return mockConfigFile;
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const mockProjectsDir: DirLike = {
				async getDirectoryHandle() {
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {
					yield { kind: "directory", name: "naia-template-project" };
					yield { kind: "file", name: "README.md" };
				},
			};

			const mockAdkDir: DirLike = {
				async getDirectoryHandle(name: string) {
					if (name === "naia-settings") return mockSettingsDir;
					if (name === "projects") return mockProjectsDir;
					throw new MockNotFoundError();
				},
				async getFileHandle(name: string) {
					if (name === "AGENTS.md" || name === "CLAUDE.md") {
						return {
							async getFile() {
								return { async text() { return ""; } };
							},
						};
					}
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const mockRoot: DirLike = {
				async getDirectoryHandle(name: string) {
					if (name === "naia-adk") return mockAdkDir;
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const snapshot = await readAdkSnapshot(() => Promise.resolve(mockRoot));

			expect(snapshot.configText).toBe(JSON.stringify({ agentName: "루미" }));
			expect(snapshot.rootFiles.has("AGENTS.md")).toBe(true);
			expect(snapshot.rootFiles.has("CLAUDE.md")).toBe(true);
			expect(snapshot.projects).toEqual([
				{ name: "naia-template-project", isDir: true },
				{ name: "README.md", isDir: false },
			]);
		});

		it("returns EMPTY_ADK_SNAPSHOT when naia-adk directory does not exist", async () => {
			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const snapshot = await readAdkSnapshot(() => Promise.resolve(mockRoot));
			expect(snapshot).toEqual(EMPTY_ADK_SNAPSHOT);
		});

		it("returns null projects when projects directory does not exist", async () => {
			const mockAdkDir: DirLike = {
				async getDirectoryHandle(name: string) {
					if (name === "projects") throw new MockNotFoundError();
					if (name === "naia-settings") {
						return {
							async getDirectoryHandle() { throw new MockNotFoundError(); },
							async getFileHandle(f: string) {
								if (f === "config.json") {
									return { getFile: async () => ({ text: async () => "{}" }) };
								}
								throw new MockNotFoundError();
							},
							async *values() {},
						};
					}
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					return mockAdkDir;
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const snapshot = await readAdkSnapshot(() => Promise.resolve(mockRoot));
			expect(snapshot.projects).toBeNull();
			expect(snapshot.configText).toBe("{}");
		});

		it("returns null configText when config.json does not exist", async () => {
			const mockSettingsDir: DirLike = {
				async getDirectoryHandle() { throw new MockNotFoundError(); },
				async getFileHandle() { throw new MockNotFoundError(); },
				async *values() {},
			};

			const mockAdkDir: DirLike = {
				async getDirectoryHandle(name: string) {
					if (name === "naia-settings") return mockSettingsDir;
					throw new MockNotFoundError();
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					return mockAdkDir;
				},
				async getFileHandle() {
					throw new MockNotFoundError();
				},
				async *values() {},
			};

			const snapshot = await readAdkSnapshot(() => Promise.resolve(mockRoot));
			expect(snapshot.configText).toBeNull();
		});

		it("rethrows non-NotFoundError error", async () => {
			const diskError = new Error("Disk hardware failure");
			const mockRoot: DirLike = {
				async getDirectoryHandle() {
					throw diskError;
				},
				async getFileHandle() {
					throw diskError;
				},
				async *values() {},
			};

			await expect(readAdkSnapshot(() => Promise.resolve(mockRoot))).rejects.toThrow(
				"Disk hardware failure",
			);
		});
	});

	describe("makeSnapshotFs", () => {
		const fullSnapshot: AdkSnapshot = {
			configText: '{"agentName":"루미"}',
			rootFiles: new Set(["AGENTS.md", "CLAUDE.md"]),
			projects: [
				{ name: "naia-template-project", isDir: true },
				{ name: "notes.txt", isDir: false },
			],
		};

		it("answers existsSync, readFileSync, readdirSync for known paths according to snapshot", () => {
			const fs = makeSnapshotFs(() => fullSnapshot);

			// config.json
			expect(fs.existsSync("opfs://naia-adk/naia-settings/config.json")).toBe(true);
			expect(fs.readFileSync("opfs://naia-adk/naia-settings/config.json", "utf8")).toBe(
				'{"agentName":"루미"}',
			);

			// AGENTS.md and CLAUDE.md
			expect(fs.existsSync("opfs://naia-adk/AGENTS.md")).toBe(true);
			expect(fs.existsSync("opfs://naia-adk/CLAUDE.md")).toBe(true);
			expect(() => fs.readFileSync("opfs://naia-adk/AGENTS.md", "utf8")).toThrow();
			expect(() => fs.readFileSync("opfs://naia-adk/CLAUDE.md", "utf8")).toThrow();

			// projects
			expect(fs.existsSync("opfs://naia-adk/projects")).toBe(true);
			const dirents = fs.readdirSync("opfs://naia-adk/projects", { withFileTypes: true });
			expect(dirents).toHaveLength(2);
			expect(dirents[0].name).toBe("naia-template-project");
			expect(dirents[0].isDirectory()).toBe(true);
			expect(dirents[1].name).toBe("notes.txt");
			expect(dirents[1].isDirectory()).toBe(false);
		});

		it("returns false for existsSync and throws for readFileSync/readdirSync on unknown paths", () => {
			const fs = makeSnapshotFs(() => fullSnapshot);

			expect(fs.existsSync("opfs://naia-adk/unknown.txt")).toBe(false);
			expect(fs.existsSync("opfs://naia-adk/other-dir")).toBe(false);
			expect(fs.existsSync("/local/path")).toBe(false);

			expect(() => fs.readFileSync("opfs://naia-adk/unknown.txt", "utf8")).toThrow("ENOENT");
			expect(() =>
				fs.readdirSync("opfs://naia-adk/unknown-dir", { withFileTypes: true }),
			).toThrow("ENOENT");
		});

		it("returns false for existsSync and throws on missing snapshot entries", () => {
			const emptyFs = makeSnapshotFs(() => EMPTY_ADK_SNAPSHOT);

			expect(emptyFs.existsSync("opfs://naia-adk/naia-settings/config.json")).toBe(false);
			expect(emptyFs.existsSync("opfs://naia-adk/AGENTS.md")).toBe(false);
			expect(emptyFs.existsSync("opfs://naia-adk/CLAUDE.md")).toBe(false);
			expect(emptyFs.existsSync("opfs://naia-adk/projects")).toBe(false);

			expect(() =>
				emptyFs.readFileSync("opfs://naia-adk/naia-settings/config.json", "utf8"),
			).toThrow("ENOENT");
			expect(() =>
				emptyFs.readdirSync("opfs://naia-adk/projects", { withFileTypes: true }),
			).toThrow("ENOENT");
		});
	});
});
