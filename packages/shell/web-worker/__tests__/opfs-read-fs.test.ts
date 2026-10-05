import type { BrowserReadFs } from "@naia-agent/composition/browser-agent.js";
import { describe, expect, it } from "vitest";
import {
	makeOpfsReadFs,
	type OpfsDirectoryHandleLike,
	type OpfsEntryLike,
	type OpfsFileHandleLike,
	type OpfsFileLike,
} from "../opfs-read-fs";

class MockNotFoundError extends DOMException {
	constructor(message = "Entry not found") {
		super(message, "NotFoundError");
	}
}

class MockTypeMismatchError extends DOMException {
	constructor(message = "Type mismatch") {
		super(message, "TypeMismatchError");
	}
}

class MockSecurityError extends DOMException {
	constructor(message = "Security error") {
		super(message, "SecurityError");
	}
}

type MemoryNode =
	| { kind: "file"; content: string }
	| { kind: "directory"; entries: Map<string, MemoryNode> };

type FailTarget =
	| "root"
	| "workspace"
	| "middle"
	| "stat-last-dir"
	| "stat-file"
	| "list-middle"
	| "list-values"
	| "read-middle"
	| "read-file"
	| "read-text";

interface FakeOpfsOptions {
	failAt?: FailTarget;
	injectedError?: Error;
	rootEntries?: Map<string, MemoryNode>;
}

function createDefaultTree(): Map<string, MemoryNode> {
	const adkEntries = new Map<string, MemoryNode>();

	adkEntries.set("AGENTS.md", {
		kind: "file",
		content: "# naia-adk\n",
	});

	const contextEntries = new Map<string, MemoryNode>();
	contextEntries.set("philosophy.md", {
		kind: "file",
		content: "# philosophy\n",
	});

	const agentsEntries = new Map<string, MemoryNode>();
	agentsEntries.set("context", {
		kind: "directory",
		entries: contextEntries,
	});
	adkEntries.set(".agents", {
		kind: "directory",
		entries: agentsEntries,
	});

	const notesEntries = new Map<string, MemoryNode>();
	notesEntries.set("hello.md", {
		kind: "file",
		content: "hello world\n",
	});
	adkEntries.set("notes", {
		kind: "directory",
		entries: notesEntries,
	});

	adkEntries.set("empty", {
		kind: "directory",
		entries: new Map(),
	});

	const rootEntries = new Map<string, MemoryNode>();
	rootEntries.set("naia-adk", {
		kind: "directory",
		entries: adkEntries,
	});

	return rootEntries;
}

