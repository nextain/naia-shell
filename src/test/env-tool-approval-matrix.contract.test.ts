// #499 승인 행렬 계약 테스트 (P02) — FR-ENV-TOOL.8.
// 일반 편집 권한이 외부 발신·게시·구매·파괴적 명령·운영 변경을 상속하지 않는가.
import { describe, it, expect } from "vitest";
import { admitEnvOperation } from "../main/domain/env-tool.js";
import { ALL_TIERS, permits, requiresApproval, requiresHumanDecision, type CapabilityTier } from "../main/domain/capability.js";
import {
  BROWSER_RPCS_REQUIRING_APPROVAL,
  BROWSER_RPC_TIERS,
  EnvironmentToolService,
  TERMINAL_EXEC_TIER_FLOOR,
  flooredTierFor,
  requiredTierFor,
  type BrowserRpc,
} from "../main/app/control/env-tool.js";
import { envRequest, fakeBrowser, fakeCancellation, fakeTerminal, fakeWorkspaces } from "./helpers/env-tool-fixture.js";

const ORDINARY: CapabilityTier[] = ["observe", "workspace-write"];

describe("등급 분리 (FR-ENV-TOOL.8) [UC-ENV-TOOL-BOUNDARY-DENY]", () => {
  it("여덟 등급이 각각 따로 있다", () => {
    expect([...ALL_TIERS].sort()).toEqual([
      "credential",
      "destructive",
      "external-message",
      "observe",
      "production",
      "publication",
      "purchase",
      "workspace-write",
    ]);
  });

  it.each(["credential", "external-message", "publication", "purchase", "destructive", "production"] as const)(
    "일반 편집 권한은 %s 를 상속하지 않는다",
    (tier) => {
      expect(permits(ORDINARY, tier)).toBe(false);
      const r = admitEnvOperation(envRequest({ capability: tier }), { grantedTiers: ORDINARY });
      expect(r.map((x) => x.code)).toContain("capability-denied");
    },
  );

  it("게시와 구매와 외부 발신은 서로도 상속하지 않는다", () => {
    expect(permits(["external-message"], "publication")).toBe(false);
    expect(permits(["publication"], "purchase")).toBe(false);
    expect(permits(["purchase"], "external-message")).toBe(false);
  });
});

describe("승인 요구 (FR-ENV-TOOL.8)", () => {
  it("관측과 워크스페이스 편집만 건별 승인 없이 된다", () => {
    for (const tier of ALL_TIERS) {
      expect(requiresApproval(tier)).toBe(!ORDINARY.includes(tier));
    }
  });

  it("등급을 부여해도 승인 참조가 없으면 거절한다", () => {
    const r = admitEnvOperation(envRequest({ capability: "publication" }), { grantedTiers: ["publication"] });
    expect(r.map((x) => x.code)).toEqual(["approval-missing"]);
  });

  it("등급과 승인이 모두 있으면 통과한다", () => {
    const r = admitEnvOperation(envRequest({ capability: "publication", approvalRef: "a-1" }), { grantedTiers: ["publication"] });
    expect(r).toEqual([]);
  });

  it("등급 미부여와 승인 부재는 각각 남는다", () => {
    const r = admitEnvOperation(envRequest({ capability: "purchase" }), { grantedTiers: ORDINARY });
    expect(r.map((x) => x.code).sort()).toEqual(["approval-missing", "capability-denied"]);
  });
});

describe("사람 결정으로 올릴 것 (FR-ENV-TOOL.8)", () => {
  it("삭제와 운영 변경은 위임 대상이 아니다", () => {
    expect(requiresHumanDecision("destructive")).toBe(true);
    expect(requiresHumanDecision("production")).toBe(true);
  });

  it("나머지는 위임할 수 있다", () => {
    for (const tier of ALL_TIERS.filter((t) => t !== "destructive" && t !== "production")) {
      expect(requiresHumanDecision(tier)).toBe(false);
    }
  });
});

