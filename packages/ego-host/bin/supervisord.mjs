#!/usr/bin/env node
// #582 S6c — 감독자 데몬 진입점 (계약 4.8, 9절 S6c).
//
// 셸의 Rust 가 이 파일을 **소유 자식**으로 띄운다. 하는 일은 셋뿐이다.
//
//   1. `startSupervisor({adkDir})` 로 감독자 하나를 세우고 관리 비밀을 그 소켓에 붙인다.
//   2. 준비됐다는 사실을 stdout 한 줄(JSON)로 알린다. 소켓 경로와 브라우저 PID 가 그 줄에 있다.
//   3. stdin EOF 또는 SIGTERM 에 `stop()` 하고 나간다.
//
// ## 왜 데몬인가 — S3a 의 "동적 import" 와 무엇이 다른가
//
// S3a 는 감독자를 셸 **코어 프로세스 안**에서 돌렸다. 그것은 코어가 node 위에서 도는 조립
// (계약 테스트)에서만 성립한다. 실제 셸의 코어는 **웹뷰 안**에서 돌고 웹뷰에는 node 가 없다.
// 그래서 node 가 필요한 쪽을 프로세스 하나로 떼어 내고, 웹뷰는 Tauri 명령으로만 말한다.
//
// 소유 단계가 하나 늘어나는 대가는 lease 가 문다 — 감독자·Chromium 은 marker 로 회수되고
// (S6b), 이 데몬이 죽으면 파이프 EOF 가 Chromium 을 약 200ms 안에 내린다(S2b 실측).
//
// ## 비밀
//
// 관리 비밀은 `EGO_HOST_ADMIN_SECRET` 환경으로만 들어온다. 읽는 즉시 `process.env` 에서
// 지우고, 로그·lease·`.env`·ready 줄 어디에도 싣지 않는다. 이 파일에 비밀을 찍는 줄이
// 하나라도 생기면 그 순간 소유자 전용 통로가 파일 하나로 열린다.
import { startSupervisor } from "../src/supervisor/supervisor.mjs";
import { reconcileLease } from "../src/supervisor/reconcile.mjs";
import { egoHostDir } from "../src/supervisor/lease.mjs";
import { evidenceDir } from "../src/supervisor/ax-snapshot.mjs";
import {
  ensureDirs,
  runEgoScript,
  waitForPidExit,
  writeEnvFiles,
} from "../src/client/script-runner.mjs";
import { join } from "node:path";

/** 인자 해석. `--adk <dir>` 만 필수다. */
export function parseArgs(argv) {
  const options = { adkDir: null, platform: process.platform, runtimeDir: null, executable: null };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--adk") options.adkDir = args.shift() ?? null;
    else if (arg === "--platform") options.platform = args.shift() ?? process.platform;
    else if (arg === "--runtime-dir") options.runtimeDir = args.shift() ?? null;
    else if (arg === "--executable") options.executable = args.shift() ?? null;
    else return { error: `알 수 없는 인자: ${arg}` };
  }
  if (!options.adkDir) return { error: "--adk <dir> 이 필요하다" };
  return options;
}

/** ADK 아래에서 감독자가 쓰는 자리들. 없으면 벤더가 `.env` 를 영영 못 읽는다(ABI 8). */
export function hostDirs(adkDir) {
  const host = egoHostDir(adkDir);
  const workspace = join(host, "agent-workspace");
  return [host, evidenceDir(adkDir), workspace, join(workspace, "learnings")];
}

/**
 * 데몬 하나. 감독자를 세우고 관리 RPC 를 붙인다.
 *
 * `switchAdk` 가 감독자를 갈아 끼우므로 현재 감독자는 변수 하나로 든다 — 이 변수가 곧
 * "지금 어느 ADK 를 소유하는가" 다. 두 벌을 두면 A 를 내리기 전에 B 가 뜨는 길이 생긴다.
 */
