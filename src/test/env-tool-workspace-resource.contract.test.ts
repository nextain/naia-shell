// #582 S0a 브라우저 작업 공간 자원 계약 테스트 (P02) — FR-ENV-TOOL.6·10.
// 계약: docs/progress/issue-582-ego-browser-host.md 4.4·4.5.
// 자원이 작업과 다른 수명을 갖는가, 헤드리스 전이 표대로 거부하는가, 증거에 캡처가 있는가.
import { describe, it, expect } from "vitest";
import {
  EGO_HANDOFF_UNSUPPORTED_HEADLESS,
  ENV_FAILURE_REASONS,
  applyWorkspaceHelper,
  createHeadlessWorkspace,
  hasEvidence,
  isEnvFailureReason,
  isReachableOwnership,
  revisionMatches,
  type BrowserPage,
  type BrowserWorkspace,
  type WorkspaceHelper,
  type WorkspaceOwnership,
} from "../main/domain/env-tool.js";

const WORKSPACE: BrowserWorkspace = createHeadlessWorkspace("ws-1");

describe("작업 공간 자원 (FR-ENV-TOOL.10) [UC-ENV-TOOL-SPACE]", () => {
  it("새 공간은 헤드리스이고 에이전트 소유이며 개정 0 에서 시작한다", () => {
    expect(WORKSPACE).toEqual({ id: "ws-1", mode: "headless", ownership: "agent", revision: 0 });
  });

  it("페이지는 자기 공간과 주소·개정을 함께 들고 다닌다", () => {
    const page: BrowserPage = { id: "p-1", workspaceId: WORKSPACE.id, url: "https://example.test/a", urlRevision: 3 };
    expect(page.workspaceId).toBe("ws-1");
    expect(page.urlRevision).toBe(3);
  });

  it("헤드리스에서 도달하는 소유 상태는 agent 뿐이다", () => {
    const all: WorkspaceOwnership[] = ["agent", "agentDelegatedToUser", "user"];
    expect(all.filter(isReachableOwnership)).toEqual(["agent"]);
  });
});

describe("헤드리스 소유권 전이 표 (#582 4.4) [UC-ENV-TOOL-SPACE]", () => {
  it.each(["useOrCreateTaskSpace", "switchTaskSpace"] as const)("%s 는 공간을 고른다", (helper) => {
    const out = applyWorkspaceHelper(WORKSPACE, helper);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.effect).toBe("select");
    expect(out.workspace.revision).toBe(0);
  });

  it.each(["claimTaskSpace", "handOffTaskSpace", "takeOverTaskSpace", "waitForAgentControl"] as const)(
    "%s 는 형식 있는 오류로 거부한다 — 인계하는 흉내를 내지 않는다",
    (helper) => {
      const out = applyWorkspaceHelper(WORKSPACE, helper);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.errorCode).toBe(EGO_HANDOFF_UNSUPPORTED_HEADLESS);
      expect(out.detail).toContain(helper);
    },
  );

  it("keep 은 공간을 유지하고 close 는 닫으며 개정을 올린다", () => {
    const keep = applyWorkspaceHelper(WORKSPACE, "completeTaskSpaceKeep");
    const close = applyWorkspaceHelper(WORKSPACE, "completeTaskSpaceClose");
    expect(keep.ok && keep.effect).toBe("keep");
    expect(close.ok && close.effect).toBe("close");
    if (!close.ok) return;
    expect(close.workspace.revision).toBe(1);
  });

  it.each(["agentDelegatedToUser", "user"] as const)("%s 소유 공간은 어느 헬퍼로도 성공하지 않는다 — 도달 불가 상태다", (ownership) => {
    const unreachable: BrowserWorkspace = { ...WORKSPACE, ownership };
    const helpers: WorkspaceHelper[] = [
      "useOrCreateTaskSpace",
      "switchTaskSpace",
      "claimTaskSpace",
      "handOffTaskSpace",
      "takeOverTaskSpace",
      "waitForAgentControl",
      "completeTaskSpaceKeep",
      "completeTaskSpaceClose",
    ];
    for (const helper of helpers) {
      const out = applyWorkspaceHelper(unreachable, helper);
      expect(out.ok, `${helper} 가 도달 불가 상태에서 성공했다`).toBe(false);
      if (out.ok) continue;
      expect(out.errorCode).toBe(EGO_HANDOFF_UNSUPPORTED_HEADLESS);
    }
  });

  it("전이는 원본 공간을 바꾸지 않는다 — 자원은 값으로만 오간다", () => {
    applyWorkspaceHelper(WORKSPACE, "completeTaskSpaceClose");
    expect(WORKSPACE.revision).toBe(0);
  });
});

describe("개정 확인 (#582 stale ref) [UC-ENV-TOOL-SPACE]", () => {
  it("기대를 적지 않은 요청은 검사 대상이 아니다", () => {
    expect(revisionMatches(undefined, 7)).toBe(true);
  });

  it("기대와 실제가 다르면 작용하지 않는다", () => {
    expect(revisionMatches(2, 3)).toBe(false);
    expect(revisionMatches(3, 3)).toBe(true);
  });
});

describe("형식 있는 실패 사유 (#582 4.4)", () => {
  it("취소·타임아웃·단절·정책 거부가 각각 다른 이름을 갖는다", () => {
    expect([...ENV_FAILURE_REASONS].sort()).toEqual([
      "approval-missing",
      "cancelled",
      "capability-denied",
      "context-mismatch",
      "disconnected",
      "method-denied",
      "partial",
      "process-exit",
      "timeout",
      "timeout-unbounded",
      "workspace-escape",
    ]);
  });

  it("기존 수용 판정 사유가 전부 그대로 남아 있다", () => {
    for (const code of ["capability-denied", "approval-missing", "workspace-escape", "timeout-unbounded"]) {
      expect(isEnvFailureReason(code)).toBe(true);
    }
  });

  it("모르는 문자열은 사유가 아니다 — 문자열을 사유로 승격하지 않는다", () => {
    expect(isEnvFailureReason("아무거나")).toBe(false);
    expect(isEnvFailureReason("Error: boom")).toBe(false);
  });
});

describe("증거에는 캡처가 있어야 한다 (FR-ENV-TOOL.6, #582 4.5)", () => {
  it("캡처 참조가 빈 브라우저 완료는 증거로 인정하지 않는다", () => {
    expect(
      hasEvidence("completed", {
        kind: "browser",
        value: { snapshotRef: "snap:1", screenshotRef: "", url: "https://example.test/a", urlRevision: 1 },
      }),
    ).toBe(false);
  });

  it("스냅샷·캡처·주소가 모두 있어야 완료다", () => {
    expect(
      hasEvidence("completed", {
        kind: "browser",
        value: { snapshotRef: "snap:1", screenshotRef: "shot:1", url: "https://example.test/a", urlRevision: 1 },
      }),
    ).toBe(true);
  });

  it("완료가 아닌 상태에는 증거를 요구하지 않는다 — 진행 중인 일을 실패로 만들지 않는다", () => {
    for (const state of ["accepted", "running", "failed", "cancelled"] as const) {
      expect(hasEvidence(state, undefined)).toBe(true);
    }
  });
});
