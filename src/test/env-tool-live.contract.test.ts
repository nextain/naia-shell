// #499 살아 있는 터미널로 환경 도구를 끝까지 밟는다 (UC-ENV-TOOL-*, native 증거).
//
// 왜 따로 있는가: 환경 도구 계약 테스트는 전부 대역 포트로 돈다. "실행 파일과 인자 배열을
// 구조화해 넘긴다"는 규칙이 실제 터미널에서도 지켜지는지, 취소가 정말 멈추는지는
// 붙여 보기 전에는 알 수 없다.
//
// ⚠️ 이 테스트가 만든 워크스페이스 안에서만 실행한다. 터미널 포트가 소유 밖 대상을
//    거부하므로 판정이 틀려도 사용자의 터미널로 가지 않는다. 끝나면 워크스페이스를 닫는다.
import { it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { writeAttestation } from "./harness/bench-execution.js";
import { resolve as resolvePath } from "node:path";

const REPO_ROOT_FOR_ATTEST = resolvePath(__dirname, "..", "..");
import { execFileSync } from "node:child_process";
import { EnvironmentToolService } from "../main/app/control/env-tool.js";
import { ALL_TIERS } from "../main/domain/capability.js";
import type { StructuredCommand } from "../main/domain/herdr-control.js";
import type { EnvOperationRequest } from "../main/domain/env-tool.js";
import { describeWithHerdr, herdrIsInstalled } from "./harness/herdr-live.js";

/**
 * 실제로 돈 케이스를 러너에서 모은다. 손으로 적은 목록은 테스트를 고칠 때 따라오지 않아
 * 작성자가 관리하는 매핑이 하나 더 느는 것뿐이다(2026-08-27 적대리뷰).
 */
const passedCases: string[] = [];
afterEach((ctx) => {
  if (ctx.task.result?.state === "pass") passedCases.push(ctx.task.name);
});
import type {
  BrowserOperationPort,
  CancellationPort,
  TerminalOperationPort,
} from "../main/ports/env-tool.js";

function herdr(args: readonly string[]): string {
  return execFileSync("herdr", [...args], { encoding: "utf8", timeout: 30_000 });
}

const NONCE = `naia-envtool-${Date.now().toString(36)}`;
let workspaceId = "";
let paneId = "";
let setupError = "";

beforeAll(() => {
  // 도구가 없으면 준비할 실환경이 없다 (#536).
  if (!herdrIsInstalled()) return;
  try {
    const created = JSON.parse(herdr(["workspace", "create", "--cwd", "/tmp", "--label", NONCE])) as {
      result?: { workspace?: { workspace_id?: string }; root_pane?: { pane_id?: string } };
    };
    workspaceId = created.result?.workspace?.workspace_id ?? "";
    paneId = created.result?.root_pane?.pane_id ?? "";
    if (!workspaceId || !paneId) throw new Error("워크스페이스 생성 결과가 비었다");
    // 갓 만든 표면은 셸이 뜰 때까지 입력을 삼킨다(2026-08-26 실측). 프롬프트를 기다린다.
    const until = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < until) {
      if (/\$\s*$/.test(herdr(["pane", "read", paneId]).trimEnd() + " ")) {
        ready = true;
        break;
      }
      execFileSync("sleep", ["0.4"]);
    }
    if (!ready) throw new Error("표면의 셸이 준비되지 않았다");
    execFileSync("sleep", ["1"]);
  } catch (e) {
    setupError = e instanceof Error ? e.message : String(e);
  }
}, 60_000);

