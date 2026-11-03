import { Logger } from "../logger";
import { resolveWebConversationsDir } from "../web-runtime/web-workspace-commands";
import { extractArchive, validateArchive, Sha256, type ArchiveSource } from "./archive";
import { assertTransferPath } from "./policy";
import { MAX_FILES } from "./manifest";

export function fileArchive(file: File): ArchiveSource {
    return { size: file.size, async *read(offset, length) {
        for (let pos = offset; pos < offset + length; pos += 65536)
            yield new Uint8Array(await file.slice(pos, Math.min(pos + 65536, offset + length)).arrayBuffer());
    } };
}
export const inspectWebTransfer = (file: File) => validateArchive(fileArchive(file));
const journalName = "naia-restore-journal";
const lockName = "naia-memory-transfer";
type RecordEntry = { path: string; size: number | null; sha256: string | null };
type Journal = { version: 1; files: RecordEntry[] };
const missing = (e: unknown) => e instanceof DOMException && e.name === "NotFoundError";
async function write(handle: FileSystemFileHandle, data: FileSystemWriteChunkType) {
    const stream = await handle.createWritable();
    try { await stream.write(data); await stream.close(); }
    catch (error) { await stream.abort().catch(() => {}); throw error; }
}
async function hash(file: File) {
    const sha = new Sha256();
    for await (const bytes of fileArchive(file).read(0, file.size)) sha.update(bytes);
    return sha.digest();
}
async function parentFor(workspace: FileSystemDirectoryHandle, path: string) {
    assertTransferPath(path);
    const parts = path.split("/"); const name = parts.pop()!;
    let parent = workspace;
    for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: true });
    return { parent, name };
}
async function optionalFile(dir: FileSystemDirectoryHandle, name: string) {
    try { return await (await dir.getFileHandle(name)).getFile(); }
    catch (error) { if (missing(error)) return null; throw error; }
}
/** Validate all recovery metadata and originals before the first rollback write. */
async function rollback(root: FileSystemDirectoryHandle, temp: FileSystemDirectoryHandle, journal: Journal) {
    if (journal.version !== 1 || !Array.isArray(journal.files) || journal.files.length > MAX_FILES) throw new Error("invalid restore journal");
    const originals: (File | null)[] = [], names = new Set<string>();
    for (const [index, item] of journal.files.entries()) {
        if (!item || typeof item.path !== "string") throw new Error("invalid restore journal path");
        assertTransferPath(item.path);
        const key = item.path.toLowerCase();
        if (names.has(key)) throw new Error("duplicate restore journal path"); names.add(key);
        if (item.size === null && item.sha256 === null) { originals.push(null); continue; }
        if (!Number.isSafeInteger(item.size) || item.size! < 0 || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("invalid restore journal original");
        const original = await (await temp.getFileHandle(`backup-${index}`)).getFile();
        if (original.size !== item.size || await hash(original) !== item.sha256) throw new Error("restore original damaged");
        originals.push(original);
    }
    for (const name of names) {
        for (let pos = name.indexOf("/"); pos !== -1; pos = name.indexOf("/", pos + 1)) {
            if (names.has(name.slice(0, pos))) throw new Error("restore journal path collision");
        }
    }
    const workspace = await root.getDirectoryHandle("naia-adk");
    for (const [index, item] of journal.files.entries()) {
        const { parent, name } = await parentFor(workspace, item.path);
        if (originals[index]) await write(await parent.getFileHandle(name, { create: true }), originals[index]!);
        else await parent.removeEntry(name).catch(error => { if (!missing(error)) throw error; });
    }
}
async function recover(root: FileSystemDirectoryHandle) {
    let temp: FileSystemDirectoryHandle;
    try { temp = await root.getDirectoryHandle(journalName); }
    catch (error) { if (missing(error)) return; throw error; }
    Logger.debug("WebMemoryTransfer", "recover journal");
    const journal = await optionalFile(temp, "journal.json");
    const marker = await optionalFile(temp, "committed");
    const committed = marker && marker.size > 0 ? marker : null;
    if (committed && await committed.text() !== "v1") throw new Error("invalid restore commit marker");
    if (journal && journal.size > 0 && !committed) {
        if (journal.size > 16 * 1024 * 1024) throw new Error("restore journal too large");
        await rollback(root, temp, JSON.parse(await journal.text()) as Journal);
    } else if (committed && !journal) throw new Error("restore journal missing");
    // No journal means interruption while staging: workspace was never touched.
    await root.removeEntry(journalName, { recursive: true });
}
export async function recoverWebTransfer() {
    return navigator.locks.request(lockName, async () => recover(await navigator.storage.getDirectory()));
}
/** Single-restore transaction. OPFS close is the durable boundary, not power-loss fsync. */
export async function restoreWebTransfer(file: File) {
    return navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("transfer busy");
        Logger.debug("WebMemoryTransfer", "restore start", { bytes: file.size });
        const root = await navigator.storage.getDirectory();
        await recover(root);
        const validated = await inspectWebTransfer(file);
        const workspace = await root.getDirectoryHandle("naia-adk");
        const records: RecordEntry[] = [];
        let originalBytes = 0, largest = 0;
        for (const item of validated.manifest.files) {
            const target = item.path.startsWith("conversations/") ? `${resolveWebConversationsDir().replace(/^naia-adk\//, "")}/${item.path.slice(14)}` : item.path;
            const { parent, name } = await parentFor(workspace, target);
            const original = await optionalFile(parent, name);
            originalBytes += original?.size ?? 0;
            largest = Math.max(largest, item.size, original?.size ?? 0);
            records.push({ path: target, size: original?.size ?? null, sha256: original ? await hash(original) : null });
        }
        const estimate = await navigator.storage.estimate();
        // Staging + originals + atomic replacement scratch + metadata/headroom.
        const needed = validated.manifest.totalBytes + originalBytes + largest + 4 * 1024 * 1024;
        if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < needed) throw new DOMException("Not enough space for a safe restore", "QuotaExceededError");
        const temp = await root.getDirectoryHandle(journalName, { create: true });
        type Item = { stream: FileSystemWritableFileStream; staged: FileSystemFileHandle };
        let next = 0, committed = false;
        try {
            await extractArchive(fileArchive(file), {
                async open() {
                    const staged = await temp.getFileHandle(`stage-${next++}`, { create: true });
                    return { staged, stream: await staged.createWritable() } as Item;
                },
                async write(item, chunk) { await item.stream.write(chunk as FileSystemWriteChunkType); },
                async commit(items) {
                    for (const item of items) await item.stream.close();
                    for (const [index, record] of records.entries()) {
                        const { parent, name } = await parentFor(workspace, record.path);
                        const original = await optionalFile(parent, name);
                        if ((original?.size ?? null) !== record.size || (original && await hash(original) !== record.sha256)) throw new Error("workspace changed during restore");
                        if (original) await write(await temp.getFileHandle(`backup-${index}`, { create: true }), original);
                    }
                    const journal = JSON.stringify({ version: 1, files: records });
                    if (new TextEncoder().encode(journal).length > 16 * 1024 * 1024) throw new Error("restore journal too large");
                    await write(await temp.getFileHandle("journal.json", { create: true }), journal);
                    for (const [index, item] of items.entries()) {
                        const { parent, name } = await parentFor(workspace, records[index].path);
                        await write(await parent.getFileHandle(name, { create: true }), await item.staged.getFile());
                    }
                    await write(await temp.getFileHandle("committed", { create: true }), "v1");
                    committed = true;
                },
                async discard(items) {
                    for (const item of items) await item.stream.abort().catch(() => {});
                    Logger.debug("WebMemoryTransfer", "restore interrupted", { committed });
                },
            });
        } catch (error) {
            // A failed rollback preserves all snapshots and journal for next startup.
            await recover(root);
            throw error;
        }
        await recover(root);
        Logger.debug("WebMemoryTransfer", "restore complete", { files: records.length });
    });
}