function createFakeOpfs(options?: FakeOpfsOptions): {
	fs: BrowserReadFs;
	record: Array<[string, ...unknown[]]>;
	deleteEntry: (path: string) => void;
} {
	const record: Array<[string, ...unknown[]]> = [];
	const rootEntries = options?.rootEntries ?? createDefaultTree();
	const failAt = options?.failAt;
	const injectedError = options?.injectedError ?? new MockSecurityError();

	function makeFileHandle(name: string, fileNode: { kind: "file"; content: string }, path: string): OpfsFileHandleLike {
		return {
			kind: "file",
			name,
			async getFile(): Promise<OpfsFileLike> {
				record.push(["getFile"]);
				if (
					(failAt === "stat-file" && path === "naia-adk/AGENTS.md") ||
					(failAt === "read-file" && path === "naia-adk/AGENTS.md")
				) {
					throw injectedError;
				}
				const size = new TextEncoder().encode(fileNode.content).length;
				return {
					size,
					async text(): Promise<string> {
						record.push(["text"]);
						if (failAt === "read-text" && path === "naia-adk/AGENTS.md") {
							throw injectedError;
						}
						return fileNode.content;
					},
				};
			},
			async createWritable(...args: unknown[]): Promise<unknown> {
				record.push(["createWritable", ...args]);
				return {};
			},
			async removeEntry(...args: unknown[]): Promise<void> {
				record.push(["removeEntry", ...args]);
			},
			async move(...args: unknown[]): Promise<void> {
				record.push(["move", ...args]);
			},
		} as OpfsFileHandleLike & {
			createWritable: (...args: unknown[]) => Promise<unknown>;
			removeEntry: (...args: unknown[]) => Promise<void>;
			move: (...args: unknown[]) => Promise<void>;
		};
	}

	function makeDirectoryHandle(name: string, dirNode: { kind: "directory"; entries: Map<string, MemoryNode> }, path: string): OpfsDirectoryHandleLike {
		return {
			kind: "directory",
			name,
			async getDirectoryHandle(childName: string): Promise<OpfsDirectoryHandleLike> {
				record.push(["getDirectoryHandle", childName]);
				const childPath = path ? `${path}/${childName}` : childName;

				if (failAt === "workspace" && childPath === "naia-adk") {
					throw injectedError;
				}
				if (failAt === "middle" && childPath === "naia-adk/notes") {
					throw injectedError;
				}
				if (failAt === "stat-last-dir" && childPath === "naia-adk/AGENTS.md") {
					throw injectedError;
				}
				if (failAt === "list-middle" && childPath === "naia-adk/.agents") {
					throw injectedError;
				}
				if (failAt === "read-middle" && childPath === "naia-adk/notes") {
					throw injectedError;
				}

				const entry = dirNode.entries.get(childName);
				if (!entry) {
					throw new MockNotFoundError(`Directory ${childName} not found`);
				}
				if (entry.kind !== "directory") {
					throw new MockTypeMismatchError(`${childName} is not a directory`);
				}
				return makeDirectoryHandle(childName, entry, childPath);
			},

			async getFileHandle(childName: string): Promise<OpfsFileHandleLike> {
				record.push(["getFileHandle", childName]);
				const childPath = path ? `${path}/${childName}` : childName;
				const entry = dirNode.entries.get(childName);
				if (!entry) {
					throw new MockNotFoundError(`File ${childName} not found`);
				}
				if (entry.kind !== "file") {
					throw new MockTypeMismatchError(`${childName} is not a file`);
				}
				return makeFileHandle(childName, entry, childPath);
			},

			async *values(): AsyncIterable<OpfsEntryLike> {
				record.push(["values"]);
				if (failAt === "list-values" && path === "naia-adk") {
					throw injectedError;
				}
				for (const [entryName, entryNode] of dirNode.entries) {
					yield {
						name: entryName,
						kind: entryNode.kind,
					};
				}
			},

			async createWritable(...args: unknown[]): Promise<unknown> {
				record.push(["createWritable", ...args]);
				return {};
			},
			async removeEntry(...args: unknown[]): Promise<void> {
				record.push(["removeEntry", ...args]);
			},
			async move(...args: unknown[]): Promise<void> {
				record.push(["move", ...args]);
			},
		} as OpfsDirectoryHandleLike & {
			createWritable: (...args: unknown[]) => Promise<unknown>;
			removeEntry: (...args: unknown[]) => Promise<void>;
			move: (...args: unknown[]) => Promise<void>;
		};
	}

	const rootHandle = makeDirectoryHandle("", { kind: "directory", entries: rootEntries }, "");

	const getRoot = async (): Promise<OpfsDirectoryHandleLike> => {
		record.push(["getRoot"]);
		if (failAt === "root") {
			throw injectedError;
		}
		return rootHandle;
	};

	const fs = makeOpfsReadFs(getRoot);

	const deleteEntry = (entryPath: string): void => {
		const parts = entryPath.split("/");
		let currentMap = rootEntries;
		for (let i = 0; i < parts.length - 1; i++) {
			const node = currentMap.get(parts[i]);
			if (node && node.kind === "directory") {
				currentMap = node.entries;
			} else {
				return;
			}
		}
		currentMap.delete(parts[parts.length - 1]);
	};

	return { fs, record, deleteEntry };
}

