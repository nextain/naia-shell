/** Paths are ADK-root-relative and must be portable across supported platforms. */
const userRoots = new Set(["docs", "skills", "knowledge", "conversations", "memory"]);
const denied = /(?:token|secret|credential|api[-_]?key|private[-_]?key)/i;
const blockedPart = /^(?:\.git|\.keys|data-private|node_modules|\.cache|cache|dist|build|tmp|temp|models?|\.naia-sync|\.env(?:\..*)?|secure-keys\.dat)$/i;
const blockedFile = /(?:\.dpapi|\.gguf|\.safetensors|\.onnx|\.exe|\.dll|\.so|\.dylib|\.bat|\.cmd|\.sh|\.ps1)$/i;
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function assertTransferPath(path: string): void {
  if (!path || path.normalize("NFC") !== path || path.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(path)) throw new Error("invalid path");
  const parts = path.split("/");
  if (parts[0] === "conversations" && parts.length > 2 && /^u-/i.test(parts[1] ?? "")) throw new Error("account conversation path forbidden");
  if (parts.some((part) => !part || part === "." || part === ".." || /[ .]$/.test(part) || reserved.test(part) || blockedPart.test(part) || denied.test(part))) throw new Error("forbidden path");
  if (blockedFile.test(parts[parts.length - 1])) throw new Error("forbidden file");
  const allowed = userRoots.has(parts[0]) || (parts[0] === ".agents" && parts[1] === "skills") || (parts[0] === "naia-settings" && (parts[1] === "config.json" || parts[1] === "ui-config.json" || (parts[1] === "memory" && parts[2] === "store.json" && parts.length === 3)));
  if (!allowed || parts.length < 2) throw new Error("path not allowed");
  if (parts[0] === "naia-settings" && parts[1] !== "memory" && parts.length !== 2) throw new Error("path not allowed");
}

export function validateMemoryStore(value: unknown): number {
  if (!value || typeof value !== "object" || !Array.isArray((value as { facts?: unknown }).facts)) throw new Error("invalid memory store");
  const facts = (value as { facts: unknown[] }).facts;
  const ids = new Set<string>();
  for (const fact of facts) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) throw new Error("invalid memory fact");
    const record = fact as Record<string, unknown>;
    const { id, content } = record;
    const stringArrays = ["entities", "topics", "sourceEpisodes"];
    const numbers = ["createdAt", "updatedAt", "importance", "recallCount", "lastAccessed", "strength"];
    if (typeof id !== "string" || !id || typeof content !== "string" || !content || ids.has(id)
      || stringArrays.some((field) => !Array.isArray(record[field]) || !(record[field] as unknown[]).every((item) => typeof item === "string"))
      || numbers.some((field) => typeof record[field] !== "number" || !Number.isFinite(record[field]))) throw new Error("invalid memory fact");
    ids.add(id);
  }
  return facts.length;
}

/** Archive names are account-neutral; only trusted, mapped journal targets include an account. */
export function assertTransferTargetPath(path: string): void {
  assertTransferPath(path.replace(/^conversations\/u-[a-zA-Z0-9_-]{1,128}\//, "conversations/"));
}
export const WEB_TRANSFER_LOCK = "naia-memory-transfer";
/** Serialize exports and conversation read/modify/write with restore + crash recovery. */
export async function withRecoveredWebWorkspace<T>(operation: () => Promise<T>): Promise<T> {
  // Without Web Locks restore is unavailable, so legacy/non-browser adapters cannot race it.
  if (!globalThis.navigator?.locks) return operation();
  return navigator.locks.request(WEB_TRANSFER_LOCK, async () => {
    const { recoverWebTransferUnderLock } = await import("./restore-web");
    await recoverWebTransferUnderLock();
    return operation();
  });
}
