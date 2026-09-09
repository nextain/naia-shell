// #582 S2b — 실브라우저 테스트 지그.
//
// 원칙 하나: **Chromium 이 없으면 건너뛰지 않고 RED 다.** 건너뛴 테스트는 초록으로 보이고,
// 초록으로 보이는 미검증은 나중에 "검증했다"로 보고된다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverBrowser } from "../../src/supervisor/browser-discovery.mjs";

const dirs = [];
const pids = new Set();

/** 이 머신의 Chromium. 없으면 던진다 — 그 던짐이 RED 다. */
export function requireChromium() {
  return discoverBrowser({}).executable;
}

/** 짧은 임시 디렉터리. unix 소켓 경로 상한(104바이트) 때문에 길게 잡으면 bind 가 죽는다. */
export function tempDir(prefix = "ego-s2b-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function trackPid(pid) {
  if (typeof pid === "number") pids.add(pid);
  return pid;
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** PID 가 사라질 때까지 기다린 시간(ms). 제한 시간 안에 안 사라지면 null. */
export async function waitForExit(pid, timeoutMs = 10_000, stepMs = 50) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!alive(pid)) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return null;
}

/** 테스트가 실패해도 브라우저·감독자가 남지 않게 한다. 남으면 다음 실행이 오염된다. */
export function cleanupAll() {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  pids.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
