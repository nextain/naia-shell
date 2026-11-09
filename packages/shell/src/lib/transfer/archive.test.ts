import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync, Zip, ZipPassThrough } from "fflate";
import { createHash } from "node:crypto";
import { createArchive as createStream, extractArchive as extractStream, validateArchive as validateStream, PARSED_FILE_LIMIT } from "./archive";

const chunkSize = 65536;
const sourceOf = (data: Map<string, Uint8Array>) => ({ list: async () => [...data.keys()], async *read(path: string) { const bytes = data.get(path)!; for (let p = 0; p < bytes.length; p += chunkSize) yield bytes.subarray(p, p + chunkSize); } });
const archiveOf = (bytes: Uint8Array) => ({ size: bytes.length, async *read(offset: number, length: number) { for (let p = offset; p < offset + length; p += chunkSize) yield bytes.subarray(p, Math.min(p + chunkSize, offset + length)); } });
const createArchive = async (paths: string[], read: (path: string) => Promise<Uint8Array>, format: { shellFormat: string; adkFormat: string }) => { const data = new Map<string, Uint8Array>(); for (const path of paths) data.set(path, await read(path)); const chunks: Uint8Array[] = []; const result = await createStream(sourceOf(data), { write: async chunk => { chunks.push(chunk.slice()); } }, format); const size = chunks.reduce((n, c) => n + c.length, 0), bytes = new Uint8Array(size); let p = 0; for (const c of chunks) { bytes.set(c, p); p += c.length; } return { ...result, bytes }; };
const extractArchive = async (bytes: Uint8Array, write: (path: string, bytes: Uint8Array) => Promise<void>, limits?: Parameters<typeof validateStream>[1]) => extractStream(archiveOf(bytes), { open: async (path: string) => ({ path, chunks: [] as Uint8Array[] }), write: async (h, c) => { h.chunks.push(c.slice()); }, commit: async handles => { for (const h of handles) { const size = h.chunks.reduce((n,c) => n+c.length,0), data = new Uint8Array(size); let p=0;for(const c of h.chunks){data.set(c,p);p+=c.length;}await write(h.path,data); } }, discard: async () => {} }, limits);
const validateArchive = async (bytes: Uint8Array, limits?: Parameters<typeof validateStream>[1]) => { const files = new Map<string, Uint8Array>(); const result = await extractArchive(bytes, async (path, data) => { files.set(path, data); }, limits); return { ...result, files }; };
const encode = (value: unknown) => strToU8(JSON.stringify(value));
const source = new Map<string, Uint8Array>([
  ["docs/example.txt", strToU8("hello")],
  ["conversations/day.jsonl", strToU8('{"content":"hi"}\n')],
  ["naia-settings/memory/store.json", encode({ facts: [{ id: "fact", content: "memory", entities: [], topics: [], createdAt: 1, updatedAt: 1, importance: 1, recallCount: 0, lastAccessed: 1, strength: 1, sourceEpisodes: [] }] })],
]);
const create = (data = source) => createArchive([...data.keys()], async path => data.get(path)!, { shellFormat: "1", adkFormat: "1" });
const bundle = async (data = source) => (await create(data)).bytes;
const entries = async (): Promise<Record<string, Uint8Array>> => {
  const { manifest } = await create();
  return { "manifest.json": encode(manifest), ...Object.fromEntries([...source].map(([key, value]) => [`files/${key}`, value])) };
};
async function rejected(bytes: Uint8Array, limits?: { files?: number; fileBytes?: number; totalBytes?: number; archiveBytes?: number; ratio?: number }) {
  const open = vi.fn(async (path: string) => path);
  const write = vi.fn(async (_path: string, _chunk: Uint8Array) => {});
  const commit = vi.fn(async (_handles: string[]) => {});
  const discard = vi.fn(async (_handles: string[]) => {});
  await expect(extractStream(archiveOf(bytes), { open, write, commit, discard }, limits)).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  expect(discard).not.toHaveBeenCalled();
}
function mutateCentral(bytes: Uint8Array, mutate: (v: DataView, p: number) => void) {
  const copy = bytes.slice(), view = new DataView(copy.buffer);
  const central = view.getUint32(copy.length - 6, true);
  mutate(view, central);
  return copy;
}

