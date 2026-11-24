// The manifest is the source for native code generation and CI checkouts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const pairing = JSON.parse(
  readFileSync(resolve(ROOT, "packages", "shell", "agent-pairing.json"), "utf8"),
) as {
  agentCommit: string;
  protoSha256: string;
  memoryCommit: string;
  memoryVersion: string;
};
const buildRs = readFileSync(resolve(ROOT, "packages", "shell", "src-tauri", "build.rs"), "utf8");

describe("페어링 핀이 두 곳에서 갈라지지 않는다", () => {
  it("Rust reads both pins from the manifest", () => {
    expect(buildRs).toContain('join("../agent-pairing.json")');
    expect(buildRs).toContain('manifest["agentCommit"]');
    expect(buildRs).toContain('manifest["protoSha256"]');
    expect(buildRs).toContain('agent_commit != required_agent_commit');
    expect(buildRs).toContain('proto_sha256 != required_proto_sha256');
  });

  it("CI reads agent and memory pins from the manifest", () => {
    const wf = readFileSync(resolve(ROOT, ".github", "workflows", "build-installers.yml"), "utf8");
    expect(wf).toContain('require("./packages/shell/agent-pairing.json").agentCommit');
    expect(wf).toContain('require("./packages/shell/agent-pairing.json").memoryCommit');
  });

  it("핀이 실제 커밋 해시 형태다 — 빈 값이나 자리표시자가 아니다", () => {
    expect(pairing.agentCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(pairing.protoSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pairing.memoryCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(pairing.memoryVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });

  it("self-trust CI also checks out the paired agent", () => {
    const workflow = readFileSync(resolve(ROOT, ".github", "workflows", "self-trust-gates.yml"), "utf8");
    expect(workflow).toContain('require("./packages/shell/agent-pairing.json").agentCommit');
  });

  it("memory 핀이 staging의 commit·clean·package gate에 연결된다", () => {
    const stage = readFileSync(
      resolve(ROOT, "packages", "shell", "scripts", "stage-agent.mjs"),
      "utf8",
    );
    expect(stage).toContain("REQUIRED_MEMORY_COMMIT");
    expect(stage).toContain("REQUIRED_MEMORY_VERSION");
    expect(stage).toContain("validateMemoryCheckout");
    expect(stage).toContain('assertPairedMemoryCheckout("after install/build")');
  });
});
