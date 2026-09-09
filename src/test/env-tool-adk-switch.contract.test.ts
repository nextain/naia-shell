// #582 UC-ENV-TOOL-RECOVER — ADK 전환 순서 (계약 4.8, 9절 S3b).
//
// 재는 것은 하나다: **A 가 정말 내려간 뒤에만 B 를 건드린다.** "종료를 요청했다"는 기준이 아니다.
// A 의 Chromium 이 살아 있는데 B 를 시작하면 그 순간 고아가 하나 생기고, B 의 lease 가 A 의
// 것을 덮어써 영영 회수할 수 없게 된다.
//
// 순서를 어겼을 때를 시험하려면 어기는 길이 있어야 한다. 그래서 마지막 케이스는 감독자 모듈
// 자리에 **내려가지 않는 감독자**를 꽂는다(어댑터의 `loadApi` 이음매). 실제 Chromium 을 억지로
// 살려 두는 것보다 정확하고, 실패했을 때 사람의 프로세스를 건드리지 않는다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo, Socket } from "node:net";
import {
  createEgoBrowserEnvironment,
  egoHostPaths,
  type EgoBrowserEnvironment,
  type EgoHostApi,
} from "../main/adapters/ego-browser-env.js";
import type { EnvOperationRequest } from "../main/domain/env-tool.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const EGO_HOST = join(REPO_ROOT, "packages", "ego-host");

const PAGE = `<!doctype html><meta charset="utf-8"><title>전환</title><body><h1>전환 픽스처</h1></body>`;

let fixture: Server;
let origin = "";
const hangingSockets: Socket[] = [];
const temps: string[] = [];
const running: EgoBrowserEnvironment[] = [];
let executable = "";

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

let seq = 0;
function request(workspaceId: string, over: Partial<EnvOperationRequest> = {}): EnvOperationRequest {
  seq += 1;
  return {
    operationId: `s3b-op-${seq}`,
    idempotencyKey: `s3b-key-${seq}`,
    capability: "workspace-write",
    timeoutMs: 60_000,
    workspaceId,
    ...over,
  };
}

async function requireChromium(): Promise<string> {
  const discovery = (await import(
    /* @vite-ignore */ pathToFileURL(join(EGO_HOST, "src", "supervisor", "browser-discovery.mjs")).href
  )) as { discoverBrowser(options: Record<string, unknown>): { executable: string } };
  return discovery.discoverBrowser({}).executable;
}

