// #498 실행부 계약 테스트 — 실제로 돌려 증거를 모으는 부분이 정직한가.
//
// 여기서 지키려는 것은 하나다: 벤치가 자기에게 유리하게 보고하지 않는다.
// 실패한 명령은 증거가 되지 않고, 확인 수단이 없으면 없다고 말하고,
// 등급을 실제보다 높여 적지 않는다.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALLOWED_EXECUTABLES,
  CommandBenchExecution,
  VERIFICATION,
  parseTestCount,
  readClaim,
  MISSING_SPECS,
  e2eBinaryIsCurrent,
  plausibleResource,
  readFreshAttestation,
  writeAttestation,
  type CommandRunnerPort,
  type VerificationStep,
} from "./harness/bench-execution.js";
import { DEFERRED_SCENARIOS, parseScenarios, ownedByEpic, allHeadings } from "./harness/agent-bench-scenarios.js";
import { judge } from "../main/domain/agent-bench.js";
import type { BenchScenario } from "../main/domain/agent-bench.js";

const DOC = resolve(__dirname, "..", "..", "docs", "user-scenarios.md");
const REQ = resolve(__dirname, "..", "..", "docs", "requirements.md");
const markdown = readFileSync(DOC, "utf8");
const requirements = readFileSync(REQ, "utf8");

function runner(codes: readonly number[], stdout = "  ✓ 샘플 케이스 (1ms)"): CommandRunnerPort & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    run: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      const code = codes[i] ?? 0;
      i += 1;
      return { code, stdout, ms: 10 };
    },
  };
}

const scenario = (id: string, overrides: Partial<BenchScenario> = {}): BenchScenario => ({
  id,
  uc: id,
  gate: "native",
  requiredEvidence: ["native"],
  ...overrides,
});

function exec(deps: {
  runner: CommandRunnerPort;
  verification?: Readonly<Record<string, readonly VerificationStep[]>>;
  requirementsMarkdown?: string;
}) {
  return new CommandBenchExecution({
    runner: deps.runner,
    repoRoot: resolve(__dirname, "..", ".."),
    contextRevision: "abc1234",
    requirementsMarkdown: deps.requirementsMarkdown ?? requirements,
    verification: deps.verification,
    // 여기서 확인하는 것은 영수증·허용목록·증명서 규칙이지 빌드 상태가 아니다.
    // 실제 판정을 그대로 쓰면 디스크에 빌드된 바이너리가 있느냐에 따라 결과가
    // 흔들린다 — 바이너리를 만들지 않는 CI 에서는 전부 실패한다. 최신성 판정
    // 자체는 아래 "옛 바이너리로 실 백엔드 증거를 만들지 않는다" 에서 실제
    // 함수로 확인한다.
    binaryIsCurrent: () => ({ ok: true, why: "" }),
  });
}

const STEP: VerificationStep = {
  // 대역 단계는 mock 이다 — native/worker 는 실환경 관측 증명서를 요구하므로
  // 증명서 없는 대역으로는 영수증이 나오지 않는다(그 성질은 아래에서 따로 확인한다).
  kind: "mock",
  cmd: "npx",
  args: ["wdio", "run", "x.conf.ts"],
  cwd: "packages/shell",
  why: "실 백엔드 확인",
  // 케이스 선택자가 없는 단계는 증거를 만들지 않는다 — 대역 단계도 예외가 아니다.
  cases: ["샘플 케이스"],
};

describe("실패는 증거가 되지 않는다", () => {
  it("명령이 통과하면 영수증이 생긴다", async () => {
    const r = runner([0]);
    const out = await exec({ runner: r, verification: { S: [STEP] } }).run(scenario("S"));
    expect(out.receipts).toHaveLength(1);
    expect(out.receipts[0]?.kind).toBe("mock");
  });

  it("명령이 실패하면 영수증이 없다 — 돌렸다는 사실이 증거가 아니다", async () => {
    const r = runner([1]);
    const out = await exec({ runner: r, verification: { S: [STEP] } }).run(scenario("S"));
    expect(r.calls, "명령은 실제로 돌았다").toHaveLength(1);
    expect(out.receipts, "실패했는데 증거가 생겼다").toHaveLength(0);
  });

  it("여러 수단 중 통과한 것만 증거가 된다", async () => {
    const r = runner([0, 1]);
    const out = await exec({
      runner: r,
      verification: { S: [STEP, { ...STEP, kind: "browser", args: ["playwright", "test", "y"], cases: ["샘플 케이스"] }] },
    }).run(scenario("S"));
    expect(out.receipts.map((x) => x.kind)).toEqual(["mock"]);
  });
});