function sortByName<T extends { name: string }>(entries: readonly T[]): T[] {
	return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

describe("opfs-read-fs", () => {
	it("WO13B-U01 stat root", async () => {
		const { fs } = createFakeOpfs();
		const result = await fs.stat([]);
		expect(result).toEqual({ kind: "directory" });
	});

	it("WO13B-U02 stat directory", async () => {
		const { fs } = createFakeOpfs();
		const result = await fs.stat([".agents", "context"]);
		expect(result).toEqual({ kind: "directory" });
	});

	it("WO13B-U03 stat file", async () => {
		const { fs } = createFakeOpfs();
		const result = await fs.stat(["AGENTS.md"]);
		expect(result).toEqual({ kind: "file", size: 11 });
	});

	it("WO13B-U04 stat nonexistent", async () => {
		const { fs } = createFakeOpfs();
		expect(await fs.stat(["nope"])).toBeNull();
		expect(await fs.stat(["notes", "nope.md"])).toBeNull();
		expect(await fs.stat(["nope", "x"])).toBeNull();
	});

	it("WO13B-U05 stat file child", async () => {
		const { fs } = createFakeOpfs();
		const result = await fs.stat(["AGENTS.md", "x"]);
		expect(result).toBeNull();
	});

	it("WO13B-U06 stat missing workspace", async () => {
		const emptyRoot = new Map<string, MemoryNode>();
		const { fs: fsNoWorkspace } = createFakeOpfs({ rootEntries: emptyRoot });
		expect(await fsNoWorkspace.stat([])).toBeNull();
		expect(await fsNoWorkspace.stat(["AGENTS.md"])).toBeNull();

		const rootWithAdkAsFile = new Map<string, MemoryNode>();
		rootWithAdkAsFile.set("naia-adk", { kind: "file", content: "not a dir" });
		const { fs: fsWorkspaceIsFile } = createFakeOpfs({ rootEntries: rootWithAdkAsFile });
		expect(await fsWorkspaceIsFile.stat([])).toBeNull();
		expect(await fsWorkspaceIsFile.stat(["AGENTS.md"])).toBeNull();
	});

	it("WO13B-U07 list root", async () => {
		const { fs } = createFakeOpfs();
		const result = await fs.list([]);
		expect(sortByName(result)).toEqual([
			{ name: ".agents", kind: "directory" },
			{ name: "AGENTS.md", kind: "file" },
			{ name: "empty", kind: "directory" },
			{ name: "notes", kind: "directory" },
		]);
	});

	it("WO13B-U08 list subdirectories", async () => {
		const { fs } = createFakeOpfs();
		expect(await fs.list(["empty"])).toEqual([]);
		expect(await fs.list([".agents", "context"])).toEqual([
			{ name: "philosophy.md", kind: "file" },
		]);
	});

	it("WO13B-U09 readText files", async () => {
		const { fs } = createFakeOpfs();
		expect(await fs.readText(["AGENTS.md"])).toBe("# naia-adk\n");
		expect(await fs.readText(["notes", "hello.md"])).toBe("hello world\n");
	});

	const securityError = new MockSecurityError();
	const u10Cases: ReadonlyArray<[FailTarget, (fs: BrowserReadFs) => Promise<unknown>]> = [
		["root", (fs: BrowserReadFs) => fs.stat(["AGENTS.md"])],
		["workspace", (fs: BrowserReadFs) => fs.stat([])],
		["middle", (fs: BrowserReadFs) => fs.stat(["notes", "hello.md"])],
		["stat-last-dir", (fs: BrowserReadFs) => fs.stat(["AGENTS.md"])],
		["stat-file", (fs: BrowserReadFs) => fs.stat(["AGENTS.md"])],
		["list-middle", (fs: BrowserReadFs) => fs.list([".agents", "context"])],
		["list-values", (fs: BrowserReadFs) => fs.list([])],
		["read-middle", (fs: BrowserReadFs) => fs.readText(["notes", "hello.md"])],
		["read-file", (fs: BrowserReadFs) => fs.readText(["AGENTS.md"])],
		["read-text", (fs: BrowserReadFs) => fs.readText(["AGENTS.md"])],
	];

	it.each(u10Cases)("WO13B-U10 %s", async (target, fn) => {
		const { fs } = createFakeOpfs({ failAt: target, injectedError: securityError });
		await expect(fn(fs)).rejects.toBe(securityError);
	});

	it("WO13B-U11 no caching", async () => {
		const { fs, record, deleteEntry } = createFakeOpfs();
		const res1 = await fs.stat(["AGENTS.md"]);
		expect(res1).toEqual({ kind: "file", size: 11 });

		deleteEntry("naia-adk/AGENTS.md");
		const res2 = await fs.stat(["AGENTS.md"]);
		expect(res2).toBeNull();

		const getRootCalls = record.filter((r) => r[0] === "getRoot");
		expect(getRootCalls).toEqual([["getRoot"], ["getRoot"]]);
	});

	it("WO13B-U12 no writes", async () => {
		const { fs, record } = createFakeOpfs();

		await fs.stat([]);
		await fs.stat([".agents", "context"]);
		await fs.stat(["AGENTS.md"]);
		await fs.stat(["nope"]);
		await fs.stat(["notes", "nope.md"]);
		await fs.stat(["nope", "x"]);
		await fs.stat(["AGENTS.md", "x"]);
		await fs.list([]);
		await fs.list(["empty"]);
		await fs.list([".agents", "context"]);
		await fs.readText(["AGENTS.md"]);
		await fs.readText(["notes", "hello.md"]);

		const dirCalls = record.filter((r) => r[0] === "getDirectoryHandle");
		const fileCalls = record.filter((r) => r[0] === "getFileHandle");
		expect(dirCalls.length).toBeGreaterThan(0);
		expect(fileCalls.length).toBeGreaterThan(0);

		for (const call of [...dirCalls, ...fileCalls]) {
			expect(call).toHaveLength(2);
			expect(typeof call[1]).toBe("string");
		}

		const writeCalls = record.filter(
			(r) =>
				r[0] === "createWritable" ||
				r[0] === "removeEntry" ||
				r[0] === "move",
		);
		expect(writeCalls).toEqual([]);
	});
});
