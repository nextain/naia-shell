// T-WIRE-17 — Shell worktree가 base checkout이 아니라 명시한 #89 agent proto를
// compile하도록 build.rs의 fail-closed 경로를 잠근다.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BUILD_RS = readFileSync("packages/shell/src-tauri/build.rs", "utf8");

describe("UC-WIRE-V1 paired proto build", () => {
  it("NAIA_AGENT_PROTO_DIR 명시 경로를 우선한다", () => {
    expect(BUILD_RS).toContain('env::var("NAIA_AGENT_PROTO_DIR")');
    expect(BUILD_RS).toContain("naia_agent.proto");
  });

  it("proto 부재를 warning으로 통과시키지 않는다", () => {
    expect(BUILD_RS).not.toContain("cargo:warning=naia_agent.proto 없음");
    expect(BUILD_RS).toMatch(/panic!|expect\(/);
  });

  it("paired build 결과에 agent commit과 proto SHA-256을 남긴다", () => {
    expect(BUILD_RS).toContain("NAIA_AGENT_PAIRED_COMMIT");
    expect(BUILD_RS).toContain("NAIA_AGENT_PROTO_SHA256");
    expect(BUILD_RS).toContain("NAIA_AGENT_PAIRED_DIRTY");
    expect(BUILD_RS).toContain("Sha256");
  });
});
