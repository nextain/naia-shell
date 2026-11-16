import { assertTransferPath } from "./policy";

export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

export interface TransferFile { path: string; size: number; sha256: string }
export interface TransferManifest {
  schemaVersion: "naia-transfer-v1";
  exportedAt: string;
  shellFormat: string;
  adkFormat: string;
  files: TransferFile[];
  fileCount: number;
  totalBytes: number;
  memoryFacts: number | null;
  conversationFiles: number;
}

const count = (n: unknown, max: number): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;

export function validateManifest(value: unknown): TransferManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid manifest");
  const m = value as Record<string, unknown>;
  if (m.schemaVersion !== "naia-transfer-v1" || typeof m.exportedAt !== "string" || !Number.isFinite(Date.parse(m.exportedAt)) || typeof m.shellFormat !== "string" || !m.shellFormat || typeof m.adkFormat !== "string" || !m.adkFormat || !Array.isArray(m.files) || m.files.length > MAX_FILES || !count(m.fileCount, MAX_FILES) || m.fileCount !== m.files.length || !count(m.totalBytes, MAX_TOTAL_BYTES) || !(m.memoryFacts === null || count(m.memoryFacts, MAX_TOTAL_BYTES)) || !count(m.conversationFiles, MAX_FILES)) throw new Error("invalid manifest fields");
  const names = new Set<string>();
  let total = 0;
  let conversations = 0;
  let hasMemory = false;
  for (const item of m.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid manifest file");
    const f = item as Record<string, unknown>;
    if (typeof f.path !== "string" || !count(f.size, MAX_FILE_BYTES) || typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error("invalid manifest file fields");
    assertTransferPath(f.path);
    const key = f.path.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error("duplicate manifest path");
    names.add(key);
    total += f.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("manifest too large");
    if (f.path.startsWith("conversations/") && f.path.endsWith(".jsonl")) conversations++;
    if (f.path === "naia-settings/memory/store.json") hasMemory = true;
  }
  for (const name of names) {
    for (let at = name.indexOf("/"); at !== -1; at = name.indexOf("/", at + 1)) {
      if (names.has(name.slice(0, at))) throw new Error("file and directory collision");
    }
  }
  if (total !== m.totalBytes || conversations !== m.conversationFiles || hasMemory !== (m.memoryFacts !== null)) throw new Error("manifest totals mismatch");
  return m as unknown as TransferManifest;
}