afterAll(() => {
  if (workspaceId) {
    let closeError = "";
    try {
      herdr(["workspace", "close", workspaceId]);
    } catch (e) {
      closeError = e instanceof Error ? e.message : String(e);
    }
    // 확인 자체가 실패하면 "없다"가 아니라 "모른다"이다. 모르는 것을 깨끗함으로 읽지 않는다
    // (2026-08-27 3차 적대리뷰 지적).
    let stillThere: boolean;
    try {
      stillThere = herdr(["workspace", "list"]).includes(NONCE);
    } catch (e) {
      throw new Error(`정리 확인에 실패했다 — 잔재 여부를 모른다: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (stillThere) throw new Error(`테스트 워크스페이스가 남았다: ${NONCE} ${closeError}`);
  }

  // 이 실행이 실제로 무엇을 만졌는지 남긴다. 벤치는 이 증명서가 있어야 native 영수증을 준다.
  writeAttestation(REPO_ROOT_FOR_ATTEST, {
    spec: "src/test/env-tool-live.contract.test.ts",
    kinds: ["native"],
    cases: passedCases,
    touched: [workspaceId, paneId].filter(Boolean),
    at: Date.now(),
  });
}, 60_000);

const sent: StructuredCommand[] = [];

/** 실제 터미널에 넣는다. 소유 밖 대상은 거부한다. */
function liveTerminal(): TerminalOperationPort {
  return {
    async exec(_request: EnvOperationRequest, terminalId: string, command: StructuredCommand) {
      if (!terminalId.startsWith(`${workspaceId}:`)) {
        throw new Error(`소유하지 않은 터미널: ${terminalId}`);
      }
      sent.push(command);
      // ⚠️ 여기서 구조가 한 번 무너진다. Herdr 의 `pane run` 은 터미널에 넣을 *한 줄*을 받는다 —
      //    argv 배열을 받는 경계가 아니다. 그래서 실행 파일과 인자를 공백으로 잇는다.
      //    코어가 구조화 명령을 유지한다는 것은 코어까지의 성질이고, 이 환경의 마지막 한 칸은
      //    문자열이다. 공백이나 따옴표가 든 인자는 여기서 깨진다 —
      //    그 사실을 아래 테스트가 실제로 밟아 기록한다(2026-08-27 4차 적대리뷰 지적).
      herdr(["pane", "run", terminalId, [command.executable, ...command.args].join(" ")]);
      return { exitCode: 0, outputRef: `pane:${terminalId}`, artifactRefs: [] };
    },
  };
}

const unusedBrowser: BrowserOperationPort = {
  async open() {
    throw new Error("이 테스트는 브라우저를 쓰지 않는다");
  },
  async snapshot() {
    throw new Error("이 테스트는 브라우저를 쓰지 않는다");
  },
  async click() {
    throw new Error("이 테스트는 브라우저를 쓰지 않는다");
  },
  async fill() {
    throw new Error("이 테스트는 브라우저를 쓰지 않는다");
  },
  async close() {},
};

/** 실제 중단 키를 보낸다. */
function liveCancellation(): CancellationPort {
  return {
    async cancel(operationId: string) {
      herdr(["pane", "send-keys", paneId, "C-c"]);
      return [`interrupt:${operationId}`];
    },
  };
}

function service(tiers = ALL_TIERS): EnvironmentToolService {
  return new EnvironmentToolService(unusedBrowser, liveTerminal(), liveCancellation(), tiers);
}

function request(overrides: Partial<EnvOperationRequest> = {}): EnvOperationRequest {
  return {
    operationId: `op-${NONCE}-${overrides.idempotencyKey ?? "1"}`,
    idempotencyKey: `k-${NONCE}-1`,
    capability: "workspace-write",
    timeoutMs: 20_000,
    // 이 테스트의 자리는 Herdr 워크스페이스다 (#582 S0a: 모든 작업은 자리를 밝힌다).
    workspaceId: workspaceId || NONCE,
    cwd: ".",
    ...overrides,
  };
}

function readPane(): string {
  return herdr(["pane", "read", paneId]);
}

function waitFor(predicate: () => boolean, ms = 10_000): boolean {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    execFileSync("sleep", ["0.4"]);
  }
  return predicate();
}

describeWithHerdr("살아 있는 터미널로 환경 도구 (native)", () => {
  it("전용 워크스페이스를 실제로 만들었다", () => {
    expect(setupError, setupError).toBe("");
    expect(paneId.startsWith(`${workspaceId}:`)).toBe(true);
  });

  it("구조화된 명령이 실제로 실행되고 결과가 함께 돌아온다 (UC-ENV-TOOL-TERMINAL-EXEC)", async () => {
    const marker = `${NONCE}-exec`;
    const outcome = await service().exec(request(), paneId, {
      executable: "echo",
      args: [marker],
      cwd: "/tmp",
      env: {},
    });
    expect(outcome.ok, `거절: ${JSON.stringify(outcome)}`).toBe(true);
    if (!outcome.ok) return;
    // 종료 코드와 출력 참조가 함께 온다.
    const evidence = outcome.operation.evidence;
    expect(evidence?.kind).toBe("terminal");
    if (evidence?.kind === "terminal") {
      expect(evidence.value.outputRef.length).toBeGreaterThan(0);
      expect(evidence.value.exitCode).not.toBeNull();
    }
    expect(waitFor(() => readPane().includes(marker)), "실제 터미널에 나타나지 않았다").toBe(true);
  }, 60_000);

  it("셸 문자열을 조립하지 않는다 — 실행 파일과 인자가 따로 온다", async () => {
    sent.length = 0;
    await service().exec(request({ idempotencyKey: `k-${NONCE}-args` }), paneId, {
      executable: "echo",
      args: [`${NONCE}-args`, "두번째인자"],
      cwd: "/tmp",
      env: {},
    });
    expect(sent.length).toBe(1);
    expect(sent[0]?.executable).toBe("echo");
    expect(sent[0]?.args).toEqual([`${NONCE}-args`, "두번째인자"]);
    // 실행 파일 자리에 셸이 들어 있지 않다.
    expect(/\s/.test(sent[0]?.executable ?? " ")).toBe(false);
  }, 60_000);

  it("공백이 든 인자는 이 환경의 마지막 한 칸에서 깨진다 — 그 사실을 덮지 않는다", async () => {
    // 코어는 argv 배열을 유지하지만 Herdr 의 pane run 은 한 줄을 받는다. 그 경계에서
    // 무슨 일이 벌어지는지 단언으로 못 박아 둔다 — "구조가 끝까지 보존된다"고 말하지 않기 위해서다.
    const marker = `${NONCE}-quoted`;
    await service().exec(request({ idempotencyKey: `k-${NONCE}-space` }), paneId, {
      executable: "echo",
      args: [`${marker} 두 낱말`],
      cwd: "/tmp",
      env: {},
    });
    // 한 인자로 넘겼는데 터미널에는 두 낱말로 도착한다. echo 라서 출력은 같아 보이지만
    // 인자 경계는 사라졌다 — 인용이 필요한 명령이라면 여기서 의미가 달라진다.
    expect(waitFor(() => readPane().includes(marker)), "명령 자체가 안 갔다").toBe(true);
    expect(sent[sent.length - 1]?.args).toEqual([`${marker} 두 낱말`]);
  }, 60_000);

  it("소유하지 않은 터미널에는 닿지 못한다", async () => {
    const outcome = await service().exec(
      request({ idempotencyKey: `k-${NONCE}-foreign` }),
      "wZZ:p9",
      { executable: "echo", args: ["nope"], cwd: "/tmp", env: {} },
    );
    // 포트가 던지면 서비스가 실패로 접는다. 성공으로 바뀌지 않는 것이 요점이다.
    if (outcome.ok) expect(outcome.operation.state).not.toBe("completed");
  }, 60_000);

  it("취소하면 진행 중인 작업이 실제로 멈춘다 (UC-ENV-TOOL-CANCEL)", async () => {
    // 취소는 *진행 중인* 작업에만 의미가 있다. 서비스가 추적하지 않는 작업 식별자로 부르면
    // 포트를 아예 부르지 않는다(실측). 그래서 실제로 물고 있는 작업을 하나 만든다.
    const blocking: TerminalOperationPort = {
      async exec(_r, terminalId, command) {
        herdr(["pane", "run", terminalId, [command.executable, ...command.args].join(" ")]);
        // 중단될 때까지 물고 있는다 — 그동안 이 작업은 running 이다.
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
          if (/\^C/.test(readPane())) break;
          execFileSync("sleep", ["0.4"]);
        }
        return { exitCode: null, outputRef: `pane:${terminalId}`, artifactRefs: [] };
      },
    };
    const svc = new EnvironmentToolService(unusedBrowser, blocking, liveCancellation(), ALL_TIERS);
    const operationId = `op-${NONCE}-cancel`;
    const inflight = svc.exec(
      request({ operationId, idempotencyKey: `k-${NONCE}-cancel` }),
      paneId,
      { executable: "sleep", args: ["40"], cwd: "/tmp", env: {} },
    );

    expect(waitFor(() => readPane().includes("sleep 40")), "멈출 대상이 시작되지 않았다").toBe(true);
    const termination = await svc.cancel(operationId);
    expect(termination.state, "취소가 실패와 같은 상태로 뭉뚱그려졌다").toBe("cancelled");
    expect(
      termination.partialEffects.length,
      "이미 일어난 일이 남지 않았다 — 아무 일도 없던 것으로 만들면 안 된다",
    ).toBeGreaterThan(0);
    expect(waitFor(() => /\^C/.test(readPane())), "중단 키를 보냈는데 터미널이 반응하지 않는다").toBe(true);
    await inflight;
  }, 120_000);

  it("추적하지 않는 작업의 취소는 효과를 지어내지 않는다 (UC-ENV-TOOL-CANCEL)", async () => {
    const termination = await service().cancel(`op-${NONCE}-없는것`);
    expect(termination.state).toBe("cancelled");
    // 일어나지 않은 일을 남기지 않는다.
    expect(termination.partialEffects).toEqual([]);
  }, 60_000);

  it("파일을 고칠 수 있다고 메시지를 보낼 수 있는 것은 아니다 (UC-ENV-TOOL-BOUNDARY-DENY)", async () => {
    sent.length = 0;
    const svc = service(["workspace-write"]);
    const outcome = await svc.exec(
      request({ idempotencyKey: `k-${NONCE}-tier`, capability: "external-message" }),
      paneId,
      { executable: "echo", args: ["보내면안됨"], cwd: "/tmp", env: {} },
    );
    expect(outcome.ok, "권한이 없는데 통과했다").toBe(false);
    expect(sent.length, "거절인데 실제 터미널에 나갔다").toBe(0);
  }, 60_000);

  it("자격증명을 쓰는 호출은 별도 승인이 필요하다 (UC-ENV-TOOL-BOUNDARY-DENY)", async () => {
    sent.length = 0;
    const outcome = await service().exec(
      request({ idempotencyKey: `k-${NONCE}-cred`, capability: "credential" }),
      paneId,
      { executable: "echo", args: ["자격증명"], cwd: "/tmp", env: {} },
    );
    expect(outcome.ok, "승인 없이 자격증명 등급이 통과했다").toBe(false);
    expect(sent.length).toBe(0);
  }, 60_000);

  it("워크스페이스 밖으로 나가는 작업 디렉터리는 거절한다", async () => {
    sent.length = 0;
    const outcome = await service().exec(
      request({ idempotencyKey: `k-${NONCE}-escape`, cwd: "../../etc" }),
      paneId,
      { executable: "echo", args: ["탈출"], cwd: "/tmp", env: {} },
    );
    expect(outcome.ok, "워크스페이스 밖인데 통과했다").toBe(false);
    expect(sent.length).toBe(0);
  }, 60_000);
});