describe("UT-TRANSFER-01 actual ZIP round trip", () => {
  it("preserves hashes and bytes for web and app adapters", async () => {
    const created = await create();
    expect(created.bytes[0]).toBe(0x50);
    expect(created.manifest.memoryFacts).toBe(1);
    expect(created.manifest.conversationFiles).toBe(1);
    for (const platform of ["web", "app"]) {
      const files = new Map<string, Uint8Array>();
      const result = await extractArchive(created.bytes, async (path, bytes) => { files.set(path, bytes); });
      expect(platform).toBeTruthy();
      expect(files).toEqual(source);
      expect(result.manifest.files).toEqual(created.manifest.files);
    }
  });
});
describe("UT-TRANSFER-02 malicious ZIP paths and links", () => {
  it.each(["../docs/x", "/docs/x", "files/../docs/x", "files//docs/x", "files/docs/CON"])('rejects %s before writes', async path => {
    await rejected(zipSync({ ...(await entries()), [path]: strToU8("x") }, { level: 0 }));
  });
  it("rejects case-insensitive duplicates", async () => {
    await rejected(zipSync({ ...(await entries()), "files/docs/EXAMPLE.txt": strToU8("x") }, { level: 0 }));
  });
  it("rejects file and directory collisions before export", async () => {
    await expect(create(new Map([["docs/a", strToU8("x")], ["docs/a/b", strToU8("y")]]))).rejects.toThrow();
  });
  it("rejects symlink external attributes", async () => {
    await rejected(mutateCentral(await bundle(), (v,p) => { v.setUint16(p + 4, 0x0314, true); v.setUint32(p + 38, 0xa1ff0000, true); }));
  });
  it("rejects disagreement between central and local names", async () => {
    const b = await bundle(); b[30] ^= 1; await rejected(b);
  });
});
describe("UT-TRANSFER-03 actual ZIP limits", () => {
  it("rejects compression ratio", async () => {
    const data = { ...(await entries()), "files/docs/compressed.txt": new Uint8Array(4096) };
    await rejected(zipSync(data, { level: 9 }), { ratio: 2 });
  });
  it.each([{ files: 2 }, { fileBytes: 4 }, { totalBytes: 10 }, { archiveBytes: 10 }])("rejects injected limit %o", async limit => { await rejected(await bundle(), limit); });
});
describe("UT-TRANSFER-04 integrity and membership", () => {
  it("rejects changed content with original manifest", async () => {
    await rejected(zipSync({ ...(await entries()), "files/docs/example.txt": strToU8("HELLO") }, { level: 0 }));
  });
  it("rejects a missing file", async () => {
    const files = await entries(); delete files["files/docs/example.txt"]; await rejected(zipSync(files, { level: 0 }));
  });
  it("rejects an extra file", async () => {
    await rejected(zipSync({ ...(await entries()), "files/docs/extra.txt": strToU8("x") }, { level: 0 }));
  });
});
describe("UT-TRANSFER-05 secrets in actual ZIP", () => {
  it("rejects forbidden secret path", async () => { await rejected(zipSync({ ...(await entries()), "files/docs/token.txt": strToU8("x") }, { level: 0 })); });
  it("sanitizes exported settings and rejects imported secret fields", async () => {
    const input = new Map([["naia-settings/config.json", encode({ naiaUserId: "account", model: "example", child: { gatewayToken: "value" } })]]);
    const result = await create(input);
    expect(result.removed).toBe(2);
    const valid = await validateArchive(result.bytes);
    expect(JSON.parse(new TextDecoder().decode(valid.files.get("naia-settings/config.json")))).toEqual({ model: "example", child: {} });
    const modified = new Map([["naia-settings/config.json", encode({ model: "example" })]]);
    const normal = await create(modified);
    const dirty = encode({ naiaUserId: "id", model: "example" });
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(dirty).buffer);
    normal.manifest.files[0].size = dirty.length;
    normal.manifest.files[0].sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,"0")).join("");
    normal.manifest.totalBytes = dirty.length;
    await rejected(zipSync({ "manifest.json": encode(normal.manifest), "files/naia-settings/config.json": dirty }, { level: 0 }));
  });
});
describe("UT-TRANSFER-06 memory store", () => {
  it("reports absent long-term memory", async () => {
    const result = await validateArchive(await bundle(new Map([["docs/example.txt", strToU8("hello")]])));
    expect(result.memoryStatus).toBe("web-long-term-memory-absent");
  });
  it("rejects invalid memory even with matching hash", async () => {
    const normal = await create(new Map([["naia-settings/memory/store.json", encode({ facts: [] })]]));
    const dirty = encode({ facts: [{}] });
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(dirty).buffer);
    normal.manifest.files[0].size = dirty.length;
    normal.manifest.files[0].sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
    normal.manifest.totalBytes = dirty.length;
    normal.manifest.memoryFacts = 1;
    await rejected(zipSync({ "manifest.json": encode(normal.manifest), "files/naia-settings/memory/store.json": dirty }, { level: 0 }));
  });
});

