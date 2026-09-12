// #582 S2b — lease·시작 조정·감독자 생명주기 (계약 4.8·4.9).
//
// 이 파일이 답하는 질문은 하나다: **감독자가 어떻게 죽어도 고아 Chromium 이 남지 않는가.**
// 정상 종료(stop)·크래시(SIGKILL)·재시작(조정) 세 갈래를 실제 프로세스로 확인한다.
// 실브라우저가 없으면 건너뛰지 않고 RED 다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  cmdlineHasToken,
  createLease,
  defaultProfileDir,
  isAlive,
  leasePath,
  markerArg,
  markerState,
  readLease,
  removeLease,
  writeLease,
} from "../src/supervisor/lease.mjs";
import { RECONCILE_STATUS, reconcileLease } from "../src/supervisor/reconcile.mjs";
import { startSupervisor } from "../src/supervisor/supervisor.mjs";
import { alive, cleanupAll, requireChromium, tempDir, trackPid, waitForExit } from "./helpers/live-browser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKER_SLEEP = join(HERE, "helpers", "marker-sleep.mjs");
const RUN_SUPERVISOR = join(HERE, "helpers", "run-supervisor.mjs");

after(cleanupAll);

/** marker 를 명령줄에 단 진짜 프로세스 하나. 조정이 "죽인다/안 죽인다"를 실물로 판정한다. */
function spawnMarked(marker) {
  const child = spawn(process.execPath, [MARKER_SLEEP, marker], { stdio: ["ignore", "ignore", "ignore"] });
  trackPid(child.pid);
  return child;
}