describe("확인 수단이 없으면 없다고 말한다", () => {
  it("목록에 없는 시나리오는 영수증이 하나도 없다", async () => {
    const r = runner([0]);
    const out = await exec({ runner: r, verification: {} }).run(scenario("없는것"));
    expect(out.receipts).toEqual([]);
    expect(r.calls, "확인 수단이 없는데 뭔가를 돌렸다").toEqual([]);
  });

  it("아무도 완료라고 안 했으면 미주장으로 거절된다", async () => {
    // 도메인 규칙: 완료 주장이 없으면 증거 축은 아예 보지 않는다(unclaimed).
    // 증거 없음은 "완료라고 적혀 있는데 증거가 없을 때" 나오는 사유다.
    const s = scenario("없는것");
    const out = await exec({ runner: runner([0]), verification: {} }).run(s);
    const verdict = judge({
      scenario: s,
      receipts: out.receipts,
      claim: out.claim,
      baseline: { testCount: 0 },
      currentTestCount: out.testCount,
      safety: out.safety,
      trace: out.trace,
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons).toContain("unclaimed");
  });

  it("완료라고 적혀 있는데 확인 수단이 없으면 증거 없음으로 거절된다", async () => {
    const s = scenario("S");
    const out = await exec({
      runner: runner([0]),
      verification: {},
      requirementsMarkdown: "| FR-X | 뭐 | S | 검증 | Done |",
    }).run(s);
    const verdict = judge({
      scenario: s,
      receipts: out.receipts,
      claim: out.claim,
      baseline: { testCount: 0 },
      currentTestCount: out.testCount,
      safety: out.safety,
      trace: out.trace,
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons).toContain("no-evidence");
    expect(verdict.reasons).toContain("false-completion");
  });
});

describe("등급을 실제보다 높여 적지 않는다", () => {
  it("Playwright 단계는 browser 등급이다 — IPC 가 대역이므로 native 가 아니다", () => {
    for (const steps of Object.values(VERIFICATION)) {
      for (const step of steps) {
        if (step.args.includes("playwright")) expect(step.kind).toBe("browser");
        if (step.args.includes("wdio")) expect(step.kind).toBe("native");
      }
    }
  });

  it("native 를 자처하는 vitest 단계는 건너뛸 수 없어야 한다", () => {
    // 등급은 어떤 실행기로 띄우느냐가 아니라 무엇을 실제로 건드리느냐로 정해진다.
    // vitest 로 살아 있는 Herdr 을 조회하는 단계는 native 가 맞다. 다만 그런 단계가
    // 환경이 없을 때 건너뛰면 통과로 보이고, 그건 거짓 증거다 — 그 경로를 막는다.
    const root = resolve(__dirname, "..", "..");
    for (const [id, steps] of Object.entries(VERIFICATION)) {
      for (const step of steps) {
        if (step.kind !== "native" || !step.args.includes("vitest")) continue;
        const spec = step.args[step.args.length - 1] as string;
        const body = readFileSync(resolve(root, step.cwd, spec), "utf8");
        expect(body, `${id} 의 native 단계(${spec})가 건너뛸 수 있다`).not.toContain("skipIf");
      }
    }
  });

  it("mock 등급이 아닌 단계가 하나 이상이다 — 전부 결정론이면 벤치가 무의미하다", () => {
    const kinds = Object.values(VERIFICATION).flat().map((s) => s.kind);
    expect(kinds.filter((k) => k !== "mock").length).toBeGreaterThan(0);
  });

  it("native 를 요구하는 시나리오가 browser 증거만으로 통과하지 못한다", async () => {
    const s = scenario("S", { requiredEvidence: ["native"] });
    const out = await exec({
      runner: runner([0]),
      verification: { S: [{ ...STEP, kind: "browser", args: ["playwright", "test", "y"], cases: ["샘플 케이스"] }] },
      requirementsMarkdown: "| FR-X | 뭐 | S | t | Done |",
    }).run(s);
    const verdict = judge({
      scenario: s,
      receipts: out.receipts,
      claim: out.claim,
      baseline: { testCount: 0 },
      currentTestCount: out.testCount,
      safety: out.safety,
      trace: out.trace,
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons).toContain("false-completion");
  });
});

describe("완료 주장은 실행부가 만들지 않는다", () => {
  it("요구사항 문서가 Done 이라고 적으면 그것이 주장이다", () => {
    const claim = readClaim("| FR-A | 설명 | UC-X | 검증 | Done |", scenario("UC-X"));
    expect(claim?.claimedComplete).toBe(true);
  });

  it("한 행이라도 Pending 이면 완료 주장이 아니다", () => {
    const claim = readClaim(
      "| FR-A | 설명 | UC-X | 검증 | Done |\n| FR-B | 설명 | UC-X | 검증 | Pending |",
      scenario("UC-X"),
    );
    expect(claim?.claimedComplete).toBe(false);
  });

  it("문서에 행이 없으면 주장 자체가 없다 — 실행부가 대신 주장하지 않는다", () => {
    expect(readClaim("| FR-A | 설명 | UC-다른것 | 검증 | Done |", scenario("UC-X"))).toBeUndefined();
  });
});

describe("실행 파일 허용 목록", () => {
  it("목록 밖 실행 파일은 돌리지 않고 무단 효과로 남는다", async () => {
    const r = runner([0]);
    const out = await exec({
      runner: r,
      verification: { S: [{ ...STEP, cmd: "rm" }] },
    }).run(scenario("S"));
    expect(r.calls, "허용 목록 밖인데 실행됐다").toEqual([]);
    // 안전 관측에는 잔재 감사 결과도 함께 실린다 — 개수가 아니라 이 사건이 실렸는지를 본다.
    expect(out.safety.unauthorizedEffects.join(" ")).toContain("rm");
  });

  it("목록이 비어 있지 않다 — 공허하게 통과하지 않게", () => {
    expect(ALLOWED_EXECUTABLES.length).toBeGreaterThan(0);
  });
});

describe("테스트 수 읽기", () => {
  it("vitest 출력에서 읽는다", () => {
    expect(parseTestCount("      Tests  835 passed (835)")).toBe(835);
  });

  it("실패가 섞인 vitest 출력에서도 통과 수를 읽는다", () => {
    expect(parseTestCount("      Tests  12 failed | 1697 passed | 21 skipped (1730)")).toBe(1697);
  });

  it("playwright 출력에서 읽는다", () => {
    expect(parseTestCount("  6 passed (10.9s)")).toBe(6);
  });

  it("mocha(e2e-tauri) 출력에서 읽는다", () => {
    expect(parseTestCount("[wry] 16 passing (660ms)")).toBe(16);
  });

  it("못 읽으면 0 — 지어내지 않는다", () => {
    expect(parseTestCount("아무 말")).toBe(0);
  });
});

describe("확인 수단 목록이 시나리오와 어긋나지 않는다", () => {
  const scenarios = parseScenarios(markdown);

  it("목록의 모든 항목이 실제 시나리오다 — 죽은 항목이 없다", () => {
    const ids = new Set(scenarios.map((s) => s.id));
    expect(Object.keys(VERIFICATION).filter((id) => !ids.has(id))).toEqual([]);
  });

  it("에픽 시나리오를 실제로 읽어 왔다", () => {
    expect(allHeadings(markdown).filter(ownedByEpic).length).toBeGreaterThan(10);
  });

  it("확인 수단이 붙은 시나리오가 하나 이상이다 — 전부 미검증이면 벤치가 무의미하다", () => {
    expect(Object.keys(VERIFICATION).length).toBeGreaterThan(0);
  });

  it("모든 단계가 가리키는 파일이 실제로 있다", () => {
    // 시나리오 id 만 검사하면 명령이 없는 파일을 가리켜도 통과한다. 실제로 그랬다 —
    // 첫 실행에서 workspace-context.contract.test.ts 를 가리켰는데 그런 파일이 없었고,
    // 벤치는 "확인 수단이 실패했다"고만 말해 원인이 안 보였다(2026-08-26).
    const root = resolve(__dirname, "..", "..");
    const missing: string[] = [];
    for (const [id, steps] of Object.entries(VERIFICATION)) {
      for (const step of steps) {
        const spec = step.args[step.args.length - 1] as string;
        if (!spec.includes("/")) continue; // 파일 경로가 아닌 인자는 건너뛴다
        if (!existsSync(resolve(root, step.cwd, spec))) missing.push(`${id} → ${step.cwd}/${spec}`);
      }
    }
    expect(missing, "확인 수단이 없는 파일을 가리킨다").toEqual([]);
  });

  it("실 백엔드 단계는 필요한 환경을 스스로 갖춘다", () => {
    // 주변 환경에 기대면 "내 셸에서는 되는데" 가 되어 아무도 재현하지 못한다.
    for (const steps of Object.values(VERIFICATION)) {
      for (const step of steps) {
        if (step.kind === "native") {
          expect(step.env, "native 단계인데 환경을 스스로 갖추지 않는다").toBeDefined();
        }
      }
    }
  });

  it("모든 단계가 이유를 적었다", () => {
    for (const steps of Object.values(VERIFICATION)) {
      for (const step of steps) expect(step.why.length).toBeGreaterThan(5);
    }
  });
});

describe("문서와 하네스가 어긋나면 드러난다", () => {
  const scenarios = parseScenarios(markdown);

  it("문서가 선언한 확인 수단 파일이 전부 실제로 있다", () => {
    // 문서 표가 썩어도 벤치는 "확인 수단이 없다"로만 보고한다 — 구현이 없는 것과
    // 표가 낡은 것은 완전히 다른 상태인데 구분이 안 된다. 여기서 표 쪽을 잡는다.
    expect(MISSING_SPECS, "문서가 없는 파일을 확인 수단으로 선언한다").toEqual([]);
  });

  it("확인 수단이 하나도 없는 시나리오를 이름으로 안다", () => {
    // 없는 것 자체는 사실일 수 있다. 다만 몇 개인지가 아니라 무엇인지 알아야 한다.
    const orphans = scenarios.filter((sc) => (VERIFICATION[sc.id] ?? []).length === 0).map((sc) => sc.id);
    // 확인 수단 없는 시나리오는 유예로 *이름을 걸어* 선언한 것만 허용한다.
    // 조용히 비어 있는 것과 "왜 아직 안 됐는지 적어 둔 것"은 다르다.
    // 확인 수단이 없는 시나리오는 이름이 드러난다. 예외 목록으로 감추지 않는다.
    // 두 자리 모두 실제 모델을 띄워야 증명되고, 자격증명과 비용이 드는 사람 결정이다.
    // 요구를 낮춰 초록불로 만드는 것은 작성자 몫이 아니므로 이름을 그대로 남긴다.
    // UC-WORKSPACE-BIND-651 은 수단이 짝 저장소 naia-agent 의 계약 테스트에만 있다.
    // 이 저장소 파일이 아니므로 가리킬 수 없고, 실제 Codex app-server 를 띄우는 확인도 아직 없다.
    expect(orphans.sort(), `확인 수단 없는 시나리오: ${orphans.join(", ")}`).toEqual([
      "UC-ENV-ATTENTION-POLICY",
      "UC-ORCHESTRATION-CODING-PROVIDER",
      "UC-WORKSPACE-BIND-651",
    ]);
  });

  it("유예 장치가 없다 — 작성자가 혼자 게이트를 초록불로 만들 수 없다", () => {
    expect(Object.keys(DEFERRED_SCENARIOS)).toEqual([]);
  });

  it("문서에서 실제로 수단을 읽어 왔다 — 손으로 적은 것만 있는 게 아니다", () => {
    const fromDoc = Object.values(VERIFICATION)
      .flat()
      .filter((step) => step.why.includes("Test Coverage Map"));
    expect(fromDoc.length).toBeGreaterThan(15);
  });
});

describe("모든 단계가 시나리오 케이스를 지목한다", () => {
  it("케이스 선택자가 없는 단계가 없다", () => {
    // 선택자가 없으면 파일 안의 무관한 테스트로 시나리오가 증명된다.
    const naked: string[] = [];
    for (const [id, steps] of Object.entries(VERIFICATION)) {
      for (const step of steps) {
        if ((!step.cases || step.cases.length === 0) && (!step.anyCases || step.anyCases.length === 0)) {
          naked.push(`${id} → ${step.cwd}/${step.args[step.args.length - 1]}`);
        }
      }
    }
    expect(naked, `케이스 선택자 없는 단계: ${naked.join(" | ")}`).toEqual([]);
  });
});

describe("실환경 등급은 관측 증명서를 요구한다", () => {
  it("증명서 없이 native 를 자처하면 증거가 되지 않는다", async () => {
    const r = runner([0]);
    const out = await exec({
      runner: r,
      verification: { S: [{ ...STEP, kind: "native", cases: ["샘플 케이스"] }] },
    }).run(scenario("S"));
    expect(r.calls, "명령은 실제로 돌았다").toHaveLength(1);
    expect(out.receipts, "증명서가 없는데 native 증거가 생겼다").toEqual([]);
  });

  it("증명서 없이 worker 를 자처해도 마찬가지다", async () => {
    const out = await exec({
      runner: runner([0]),
      verification: { S: [{ ...STEP, kind: "worker", cases: ["샘플 케이스"] }] },
    }).run(scenario("S", { requiredEvidence: ["worker"] }));
    expect(out.receipts).toEqual([]);
  });
});

describe("증명서가 막는 것과 막지 못하는 것", () => {
  // 증명서는 테스트가 자기 손으로 쓴다. 그러므로 "위조 불가"가 아니다.
  // 무엇을 막고 무엇을 못 막는지 여기서 밟아 둔다 — 못 막는 것을 막는다고 적어 두면
  // 그 자체가 거짓 봉인이다(2026-08-27 5차 적대리뷰가 이 자기충족성을 지적했다).
  it("형태에 맞지 않는 자원 신고는 증거로 세지 않는다", () => {
    expect(plausibleResource("wA:p1")).toBe(true);
    // 실제 Herdr 이 내는 모양(2026-08-27 실측). 숫자만 허용하던 첫 판본이 이것들을 거절했다.
    for (const real of ["w9", "w9:p1A", "w9:p1M", "w9:pM", "w9:t1"]) {
      expect(plausibleResource(real), `실제 자원인데 거절한다: ${real}`).toBe(true);
    }
    expect(plausibleResource("/tmp/naia-orch-x")).toBe(true);
    expect(plausibleResource("pid:1234")).toBe(true);
    expect(plausibleResource("그냥 아무 말")).toBe(false);
    expect(plausibleResource("")).toBe(false);
  });

  it("빈 신고는 증명서로 받지 않는다", () => {
    const root = resolve(__dirname, "..", "..");
    writeAttestation(root, { spec: "위조-빈신고.test.ts", kinds: ["native"], touched: [], at: Date.now() });
    expect(readFreshAttestation(root, "위조-빈신고.test.ts", Date.now() - 10_000)).toBeNull();
  });

  it("오래된 증명서는 이번 실행의 증거가 아니다", () => {
    const root = resolve(__dirname, "..", "..");
    writeAttestation(root, {
      spec: "위조-옛날.test.ts",
      kinds: ["native"],
      touched: ["/tmp/x"],
      at: Date.now() - 3_600_000,
    });
    expect(readFreshAttestation(root, "위조-옛날.test.ts", Date.now() - 10_000)).toBeNull();
  });

  it("환경을 밟지 않은 케이스로 실환경 등급을 주장하면 거절된다", async () => {
    // 파일 단위 증명서만으로 등급을 주면 같은 파일의 순수 함수 테스트가 native 를 받는다.
    // 증명서가 신고한 "환경을 밟은 케이스"에 없는 케이스는 실환경 증거가 아니다.
    const root = resolve(__dirname, "..", "..");
    writeAttestation(root, {
      spec: "등급-케이스.test.ts",
      kinds: ["native"],
      cases: ["실제 터미널을 만졌다"],
      touched: ["wZ:p1"],
      at: Date.now(),
    });
    const out = await exec({
      runner: runner([0], "  ✓ 순수 계산만 한다 (1ms)"),
      verification: {
        S: [
          {
            ...STEP,
            kind: "native",
            cwd: ".",
            args: ["vitest", "run", "등급-케이스.test.ts"],
            cases: ["순수 계산만 한다"],
          },
        ],
      },
    }).run(scenario("S"));
    expect(out.receipts, "환경을 안 밟은 케이스가 native 증거가 됐다").toEqual([]);
  });

  it("⚠️ 알려진 한계 — 그럴듯한 값을 신고하면 형태 검사는 통과한다", () => {
    // 이것은 통과해야 할 성질이 아니라 *아직 못 막는 것*의 기록이다. 성공으로 적어 두면
    // 위조가 승인된 동작처럼 읽히므로(2026-08-27 6차 적대리뷰 지적), 무엇이 남았는지를
    // 이름과 주석으로 남기고 통과 여부가 아니라 사실만 확인한다.
    const root = resolve(__dirname, "..", "..");
    writeAttestation(root, {
      spec: "한계-그럴듯.test.ts",
      kinds: ["native"],
      touched: ["wZ:p1"],
      at: Date.now(),
    });
    const att = readFreshAttestation(root, "한계-그럴듯.test.ts", Date.now() - 10_000);
    // 형태 검사는 값의 모양만 본다. 그 값이 실제로 존재했는지는 벤치가 모른다.
    expect(att?.touched).toEqual(["wZ:p1"]);
    expect(plausibleResource("wZ:p1")).toBe(true);
    // 남은 위험: 케이스 신고 없이 파일 단위로만 쓰면 케이스 대조가 적용되지 않는다.
    expect(att?.cases, "케이스 신고가 없으면 케이스 대조가 걸리지 않는다").toBeUndefined();
  });
});

describe("최신성 판정이 거절하면 실 백엔드 단계는 돌지 않는다", () => {
  // 판정을 주입 가능하게 바꾸면서 게이트가 헐거워지지 않았는지를 여기서 고정한다.
  // 주입된 판정이 거절하면 명령은 아예 돌지 않고, 그 사실이 무단 효과로 남아야 한다.
  it("거절된 최신성은 명령을 막고 이유를 남긴다", async () => {
    const r = runner([0]);
    const out = await new CommandBenchExecution({
      runner: r,
      repoRoot: resolve(__dirname, "..", ".."),
      contextRevision: "abc1234",
      requirementsMarkdown: requirements,
      verification: { S: [{ ...STEP, kind: "native" }] },
      binaryIsCurrent: () => ({ ok: false, why: "테스트용 낡음" }),
    }).run(scenario("S"));
    expect(r.calls, "거절됐는데 명령이 돌았다").toEqual([]);
    expect(out.receipts, "돌지도 않았는데 증거가 생겼다").toHaveLength(0);
    expect(out.safety.unauthorizedEffects.join(" ")).toContain("테스트용 낡음");
  });
});

describe("옛 바이너리로 실 백엔드 증거를 만들지 않는다", () => {
  // 실측(2026-08-27): 바이너리는 11:00, Rust 소스 마지막 커밋은 13:17 이었다.
  // "실 Rust 백엔드로 검증했다"가 실제로는 옛 바이너리를 상대로 한 것이었고,
  // 벤치는 그 어긋남을 보지 못해 통과를 그대로 증거로 셌다.
  const ROOT = resolve(__dirname, "..", "..");

  const BINARY = resolve(
    ROOT,
    "packages",
    "shell",
    "src-tauri",
    "target-e2e",
    "debug",
    "naia-shell",
  );

  it("바이너리가 없으면 없다고 말한다 — 없는 것을 최신으로 세지 않는다", () => {
    if (existsSync(BINARY)) {
      const out = e2eBinaryIsCurrent(ROOT);
      // 빌드된 바이너리가 있는 환경에서는 실제 최신성이 판정된다. 오래됐다면
      // 그것은 이 테스트의 실패가 아니라 다시 빌드하라는 신고다.
      expect(typeof out.ok).toBe("boolean");
      return;
    }
    const out = e2eBinaryIsCurrent(ROOT);
    expect(out.ok).toBe(false);
    expect(out.why).toContain("없다");
  });

  it("소스가 바이너리보다 새로우면 거절한다", () => {
    if (!existsSync(BINARY)) {
      // 바이너리가 없으면 최신성을 견줄 대상이 없다. 이 성질은 빌드가 있는
      // 환경에서만 의미가 있다.
      expect(e2eBinaryIsCurrent(ROOT).ok).toBe(false);
      return;
    }
    const src = resolve(ROOT, "packages", "shell", "src-tauri", "src", "lib.rs");
    const before = statSync(src);
    try {
      const future = new Date(Date.now() + 60_000);
      utimesSync(src, future, future);
      const out = e2eBinaryIsCurrent(ROOT);
      expect(out.ok, "소스가 더 새로운데 통과했다").toBe(false);
      expect(out.why).toContain("오래됐다");
    } finally {
      utimesSync(src, before.atime, before.mtime);
    }
  });
});
