// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { downloadWebTransfer, loadTransfer } from "./entry";

type FileNode = { kind: "file"; getFile: () => Promise<{ size: number; slice: (start: number, end: number) => { arrayBuffer: () => Promise<ArrayBuffer> } }> };
interface DirNode {
	kind: "directory";
	getDirectoryHandle(name: string): Promise<DirNode>;
	getFileHandle(name: string): Promise<FileNode>;
	entries(): AsyncIterable<[string, FileNode | DirNode]>;
}
type Node = FileNode | DirNode;
function file(size: number): FileNode {
	return { kind: "file" as const, getFile: async () => ({
		size,
		slice: (start: number, end: number) => ({ arrayBuffer: async () => new ArrayBuffer(Math.min(end, size) - start) }),
	}) };
}
function dir(children: Record<string, Node>): DirNode {
	return {
		kind: "directory",
		async getDirectoryHandle(name) {
			const child = children[name];
			if (!child || child.kind !== "directory") throw new DOMException("missing", "NotFoundError");
			return child;
		},
		async getFileHandle(name) {
			const child = children[name];
			if (!child || child.kind !== "file") throw new DOMException("missing", "NotFoundError");
			return child;
		},
		async *entries() { for (const entry of Object.entries(children)) yield entry; },
	};
}