function makeEnvironment(adkDir: string, over: Record<string, unknown> = {}): EgoBrowserEnvironment {
  const environment = createEgoBrowserEnvironment({
    adkDir,
    platform: "linux",
    cwd: REPO_ROOT,
    executable,
    runtimeDir: tempDir("ego-run-"),
    baseEnv: { PATH: process.env.PATH ?? "" },
    ...over,
  });
  running.push(environment);
  return environment;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

beforeAll(async () => {
  fixture = createServer((req, res) => {
    if ((req.url ?? "/").startsWith("/slow")) {
      hangingSockets.push(req.socket);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", () => done()));
  origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  // Chromium 이 없으면 건너뛰지 않고 RED 다.
  executable = await requireChromium();
}, 120_000);

afterAll(async () => {
  const owned: number[] = [];
  for (const environment of running.splice(0)) {
    const pid = environment.browserPid;
    if (pid !== null) owned.push(pid);
    try {
      await environment.stop();
    } catch {
      /* 이미 내려갔다 */
    }
  }
  for (const socket of hangingSockets.splice(0)) socket.destroy();
  await new Promise<void>((done) => fixture?.close(() => done()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  // 전환은 감독자를 둘 다루므로 고아가 생기기 가장 쉬운 자리다. 내린 **뒤** 직접 잰다.
  // 재는 대상은 **이 파일이 띄운 PID** 다 — `pgrep` 으로 기계 전체를 훑으면 나란히 도는 다른
  // 테스트 파일의 살아 있는 브라우저를 우리 고아로 읽는다(vitest 는 파일을 병렬로 돌린다).
  const orphans = owned.filter((pid) => pidAlive(pid));
  if (orphans.length > 0) throw new Error(`이 파일이 띄운 브라우저가 남았다: ${orphans.join(", ")}`);
}, 60_000);

describe("#582 ADK 전환 (S3b)", () => {
  it("A 의 감독자를 정상 종료한 뒤에만 B 의 lease 를 조정하고 B 를 시작한다", async () => {
    const adkA = tempDir("ego a-");
    const adkB = tempDir("ego b-");
    const a = makeEnvironment(adkA);
    await a.start();
    const workspace = await a.createWorkspace(request("전환-A"));
    await a.open(request(workspace.id), `${origin}/`);

    const pathsA = egoHostPaths(adkA, "linux");
    const pathsB = egoHostPaths(adkB, "linux");
    expect(existsSync(pathsA.leasePath), "A 의 lease 가 없다 — 전환할 대상이 없다").toBe(true);
    expect(existsSync(pathsB.leasePath), "전환 전인데 B 에 lease 가 있다").toBe(false);

    const report = await a.switchAdk(adkA, adkB);
    running.push(report.next as EgoBrowserEnvironment);

    // A 의 Chromium 이 실제로 사라졌다.
    expect(report.stoppedPid).not.toBeNull();
    expect(pidAlive(report.stoppedPid as number), "A 의 Chromium 이 남았다").toBe(false);
    // A 의 lease 는 지워지고 B 의 lease 가 생겼다.
    expect(existsSync(pathsA.leasePath), "A 의 lease 가 남았다").toBe(false);
    expect(existsSync(pathsB.leasePath), "B 의 lease 가 없다 — B 가 시작되지 않았다").toBe(true);
    // B 는 A 의 흔적을 찾을 것이 없다(조정 결과가 그렇게 말한다).
    expect(report.reconciliation.status).toBe("no-lease");
    expect(report.reconciliation.orphans).toBe(0);

    // 전환한 어댑터는 되살아나지 않는다 — 다음 요청이 A 를 조용히 다시 띄우면 ADK 가 둘이 된다.
    expect(a.isRunning).toBe(false);
    await expect(a.snapshot(request(workspace.id))).rejects.toMatchObject({ reason: "disconnected" });

    // B 는 자기 자리에서 새로 돈다.
    const next = report.next as EgoBrowserEnvironment;
    const spaceB = await next.createWorkspace(request("전환-B"));
    const evidence = await next.open(request(spaceB.id), `${origin}/`);
    expect(evidence.url).toBe(`${origin}/`);
    expect(evidence.snapshotRef.startsWith(pathsB.evidenceDir), "B 의 증거가 B 아래가 아니다").toBe(true);
  }, 180_000);

  it("A 의 lease 파일이 B 아래로 새지 않는다", async () => {
    const adkA = tempDir("ego a-");
    const adkB = tempDir("ego b-");
    const a = makeEnvironment(adkA);
    await a.start();
    const pathsA = egoHostPaths(adkA, "linux");
    const pathsB = egoHostPaths(adkB, "linux");
    const leaseA = JSON.parse(readFileSync(pathsA.leasePath, "utf8")) as Record<string, string>;
    expect(leaseA.profileDir.startsWith(pathsA.egoHostDir)).toBe(true);

    const report = await a.switchAdk(adkA, adkB);
    running.push(report.next as EgoBrowserEnvironment);

    const leaseB = JSON.parse(readFileSync(pathsB.leasePath, "utf8")) as Record<string, string>;
    expect(leaseB.nonce, "B 가 A 의 nonce 를 물려받았다").not.toBe(leaseA.nonce);
    expect(leaseB.pid, "B 가 A 의 PID 를 물려받았다").not.toBe(leaseA.pid);
    expect(leaseB.profileDir.startsWith(pathsB.egoHostDir), "B 의 프로필이 A 아래에 있다").toBe(true);
    expect(leaseB.socketPath, "두 ADK 가 같은 소켓을 쓴다").not.toBe(leaseA.socketPath);
    // A 아래에는 lease 도, B 를 가리키는 무엇도 남지 않는다.
    expect(existsSync(pathsA.leasePath)).toBe(false);
    expect(readFileSync(pathsB.leasePath, "utf8")).not.toContain(pathsA.egoHostDir);
  }, 180_000);

  it("전환 중 A 의 진행 중 작업이 형식 있게 끝난다", async () => {
    const adkA = tempDir("ego a-");
    const adkB = tempDir("ego b-");
    const a = makeEnvironment(adkA);
    await a.start();
    const workspace = await a.createWorkspace(request("전환-중"));
    await a.open(request(workspace.id), `${origin}/`);

    // 응답하지 않는 페이지로 이동을 걸어 두고 그 위에서 전환한다.
    const inflight = a.navigate(request(workspace.id), `${origin}/slow`);
    const settled = inflight.then(
      () => ({ ok: true, reason: "" }),
      (error: { reason?: string }) => ({ ok: false, reason: error.reason ?? "" }),
    );
    await new Promise((done) => setTimeout(done, 700));

    const report = await a.switchAdk(adkA, adkB);
    running.push(report.next as EgoBrowserEnvironment);

    const result = await settled;
    expect(result.ok, "감독자가 내려갔는데 진행 중 작업이 성공으로 끝났다").toBe(false);
    // 형식 있는 사유여야 한다. 문자열로 뭉개면 전환과 페이지 오류를 구별하지 못한다.
    expect(["cancelled", "disconnected"]).toContain(result.reason);
  }, 180_000);

  it("A 가 살아 있으면 B 의 lease 를 건드리지도 않는다 (순서 강제)", async () => {
    const adkA = tempDir("ego a-");
    const adkB = tempDir("ego b-");
    let reconciled = 0;
    // 내려가지 않는 감독자. `stop()` 이 성공한 척하지만 Chromium PID 는 계속 살아 있다.
    const stubbornApi: EgoHostApi = {
      async startSupervisor() {
        return {
          socketPath: "/tmp/naia-ego-stub.sock",
          browserPid: process.pid, // 확실히 살아 있는 PID — 이 프로세스 자신이다.
          server: {
            issueToken: () => "stub-token",
            operations: {
              async cancel() {
                return { changed: false, status: "unknown", cleanup: null };
              },
              async complete() {
                return { changed: false, status: "unknown", cleanup: null };
              },
              list: () => [],
            },
          },
          browser: { on: () => undefined },
          async stop() {
            return { alreadyStopped: false };
          },
        };
      },
      async connectSupervisor() {
        throw new Error("이 케이스는 연결하지 않는다");
      },
      async reconcileLease() {
        reconciled += 1;
        return { status: "no-lease", orphans: 0, note: "" };
      },
      ensureDirs: () => undefined,
      pidAlive: (pid: number) => pidAlive(pid),
      waitForPidExit: async (pid: number) => !pidAlive(pid),
      writeEnvFiles: () => [],
      async runEgoScript() {
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
      DEFAULT_SDK_DIR: "",
    };
    const a = createEgoBrowserEnvironment({
      adkDir: adkA,
      platform: "linux",
      cwd: REPO_ROOT,
      loadApi: async () => stubbornApi,
    });
    await a.start();

    await expect(a.switchAdk(adkA, adkB)).rejects.toMatchObject({ reason: "disconnected" });
    expect(reconciled, "A 가 살아 있는데 B 의 lease 를 조정했다").toBe(0);
    expect(existsSync(egoHostPaths(adkB, "linux").leasePath), "B 에 lease 가 생겼다").toBe(false);
  }, 60_000);
});
