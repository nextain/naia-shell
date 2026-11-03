import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UC-B2C-026-R7 release metadata", () => {
  it("keeps installer, registered app and workspace version at 0.2.6", () => {
    for (const path of ["package.json", "packages/shell/package.json", "packages/shell/src-tauri/tauri.conf.json"]) {
      expect(JSON.parse(readFileSync(path, "utf8")).version, path).toBe("0.2.6");
    }
    expect(readFileSync("packages/shell/src-tauri/Cargo.toml", "utf8")).toMatch(/name = "naia-shell"\nversion = "0\.2\.6"/);
    expect(readFileSync("packages/shell/src-tauri/Cargo.lock", "utf8")).toMatch(/name = "naia-shell"\nversion = "0\.2\.6"/);
  });
});
