// #582 S2b — 시작 조정 (계약 4.8 "시작 시 조정에서 marker 가 일치하는 프로세스만 입양하거나 회수한다").
//
// 감독자가 크래시로 죽으면 lease 파일만 남는다. 다음 시작이 그 파일을 읽고 세 갈래로 나뉜다.
//
//   (a) PID 살아 있고 marker 일치  → 우리 것이다. 회수(종료)하거나 입양한다.
//   (b) PID 살아 있으나 marker 불일치 → **남의 프로세스다. 절대 건드리지 않는다.** PID 는 재사용된다.
//   (c) PID 없음                    → 고아 없음. lease 만 지운다.
//
// (b) 가 이 파일의 전부다. marker 없이 PID 만 보고 죽이는 코드는 언젠가 사람의 프로세스를 죽인다.
// win32 는 이번 슬라이스에서 marker 를 확인할 수단이 없어(4.9) 살아 있으면 (b) 와 같이 다룬다 —
// **확인 못 한 것을 회수하지 않는다.** 회수는 windows4060 실측 게이트로 미룬다.
import { inspectLease, readLease, removeLease } from "./lease.mjs";
import { CODES } from "../errors.mjs";

/** 조정 결과 상태값. 테스트와 증거가 이 문자열을 그대로 읽는다. */
export const RECONCILE_STATUS = Object.freeze({
  NO_LEASE: "no-lease",
  UNREADABLE: "unreadable",
  RECLAIMED: "reclaimed",
  ADOPTED: "adopted",
  FOREIGN: "foreign",
  UNVERIFIED: "unverified",
  STALE: "stale",
});

const TERM_GRACE_MS = 2_000;

/**
 * 시작 조정 한 번.
 *
 * @param {object} options
 * @param {string} options.adkDir
 * @param {boolean} [options.adopt]  true 면 (a) 에서 종료하지 않고 lease 를 유지한다.
 * @param {string} [options.platform]
 * @returns {Promise<{status:string, lease:object|null, pid:number|null,
 *   marker:"match"|"mismatch"|"unverified"|null, killed:boolean, leaseRemoved:boolean,
 *   orphans:number, note:string}>}
 */
export async function reconcileLease({
  adkDir,
  adopt = false,
  platform = process.platform,
  kill = process.kill.bind(process),
  graceMs = TERM_GRACE_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ...injected
} = {}) {
  const base = {
    status: RECONCILE_STATUS.NO_LEASE,
    lease: null,
    pid: null,
    marker: null,
    killed: false,
    leaseRemoved: false,
    orphans: 0,
    note: "",
  };

  let lease;
  try {
    lease = readLease(adkDir, injected);
  } catch (error) {
    // 형식이 깨진 lease 는 소유를 증명하지 못한다. 아무 PID 도 건드리지 않고 파일만 치운다.
    removeLease(adkDir, injected);
    return {
      ...base,
      status: RECONCILE_STATUS.UNREADABLE,
      leaseRemoved: true,
      note: `${error.error_code ?? CODES.LEASE_INVALID}: ${error.message} — 아무 프로세스도 건드리지 않았다`,
    };
  }
  if (!lease) return { ...base, note: "lease 없음 — 이전 감독자의 흔적이 없다" };

  const { alive, marker } = inspectLease(lease, { platform, kill, ...injected });
  const common = { ...base, lease, pid: lease.pid, marker };

  if (!alive) {
    removeLease(adkDir, injected);
    return {
      ...common,
      status: RECONCILE_STATUS.STALE,
      marker: null,
      leaseRemoved: true,
      note: `PID ${lease.pid} 는 없다 — 고아 0, lease 만 지웠다`,
    };
  }

  if (marker === "unverified") {
    return {
      ...common,
      status: RECONCILE_STATUS.UNVERIFIED,
      orphans: 1,
      note:
        `PID ${lease.pid} 는 살아 있으나 이 플랫폼(${platform})에서는 marker 를 확인할 수 없다. ` +
        "확인하지 못한 프로세스는 회수하지 않는다(계약 4.9 windows4060 게이트).",
    };
  }

  if (marker === "mismatch") {
    return {
      ...common,
      status: RECONCILE_STATUS.FOREIGN,
      note:
        `PID ${lease.pid} 는 살아 있지만 명령줄에 우리 marker 가 없다 — PID 가 재사용됐다. ` +
        "남의 프로세스이므로 종료하지 않고 lease 도 지우지 않는다. 기록만 남긴다.",
    };
  }

  // (a) 우리 것이다.
  if (adopt) {
    return {
      ...common,
      status: RECONCILE_STATUS.ADOPTED,
      note: `PID ${lease.pid} 를 입양했다 — lease 를 유지한다`,
    };
  }

  let killed = false;
  try {
    kill(lease.pid, "SIGTERM");
    killed = true;
  } catch {
    /* 판정과 종료 사이에 스스로 죽었다 */
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!inspectLease(lease, { platform, kill, ...injected }).alive) break;
    await sleep(50);
  }
  let stillAlive = inspectLease(lease, { platform, kill, ...injected }).alive;
  if (stillAlive) {
    try {
      kill(lease.pid, "SIGKILL");
    } catch {}
    const hard = Date.now() + graceMs;
    while (Date.now() < hard) {
      if (!inspectLease(lease, { platform, kill, ...injected }).alive) break;
      await sleep(50);
    }
    stillAlive = inspectLease(lease, { platform, kill, ...injected }).alive;
  }
  removeLease(adkDir, injected);
  return {
    ...common,
    status: RECONCILE_STATUS.RECLAIMED,
    killed,
    leaseRemoved: true,
    orphans: stillAlive ? 1 : 0,
    note: stillAlive
      ? `PID ${lease.pid} 가 SIGKILL 뒤에도 남았다 — 회수 실패를 기록한다`
      : `PID ${lease.pid} 를 회수했다 — 고아 0`,
  };
}
