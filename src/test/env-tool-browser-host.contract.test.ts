// #582 UC-ENV-TOOL-BROWSE·CANCEL·SPACE·RECOVER·SCRIPT — 실제 어댑터 + 실제 감독자 + 실제
// Chromium 으로 #499 계약 전체를 밟는다 (계약 9절 S3a).
//
// 대역이 하나도 없다. `EnvironmentToolService` 아래에 꽂히는 것은 조립이 실제로 꽂는
// `EgoBrowserEnvironment` 이고, 그 아래는 소켓·CDP·Chromium 이다. 그래서 여기서 초록이 나오면
// "계약을 지키도록 짰다"가 아니라 "이 기계에서 실제로 그렇게 돌았다"가 된다.
//
// **Chromium 이 없으면 건너뛰지 않고 RED 다.** 건너뛴 실행은 초록으로 보이고, 초록으로 보이는
// 미검증은 다음 사람에게 "검증했다"로 읽힌다(packages/ego-host/test/helpers/live-browser.mjs
// 와 같은 원칙). 대신 페이지는 전부 이 프로세스가 띄운 로컬 픽스처다 — 외부 네트워크는 없다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo, Socket } from "node:net";
import { EnvironmentToolService } from "../main/app/control/env-tool.js";
import { makeEnvironmentToolService } from "../main/composition/index.js";
import {
  egoHostPaths,
  egoLaunchEnv,
  joinPath,
  resolveAdkDir,
  type EgoBrowserEnvironment,
} from "../main/adapters/ego-browser-env.js";
import { ALL_TIERS } from "../main/domain/capability.js";
import type { EnvOperationRequest } from "../main/domain/env-tool.js";
import type { BrowserOperationPort, BrowserScriptPort, TerminalOperationPort } from "../main/ports/env-tool.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const EGO_HOST = join(REPO_ROOT, "packages", "ego-host");

/** 픽스처. `/느린` 은 영원히 응답하지 않는다 — 취소와 상한이 물 대상이 필요하다. */
const HOME_PAGE = `<!doctype html><meta charset="utf-8"><title>naia 582 S3a</title>
<body>
  <h1 id="title">첫 페이지</h1>
  <button id="send-button">보내기</button>
  <a id="home-link" href="/second">다음</a>
  <label for="query">검색어</label><input id="query" type="text" name="query">
</body>`;

const SECOND_PAGE = `<!doctype html><meta charset="utf-8"><title>naia 582 둘째</title>
<body><h1 id="title">둘째 페이지</h1><p id="mark">여기에는 버튼이 없다</p></body>`;

let fixture: Server;
let origin = "";
const hangingSockets: Socket[] = [];

let adkDir = "";
let runtimeDir = "";
let executable = "";
let service: EnvironmentToolService;
let environment: EgoBrowserEnvironment | null = null;
let workspaceId = "";
let setupError = "";

let seq = 0;
function request(over: Partial<EnvOperationRequest> = {}): EnvOperationRequest {
  seq += 1;
  return {
    operationId: `s3a-op-${seq}`,
    idempotencyKey: `s3a-key-${seq}`,
    capability: "workspace-write",
    timeoutMs: 60_000,
    workspaceId,
    ...over,
  };
}

/** 이 기계의 Chromium. 없으면 던진다 — 그 던짐이 RED 다. */
async function requireChromium(): Promise<string> {
  const discovery = (await import(
    /* @vite-ignore */ pathToFileURL(join(EGO_HOST, "src", "supervisor", "browser-discovery.mjs")).href
  )) as { discoverBrowser(options: Record<string, unknown>): { executable: string } };
  return discovery.discoverBrowser({}).executable;
}

