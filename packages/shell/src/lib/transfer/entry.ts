/** Load transfer functionality only when the migration flow is requested. */
export function loadTransfer() {
	return import("./archive");
}

type Transfer = Awaited<ReturnType<typeof loadTransfer>>;
type DirectoryEntries = FileSystemDirectoryHandle & {
	entries(): AsyncIterable<[string, FileSystemHandle]>;
};
const activeTransfers = new Set<string>();

/** Export the current browser workspace without retaining the ZIP in JS memory. */
export async function downloadWebTransfer(transfer: Transfer, conversationsDir: string) {
	const { assertTransferPath } = await import("./policy");
	const root = await navigator.storage.getDirectory();
	const missing = (error: unknown) => error instanceof DOMException && error.name === "NotFoundError";
	for await (const [name, handle] of (root as DirectoryEntries).entries()) {
		if (handle.kind === "file" && name.startsWith("naia-transfer-") && !activeTransfers.has(name)) {
			try { await root.removeEntry(name); }
			catch (error) { if (!missing(error)) throw error; }
		}
	}
	const workspace = await root.getDirectoryHandle("naia-adk");
	const files = new Map<string, FileSystemFileHandle>();
	async function directory(path: string): Promise<FileSystemDirectoryHandle | null> {
		let dir = workspace;
		try {
			for (const part of path.split("/")) dir = await dir.getDirectoryHandle(part);
			return dir;
		} catch (error) {
			if (missing(error)) return null;
			throw error;
		}
	}
	async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
		for await (const [name, handle] of (dir as DirectoryEntries).entries()) {
			const path = `${prefix}/${name}`;
			if (prefix === "conversations" && handle.kind === "directory" && name.startsWith("u-")) continue;
			try {
				assertTransferPath(handle.kind === "directory" ? `${path}/placeholder.txt` : path);
			} catch {
				continue;
			}
			if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, path);
			else files.set(path, handle as FileSystemFileHandle);
		}
	}
	for (const path of ["docs", "skills", "knowledge", "memory", ".agents/skills"]) {
		const dir = await directory(path);
		if (dir) await walk(dir, path);
	}
	// Strip the account-specific directory from exported conversation paths.
	const conversations = await directory(conversationsDir.replace(/^naia-adk\//, ""));
	if (conversations) await walk(conversations, "conversations");
	for (const path of ["naia-settings/config.json", "naia-settings/ui-config.json", "naia-settings/memory/store.json"]) {
		const parts = path.split("/");
		const name = parts.pop()!;
		const dir = await directory(parts.join("/"));
		if (!dir) continue;
		try { files.set(path, await dir.getFileHandle(name)); }
		catch (error) { if (!missing(error)) throw error; }
	}
	const tempName = `naia-transfer-${crypto.randomUUID()}.zip`;
	activeTransfers.add(tempName);
	let writable: FileSystemWritableFileStream | undefined;
	let url: string | undefined;
	let handedOff = false;
	try {
		const temp = await root.getFileHandle(tempName, { create: true });
		writable = await temp.createWritable();
		await transfer.createArchive({
			list: async () => [...files.keys()],
			async *read(path: string) {
				const handle = files.get(path);
				if (!handle) throw new Error("workspace file missing");
				const file = await handle.getFile();
				for (let offset = 0; offset < file.size; offset += 64 * 1024) {
					yield new Uint8Array(await file.slice(offset, offset + 64 * 1024).arrayBuffer());
				}
			},
		}, { write: async (chunk: Uint8Array) => { await writable!.write(chunk as FileSystemWriteChunkType); } },
		{ shellFormat: "0.2.5", adkFormat: "1" });
		await writable.close();
		writable = undefined;
		url = URL.createObjectURL(await temp.getFile());
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "naia-transfer-v1.zip";
		anchor.click();
		handedOff = true;
		const downloadUrl = url;
		setTimeout(() => {
			URL.revokeObjectURL(downloadUrl);
			void root.removeEntry(tempName).catch(() => {});
		}, 60_000);
	} finally {
		activeTransfers.delete(tempName);
		if (!handedOff) {
			if (url) URL.revokeObjectURL(url);
			if (writable) await writable.abort().catch(() => {});
			await root.removeEntry(tempName).catch(() => {});
		}
	}
}