async function waitUntilAlive(pid, timeoutMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// ── lease 파일 ───────────────────────────────────────────────────────────────

test("lease: 계약 4.8 의 여덟 필드를 그대로 쓰고 읽는다", () => {
  const adk = tempDir("ego-adk-");
  const lease = createLease({
    nonce: "n-1",
    pid: 1234,
    executable: "/opt/chrome",
    profileDir: "/p",
    socketPath: "/s.sock",
    supervisorPid: 99,
  });
  assert.deepEqual(Object.keys(lease).sort(), [
    "executable",
    "marker",
    "nonce",
    "pid",
    "profileDir",
    "socketPath",
    "startedAt",
    "supervisorPid",
  ]);
  assert.equal(lease.marker, markerArg("n-1"));
  writeLease(adk, lease);
  assert.deepEqual(readLease(adk), lease);
});

test("lease: 원자적으로 쓴다 — 임시 파일을 남기지 않고 덮어쓰기도 온전하다", () => {
  const adk = tempDir("ego-adk-");
  writeLease(adk, createLease({ nonce: "a", pid: 1 }));
  writeLease(adk, createLease({ nonce: "b", pid: 2 }));
  const dir = join(adk, "ego-host");
  assert.deepEqual(readdirSync(dir), ["lease.json"]);
  assert.equal(readLease(adk).nonce, "b");
  // 파일 자체가 온전한 JSON 이다(반쯤 쓰인 lease 는 소유를 판정할 수 없다).
  JSON.parse(readFileSync(join(dir, "lease.json"), "utf8"));
});

test("lease: 없으면 null, 깨졌으면 형식 있는 오류다", () => {
  const adk = tempDir("ego-adk-");
  assert.equal(readLease(adk), null);
  mkdirSync(join(adk, "ego-host"), { recursive: true });
  writeFileSync(leasePath(adk), "{ 반쯤", "utf8");
  assert.throws(() => readLease(adk), (error) => {
    assert.equal(error.error_code, "EGO_HOST_LEASE_INVALID");
    return true;
  });
  removeLease(adk);
  assert.equal(existsSync(leasePath(adk)), false);
});

// ── marker 확인: 세 OS ────────────────────────────────────────────────────────

test("marker: 리눅스는 /proc/<pid>/cmdline 을 읽고, Chromium 의 공백 이어붙인 argv 도 읽어낸다", () => {
  // 실측: Chromium 은 시작하며 argv 를 통째로 다시 써서 NUL 이 아니라 공백으로 이어 붙인다.
  const rewritten =
    "/opt/chrome --headless=new --remote-debugging-pipe --naia-ego-marker=n-1 --ozone-platform=headless";
  assert.equal(cmdlineHasToken(rewritten, markerArg("n-1")), true);
  assert.equal(cmdlineHasToken(rewritten, markerArg("n-11")), false, "접두사만 같은 nonce 를 우리 것으로 읽으면 안 된다");
  const nulSeparated = ["/opt/chrome", "--headless=new", markerArg("n-2")].join("\0");
  assert.equal(cmdlineHasToken(nulSeparated, markerArg("n-2")), true);

  const state = markerState({
    pid: 7,
    marker: markerArg("n-1"),
    platform: "linux",
    fs: { readFileSync: (path) => (path === "/proc/7/cmdline" ? rewritten : (() => { throw new Error("ENOENT"); })()) },
  });
  assert.equal(state, "match");
});

test("marker: darwin 은 ps -p <pid> -o command= 를 본다", () => {
  const calls = [];
  const state = markerState({
    pid: 8,
    marker: markerArg("n-3"),
    platform: "darwin",
    execFileSync: (cmd, args) => {
      calls.push([cmd, ...args]);
      return `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new ${markerArg("n-3")}`;
    },
  });
  assert.equal(state, "match");
  assert.deepEqual(calls, [["ps", "-p", "8", "-o", "command="]]);
  // ps 가 그 PID 를 못 찾으면 우리 것이 아니다.
  assert.equal(
    markerState({
      pid: 9,
      marker: markerArg("n-3"),
      platform: "darwin",
      execFileSync: () => {
        throw new Error("ps: no such process");
      },
    }),
    "mismatch",
  );
});

test("marker: win32 는 이번 슬라이스에서 확인하지 않고 unverified 다 (미실측)", () => {
  assert.equal(markerState({ pid: 10, marker: markerArg("n-4"), platform: "win32" }), "unverified");
});

test("marker: 실제 프로세스의 명령줄에서 marker 를 찾는다", async () => {
  const marker = markerArg("real-1");
  const child = spawnMarked(marker);
  assert.ok(await waitUntilAlive(child.pid));
  assert.equal(markerState({ pid: child.pid, marker, platform: "linux" }), "match");
  assert.equal(markerState({ pid: child.pid, marker: markerArg("other"), platform: "linux" }), "mismatch");
  assert.equal(isAlive(child.pid), true);
  child.kill("SIGKILL");
});

// ── 조정 (a)(b)(c) ───────────────────────────────────────────────────────────

test("조정 (a): PID 살아 있고 marker 일치면 회수한다", async () => {
  const adk = tempDir("ego-adk-");
  const nonce = "own-1";
  const child = spawnMarked(markerArg(nonce));
  assert.ok(await waitUntilAlive(child.pid));
  writeLease(adk, createLease({ nonce, pid: child.pid, executable: "x", profileDir: "p", socketPath: "s" }));

  const result = await reconcileLease({ adkDir: adk, platform: "linux" });
  assert.equal(result.status, RECONCILE_STATUS.RECLAIMED);
  assert.equal(result.killed, true);
  assert.equal(result.orphans, 0);
  assert.equal(result.leaseRemoved, true);
  assert.equal(existsSync(leasePath(adk)), false);
  assert.equal(alive(child.pid), false, "회수했다면 그 PID 는 없어야 한다");
});

test("조정 (a'): adopt 면 죽이지 않고 lease 를 유지한다", async () => {
  const adk = tempDir("ego-adk-");
  const nonce = "own-2";
  const child = spawnMarked(markerArg(nonce));
  assert.ok(await waitUntilAlive(child.pid));
  writeLease(adk, createLease({ nonce, pid: child.pid }));

  const result = await reconcileLease({ adkDir: adk, adopt: true, platform: "linux" });
  assert.equal(result.status, RECONCILE_STATUS.ADOPTED);
  assert.equal(result.killed, false);
  assert.equal(alive(child.pid), true);
  assert.equal(existsSync(leasePath(adk)), true);
  child.kill("SIGKILL");
});

test("조정 (b): marker 가 다른 살아 있는 프로세스는 절대 건드리지 않는다", async () => {
  const adk = tempDir("ego-adk-");
  // 남의 프로세스다 — marker 가 우리 nonce 와 다르다(PID 재사용 상황).
  const stranger = spawnMarked(markerArg("other"));
  assert.ok(await waitUntilAlive(stranger.pid));
  writeLease(adk, createLease({ nonce: "ours", pid: stranger.pid }));

  const result = await reconcileLease({ adkDir: adk, platform: "linux" });
  assert.equal(result.status, RECONCILE_STATUS.FOREIGN);
  assert.equal(result.killed, false);
  assert.equal(result.leaseRemoved, false);
  assert.match(result.note, /남의 프로세스/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(alive(stranger.pid), true, "남의 프로세스를 죽였다 — 계약 4.8 위반");
  stranger.kill("SIGKILL");
});

test("조정 (b'): marker 를 확인할 수 없는 플랫폼(win32)에서는 회수하지 않는다", async () => {
  const adk = tempDir("ego-adk-");
  const child = spawnMarked(markerArg("win-x"));
  assert.ok(await waitUntilAlive(child.pid));
  writeLease(adk, createLease({ nonce: "win-x", pid: child.pid }));

  const result = await reconcileLease({ adkDir: adk, platform: "win32" });
  assert.equal(result.status, RECONCILE_STATUS.UNVERIFIED);
  assert.equal(result.killed, false);
  assert.equal(result.orphans, 1, "확인 못 한 프로세스는 고아로 기록만 한다");
  assert.equal(alive(child.pid), true);
  child.kill("SIGKILL");
});

test("조정 (c): PID 가 없으면 lease 만 지운다 — 고아 0", async () => {
  const adk = tempDir("ego-adk-");
  const child = spawnMarked(markerArg("gone-1"));
  assert.ok(await waitUntilAlive(child.pid));
  child.kill("SIGKILL");
  assert.notEqual(await waitForExit(child.pid, 5_000), null);
  writeLease(adk, createLease({ nonce: "gone-1", pid: child.pid }));

  const result = await reconcileLease({ adkDir: adk, platform: "linux" });
  assert.equal(result.status, RECONCILE_STATUS.STALE);
  assert.equal(result.orphans, 0);
  assert.equal(existsSync(leasePath(adk)), false);
});

test("조정: 깨진 lease 는 아무 PID 도 건드리지 않고 파일만 치운다", async () => {
  const adk = tempDir("ego-adk-");
  mkdirSync(join(adk, "ego-host"), { recursive: true });
  writeFileSync(leasePath(adk), "not json", "utf8");
  const result = await reconcileLease({ adkDir: adk, platform: "linux" });
  assert.equal(result.status, RECONCILE_STATUS.UNREADABLE);
  assert.equal(result.killed, false);
  assert.equal(existsSync(leasePath(adk)), false);
});

// ── 감독자 생명주기 (실브라우저) ──────────────────────────────────────────────

test("감독자 stop(): Chromium 소멸·lease 삭제·프로필 유지", async () => {
  requireChromium();
  const adk = tempDir("ego-adk-");
  const supervisor = await startSupervisor({ adkDir: adk, runtimeDir: tempDir("ego-rt-") });
  trackPid(supervisor.browserPid);

  assert.equal(alive(supervisor.browserPid), true);
  assert.equal(existsSync(leasePath(adk)), true);
  const lease = readLease(adk);
  assert.equal(lease.pid, supervisor.browserPid);
  assert.equal(lease.socketPath, supervisor.socketPath);
  assert.equal(lease.supervisorPid, process.pid);
  assert.equal(markerState({ pid: supervisor.browserPid, marker: lease.marker, platform: "linux" }), "match");
  // 실제로 도는 브라우저다 — 응답이 온다.
  const version = await supervisor.server.mux.hostRequest("Browser.getVersion");
  assert.match(version.product, /Chrome|Chromium/);

  const stopResult = await supervisor.stop();
  assert.equal(stopResult.closeRequested, true);
  assert.equal(stopResult.forced, false, "Browser.close 로 나가야 한다 — 강제 종료는 실패 신호다");
  assert.notEqual(await waitForExit(supervisor.browserPid, 10_000), null, "stop() 뒤에도 Chromium 이 남았다");
  assert.equal(existsSync(leasePath(adk)), false, "lease 가 남았다");
  assert.equal(existsSync(supervisor.profileDir), true, "프로필 디렉터리는 남아야 한다");
  assert.equal(existsSync(supervisor.socketPath), false, "소켓 파일이 남았다");
});

test("감독자 SIGKILL: 파이프 EOF 로 Chromium 이 스스로 종료한다 (계약 4.8)", async () => {
  requireChromium();
  const adk = tempDir("ego-adk-");
  const runtimeDir = tempDir("ego-rt-");
  const child = spawn(process.execPath, [RUN_SUPERVISOR, adk, runtimeDir], {
    // 정확히 세 칸. 감독자의 파이프 fd 를 이 자식에게 넘기지 않는다.
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackPid(child.pid);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const line = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`감독자가 시작 보고를 하지 않았다. stderr:\n${stderr}`)),
      30_000,
    );
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index !== -1) {
        clearTimeout(timer);
        resolve(buffer.slice(0, index));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`감독자가 ${code} 로 먼저 죽었다. stderr:\n${stderr}`));
    });
  });
  const info = JSON.parse(line);
  trackPid(info.browserPid);
  assert.equal(alive(info.browserPid), true);
  assert.equal(existsSync(leasePath(adk)), true);

  // 감독자를 SIGKILL 한다. 정리 코드가 돌 기회가 없다 — 남은 장치는 파이프 EOF 뿐이다.
  process.kill(child.pid, "SIGKILL");
  const elapsedMs = await waitForExit(info.browserPid, 10_000);
  assert.notEqual(elapsedMs, null, "감독자 SIGKILL 뒤 10초 안에 Chromium 이 사라지지 않았다");
  console.log(`  [실측] 감독자 SIGKILL → Chromium 소멸: ${elapsedMs}ms`);

  // 그리고 다음 시작의 조정이 고아 0 을 보증한다: lease 는 남았지만 PID 는 없다.
  assert.equal(existsSync(leasePath(adk)), true, "SIGKILL 된 감독자는 lease 를 지우지 못한다");
  const result = await reconcileLease({ adkDir: adk, platform: "linux" });
  assert.equal(result.status, RECONCILE_STATUS.STALE);
  assert.equal(result.orphans, 0);
  assert.equal(existsSync(leasePath(adk)), false);
});

test("감독자 재시작: 조정이 이전 브라우저를 회수하고 새 lease 로 갈아탄다", async () => {
  requireChromium();
  const adk = tempDir("ego-adk-");
  const runtimeDir = tempDir("ego-rt-");
  const first = await startSupervisor({ adkDir: adk, runtimeDir });
  trackPid(first.browserPid);
  const firstPid = first.browserPid;
  // 감독자 객체는 버리고 lease 만 남긴다 = 셸이 크래시한 상황을 흉내낸다.
  await first.server.close();

  const second = await startSupervisor({ adkDir: adk, runtimeDir });
  trackPid(second.browserPid);
  assert.equal(second.reconciliation.status, RECONCILE_STATUS.RECLAIMED);
  assert.equal(second.reconciliation.orphans, 0);
  assert.notEqual(await waitForExit(firstPid, 10_000), null, "이전 Chromium 이 회수되지 않았다");
  assert.notEqual(second.browserPid, firstPid);
  assert.equal(readLease(adk).pid, second.browserPid);
  assert.equal(defaultProfileDir(adk), second.profileDir);
  await second.stop();
  assert.equal(existsSync(leasePath(adk)), false);
});