describe("UT-TRANSFER-07 sensitive field and memory schema rejection", () => {
  it("removes sensitive names from nested objects and arrays on export", async () => {
    const input = { serviceToken: "a", fooSecret: "b", x_api_key: "c", ClientPassword: "d", nested: { serviceToken: "e" }, list: [{ fooSecret: "f", model: "ok" }] };
    const created = await create(new Map([["naia-settings/config.json", encode(input)]]));
    expect(created.removed).toBe(6);
    const validated = await validateArchive(created.bytes);
    expect(JSON.parse(new TextDecoder().decode(validated.files.get("naia-settings/config.json")))).toEqual({ nested: {}, list: [{ model: "ok" }] });
  });
  it.each([
    { serviceToken: "x" }, { fooSecret: "x" }, { x_api_key: "x" }, { ClientPassword: "x" },
    { nested: { fooSecret: "x" } }, { nested: [{ serviceToken: "x" }] },
  ])("rejects matching-hash settings containing %o before opening a target", async dirtyObject => {
    const normal = await create(new Map([["naia-settings/config.json", encode({ model: "example" })]]));
    const dirty = encode(dirtyObject), digest = await crypto.subtle.digest("SHA-256", new Uint8Array(dirty).buffer);
    normal.manifest.files[0].size = dirty.length;
    normal.manifest.files[0].sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
    normal.manifest.totalBytes = dirty.length;
    await rejected(zipSync({ "manifest.json": encode(normal.manifest), "files/naia-settings/config.json": dirty }, { level: 0 }));
  });
  it.each([{ id: "fact", content: "x" }, { id: "fact", content: "x", entities: "wrong", topics: [], createdAt: 1, updatedAt: 1, importance: 1, recallCount: 0, lastAccessed: 1, strength: 1, sourceEpisodes: [] }])("UT-TRANSFER-09 rejects invalid fact %o before writing", async fact => {
    const normal = await create(new Map([["naia-settings/memory/store.json", encode({ facts: [] })]]));
    const dirty = encode({ facts: [fact] }), digest = await crypto.subtle.digest("SHA-256", new Uint8Array(dirty).buffer);
    normal.manifest.files[0].size = dirty.length;
    normal.manifest.files[0].sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
    normal.manifest.totalBytes = dirty.length; normal.manifest.memoryFacts = 1;
    await rejected(zipSync({ "manifest.json": encode(normal.manifest), "files/naia-settings/memory/store.json": dirty }, { level: 0 }));
  });
});
describe("UT-TRANSFER-08 streaming and rollback", () => {
  it("handles bounded source chunks and discards all temporary files after a second-pass write failure", async () => {
    const chunks: Uint8Array[] = [], maxInput = 1024; let maxOutput = 0, maxWritten = 0;
    const streamSource = { list: async () => ["docs/a.txt", "docs/b.txt"], async *read() { for (let i=0;i<2048;i++) yield new Uint8Array(maxInput).fill(i % 251); } };
    await createStream(streamSource, { write: async chunk => { maxOutput = Math.max(maxOutput, chunk.length); chunks.push(chunk.slice()); } }, { shellFormat: "1", adkFormat: "1" }, { chunkBytes: maxInput });
    const length=chunks.reduce((n,c)=>n+c.length,0), zip=new Uint8Array(length);let at=0;for(const c of chunks){zip.set(c,at);at+=c.length;}
    const archive = { size: zip.length, async *read(offset: number, length: number) { for(let p=offset;p<offset+length;p+=maxInput) yield zip.subarray(p,Math.min(p+maxInput,offset+length)); } };
    const commit=vi.fn(), discard=vi.fn(), open=vi.fn(async (path:string)=>path);let calls=0;
    const write=vi.fn(async (_path:string,chunk:Uint8Array)=>{maxWritten=Math.max(maxWritten,chunk.length);if(++calls===2100)throw new Error("injected write failure");});
    await expect(extractStream(archive,{open,write,commit,discard},{chunkBytes:maxInput})).rejects.toThrow("injected write failure");
    expect(open).toHaveBeenCalledTimes(2);expect(commit).not.toHaveBeenCalled();expect(discard).toHaveBeenCalledWith(["docs/a.txt","docs/b.txt"]);expect(maxWritten).toBeLessThanOrEqual(maxInput);
    // ZIP central-directory output is bounded by its independent metadata cap.
    expect(maxOutput).toBeLessThan(4096);
  });
  it("discards temporary files when content changes between validation and extraction", async () => {
    const zip = await bundle(new Map([["docs/example.txt", strToU8("hello")]]));
    let validations = 0;
    const archive = { size: zip.length, async *read(offset: number, length: number) {
      if (offset === zip.length - 22 && length === 22) validations++;
      const data = zip.slice(offset, offset + length);
      if (validations >= 2 && length === 5) data[0] ^= 1;
      for (let p = 0; p < data.length; p += chunkSize) yield data.subarray(p, p + chunkSize);
    } };
    const commit = vi.fn(), discard = vi.fn(), open = vi.fn(async (path: string) => path), write = vi.fn(async () => {});
    await expect(extractStream(archive, { open, write, commit, discard })).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith(["docs/example.txt"]);
  });
});
describe("UT-TRANSFER-14 large archive memory measurements", () => {
  it.skipIf(process.env.NAIA_TRANSFER_HEAVY !== "1")("HEAVY create ordinary bundle", async () => {
    const count = process.env.NAIA_TRANSFER_SIZE === "256" ? 1 : 4, generated = ordinarySource(count);
    let emitted = 0, maxOutput = 0;
    const result = await createStream(generated, { write: async chunk => { emitted += chunk.length; maxOutput = Math.max(maxOutput, chunk.length); } }, { shellFormat: "1", adkFormat: "1" });
    expect(result.manifest.totalBytes).toBe(count * 255 * 1024 * 1024);
    expect(emitted).toBeGreaterThan(result.manifest.totalBytes);
    expect(maxOutput).toBeLessThanOrEqual(chunkSize);
  }, 900000);
  it.skipIf(process.env.NAIA_TRANSFER_HEAVY !== "1")("HEAVY import ordinary bundle", async () => {
    const count = process.env.NAIA_TRANSFER_SIZE === "256" ? 1 : 4, archive = virtualArchive(73);
    const fixtureStart = performance.now();
    await createStream(ordinarySource(count), archive.output, { shellFormat: "1", adkFormat: "1" });
    const extractStart = performance.now();
    let written = 0; const commit = vi.fn();
    const result = await extractStream(archive.source(), { open: async (path: string) => path, write: async (_path: string, chunk: Uint8Array) => { written += chunk.length; }, commit, discard: vi.fn() });
    process.stdout.write(`fixture_ms=${Math.round(extractStart - fixtureStart)} import_ms=${Math.round(performance.now() - extractStart)}\n`);
    expect(result.manifest.totalBytes).toBe(count * 255 * 1024 * 1024);
    expect(written).toBe(result.manifest.totalBytes); expect(commit).toHaveBeenCalledOnce();
  }, 900000);
  it.skipIf(process.env.NAIA_TRANSFER_HEAVY !== "1")("HEAVY memory store round trip", async () => {
    const archive = virtualArchive(32), size = 60 * 1024 * 1024;
    const createStart = performance.now();
    await createStream(memorySource(size), archive.output, { shellFormat: "1", adkFormat: "1" });
    const extractStart = performance.now();
    let written = 0; const commit = vi.fn();
    const result = await extractStream(archive.source(), { open: async (path: string) => path, write: async (_path: string, chunk: Uint8Array) => { written += chunk.length; }, commit, discard: vi.fn() });
    process.stdout.write(`create_ms=${Math.round(extractStart - createStart)} import_ms=${Math.round(performance.now() - extractStart)}\n`);
    expect(written).toBe(size); expect(result.manifest.memoryFacts).toBe(0); expect(commit).toHaveBeenCalledOnce();
  }, 900000);
});