beforeAll(async () => {
  try {
    fixture = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/slow") {
        // 응답을 영원히 보내지 않는다. 소켓만 잡아 두고 나중에 정리한다.
        hangingSockets.push(req.socket);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(path === "/second" ? SECOND_PAGE : HOME_PAGE);
    });
    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", () => done()));
    origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

    executable = await requireChromium();
    // 공백이 든 ADK 경로를 일부러 고른다 — 인자를 배열로만 넘긴다는 주장의 반증 자리다.
    adkDir = mkdtempSync(join(tmpdir(), "ego s3a-"));
    // unix 소켓 경로 상한(104바이트) 때문에 소켓 자리는 짧게 따로 둔다.
    runtimeDir = mkdtempSync(join(tmpdir(), "ego-run-"));

    const wiring = makeEnvironmentToolService({
      adkDir,
      platform: "linux",
      cwd: REPO_ROOT,
      executable,
      runtimeDir,
      baseEnv: { PATH: process.env.PATH ?? "" },
      grantedTiers: ALL_TIERS,
    });
    expect(wiring.enabled, "리눅스에서는 기능 플래그가 기본으로 켜져 있어야 한다").toBe(true);
    service = wiring.service;
    environment = wiring.environment;

    const created = await service.createWorkspace(request({ workspaceId: "s3a-공간" }));
    if (!created.ok) throw new Error(`작업 공간 생성 실패: ${JSON.stringify(created.rejections)}`);
    workspaceId = created.value.id;
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}, 180_000);