export async function createDaemon({ adkDir, platform, runtimeDir, executable, adminSecret }) {
  let current = null;
  let currentAdk = adkDir;

  async function start(dir) {
    ensureDirs(hostDirs(dir));
    const supervisor = await startSupervisor({
      adkDir: dir,
      platform,
      ...(executable ? { executable } : {}),
      ...(runtimeDir ? { runtimeDir } : {}),
      server: { adminSecret },
    });
    supervisor.server.setAdminHandlers(adminHandlers);
    current = supervisor;
    currentAdk = dir;
    return supervisor;
  }

  const adminHandlers = {
    hostInfo: () => ({
      adkDir: currentAdk,
      socketPath: current?.socketPath ?? null,
      socketKind: current?.socketKind ?? null,
      browserPid: current?.browserPid ?? null,
      executable: current?.executable ?? null,
      pid: process.pid,
    }),
    ensureDirs: (params) => {
      ensureDirs(Array.isArray(params?.dirs) ? params.dirs : []);
      return { ok: true };
    },
    writeEnvFiles: (params) => ({
      written: writeEnvFiles(Array.isArray(params?.files) ? params.files : []),
    }),
    reconcileLease: async (params) =>
      reconcileLease({ adkDir: params?.adkDir ?? currentAdk, platform }),
    waitForPidExit: async (params) => ({
      exited: await waitForPidExit(Number(params?.pid), Number(params?.timeoutMs ?? 10_000)),
    }),
    runScript: async (params) => {
      // 시한은 호출자가 준다. 환경도 호출자가 완성해서 준다 — 여기서 `process.env` 를 섞으면
      // 데몬이 가진 변수(관리 비밀 포함)가 에이전트 브라우저로 샌다.
      const run = await runEgoScript({
        code: String(params?.code ?? ""),
        env: params?.env ?? {},
        timeoutMs: Number(params?.timeoutMs ?? 30_000),
      });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr, timedOut: run.timedOut };
    },
    /**
     * ADK 전환 (계약 4.8). 순서가 계약이다 —
     * A 정상 종료 → A 의 Chromium 소멸 확인 → B 의 lease 조정 → B 시작.
     * 순서를 어기면 그 순간 고아가 하나 생기고 B 의 lease 가 A 의 것을 덮어써 회수 수단이 사라진다.
     */
    switchAdk: async (params) => {
      const from = String(params?.from ?? currentAdk);
      const to = String(params?.to ?? "");
      if (!to) throw new Error("switchAdk 에 도착지(to)가 없다");
      if (to === from) throw new Error(`같은 ADK 로는 전환하지 않는다: ${to}`);
      if (from !== currentAdk) {
        throw new Error(`전환 출발지(${from})가 지금 소유한 ADK(${currentAdk})가 아니다`);
      }
      const stoppedPid = current?.browserPid ?? null;
      if (current) await current.stop();
      current = null;
      if (stoppedPid !== null && !(await waitForPidExit(stoppedPid, 10_000))) {
        throw new Error(
          `이전 ADK(${from})의 Chromium(PID ${stoppedPid})이 아직 살아 있다. ` +
            "A 가 살아 있는 동안에는 B 의 lease 를 건드리지도, B 를 시작하지도 않는다",
        );
      }
      const reconciliation = await reconcileLease({ adkDir: to, platform });
      const next = await start(to);
      return {
        from,
        to,
        stoppedPid,
        reconciliation,
        socketPath: next.socketPath,
        browserPid: next.browserPid,
      };
    },
    stop: async () => {
      const result = current ? await current.stop() : { alreadyStopped: true };
      current = null;
      return { stopped: true, ...result };
    },
  };

  const supervisor = await start(adkDir);
  return {
    get supervisor() {
      return current;
    },
    get adkDir() {
      return currentAdk;
    },
    ready: {
      ready: true,
      pid: process.pid,
      adkDir,
      socketPath: supervisor.socketPath,
      socketKind: supervisor.socketKind,
      browserPid: supervisor.browserPid,
      executable: supervisor.executable,
    },
    async shutdown() {
      if (!current) return;
      const handle = current;
      current = null;
      await handle.stop();
    },
  };
}

/** 이 파일이 직접 실행됐는가. import 로 들어온 테스트는 main 을 돌리지 않는다. */
function isDirectRun() {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("supervisord.mjs");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    process.stdout.write(`${JSON.stringify({ ready: false, error: options.error })}\n`);
    process.exit(2);
  }
  const adminSecret = process.env.EGO_HOST_ADMIN_SECRET ?? "";
  // 읽는 즉시 지운다. 자식 프로세스(런처)가 환경을 물려받는 길을 여기서 끊는다.
  delete process.env.EGO_HOST_ADMIN_SECRET;
  if (!adminSecret) {
    process.stdout.write(
      `${JSON.stringify({ ready: false, error: "EGO_HOST_ADMIN_SECRET 이 없다. 관리 통로 없는 감독자는 띄우지 않는다" })}\n`,
    );
    process.exit(2);
  }

  let daemon;
  try {
    daemon = await createDaemon({ ...options, adminSecret });
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ready: false, error: error?.message ?? String(error) })}\n`,
    );
    process.exit(1);
    return;
  }
  process.stdout.write(`${JSON.stringify(daemon.ready)}\n`);

  let closing = false;
  const shutdown = async (reason) => {
    if (closing) return;
    closing = true;
    process.stderr.write(`[ego-host] 종료: ${reason}\n`);
    try {
      await daemon.shutdown();
    } catch (error) {
      process.stderr.write(`[ego-host] 종료 정리 실패: ${error?.message ?? error}\n`);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // stdin EOF 는 부모가 사라졌다는 뜻이다. 신호가 오지 않는 경로(Windows 포함)에서 이것이
  // 유일한 통보이므로 반드시 읽는다. `resume()` 없이는 `end` 가 오지 않는다.
  process.stdin.resume();
  process.stdin.on("end", () => void shutdown("stdin EOF"));
  process.stdin.on("close", () => void shutdown("stdin close"));
  process.stdin.on("error", () => void shutdown("stdin error"));
}

if (isDirectRun()) {
  main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ ready: false, error: error?.message ?? String(error) })}\n`,
    );
    process.exit(1);
  });
}
