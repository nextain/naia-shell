import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest";

const manifest = () => ({ schemaVersion: "naia-transfer-v1", exportedAt: "2026-01-01T00:00:00.000Z", shellFormat: "0.2.5", adkFormat: "1", files: [{ path: "docs/example.md", size: 3, sha256: "a".repeat(64) }], fileCount: 1, totalBytes: 3, memoryFacts: null, conversationFiles: 0 });

describe("UT-TRANSFER-03 manifest limits", () => {
  it("rejects excessive file count, file size and total size", () => {
    expect(() => validateManifest({ ...manifest(), fileCount: 20001 })).toThrow();
    const large = manifest(); large.files[0].size = 256 * 1024 * 1024 + 1; large.totalBytes = large.files[0].size;
    expect(() => validateManifest(large)).toThrow();
    expect(() => validateManifest({ ...manifest(), totalBytes: 1024 * 1024 * 1024 + 1 })).toThrow();
  });
});
describe("UT-TRANSFER-04 manifest integrity", () => {
  it("rejects duplicate paths and inconsistent totals", () => {
    const m = manifest(); m.files.push(m.files[0]); m.fileCount = 2; m.totalBytes = 6;
    expect(() => validateManifest(m)).toThrow();
    expect(() => validateManifest({ ...manifest(), totalBytes: 4 })).toThrow();
  });
  it("accepts a valid manifest", () => expect(validateManifest(manifest()).fileCount).toBe(1));
});