afterAll(async () => {
  try {
    await environment?.stop();
  } finally {
    for (const socket of hangingSockets.splice(0)) socket.destroy();
    await new Promise<void>((done) => fixture?.close(() => done()));
    for (const dir of [adkDir, runtimeDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  }
  // 감독자를 내린 **뒤** 재는 것이 뜻이 있다. 테스트 안에서 재면 그때는 당연히 살아 있다.
  // `pgrep` 은 하나도 못 찾으면 종료 코드 1 이므로 그것이 깨끗함이다.
  let leftover = "";
  try {
    leftover = execFileSync("pgrep", ["-f", "naia-ego-[m]arker"], { encoding: "utf8" });
  } catch {
    leftover = "";
  }
  if (leftover.trim() !== "") throw new Error(`marker 프로세스가 남았다: ${leftover.trim()}`);
}, 60_000);

/** 스냅샷 증거 파일에서 안정 참조 하나를 꺼낸다. 참조는 본문의 `[ref=N …]` 이다(ABI 7). */
function refOf(snapshotRef: string, pattern: RegExp): string {
  const body = readFileSync(snapshotRef, "utf8");
  const line = body.split("\n").find((row) => pattern.test(row));
  expect(line, `스냅샷에 ${pattern} 이 없다:\n${body}`).toBeTruthy();
  const found = /\[ref=(\d+)/.exec(line ?? "");
  expect(found, `참조 주석이 없다: ${line}`).toBeTruthy();
  return found?.[1] ?? "";
}

function isPng(path: string): boolean {
  const head = readFileSync(path).subarray(0, 8);
  return head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

describe("#582 실제 어댑터 계약 (S3a)", () => {
  it("열기·이동·스냅샷·안정 참조 클릭·입력·캡처·닫기가 실제 Chromium 에서 돌고 증거 셋(스냅샷·캡처 파일·주소 개정)이 남는다", async () => {
    expect(setupError, setupError).toBe("");

    const opened = await service.open(request(), `${origin}/`);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    const first = opened.operation.evidence;
    expect(first?.kind).toBe("browser");
    if (first?.kind !== "browser") return;
    expect(existsSync(first.value.snapshotRef), "스냅샷 증거 파일이 없다").toBe(true);
    expect(existsSync(first.value.screenshotRef), "캡처 파일이 없다").toBe(true);
    expect(isPng(first.value.screenshotRef), "캡처가 PNG 가 아니다").toBe(true);
    expect(first.value.url).toBe(`${origin}/`);
    expect(first.value.urlRevision).toBeGreaterThan(0);

    // 이동 — 주소와 개정이 함께 움직인다.
    const moved = await service.navigate(request(), `${origin}/second`);
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    if (!moved.ok || moved.operation.evidence?.kind !== "browser") return;
    expect(moved.operation.evidence.value.url).toBe(`${origin}/second`);
    expect(moved.operation.evidence.value.urlRevision).toBeGreaterThan(first.value.urlRevision);
    expect(readFileSync(moved.operation.evidence.value.snapshotRef, "utf8")).toContain("둘째 페이지");

    // 다시 첫 페이지로 — 조작할 요소가 거기 있다.
    const back = await service.navigate(request(), `${origin}/`);
    expect(back.ok, JSON.stringify(back)).toBe(true);
    if (!back.ok || back.operation.evidence?.kind !== "browser") return;

    const snapped = await service.snapshot(request({ capability: "observe" }));
    expect(snapped.ok, JSON.stringify(snapped)).toBe(true);
    if (!snapped.ok || snapped.operation.evidence?.kind !== "browser") return;
    const snapshotRef = snapped.operation.evidence.value.snapshotRef;
    const buttonRef = refOf(snapshotRef, /button "보내기"/);
    const inputRef = refOf(snapshotRef, /loc=css:#query/);

    // 안정 참조로 클릭 — 좌표가 아니라 참조가 먼저다(FR-ENV-TOOL.3).
    const clicked = await service.click(request(), { kind: "reference", ref: buttonRef });
    expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
    if (!clicked.ok) return;
    expect(clicked.operation.notes, "참조로 눌렀는데 좌표 사용 기록이 남았다").toEqual([]);

    // 입력 — 실제로 값이 들어갔는지는 평가로 확인한다.
    const filled = await service.fill(request(), { kind: "reference", ref: inputRef }, "나이아");
    expect(filled.ok, JSON.stringify(filled)).toBe(true);

    const evaluated = await service.evaluate(request(), {
      expression: "document.querySelector('#query').value",
    });
    expect(evaluated.ok, JSON.stringify(evaluated)).toBe(true);
    if (!evaluated.ok) return;
    expect(evaluated.operation.result).toBe(JSON.stringify("나이아"));

    // 캡처 — 감독자가 정한 자리에 PNG 가 남는다(계약 4.5).
    const shot = await service.screenshot(request({ capability: "observe" }));
    expect(shot.ok, JSON.stringify(shot)).toBe(true);
    if (!shot.ok || shot.operation.evidence?.kind !== "browser") return;
    const shotRef = shot.operation.evidence.value.screenshotRef;
    expect(isPng(shotRef)).toBe(true);
    expect(shotRef.startsWith(egoHostPaths(adkDir, "linux").evidenceDir)).toBe(true);

    // 닫기 — 자원이 사라지므로 증거가 아니라 결과 없음으로 끝난다.
    const closed = await service.close(request());
    expect(closed.ok, JSON.stringify(closed)).toBe(true);
  }, 180_000);

  it("취소와 완료가 경주하면 먼저 종결한 쪽이 남는다(CAS)", async () => {
    const opened = await service.open(request(), `${origin}/`);
    expect(opened.ok).toBe(true);

    const cancelRequest = request();
    const inflight = service.navigate(cancelRequest, `${origin}/slow`);
    // 이동이 실제로 시작될 때까지 기다린다 — 시작 전 취소는 경주가 아니다.
    await new Promise((done) => setTimeout(done, 700));
    const termination = await service.cancel(cancelRequest.operationId);
    expect(termination.state).toBe("cancelled");
    expect(termination.known, "장부가 아는 작업인데 모른다고 답했다").toBe(true);

    const outcome = await inflight;
    expect(outcome.ok, "취소한 작업이 완료로 승격됐다").toBe(false);
    expect(service.stateOf(cancelRequest.operationId)).toBe("cancelled");
    // 늦게 도착한 종결 시도는 상태를 바꾸지 못하고 장부에만 남는다.
    expect(service.snapshotOf(cancelRequest.operationId)?.state).toBe("cancelled");

    const later = await service.cancel(cancelRequest.operationId);
    expect(later.state).toBe("cancelled");
    expect(service.snapshotOf(cancelRequest.operationId)?.lateTerminations.length).toBeGreaterThan(0);
  }, 120_000);

  it("모르는 작업의 취소는 '그런 작업 없음' 으로 구별된다 (#582 S0 리뷰 3번)", async () => {
    const termination = await service.cancel("s3a-없는작업");
    expect(termination.state).toBe("cancelled");
    expect(termination.partialEffects).toEqual([]);
    expect(termination.known, "모르는 작업을 아는 척했다").toBe(false);
  });

  it("같은 멱등 키의 동시 요청은 포트 호출 1회로 끝난다", async () => {
    expect(environment).not.toBeNull();
    if (!environment) return;
    let calls = 0;
    const real = environment.operationPort();
    const counting: BrowserOperationPort = {
      ...real,
      snapshot: (req, signal) => {
        calls += 1;
        return real.snapshot(req, signal);
      },
    };
    const counted = new EnvironmentToolService(
      counting,
      noTerminal,
      environment,
      ALL_TIERS,
      environment.workspacePort(),
      environment,
    );
    const shared = request({ capability: "observe" });
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => counted.snapshot(shared)));
    expect(calls, "같은 키의 동시 요청이 포트를 여러 번 불렀다").toBe(1);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.filter((o) => o.ok && o.operation.deduplicated).length).toBe(4);
  }, 120_000);

  it("deadline 이 실제 타이머로 작동하고 만료 뒤 감독자 쪽 부작용이 멈춘다", async () => {
    const opened = await service.open(request(), `${origin}/`);
    expect(opened.ok).toBe(true);

    const timed = request({ timeoutMs: 2_500 });
    const started = Date.now();
    const outcome = await service.navigate(timed, `${origin}/slow`);
    const elapsed = Date.now() - started;
    expect(outcome.ok, "상한을 넘긴 작업이 완료로 승격됐다").toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections[0]?.code).toBe("timeout");
    expect(elapsed, "상한이 실제 시간으로 작동하지 않았다").toBeGreaterThanOrEqual(2_000);
    expect(service.stateOf(timed.operationId)).toBe("failed");

    // 감독자 쪽 정리가 실제로 돌았는지: 같은 세션의 이동·평가 배타 슬롯과 세션이 풀렸어야
    // 다음 작업이 돈다. 안 풀렸으면 여기서 EGO_SESSION_SLOT_BUSY 로 막힌다.
    const after = await service.navigate(request(), `${origin}/second`);
    expect(after.ok, `만료 뒤 정리가 안 됐다: ${JSON.stringify(after)}`).toBe(true);
    expect(environment?.stateOf(timed.operationId)).toBe("failed");
  }, 180_000);

  it("실행기(heredoc)가 강제 종료돼도 같은 작업 공간에 재접속한다", async () => {
    const opened = await service.open(request(), `${origin}/`);
    expect(opened.ok).toBe(true);
    expect(environment).not.toBeNull();
    if (!environment) return;

    const killed = request({ approvalRef: "approval-s3a", timeoutMs: 30_000 });
    const code =
      `const space = await taskSpaces.useOrCreate(${JSON.stringify("s3a-공간")});\n` +
      `console.log("TABS " + JSON.stringify(await browser.listTabs()));\n` +
      `process.kill(process.pid, "SIGKILL");\n`;
    await expect(environment.script(killed, code)).rejects.toMatchObject({ reason: "process-exit" });

    // `.env` 는 ADK 안 한 곳에만, ADK 를 따라다니는 값만 담는다(ABI 8, S3a 실측).
    const envFile = join(egoHostPaths(adkDir, "linux").agentWorkspace, ".env");
    expect(existsSync(envFile), "작업 공간 .env 가 없다").toBe(true);
    const envBody = readFileSync(envFile, "utf8");
    expect(envBody).toContain("EGO_BROWSER_AGENT_WORKSPACE=");
    expect(envBody, "단일 사용 토큰이 파일로 남았다").not.toContain("EGO_HOST_TOKEN");
    expect(envBody, "실행마다 다른 값이 파일로 남았다").not.toContain("EGO_HOST_OPERATION_ID");
    // 모든 ADK 가 공유하는 SDK 쪽 `.env` 는 만들지 않는다 — 남의 ADK 의 기본값이 된다.
    expect(
      existsSync(join(EGO_HOST, "vendor", "ego-lite", "package", "ego-browser", "dist", ".env")),
      "공유 자리에 .env 를 남겼다",
    ).toBe(false);

    // 공간과 탭은 남는다(계약 4.8). 다음 작업이 같은 공간에서 그대로 돈다.
    const after = await service.snapshot(request({ capability: "observe" }));
    expect(after.ok, `강제 종료 뒤 같은 공간에 못 붙었다: ${JSON.stringify(after)}`).toBe(true);
    if (!after.ok || after.operation.evidence?.kind !== "browser") return;
    expect(after.operation.evidence.value.url).toBe(`${origin}/`);
  }, 180_000);

  it("낡은 참조(stale ref)와 개정 불일치는 다른 페이지에 작용하지 않고 형식 있는 오류로 끝난다", async () => {
    const opened = await service.open(request(), `${origin}/`);
    expect(opened.ok).toBe(true);
    const snapped = await service.snapshot(request({ capability: "observe" }));
    expect(snapped.ok).toBe(true);
    if (!snapped.ok || snapped.operation.evidence?.kind !== "browser") return;
    const buttonRef = refOf(snapped.operation.evidence.value.snapshotRef, /button "보내기"/);
    const revisionBefore = snapped.operation.evidence.value.urlRevision;

    // 다른 페이지로 옮긴 뒤 옛 참조로 누른다 — 그 요소는 이제 없다.
    const moved = await service.navigate(request(), `${origin}/second`);
    expect(moved.ok).toBe(true);
    const stale = await service.click(request(), { kind: "reference", ref: buttonRef });
    expect(stale.ok, "낡은 참조가 다른 페이지에서 통했다").toBe(false);
    if (stale.ok) return;
    expect(stale.rejections[0]?.code).toBe("context-mismatch");

    // 개정 불일치 — 기대한 개정이 아니면 아예 작용하지 않는다.
    const mismatch = await service.snapshot(request({ capability: "observe", expectedRevision: revisionBefore }));
    expect(mismatch.ok, "낡은 개정으로 작용했다").toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.rejections[0]?.code).toBe("context-mismatch");

    // 둘째 페이지는 그대로다 — 실패한 조작이 페이지를 바꾸지 않았다.
    const still = await service.evaluate(request(), { expression: "document.title" });
    expect(still.ok).toBe(true);
    if (!still.ok) return;
    expect(still.operation.result).toBe(JSON.stringify("naia 582 둘째"));
  }, 180_000);

  it("작업 id 와 자원 id 가 증거·장부에서 일치한다", async () => {
    const req = request();
    const opened = await service.open(req, `${origin}/`);
    expect(opened.ok).toBe(true);
    if (!opened.ok || opened.operation.evidence?.kind !== "browser") return;
    const evidence = opened.operation.evidence.value;
    expect(opened.operation.operationId).toBe(req.operationId);
    // 증거 파일 이름이 작업 id 로 시작한다(계약 4.5 `<operationId>-<n>`).
    expect(basename(evidence.snapshotRef).startsWith(`${req.operationId}-`)).toBe(true);
    expect(basename(evidence.screenshotRef).startsWith(`${req.operationId}-`)).toBe(true);
    // 자원 id — 어댑터가 만든 공간이 목록에도 같은 id 로 있다.
    const listed = await service.listWorkspaces(request({ capability: "observe" }));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((w) => w.id)).toContain(workspaceId);
    expect(listed.value.every((w) => w.mode === "headless" && w.ownership === "agent")).toBe(true);
  }, 180_000);

  it("승인 없는 묶음 실행은 포트에 닿기 전에 거부된다", async () => {
    expect(environment).not.toBeNull();
    if (!environment) return;
    let calls = 0;
    const counting: BrowserScriptPort = {
      script: (req, code, signal) => {
        calls += 1;
        return environment!.script(req, code, signal);
      },
    };
    const guarded = new EnvironmentToolService(
      environment.operationPort(),
      noTerminal,
      environment,
      ALL_TIERS,
      environment.workspacePort(),
      counting,
    );
    const outcome = await guarded.script(request(), "console.log('돌면 안 된다')");
    expect(outcome.ok, "승인 없이 묶음 실행이 통과했다").toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejections[0]?.code).toBe("approval-missing");
    expect(calls, "거부인데 포트가 불렸다").toBe(0);
  }, 60_000);

});