// ── #582 S0c: 등급 고정 RPC 표 (FR-ENV-TOOL.14) ───────────────────────────────
// 계약: docs/progress/issue-582-ego-browser-host.md 4.4. 호출자 선언은 판정에 쓰지 않는다.

const OBSERVE_ONLY: CapabilityTier[] = ["observe"];
const REF = { kind: "reference", ref: "b" } as const;

function service(granted: CapabilityTier[]) {
  const browser = fakeBrowser();
  const workspaces = fakeWorkspaces();
  return {
    svc: new EnvironmentToolService(browser, fakeTerminal(), fakeCancellation(), granted, workspaces),
    browser,
    workspaces,
  };
}

describe("등급 고정 RPC 표 (FR-ENV-TOOL.14) [UC-ENV-TOOL-SCRIPT]", () => {
  it("표가 부를 수 있는 RPC 열두 개를 남김없이 정한다", () => {
    expect(Object.keys(BROWSER_RPC_TIERS).sort()).toEqual([
      "click",
      "close",
      "closeWorkspace",
      "createWorkspace",
      "evaluate",
      "fill",
      "listWorkspaces",
      "navigate",
      "open",
      "screenshot",
      "script",
      "snapshot",
    ]);
  });

  it("묶음 실행은 터미널 실행과 같은 등급이고 승인이 따로 필요하다 (계약 3절 4번)", () => {
    // 등급을 `credential` 이상으로 올려 적으면 heredoc 하나 때문에 자격증명 등급이 부여돼야
    // 하므로 그 길은 쓰지 않는다. 등급은 터미널 바닥과 같게 두고 승인만 따로 요구한다.
    expect(requiredTierFor("script")).toBe(TERMINAL_EXEC_TIER_FLOOR);
    expect(requiresApproval(requiredTierFor("script")), "등급만으로는 승인이 안 붙는다").toBe(false);
    expect(BROWSER_RPCS_REQUIRING_APPROVAL.has("script"), "승인 목록에 없다").toBe(true);
    // 반증: 나머지 RPC 는 승인 목록에 없다 — 목록이 전부를 삼키면 승인이 뜻을 잃는다.
    for (const rpc of Object.keys(BROWSER_RPC_TIERS) as BrowserRpc[]) {
      if (rpc !== "script") expect(BROWSER_RPCS_REQUIRING_APPROVAL.has(rpc)).toBe(false);
    }
  });

  it.each(["snapshot", "screenshot", "listWorkspaces"] as const)("%s 는 관측 등급이다", (rpc) => {
    expect(requiredTierFor(rpc)).toBe("observe");
  });

  it.each(["open", "navigate", "click", "fill", "evaluate", "close", "createWorkspace", "closeWorkspace"] as const)(
    "%s 는 워크스페이스 내부 변경 등급이다",
    (rpc) => {
      expect(requiredTierFor(rpc)).toBe("workspace-write");
    },
  );

  it("어떤 RPC 도 자격증명·외부 발신·게시·구매·파괴적·운영 등급을 쓰지 않는다 — 그 길은 승인받은 묶음 실행 몫이다", () => {
    const tiers = Object.values(BROWSER_RPC_TIERS);
    for (const tier of tiers) expect(["observe", "workspace-write"]).toContain(tier);
    expect(new Set(tiers).size).toBe(2);
  });

  it("표의 모든 RPC 등급이 실제 등급 집합 안에 있다", () => {
    for (const rpc of Object.keys(BROWSER_RPC_TIERS) as BrowserRpc[]) {
      expect(ALL_TIERS).toContain(requiredTierFor(rpc));
    }
  });
});