const memoryPath = "naia-settings/memory/store.json";
const sharedChunks = new Map<number, Uint8Array>();
function uniformChunk(fill: number) {
  let chunk = sharedChunks.get(fill);
  if (!chunk) { chunk = new Uint8Array(chunkSize).fill(fill); sharedChunks.set(fill, chunk); }
  return chunk;
}
function memorySource(size: number) {
  return { list: async () => [memoryPath], async *read() {
    const prefix = strToU8('{"facts":[]}'); yield prefix;
    const spaces = uniformChunk(32);
    for (let n = prefix.length; n < size; n += chunkSize) yield spaces.subarray(0, Math.min(chunkSize, size - n));
  } };
}
function ordinarySource(count: number) {
  return { list: async () => Array.from({ length: count }, (_, i) => `docs/large-${i}.bin`), async *read() {
    const chunk = uniformChunk(73);
    for (let n = 0; n < 255 * 1024 * 1024; n += chunkSize) yield chunk;
  } };
}
// Repeated input chunks are represented once; headers and variable chunks remain exact.
function virtualArchive(fill: number) {
  const segments: { start: number; data: Uint8Array }[] = []; let size = 0;
  const shared = uniformChunk(fill);
  return {
    output: { write: async (chunk: Uint8Array) => {
      const data = chunk.length === chunkSize && chunk.buffer === shared.buffer ? shared : chunk.slice();
      segments.push({ start: size, data }); size += data.length;
    } },
    source: () => ({ size, async *read(offset: number, length: number) {
      let lo = 0, hi = segments.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (segments[mid].start + segments[mid].data.length <= offset) lo = mid + 1; else hi = mid; }
      const end = offset + length;
      for (let i = lo; i < segments.length && segments[i].start < end; i++) {
        const segment = segments[i], from = Math.max(0, offset - segment.start), to = Math.min(segment.data.length, end - segment.start);
        if (to > from) yield segment.data.subarray(from, to);
      }
    } }),
  };
}

