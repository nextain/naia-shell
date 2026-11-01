// #498 시나리오 출처 계약 테스트 (P02) — NFR-AGENT-BENCH.1·2.
// 하네스가 판정할 목록이 실제 UC 문서에서 나오는가, 계열이 빠지면 잡히는가.
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { DocumentBenchScenarioSource, INSTALLED_APP_DIALOGUE_CASES, judgeInstalledAppDialogue, allHeadings, declaredFamilies, familyOf, ownedByEpic, parseScenarios } from "./harness/agent-bench-scenarios.js";
import { readFileSync } from "node:fs";

const DOC = resolve(__dirname, "..", "..", "docs", "user-scenarios.md");

describe("문서 파싱 (NFR-AGENT-BENCH.2) [UC-AGENT-BENCH-RUN]", () => {
  it("에픽 UC 제목만 시나리오가 된다", () => {
    const md = ["### UC-WORKSPACE-CONTEXT-DISCOVER — 설명", "### UC-V022-THINKING-SEPARATION", "### 그냥 제목"].join("\n");
    expect(parseScenarios(md).map((s) => s.id)).toEqual(["UC-WORKSPACE-CONTEXT-DISCOVER"]);
  });

  it("같은 UC 가 두 번 나와도 시나리오는 하나다", () => {
    const md = "### UC-ENV-TOOL-BROWSE\n### UC-ENV-TOOL-BROWSE\n";
    expect(parseScenarios(md)).toHaveLength(1);
  });

  it("계열마다 요구 증거가 다르다 — 결정론으로 다 덮이지 않는다", () => {
    expect(familyOf("UC-HERDR-CONTROL-MUTATE")?.requiredEvidence).toEqual(["native"]);
    expect(familyOf("UC-ENV-TOOL-BROWSE")?.requiredEvidence).toEqual(["browser", "native"]);
    expect(familyOf("UC-ORCHESTRATION-ISSUE-LEAD")?.requiredEvidence).toEqual(["worker", "native"]);
  });

  it("에픽 밖 UC 는 계열이 없다", () => {
    expect(familyOf("UC-V022-THINKING-SEPARATION")).toBeUndefined();
  });
});

describe("실제 문서와의 결속 (NFR-AGENT-BENCH.1)", () => {
  it("여섯 계열이 모두 문서에 시나리오를 갖는다 — 하나라도 비면 실패한다", async () => {
    const scenarios = await new DocumentBenchScenarioSource(DOC).list();
    for (const prefix of declaredFamilies()) {
      expect(scenarios.filter((s) => s.id.startsWith(prefix)).length, `${prefix} 계열 시나리오 없음`).toBeGreaterThan(0);
    }
  });

  it("현재 문서의 에픽 UC 를 전부 집어 온다", async () => {
    // 개수를 손으로 박아 두면 UC 를 더할 때마다 숫자만 올리게 되고, 정작 "빠진 게 있나"는
    // 아무도 안 본다. 문서에서 센 것과 같은지로 판정한다.
    const markdown = readFileSync(resolve(__dirname, "..", "..", "docs", "user-scenarios.md"), "utf8");
    const owned = allHeadings(markdown).filter((uc) => ownedByEpic(uc));
    const scenarios = await new DocumentBenchScenarioSource(DOC).list();
    expect(scenarios.length).toBe(owned.length);
    expect(scenarios.length).toBeGreaterThan(10); // 공허하게 통과하지 않게
    expect(scenarios.filter((s) => s.id.startsWith("UC-WORKSPACE-CONTEXT-"))).toHaveLength(4);
    expect(scenarios.filter((s) => s.id.startsWith("UC-AGENT-BENCH-"))).toHaveLength(3);
  });

  it("실제 환경을 건드리는 계열은 결정론만으로 통과할 수 없다", async () => {
    // 원래 단언은 "결정론 계열은 하나뿐"이었다. 손잡이 고정·어휘 동기처럼 실제 환경이
    // 필요 없는 계열이 생기면서 그 형태로는 못 쓴다. 지켜야 하는 성질은 개수가 아니라
    // *무엇이* 결정론으로 통과할 수 있느냐다.
    // 결정론으로 통과해도 되는 것은 "실제 환경이 있어야만 성립하는 성질이 아닌 것"이다.
    // 분류(CLASSIFY)는 순수한 판단이라 작업자를 띄워야 확인되는 성질이 아니다 —
    // worker 를 요구하면 등급과 확인 내용이 인과적으로 어긋난다(2026-08-27 6차 적대리뷰).
    const DETERMINISTIC_OK = [
      "UC-AGENT-BENCH-",
      "UC-ENV-STICKY",
      "UC-WIRE-UNION-",
    ];
    const scenarios = await new DocumentBenchScenarioSource(DOC).list();
    const mockOnly = scenarios.filter((s) => s.requiredEvidence.every((e) => e === "mock"));
    expect(mockOnly.length).toBeGreaterThan(0);
    expect(
      mockOnly.filter((s) => !DETERMINISTIC_OK.some((p) => s.id.startsWith(p))).map((s) => s.id),
      "실제 환경을 거쳐야 하는 시나리오가 mock 만으로 통과할 수 있게 됐다",
    ).toEqual([]);
    // 환경을 건드리는 계열은 반드시 native 증거를 요구한다.
    for (const s of scenarios.filter((x) => x.id.startsWith("UC-ENV-") && !x.id.startsWith("UC-ENV-STICKY"))) {
      expect(s.requiredEvidence, `${s.id} 가 실제 환경 증거를 요구하지 않는다`).toContain("native");
    }
  });

  it("같은 문서를 두 번 읽으면 같은 목록이 나온다", async () => {
    const source = new DocumentBenchScenarioSource(DOC);
    expect(await source.list()).toEqual(await source.list());
  });
});