describe("호출자 선언은 판정에 쓰지 않는다 (FR-ENV-TOOL.14) [UC-ENV-TOOL-SCRIPT]", () => {
  it("관측 권한만 있는데 관측으로 선언한 클릭은 통과하지 못한다 — 낮게 적어 통과하는 길이 없다", async () => {
    const { svc, browser } = service(OBSERVE_ONLY);
    const outcome = await svc.click(envRequest({ capability: "observe" }), REF);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((r) => r.code)).toContain("capability-denied");
    expect(browser.calls, "거절인데 포트에 닿았다").toEqual([]);
  });

  it("게시 등급과 승인을 붙여도 클릭은 여전히 워크스페이스 변경으로 판정된다 — 남의 승인을 끌어 쓰지 못한다", async () => {
    const { svc } = service(["observe", "publication"]);
    const outcome = await svc.click(envRequest({ capability: "publication", approvalRef: "a-1" }), REF);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((r) => r.code)).toEqual(["capability-denied"]);
  });

  it("구매로 선언해도 클릭에는 건별 승인이 붙지 않는다 — 선언을 아예 보지 않는다", async () => {
    const { svc } = service(["observe", "workspace-write"]);
    const outcome = await svc.click(envRequest({ capability: "purchase" }), REF);
    expect(outcome.ok).toBe(true);
    expect(svc.snapshotOf("op1")?.tier, "판정에 쓴 등급이 선언대로 남았다").toBe("workspace-write");
  });

  it("관측 RPC 는 관측 권한만으로 돈다", async () => {
    const { svc, browser } = service(OBSERVE_ONLY);
    const outcome = await svc.snapshot(envRequest({ capability: "purchase" }));
    expect(outcome.ok).toBe(true);
    expect(browser.calls).toEqual(["snapshot"]);
    expect(svc.snapshotOf("op1")?.tier).toBe("observe");
  });

  it("캡처도 관측이다 — 파일 경로는 호출자가 아니라 감독자가 정한다", async () => {
    const { svc, browser } = service(OBSERVE_ONLY);
    const outcome = await svc.screenshot(envRequest());
    expect(outcome.ok).toBe(true);
    expect(browser.calls).toEqual(["screenshot"]);
  });

  it("평가는 워크스페이스 변경이고 결과 문자열이 함께 온다", async () => {
    const { svc } = service(OBSERVE_ONLY);
    const denied = await svc.evaluate(envRequest(), { expression: "document.title" });
    expect(denied.ok, "관측 권한만으로 평가가 통과했다").toBe(false);

    const { svc: allowed } = service(["observe", "workspace-write"]);
    const outcome = await allowed.evaluate(envRequest(), { expression: "document.title" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.operation.result).toBe("평가됨:document.title");
  });
});

describe("작업 공간 RPC (FR-ENV-TOOL.10·14) [UC-ENV-TOOL-SPACE]", () => {
  it("공간 생성은 관측 권한으로 되지 않는다", async () => {
    const { svc, workspaces } = service(OBSERVE_ONLY);
    const outcome = await svc.createWorkspace(envRequest());
    expect(outcome.ok).toBe(false);
    expect(workspaces.calls).toEqual([]);
  });

  it("공간을 만들면 헤드리스·에이전트 소유로 돌아오고 목록에 남는다", async () => {
    const { svc } = service(["observe", "workspace-write"]);
    const created = await svc.createWorkspace(envRequest());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.mode).toBe("headless");
    expect(created.value.ownership).toBe("agent");

    const listed = await svc.listWorkspaces(envRequest({ operationId: "op2", idempotencyKey: "k2" }));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((w) => w.id)).toEqual([created.value.id]);
  });

  it("공간 닫기는 목록에서 사라지게 하고 관측 권한으로는 되지 않는다", async () => {
    const { svc } = service(["observe", "workspace-write"]);
    const created = await svc.createWorkspace(envRequest());
    if (!created.ok) return;
    const closed = await svc.closeWorkspace(envRequest({ operationId: "op2", idempotencyKey: "k2" }), created.value.id);
    expect(closed.ok).toBe(true);
    const listed = await svc.listWorkspaces(envRequest({ operationId: "op3", idempotencyKey: "k3" }));
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("작업 공간 포트가 배선되지 않은 조립은 형식 있는 오류로 끝난다 — 조용히 성공하지 않는다", async () => {
    const svc = new EnvironmentToolService(fakeBrowser(), fakeTerminal(), fakeCancellation(), ["observe", "workspace-write"]);
    const outcome = await svc.createWorkspace(envRequest());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((r) => r.code)).toEqual(["method-denied"]);
  });
});

