// #582 S2b — 감독자 조립 (계약 4.8·4.9).
//
// 순서가 계약이다. 시작은 조정 → 탐색 → 런처 → lease 기록 → 소켓 서버다.
//  - 조정이 먼저인 이유: 이전 감독자의 Chromium 이 살아 있는 채로 새 브라우저를 띄우면 그 순간
//    고아가 하나 생기고, 다음 lease 가 이전 lease 를 덮어써 영영 회수할 수 없게 된다.
//  - lease 기록이 소켓보다 먼저인 이유: 소켓이 열리면 CLI 가 붙기 시작한다. 그 전에 소유가
//    파일에 남아 있어야 그 사이 감독자가 죽어도 다음 시작이 회수할 수 있다.
//
// 종료는 `Browser.close` → 대기 → 남으면 프로세스 종료 → lease 삭제다. 프로필 디렉터리는
// 남긴다(다음 시작이 같은 프로필을 다시 쓴다. 지우는 것은 사람의 결정이다).
//
// 감독자가 SIGKILL 로 죽으면 이 파일은 아무것도 못 한다. 그때 Chromium 을 내리는 것은
// **파이프 EOF** 다(chrome-launcher.mjs 머리 주석). 이 슬라이스의 테스트가 그 사실을 실측한다.
import { mkdirSync } from "node:fs";
import { discoverBrowser } from "./browser-discovery.mjs";
import { launchBrowser } from "./chrome-launcher.mjs";
import {
  createLease,
  defaultProfileDir,
  egoHostDir,
  newNonce,
  removeLease,
  writeLease,
} from "./lease.mjs";
import { createMediator } from "./mediator.mjs";
import { reconcileLease } from "./reconcile.mjs";
import { createSupervisorServer } from "./rpc-server.mjs";
import { socketNeedsUnlink, supervisorSocketPath } from "./socket-path.mjs";

/** `Browser.close` 뒤 Chromium 이 스스로 나갈 때까지 기다리는 시간. */
export const STOP_GRACE_MS = 5_000;

/**
 * 감독자 하나를 띄운다.
 *
 * @param {object} options
 * @param {string} options.adkDir            `<ADK>` 루트. lease·프로필·소켓 이름이 여기서 나온다.
 * @param {string} [options.platform]
 * @param {boolean} [options.adopt]          조정에서 우리 것을 죽이지 않고 물려받는다.
 * @param {string} [options.executable]      주면 탐색을 건너뛴다.
 * @param {string} [options.profileDir]
 * @param {string} [options.runtimeDir]      소켓 디렉터리(unix 경로 상한 때문에 짧아야 한다).
 * @returns {Promise<object>} 감독자 핸들
 */
