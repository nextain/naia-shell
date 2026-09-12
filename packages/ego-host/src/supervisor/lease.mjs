// #582 S2b — 소유 lease (계약 4.8).
//
// lease 는 "이 Chromium 은 내 것이다"를 다음 시작이 읽을 수 있게 남기는 파일이다.
// **PID 만으로는 안 된다.** 감독자가 죽고 시간이 지나면 그 PID 는 남의 프로세스가 된다.
// 그래서 nonce 를 만들어 Chromium 명령줄에 `--naia-ego-marker=<nonce>` 로 심고, 회수 전에
// 그 PID 의 명령줄에 같은 nonce 가 있는지 확인한다. 없으면 남의 프로세스이므로 손대지 않는다.
//
// 쓰기는 원자적이다(임시 파일 + rename). 반쯤 쓰인 lease 를 다음 시작이 읽으면 그 순간
// "소유자가 누구인지 모르는 상태"가 되고, 그 상태에서 할 수 있는 안전한 일은 없다.
import { execFileSync as nodeExecFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  rmSync as nodeRmSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { join } from "node:path";
import { CODES, hostError } from "../errors.mjs";
import { MARKER_FLAG, markerArg } from "./chrome-launcher.mjs";

export { MARKER_FLAG, markerArg };

/** ADK 안의 자리. 감독자가 쓰는 모든 상태가 이 디렉터리 하나에 모인다. */
export function egoHostDir(adkDir) {
  if (!adkDir) throw hostError(CODES.USAGE, "lease 경로에 adkDir 이 필요하다");
  return join(adkDir, "ego-host");
}

export function leasePath(adkDir) {
  return join(egoHostDir(adkDir), "lease.json");
}

/** 기본 프로필 위치. lease 와 같은 디렉터리 아래라 ADK 를 옮기면 같이 간다. */
export function defaultProfileDir(adkDir) {
  return join(egoHostDir(adkDir), "profile");
}

export function newNonce() {
  return randomUUID();
}

/**
 * lease 한 장. 형식은 계약 4.8 이 정한 필드 그대로다.
 *
 * @returns {{nonce:string, marker:string, startedAt:string, pid:number, executable:string,
 *   profileDir:string, socketPath:string, supervisorPid:number}}
 */
export function createLease({
  nonce = newNonce(),
  pid,
  executable,
  profileDir,
  socketPath,
  supervisorPid = process.pid,
  startedAt = new Date().toISOString(),
}) {
  if (typeof pid !== "number") throw hostError(CODES.USAGE, "lease 에 브라우저 pid 가 필요하다");
  return {
    nonce,
    marker: markerArg(nonce),
    startedAt,
    pid,
    executable: executable ?? null,
    profileDir: profileDir ?? null,
    socketPath: socketPath ?? null,
    supervisorPid,
  };
}

/** 원자적 쓰기. 같은 파일 시스템의 임시 파일에 쓰고 rename 한다(rename 은 원자적이다). */
export function writeLease(adkDir, lease, { fs = defaultFs() } = {}) {
  const dir = egoHostDir(adkDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = leasePath(adkDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

/** 없으면 null. 읽을 수는 있으나 형식이 아니면 형식 있는 오류다(조용한 null 과 구별해야 한다). */
export function readLease(adkDir, { fs = defaultFs() } = {}) {
  const target = leasePath(adkDir);
  if (!fs.existsSync(target)) return null;
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (error) {
    throw hostError(CODES.LEASE_INVALID, `lease 를 읽지 못했다: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw hostError(CODES.LEASE_INVALID, `lease 가 JSON 이 아니다: ${target}`);
  }
  if (typeof parsed?.pid !== "number" || typeof parsed?.nonce !== "string") {
    throw hostError(CODES.LEASE_INVALID, `lease 에 pid·nonce 가 없다: ${target}`);
  }
  return parsed;
}

export function removeLease(adkDir, { fs = defaultFs() } = {}) {
  fs.rmSync(leasePath(adkDir), { force: true });
}

function defaultFs() {
  return {
    existsSync: nodeExistsSync,
    mkdirSync: nodeMkdirSync,
    readFileSync: nodeReadFileSync,
    renameSync: nodeRenameSync,
    rmSync: nodeRmSync,
    writeFileSync: nodeWriteFileSync,
  };
}

/** PID 가 살아 있는가. 신호 0 은 아무것도 보내지 않고 존재만 확인한다. */
export function isAlive(pid, { kill = process.kill.bind(process) } = {}) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 살아 있으나 남의 것이다. "죽었다"로 읽으면 남의 프로세스를 죽이러 간다.
    return error?.code === "EPERM";
  }
}

/**
 * 명령줄 blob 안에 그 토큰이 **온전한 인자로** 들어 있는가.
 *
 * `/proc/<pid>/cmdline` 은 보통 인자를 `\0` 로 구분하지만 **Chromium 은 그렇지 않다**(실측).
 * Chromium 은 시작하면서 자기 argv 를 통째로 다시 쓰고(`--ozone-platform=headless` 등을 덧붙인다)
 * 그 결과 cmdline 이 공백으로 이어 붙은 한 덩어리가 된다. `split("\0")` 로만 토큰을 만들면
 * marker 를 영영 못 찾고, 그러면 우리 브라우저가 전부 "남의 프로세스"로 판정돼 회수가 죽는다.
 * 그래서 구분자를 `\0` 과 공백 **둘 다** 로 본다. macOS 의 `ps -o command=` 도 공백 구분이라
 * 같은 함수가 두 OS 를 덮는다.
 */
export function cmdlineHasToken(raw, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\0\\s])${escaped}($|[\\0\\s])`).test(String(raw));
}

/**
 * 그 PID 의 명령줄에 우리 marker 가 있는가. 세 OS 가 서로 다른 곳을 본다(계약 4.9).
 *
 *  linux  `/proc/<pid>/cmdline` — 인자가 `\0` 로 구분된다.
 *  darwin `ps -p <pid> -o command=` — 한 줄로 뭉쳐 나온다.
 *  win32  **이번 슬라이스는 확인하지 않는다.** 생존만 보고 marker 는 "unverified" 다.
 *         (계약 4.9 의 windows4060 게이트 항목. 여기서 추측으로 true 를 돌려주면 그 추측이
 *          남의 프로세스를 죽이는 근거가 된다.)
 *
 * @returns {"match"|"mismatch"|"unverified"}
 */
export function markerState({
  pid,
  marker,
  platform = process.platform,
  fs = { readFileSync: nodeReadFileSync },
  execFileSync = nodeExecFileSync,
}) {
  if (!marker) return "unverified";
  if (platform === "win32") return "unverified";
  if (platform === "darwin") {
    let out;
    try {
      out = String(execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }));
    } catch {
      return "mismatch"; // ps 가 못 찾으면 그 PID 는 우리 것이 아니다
    }
    return cmdlineHasToken(out, marker) ? "match" : "mismatch";
  }
  // linux 와 그 밖의 /proc 이 있는 POSIX
  let raw;
  try {
    raw = String(fs.readFileSync(`/proc/${pid}/cmdline`));
  } catch {
    return "mismatch";
  }
  return cmdlineHasToken(raw, marker) ? "match" : "mismatch";
}

/**
 * lease 한 장에 대한 판정. 죽이지도 지우지도 않는다 — 판정만 한다(조정은 reconcile.mjs).
 *
 * @returns {{alive:boolean, marker:"match"|"mismatch"|"unverified"}}
 */
export function inspectLease(lease, options = {}) {
  const alive = isAlive(lease.pid, options);
  if (!alive) return { alive: false, marker: "mismatch" };
  return { alive: true, marker: markerState({ pid: lease.pid, marker: lease.marker, ...options }) };
}