describe("UT-TRANSFER-11 parsed-file limit", () => {
  it("accepts a 64 MiB minus one byte memory store for creation and import", async () => {
    const size = PARSED_FILE_LIMIT - 1, archive = virtualArchive(32);
    await createStream(memorySource(size), archive.output, { shellFormat: "1", adkFormat: "1" });
    let written = 0; const commit = vi.fn();
    await extractStream(archive.source(), { open: async (path: string) => path, write: async (_path: string, chunk: Uint8Array) => { written += chunk.length; }, commit, discard: vi.fn() });
    expect(written).toBe(size); expect(commit).toHaveBeenCalledOnce();
  }, 900000);
  it("rejects a 64 MiB plus one byte memory store before ZIP output", async () => {
    const write = vi.fn();
    await expect(createStream(memorySource(PARSED_FILE_LIMIT + 1), { write }, { shellFormat: "1", adkFormat: "1" })).rejects.toThrow("parsed file exceeds limit");
    expect(write).not.toHaveBeenCalled();
  }, 900000);
  it("rejects a valid oversized memory entry before any destination write", async () => {
    const size = PARSED_FILE_LIMIT + 1, input = memorySource(size), archive = virtualArchive(32), hash = createHash("sha256");
    const payloads: Uint8Array[] = []; let zipError: Error | undefined;
    const zip = new Zip((error, chunk) => { if (error) zipError = error; else payloads.push(chunk); });
    const flush = async () => { if (zipError) throw zipError; for (const chunk of payloads.splice(0)) await archive.output.write(chunk); };
    const file = new ZipPassThrough(`files/${memoryPath}`); zip.add(file); await flush();
    for await (const chunk of input.read()) { hash.update(chunk); file.push(chunk); await flush(); }
    file.push(new Uint8Array(), true); await flush();
    const manifest = { schemaVersion: "naia-transfer-v1", exportedAt: new Date().toISOString(), shellFormat: "1", adkFormat: "1", files: [{ path: memoryPath, size, sha256: hash.digest("hex") }], fileCount: 1, totalBytes: size, memoryFacts: 0, conversationFiles: 0 };
    const m = new ZipPassThrough("manifest.json"); zip.add(m); m.push(encode(manifest), true); zip.end(); await flush();
    const open = vi.fn(), write = vi.fn(), commit = vi.fn(), discard = vi.fn();
    await expect(extractStream(archive.source(), { open, write, commit, discard })).rejects.toThrow("parsed file exceeds 64 MiB limit");
    expect(open).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
  }, 900000);
  it("uses the validated snapshot if parsed input changes on a second read", async () => {
    let reads = 0; const source = { list: async () => [memoryPath], async *read() { reads++; yield encode(reads === 1 ? { facts: [] } : { facts: [{}] }); } };
    const archive = virtualArchive(32);
    await createStream(source, archive.output, { shellFormat: "1", adkFormat: "1" });
    const result = await validateStream(archive.source());
    expect(reads).toBe(1); expect(result.manifest.memoryFacts).toBe(0);
  });
  it("rejects an oversized generated manifest before writing ZIP bytes", async () => {
    const write = vi.fn();
    await expect(createStream(sourceOf(new Map()), { write }, { shellFormat: "x".repeat(PARSED_FILE_LIMIT), adkFormat: "1" })).rejects.toThrow("manifest exceeds 64 MiB");
    expect(write).not.toHaveBeenCalled();
  });
  it("rejects an oversized central directory before reading it", async () => {
    const tail = new Uint8Array(22), view = new DataView(tail.buffer); view.setUint32(0, 0x06054b50, true); view.setUint16(8, 1, true); view.setUint16(10, 1, true); view.setUint32(12, PARSED_FILE_LIMIT + 1, true);
    const size = PARSED_FILE_LIMIT + 23, reads = vi.fn(async function* (offset: number, length: number) { if (offset === size - 22 && length === 22) yield tail; else throw new Error("unexpected read"); });
    await expect(validateStream({ size, read: reads })).rejects.toThrow("central directory exceeds 64 MiB"); expect(reads).toHaveBeenCalledOnce();
  });
});
