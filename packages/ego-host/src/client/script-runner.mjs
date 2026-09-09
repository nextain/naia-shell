// #582 S3a — heredoc 실행 통로와 spawn 시점 환경 배치.
//
// 형식 있는 도구(`env_browser_*`)는 감독자 RPC 로 돈다. 묶음 실행(`env_browser_script`)만
// 이 파일을 지난다 — 런처를 **자식 프로세스**로 띄우고 stdin 에 코드를 넣고 stdout 을 결과로
// 받는다. 그것이 벤더 런타임의 유일한 실행 형태이기 때문이다(계약 4.2 "출력 통로는 console.log").
//
// 왜 어댑터가 아니라 여기인가: 셸 코어(`src/main`)에는 `node:` import 이 한 줄도 들어갈 수
// 없다(배포 표면 가드 — core-dist-browser-safety.contract.test.ts). 프로세스와 파일을 만지는
// 일은 전부 이 패키지 안에 두고, 어댑터는 **무엇을 넣을지**만 정한다.
//
// 환경은 호출자가 완성해서 준다. 여기서 `process.env` 를 섞지 않는다 — 섞으면 셸이 가진 변수가
// 조용히 에이전트 브라우저로 새고, 같은 인자로 부른 두 실행이 서로 다른 환경에서 돈다.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODES, hostError } from "../errors.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 런처. 인자 모양은 닫힌 ego 앱과 같다(`nodejs [--sdk-path <dist>]`). */
export const LAUNCHER = join(PKG_ROOT, "bin", "ego-browser.mjs");

/** 벤더 SDK 기본 위치. `.env` 를 놓을 `<REPO_ROOT>` 는 이 디렉터리의 상위다(ABI 8). */
export const DEFAULT_SDK_DIR = join(
  PKG_ROOT,
  "vendor",
  "ego-lite",
  "package",
  "ego-browser",
  "dist",
  "out",
);

/** 디렉터리를 만든다. 없는 곳에 `.env` 를 쓰면 벤더는 그 파일을 영영 못 읽는다. */
export function ensureDirs(dirs = []) {
  for (const dir of dirs) if (dir) mkdirSync(dir, { recursive: true });
}

/**
 * `.env` 파일들을 놓는다 (ABI 8 "`.env` 를 두 곳에서 읽는다").
 *
 * 이미 설정된 변수는 벤더가 덮어쓰지 않으므로(`src/env.ts:40-42`) 이 파일들은 spawn 환경의
 * **아래**에 깔리는 기본값이다. 무엇을 어디에 놓을지는 호출자가 정한다 — 어댑터는 ADK 를
 * 따라다니는 값만 ADK 안 한 곳에 놓는다(S3a 증거 3.1).
 *
 * @param {readonly {path:string, values:Record<string,string>}[]} files
 */
export function writeEnvFiles(files = []) {
  const written = [];
  for (const file of files) {
    if (!file?.path) continue;
    mkdirSync(dirname(file.path), { recursive: true });
    const body = Object.entries(file.values ?? {})
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("\n");
    writeFileSync(file.path, `${body}\n`, { encoding: "utf8", mode: 0o600 });
    written.push(file.path);
  }
  return written;
}

/** PID 가 살아 있는가. EPERM 은 "남의 것이지만 있다"이므로 살아 있는 것으로 센다. */
export function pidAlive(pid) {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * PID 가 사라질 때까지 기다린다 (S3b).
 *
 * ADK 전환에서 이것이 순서의 판정 기준이다 — "정상 종료를 요청했다"가 아니라 "그 프로세스가
 * 실제로 없다"여야 다음 ADK 를 시작해도 고아가 안 생긴다.
 *
 * @returns {Promise<boolean>} 제한 시간 안에 사라졌으면 true
 */
export async function waitForPidExit(pid, timeoutMs = 10_000, stepMs = 50) {
  if (typeof pid !== "number") return true;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return !pidAlive(pid);
}

/**
 * 런처를 자식으로 띄워 heredoc 하나를 돌린다.
 *
 * 동기 spawn 을 쓰지 않는다 — 감독자가 **같은 프로세스**에 있어서 이벤트 루프를 막으면
 * 자식의 핸드셰이크를 영원히 못 받는다.
 *
 * stdio 는 정확히 세 칸이다(계약 4.8). 숫자 fd 도 스트림도 넘기지 않는다.
 *
 * @returns {Promise<{status:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function runEgoScript({
  code,
  env = {},
  launcher = LAUNCHER,
  sdkPath = null,
  timeoutMs = 60_000,
  signal = null,
} = {}) {
  if (typeof code !== "string" || code === "") {
    throw hostError(CODES.USAGE, "heredoc 실행에는 자바스크립트 본문이 필요하다");
  }
  const args = [launcher, "nodejs", ...(sdkPath ? ["--sdk-path", sdkPath] : [])];
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const stop = () => {
      timedOut = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, timeoutMs);
    timer.unref?.();
    const onAbort = () => stop();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
    });
    child.on("close", (status, closeSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolveRun({ status, signal: closeSignal ?? null, stdout, stderr, timedOut });
    });
    child.stdin.end(code);
  });
}