export async function startSupervisor({
  adkDir,
  platform = process.platform,
  env = process.env,
  adopt = false,
  executable = null,
  profileDir = null,
  runtimeDir = null,
  headless = true,
  route = null,
  routeFactory = null,
  /**
   * CDP 통로에 껍질을 씌운다. **테스트 전용 이음매**다(운영 경로는 null).
   * 계약 4.3.1 이 요구하는 "응답→이벤트 / 이벤트→응답 두 순서"는 Chromium 이 정하는 것이라
   * 밖에서 강제할 자리가 필요하고, 예기치 않은 자식 attach 는 auto-attach 를 켜야만 생기는데
   * 우리는 절대 켜지 않으므로 결함 주입 자리도 필요하다. 그 둘이 이 인자의 전부다.
   */
  wrapBackend = null,
  server: serverOptions = {},
} = {}) {
  if (!adkDir) throw new Error("startSupervisor 에 adkDir 이 필요하다");

  // 1) 조정 — 이전 감독자의 흔적을 먼저 정리한다.
  const reconciliation = await reconcileLease({ adkDir, adopt, platform });

  // 2) 탐색
  const discovery = executable
    ? { executable, candidate: { id: "explicit-arg", kind: "explicit", path: executable }, candidates: [] }
    : discoverBrowser({ platform, env });

  // 3) 런처
  const resolvedProfile = profileDir ?? defaultProfileDir(adkDir);
  mkdirSync(egoHostDir(adkDir), { recursive: true });
  mkdirSync(resolvedProfile, { recursive: true });
  const nonce = newNonce();
  const browser = launchBrowser({
    executable: discovery.executable,
    profileDir: resolvedProfile,
    headless,
    marker: nonce,
    env,
  });

  const socket = supervisorSocketPath({ adkRoot: adkDir, platform, runtimeDir, env });

  // 4) lease 기록 — 소켓을 열기 전에.
  const lease = createLease({
    nonce,
    pid: browser.pid,
    executable: discovery.executable,
    profileDir: resolvedProfile,
    socketPath: socket.path,
  });
  writeLease(adkDir, lease);

  // Chromium 이 예기치 않게 죽으면 lease 는 거짓이 된다. 즉시 지워 다음 시작이 유령을 쫓지 않게.
  let browserExited = false;
  browser.on("exit", () => {
    browserExited = true;
    try {
      removeLease(adkDir);
    } catch {}
  });

  // 5) 소켓 서버 — 장부는 `<ADK>` 에 원자적으로 저장되고, 정책 훅은 그 장부를 본다.
  const server = createSupervisorServer({
    backend: wrapBackend ? wrapBackend(browser) : browser,
    adkDir,
    // 기본 정책 = 중계기(기본 거부 행렬, 계약 4.3.2). 가짜 백엔드 테스트는 route 를 직접 준다.
    ...(route
      ? { route }
      : {
          routeFactory:
            routeFactory ??
            (({ ledger, operations, adkDir: dir }) =>
              // S2e: 작업 장부가 중계기의 `operationHook` 자리에 들어온다.
              createMediator({ ledger, adkDir: dir, operationHook: operations?.hook ?? null })),
        }),
    ...serverOptions,
  });
  // 지난 감독자의 장부가 남아 있으면 죽은 컨텍스트를 걷어낸다. 새 Chromium 은 옛 컨텍스트를 모른다.
  const ledgerRestore = await server.ledger.restore();
  await server.listen(socket.path, { kind: socket.kind });

  let stopped = false;
  async function stop({ graceMs = STOP_GRACE_MS } = {}) {
    if (stopped) return { alreadyStopped: true };
    stopped = true;
    let closeRequested = false;
    if (!browserExited) {
      try {
        // 응답을 기다리지 않는다. Browser.close 는 응답보다 파이프 종료가 먼저 오는 편이다.
        server.mux.hostRequest("Browser.close").catch(() => {});
        closeRequested = true;
      } catch {
        /* 이미 나갔다 */
      }
    }
    const deadline = Date.now() + graceMs;
    while (!browserExited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 그래도 남으면 파이프를 닫아 EOF 를 주고, 그래도 남으면 신호를 보낸다.
    if (!browserExited) {
      browser.close();
      const hard = Date.now() + graceMs;
      while (!browserExited && Date.now() < hard) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    let forced = false;
    if (!browserExited) {
      browser.kill("SIGKILL");
      forced = true;
      await Promise.race([browser.exited, new Promise((resolve) => setTimeout(resolve, graceMs))]);
    }
    // 스트림 핸들까지 걷어낸다. 남기면 감독자 프로세스가 종료하지 못하고 매달린다.
    browser.dispose();
    await server.close();
    if (socketNeedsUnlink(socket.kind)) {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(socket.path, { force: true });
      } catch {}
    }
    try {
      removeLease(adkDir);
    } catch {}
    return { closeRequested, forced, browserExited };
  }

  return {
    adkDir,
    reconciliation,
    discovery,
    executable: discovery.executable,
    browser,
    browserPid: browser.pid,
    profileDir: resolvedProfile,
    nonce,
    marker: lease.marker,
    lease,
    socketPath: socket.path,
    socketKind: socket.kind,
    server,
    ledger: server.ledger,
    ledgerRestore,
    stop,
  };
}