// ── #582 S0d: 터미널 실행 등급 바닥 (FR-ENV-TOOL.14) ──────────────────────────
// 계약: .agents/progress/issue-582/s0-review-fable.md 1번. 낮추는 길은 막고 올리는 길은 둔다.

const EXEC_COMMAND = { executable: "pnpm", args: ["test", "--run"], cwd: "packages/shell", env: { CI: "1" } };

function terminalService(granted: CapabilityTier[]) {
  const terminal = fakeTerminal();
  return { svc: new EnvironmentToolService(fakeBrowser(), terminal, fakeCancellation(), granted), terminal };
}

describe("터미널 실행 등급 바닥 (FR-ENV-TOOL.14) [UC-ENV-TOOL-SCRIPT]", () => {
  it("바닥은 워크스페이스 내부 변경이다", () => {
    expect(TERMINAL_EXEC_TIER_FLOOR).toBe("workspace-write");
    expect(ALL_TIERS).toContain(TERMINAL_EXEC_TIER_FLOOR);
  });

  it("관측만 부여된 조립에서 관측으로 선언한 exec 는 거부된다 — 낮게 적어 통과하는 길이 없다", async () => {
    const { svc, terminal } = terminalService(OBSERVE_ONLY);
    const outcome = await svc.exec(envRequest({ capability: "observe" }), "t1", EXEC_COMMAND);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections.map((r) => r.code)).toContain("capability-denied");
    expect(terminal.execs, "거절인데 터미널 포트에 닿았다").toEqual([]);
  });

  it("관측 선언이라도 워크스페이스 권한이 있으면 바닥 등급으로 판정해 통과하고 장부에 바닥이 남는다", async () => {
    const { svc, terminal } = terminalService(["observe", "workspace-write"]);
    const outcome = await svc.exec(envRequest({ capability: "observe" }), "t1", EXEC_COMMAND);
    expect(outcome.ok).toBe(true);
    expect(terminal.execs).toHaveLength(1);
    expect(svc.snapshotOf("op1")?.tier).toBe("workspace-write");
  });

  it("파괴적 선언은 그대로 파괴적으로 판정된다 — 올리는 길은 열려 있다", async () => {
    const { svc, terminal } = terminalService(["observe", "workspace-write"]);
    const denied = await svc.exec(envRequest({ capability: "destructive", approvalRef: "a-1" }), "t1", EXEC_COMMAND);
    expect(denied.ok, "파괴적 등급이 워크스페이스 권한으로 통과했다").toBe(false);
    expect(terminal.execs).toEqual([]);

    const { svc: allowed } = terminalService(["observe", "workspace-write", "destructive"]);
    const outcome = await allowed.exec(envRequest({ capability: "destructive", approvalRef: "a-1" }), "t1", EXEC_COMMAND);
    expect(outcome.ok).toBe(true);
    expect(allowed.snapshotOf("op1")?.tier).toBe("destructive");
  });

  it("바닥 계산은 ALL_TIERS 순서를 따르고 모르는 선언은 바닥으로 되돌린다", () => {
    expect(flooredTierFor("observe", "workspace-write")).toBe("workspace-write");
    expect(flooredTierFor("workspace-write", "workspace-write")).toBe("workspace-write");
    for (const higher of ["credential", "external-message", "publication", "purchase", "destructive", "production"] as const) {
      expect(flooredTierFor(higher, "workspace-write")).toBe(higher);
    }
    expect(flooredTierFor("made-up" as CapabilityTier, "workspace-write")).toBe("workspace-write");
  });
});