describe("UT-TRANSFER-10 browser export adapter", () => {
	afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
	it("UT-TRANSFER-13 exports bounded reads and cleans up after 60 seconds", async () => {
		vi.useFakeTimers();
		const workspace = dir({
			docs: dir({ "large.txt": file(150_000), "service-secret.txt": file(8) }),
			conversations: dir({ "u-current": dir({ "chat.jsonl": file(8) }), "u-other": dir({ "private.jsonl": file(8) }) }),
			"naia-settings": dir({ "config.json": file(4) }),
		});
		const write = vi.fn().mockResolvedValue(undefined), close = vi.fn().mockResolvedValue(undefined);
		const removeEntry = vi.fn().mockResolvedValue(undefined);
		const root = {
			getDirectoryHandle: async () => workspace,
			getFileHandle: async () => ({ createWritable: async () => ({ write, close }), getFile: async () => new Blob(["zip"]) }),
			async *entries() {},
			removeEntry,
		};
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
		const BrowserURL = URL;
		class TestURL extends BrowserURL {
			static createObjectURL = vi.fn().mockReturnValue("blob:transfer");
			static revokeObjectURL = vi.fn();
		}
		vi.stubGlobal("URL", TestURL);
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const seen: string[] = [], chunks: number[] = [];
		const transfer = { createArchive: async (source: { list: () => Promise<string[]>; read: (path: string) => AsyncIterable<Uint8Array> }, output: { write: (chunk: Uint8Array) => Promise<void> }) => {
			seen.push(...await source.list());
			for (const path of seen) for await (const chunk of source.read(path)) chunks.push(chunk.length);
			await output.write(new Uint8Array([1, 2]));
		} };
		await downloadWebTransfer(transfer as never, "naia-adk/conversations/u-current");
		expect(seen.sort()).toEqual(["conversations/chat.jsonl", "docs/large.txt", "naia-settings/config.json"]);
		expect(Math.max(...chunks)).toBeLessThanOrEqual(64 * 1024);
		expect(chunks.filter(n => n > 1000)).toEqual([65536, 65536, 18928]);
		expect(write).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(click).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(59_999);
		expect(removeEntry).not.toHaveBeenCalled();
		expect(TestURL.revokeObjectURL).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(removeEntry).toHaveBeenCalledOnce();
		expect(removeEntry).toHaveBeenCalledWith(expect.stringMatching(/^naia-transfer-.*\.zip$/));
		expect(TestURL.revokeObjectURL).toHaveBeenCalledWith("blob:transfer");
	});
	it("produces a ZIP from browser workspace files with settings sanitized", async () => {
		vi.useFakeTimers();
		const data = new TextEncoder().encode(JSON.stringify({ theme: "dark", serviceToken: "should-not-export" }));
		const config = { kind: "file" as const, getFile: async () => ({
			size: data.length,
			slice: (start: number, end: number) => ({ arrayBuffer: async () => data.slice(start, end).buffer }),
		}) };
		const workspace = dir({ "naia-settings": dir({ "config.json": config }) });
		const chunks: Uint8Array[] = [];
		const root = {
			getDirectoryHandle: async () => workspace,
			async *entries() {},
			getFileHandle: async () => ({
				createWritable: async () => ({ write: async (chunk: Uint8Array) => { chunks.push(chunk.slice()); }, close: async () => {} }),
				getFile: async () => new Blob(["zip"]),
			}),
			removeEntry: vi.fn(),
		};
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
		const BrowserURL = URL;
		class TestURL extends BrowserURL { static createObjectURL = vi.fn().mockReturnValue("blob:transfer"); }
		vi.stubGlobal("URL", TestURL);
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		await downloadWebTransfer(await loadTransfer(), "naia-adk/conversations");
		const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
		const zip = unzipSync(bytes);
		expect(JSON.parse(strFromU8(zip["files/naia-settings/config.json"]))).toEqual({ theme: "dark" });
		expect(JSON.parse(strFromU8(zip["manifest.json"])).fileCount).toBe(1);
	});

	it("discards the temporary ZIP when archive creation fails", async () => {
		const abort = vi.fn().mockResolvedValue(undefined);
		const removeEntry = vi.fn().mockResolvedValue(undefined);
		const workspace = dir({});
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({
			getDirectoryHandle: async () => workspace,
			async *entries() {},
			getFileHandle: async () => ({ createWritable: async () => ({ abort }) }),
			removeEntry,
		}) } });
		const createArchive = vi.fn().mockRejectedValue(new Error("failure"));
		await expect(downloadWebTransfer({ createArchive } as never, "naia-adk/conversations")).rejects.toThrow("failure");
		expect(abort).toHaveBeenCalledOnce();
		expect(removeEntry).toHaveBeenCalledOnce();
	});

	it("UT-TRANSFER-13 removes stale transfer files before starting a new export", async () => {
		const removeEntry = vi.fn().mockResolvedValue(undefined);
		const createArchive = vi.fn().mockRejectedValue(new Error("stop"));
		const workspace = dir({});
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({
			async *entries() {
				yield ["naia-transfer-old.zip", { kind: "file" }];
				yield ["other.zip", { kind: "file" }];
				yield ["naia-transfer-folder", { kind: "directory" }];
			},
			getDirectoryHandle: async () => workspace,
			getFileHandle: async () => ({ createWritable: async () => ({ abort: vi.fn().mockResolvedValue(undefined) }) }),
			removeEntry,
		}) } });
		await expect(downloadWebTransfer({ createArchive } as never, "conversations")).rejects.toThrow("stop");
		expect(removeEntry).toHaveBeenNthCalledWith(1, "naia-transfer-old.zip");
		expect(removeEntry).toHaveBeenCalledTimes(2);
	});

	it("UT-TRANSFER-13 revokes the URL and removes the ZIP immediately if download fails", async () => {
		const removeEntry = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({
			async *entries() {},
			getDirectoryHandle: async () => dir({}),
			getFileHandle: async () => ({ createWritable: async () => ({ close: vi.fn().mockResolvedValue(undefined) }), getFile: async () => new Blob(["zip"]) }),
			removeEntry,
		}) } });
		const BrowserURL = URL;
		class TestURL extends BrowserURL {
			static createObjectURL = vi.fn().mockReturnValue("blob:transfer");
			static revokeObjectURL = vi.fn();
		}
		vi.stubGlobal("URL", TestURL);
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw new Error("click failed"); });
		await expect(downloadWebTransfer({ createArchive: vi.fn() } as never, "conversations")).rejects.toThrow("click failed");
		expect(TestURL.revokeObjectURL).toHaveBeenCalledWith("blob:transfer");
		expect(removeEntry).toHaveBeenCalledOnce();
	});

});
