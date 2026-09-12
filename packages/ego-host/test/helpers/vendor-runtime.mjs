// #582 S2a — 벤더 런타임을 **실제로 실행**하는 지그.
// 적합성 판정은 모형이 아니라 빌드된 벤더 dist 를 런처로 돌려서 한다. 벤더 파일은 읽기만 한다.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENDOR_RUNTIME = join(PKG_ROOT, "vendor", "ego-lite", "package", "ego-browser");
export const VENDOR_DIST = join(VENDOR_RUNTIME, "dist", "out");
export const VENDOR_ENTRY = join(VENDOR_DIST, "index.js");
export const LAUNCHER = join(PKG_ROOT, "bin", "ego-browser.mjs");

/** NODE_TEST_CONTEXT 를 지운다 — 상속되면 자식의 출력 형식이 조용히 바뀐다. */
function childEnv(extra = {}) {
  const env = { ...process.env, CI: "true", ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** 벤더 dist 가 없으면 만든다. `dist` 는 gitignore 대상이고 MANIFEST 도 무시한다. */
export function ensureVendorDist() {
  if (existsSync(VENDOR_ENTRY)) return VENDOR_ENTRY;
  const install = spawnSync("npm", ["ci", "--prefer-offline", "--ignore-scripts"], {
    cwd: VENDOR_RUNTIME,
    encoding: "utf8",
    env: childEnv(),
  });
  if (install.status !== 0) {
    throw new Error(`벤더 npm ci 실패(${install.status}):\n${install.stderr}`);
  }
  const build = spawnSync("npm", ["run", "build"], {
    cwd: VENDOR_RUNTIME,
    encoding: "utf8",
    env: childEnv(),
  });
  if (build.status !== 0) {
    throw new Error(`벤더 npm run build 실패(${build.status}):\n${build.stderr}`);
  }
  if (!existsSync(VENDOR_ENTRY)) throw new Error(`빌드했으나 진입점이 없다: ${VENDOR_ENTRY}`);
  return VENDOR_ENTRY;
}

/**
 * 런처로 벤더 런타임을 돌린다. **동기 spawn 을 쓰지 않는다** — 감독자가 같은 프로세스에 있어서
 * spawnSync 로 막으면 이벤트 루프가 멈춰 핸드셰이크를 영원히 못 받는다.
 */
export function runEgoScript({
  script,
  socketPath,
  token,
  grant = { tier: "workspace-write" },
  env = {},
  args = ["nodejs"],
  launcher = LAUNCHER,
  timeoutMs = 20_000,
}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [launcher, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv({
        ...(socketPath ? { EGO_HOST_SOCKET: socketPath } : {}),
        ...(token ? { EGO_HOST_TOKEN: token } : {}),
        ...(grant ? { EGO_HOST_GRANT: JSON.stringify(grant) } : {}),
        ...env,
      }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`벤더 런타임이 ${timeoutMs}ms 안에 끝나지 않았다\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

/**
 * 출력에서 `<라벨> <JSON>` 한 줄을 꺼낸다. 없으면 실패 원인을 그대로 보여준다.
 * `stream` 이 "stderr" 인 경우가 있다 — 하드 스톱(EGO_TASK_SPACE_*)이 걸리면 벤더 출력 싱크가
 * stdout 버퍼를 버리고 안내문으로 갈아치우므로, 그때는 console.error 로 관측해야 한다.
 */
export function line(result, label, stream = "stdout") {
  const match = new RegExp(`^${label} (.*)$`, "m").exec(result[stream]);
  if (!match) {
    throw new Error(
      `출력에 '${label}' 줄이 없다 (status ${result.status})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return match[1];
}

export function json(result, label, stream = "stdout") {
  return JSON.parse(line(result, label, stream));
}
