// Whole-bundle expanded size budget (every file in the ZIP), not the speech-asset limit.
// Speech assets alone are capped at 160 MiB by generation-contract.js; the bundle budget is 256 MiB (alpha-adk decision log D25).
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

function safePath(path) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.startsWith("/")
      || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

// Inspect JSZip central-directory sizes before inflating entries. JSZip does
// not expose uncompressedSize as public API, so an absent value fails closed.
export function assertZipBudget(zip, { maxBytes = DEFAULT_MAX_BYTES, maxFiles = 512 } = {}) {
  if (!zip?.files || typeof zip.files !== "object") throw new TypeError("loaded ZIP is required");
  let files = 0;
  let bytes = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    files++;
    if (files > maxFiles || !safePath(path)) throw new Error("NVA ZIP file table is invalid");
    const size = entry?._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("NVA ZIP size metadata is unavailable");
    bytes += size;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes)
      throw new Error("expanded NVA bundle exceeds the 256 MiB limit");
    if (path === "manifest.json" && size > 1024 * 1024)
      throw new Error("NVA manifest exceeds the 1 MiB limit");
  }
  return { files, bytes };
}