// ── spawn 시점 환경 (ABI 8 의 `**S3a**` 두 행) ──────────────────────────────

describe("#582 ADK 별 절대 경로 환경 주입 (S3a)", () => {
  const base = {
    platform: "linux" as const,
    socketPath: "/run/user/1000/naia-ego-host-abc.sock",
    token: "t-1",
    grant: { tier: "workspace-write" as const },
    operationId: "op-1",
    workspaceId: "3",
    deadlineMs: 13_000,
  };

  it("상대 경로·공백 든 경로·빈 cwd 에서 같은 결과가 나온다", () => {
    const absolute = "/var/home/luke/naia adk";
    expect(resolveAdkDir(absolute, "", "linux")).toBe(absolute);
    expect(resolveAdkDir(absolute, "/somewhere/else", "linux")).toBe(absolute);
    expect(resolveAdkDir("./naia adk", "/var/home/luke", "linux")).toBe(absolute);
    expect(resolveAdkDir("../luke/naia adk", "/var/home/other", "linux")).toBe(absolute);
    const fromAbsolute = egoLaunchEnv({ ...base, adkDir: resolveAdkDir(absolute, "", "linux") });
    const fromRelative = egoLaunchEnv({ ...base, adkDir: resolveAdkDir("./naia adk", "/var/home/luke", "linux") });
    expect(fromRelative).toEqual(fromAbsolute);
    // 빈 cwd 에서 상대 경로는 자리를 추측하지 않고 형식 있게 거부한다.
    expect(() => resolveAdkDir("./naia adk", "", "linux")).toThrow(/절대 작업 디렉터리/);
  });

  it("학습 루트와 `~` 확장 변수가 ADK 아래 절대 경로로 잡힌다", () => {
    const adk = "/var/home/luke/naia adk";
    const env = egoLaunchEnv({ ...base, adkDir: adk });
    expect(env.HOME).toBe(`${adk}/ego-host`);
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.EGO_BROWSER_AGENT_WORKSPACE).toBe(`${adk}/ego-host/agent-workspace`);
    expect(env.EGO_HOST_EVIDENCE_DIR).toBe(`${adk}/ego-host/evidence`);
    expect(egoHostPaths(adk, "linux").learnings).toBe(`${adk}/ego-host/agent-workspace/learnings`);
    expect(env.EGO_HOST_SOCKET).toBe(base.socketPath);
    expect(env.EGO_HOST_TOKEN).toBe("t-1");
    expect(env.EGO_HOST_DEADLINE_MS).toBe("13000");
    expect(JSON.parse(env.EGO_HOST_GRANT ?? "null")).toEqual({ tier: "workspace-write" });
  });

  it("윈도우는 USERPROFILE 로, 경로는 역슬래시로 잡힌다 (계약 4.9)", () => {
    const adk = "C:\\Users\\luke\\naia adk";
    const env = egoLaunchEnv({ ...base, platform: "win32", adkDir: resolveAdkDir(adk, "", "win32") });
    expect(env.USERPROFILE).toBe("C:\\Users\\luke\\naia adk\\ego-host");
    expect(env.HOME).toBeUndefined();
    expect(env.EGO_BROWSER_AGENT_WORKSPACE).toBe("C:\\Users\\luke\\naia adk\\ego-host\\agent-workspace");
    expect(joinPath("win32", adk, "ego-host", "lease.json")).toBe("C:\\Users\\luke\\naia adk\\ego-host\\lease.json");
  });
});

const noTerminal: TerminalOperationPort = {
  async exec() {
    throw new Error("이 테스트는 터미널을 쓰지 않는다");
  },
};
