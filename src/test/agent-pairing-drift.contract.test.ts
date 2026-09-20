// 페어링 핀이 **세 곳**에 따로 적혀 있다 —
//   packages/shell/agent-pairing.json         (프런트·테스트가 읽는 곳)
//   packages/shell/src-tauri/build.rs         (Rust 빌드가 강제하는 곳)
//   .github/workflows/build-installers.yml    (CI 가 실제로 체크아웃하는 곳)
//
// 왜 이 테스트가 있는가: 2026-08-28 실측에서 한쪽만 올리고 다른 쪽을 두었더니 빌드가
// "옛 커밋을 내놓으라"고 거절했다. 그때는 빌드가 잡아 줬지만, 반대 방향(빌드 상수만 올리고
// json 을 두는 경우)에는 빌드가 통과하면서 프런트의 짝 판정만 어긋난다. 같은 사실이
// 두 곳에 적힌 이상, 갈라지는 것을 여기서 막는다.
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

function constant(name: string): string {
  const m = buildRs.match(new RegExp(`const ${name}: &str =\\s*\\n?\\s*"([0-9a-f]{40,64})"`));
  expect(m, `build.rs 에서 ${name} 을 찾지 못했다 — 상수 형태가 바뀌었으면 이 테스트도 고쳐야 한다`).not.toBeNull();
  return (m as RegExpMatchArray)[1] as string;
}

describe("페어링 핀이 두 곳에서 갈라지지 않는다", () => {
  it("에이전트 커밋이 같다", () => {
    expect(constant("REQUIRED_AGENT_COMMIT")).toBe(pairing.agentCommit);
  });

  it("proto 해시가 같다", () => {
    expect(constant("REQUIRED_PROTO_SHA256")).toBe(pairing.protoSha256);
  });

  it("CI 워크플로가 체크아웃하는 커밋도 같다", () => {
    // 여기가 갈라지면 빌드도 테스트도 통과하는데 **배포된 것만** 다른 짝으로 나간다.
    // 세 곳 중 이 자리가 가장 조용히 어긋난다.
    const wf = readFileSync(resolve(ROOT, ".github", "workflows", "build-installers.yml"), "utf8");
    expect(wf, "CI 가 핀과 다른 커밋을 받아 간다").toContain(pairing.agentCommit);
    expect(wf, "CI 가 핀과 다른 memory 커밋을 받아 간다").toContain(
      `git -C ../naia-memory fetch --depth 1 origin ${pairing.memoryCommit}`,
    );
    expect(wf, "옛 커밋 문자열이 남아 있다").not.toMatch(/2589e4fc85e13173890e5c9109a744ee4e575854/);
  });

  it("핀이 실제 커밋 해시 형태다 — 빈 값이나 자리표시자가 아니다", () => {
    expect(pairing.agentCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(pairing.protoSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pairing.memoryCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(pairing.memoryVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });

  it("self-trust CI also checks out the paired agent", () => {
    const workflow = readFileSync(resolve(ROOT, ".github", "workflows", "self-trust-gates.yml"), "utf8");
    expect(workflow).toContain(`git -C ../naia-agent fetch --depth 1 origin ${pairing.agentCommit}`);
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