describe("에픽의 UC 가 하네스에서 조용히 사라지지 않는다", () => {
  // 계열에 없는 UC 는 parseScenarios 가 그냥 버린다. 그 방향을 아무도 안 보고 있어서
  // #502 의 UC 11개가 벤치에 들어가지 못한 채로 있었다(2026-08-26). 여기서 막는다.
  const markdown = readFileSync(
    resolve(__dirname, "..", "..", "docs", "user-scenarios.md"),
    "utf8",
  );

  it("문서에서 표제를 실제로 읽었다 — 빈 목록으로 공허하게 통과하지 않는다", () => {
    expect(allHeadings(markdown).length).toBeGreaterThan(10);
  });

  it("에픽이 소유한 UC 는 모두 계열에 속한다", () => {
    const orphans = allHeadings(markdown)
      .filter((uc) => ownedByEpic(uc))
      .filter((uc) => familyOf(uc) === undefined);
    expect(
      orphans,
      "계열이 없어 벤치가 버리는 UC. 계열을 더하거나, 에픽 밖이면 NOT_OWNED_BY_EPIC 에 적어라",
    ).toEqual([]);
  });

  it("에픽이 소유한 UC 가 전부 시나리오가 된다", () => {
    const owned = allHeadings(markdown).filter((uc) => ownedByEpic(uc));
    const parsed = new Set(parseScenarios(markdown).map((s) => s.uc));
    expect(owned.filter((uc) => !parsed.has(uc))).toEqual([]);
  });

  it("에픽 밖 UC 는 시나리오에 섞이지 않는다", () => {
    const parsed = parseScenarios(markdown).map((s) => s.uc);
    expect(parsed.filter((uc) => !ownedByEpic(uc))).toEqual([]);
  });
});

describe("계열 배정은 순서가 아니라 구체성으로 정해진다", () => {
  // 배열 순서로 먼저 걸린 것을 쓰면, 다른 계열의 접두사를 확장한 시나리오가 조용히
  // 엉뚱한 요구를 상속한다. 그러면 이미 확보한 증거로 새 시나리오가 통과해 버린다
  // (2026-08-27 11차 적대리뷰 반영 중 실측).
  it("더 긴 접두사가 이긴다", () => {
    const broad = familyOf("UC-ENV-ATTENTION");
    const specific = familyOf("UC-ENV-ATTENTION-POLICY");
    expect(broad?.prefix).toBe("UC-ENV-ATTENTION");
    expect(specific?.prefix).toBe("UC-ENV-ATTENTION-POLICY");
    expect(specific?.requiredEvidence, "구체적 선언이 넓은 것의 요구를 물려받았다").not.toEqual(
      broad?.requiredEvidence,
    );
  });

  it("확장 접두사가 없는 시나리오는 그대로 자기 계열에 붙는다", () => {
    expect(familyOf("UC-ENV-STICKY")?.prefix).toBe("UC-ENV-STICKY");
  });
});


describe("설치 앱 대화 정의", () => {
  it("답변 UC 세 개를 실제 모델 증거로 요구한다", () => {
    expect(INSTALLED_APP_DIALOGUE_CASES.map((c) => c.uc)).toEqual(["UC-025-09", "UC-025-11", "UC-025-12"]);
    for (const c of INSTALLED_APP_DIALOGUE_CASES) {
      expect(ownedByEpic(c.uc)).toBe(true);
      expect(familyOf(c.uc)?.requiredEvidence).toEqual(["native"]);
      expect(c.context.length).toBeGreaterThan(20);
      expect(c.criterion.length).toBeGreaterThan(10);
      expect(judgeInstalledAppDialogue(c.expected, c.expected)).toBe(true);
    }
  });
  it("카드 순서·미공개 카드·역할·질문 오답을 거절한다", () => {
    expect(judgeInstalledAppDialogue(INSTALLED_APP_DIALOGUE_CASES[0].expected, "달, 별, 태양")).toBe(false);
    expect(judgeInstalledAppDialogue(INSTALLED_APP_DIALOGUE_CASES[0].expected, "별, 달, 태양, 탑")).toBe(false);
    expect(judgeInstalledAppDialogue(INSTALLED_APP_DIALOGUE_CASES[1].expected, "저는 태양이에요. 안녕하세요.")).toBe(false);
    expect(judgeInstalledAppDialogue(INSTALLED_APP_DIALOGUE_CASES[1].expected, "나는 루나다. 안녕.")).toBe(false);
    expect(judgeInstalledAppDialogue(INSTALLED_APP_DIALOGUE_CASES[2].expected, "41")).toBe(false);
  });
  it("화면 UC는 개별 제외하고 새 UC는 자동 제외하지 않는다", () => {
    for (const id of ["01", "02", "03", "04", "05", "06", "07", "10"]) expect(ownedByEpic(`UC-025-${id}`)).toBe(false);
    expect(ownedByEpic("UC-025-13")).toBe(true);
    expect(ownedByEpic("UC-025-01-NEW")).toBe(true);
  });
});
