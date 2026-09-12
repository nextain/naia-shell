#!/usr/bin/env node
// #582 S2a — CLI 런처 (계약 4.2 "환경·경로" 행, 4.2.1).
//
// 인자 모양은 닫힌 ego 앱 실행 파일이 받는 것과 같다: `ego-browser nodejs [--sdk-path <dist>]`.
// 하는 일은 벤더 SDK 를 **무수정으로** 새 Node 프로세스에서 직접 실행하는 것뿐이다.
//
//   node --import <preload.mjs> <dist>/index.js
//
// 이렇게 해야 벤더 `index.js` 의 `process.argv[1]` 이 자기 자신이 되어 `isDirectCli()` 가 참이
// 되고 `runMain()` 경로로 들어간다(`installEgoSdk()` 는 import 될 때만 불린다).
// stdin 은 그대로 넘어간다 — 벤더 런타임의 유일한 실행 형태가 stdin 의 JS 본문이다.
//
// OS 가정을 넣지 않는다. 인자는 배열로 넘기고 셸을 쓰지 않는다(`shell:false` 가 기본).
// 소켓 경로는 이 프로세스가 정하지 않고 감독자가 정해 환경으로 내려준다
// (경로 형식의 OS 분기는 src/supervisor/socket-path.mjs 하나가 든다).
//
// stdio 는 정확히 세 칸의 명시 목록이다(계약 4.8). 숫자 fd 나 스트림을 절대 넘기지 않는다 —
// Chromium 의 `--remote-debugging-pipe` fd 가 자식에게 새면 감독자 SIGKILL 뒤에도
// 브라우저가 살아남는다.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODES } from "../src/errors.mjs";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(BIN_DIR, "..");
const PRELOAD = join(PKG_ROOT, "src", "client", "preload.mjs");

/** 기본 SDK 경로. 벤더 빌드 산출물의 디렉터리이며 그 안의 index.js 가 진입점이다. */
export const DEFAULT_SDK_PATH = join(
  PKG_ROOT,
  "vendor",
  "ego-lite",
  "package",
  "ego-browser",
  "dist",
  "out",
);

export const USAGE =
  "사용법:\n" +
  "  ego-browser nodejs [--sdk-path <dist>] <<'JS'\n" +
  "  console.log(await page.info())\n" +
  "  JS\n";

/** 인자 해석. 실패는 형식 있는 `{error, error_code}` 다. */
export function parseArgs(argv) {
  const args = [...argv];
  if (args[0] !== "nodejs") {
    return {
      error: `첫 인자는 nodejs 여야 한다(받은 것: ${JSON.stringify(args[0] ?? null)})\n${USAGE}`,
      error_code: CODES.USAGE,
    };
  }
  args.shift();
  let sdkPath = DEFAULT_SDK_PATH;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--sdk-path") {
      const value = args.shift();
      if (!value) {
        return { error: "--sdk-path 뒤에 디렉터리를 적는다", error_code: CODES.USAGE };
      }
      sdkPath = resolve(value);
      continue;
    }
    return { error: `알 수 없는 인자: ${arg}\n${USAGE}`, error_code: CODES.USAGE };
  }
  // `--sdk-path` 는 **디렉터리도 파일도** 받는다. 업스트림 실브라우저 e2e 러너는 진입점 파일을
  // 그대로 넘긴다(`scripts/real-browser-e2e/runner.mjs:20-21` — `dist/out/index.js`). 디렉터리만
  // 받으면 그 러너를 벤더 무수정으로 붙일 수 없다(`index.js/index.js` 가 되어 종료 코드 2).
  const entry = /\.[cm]?js$/i.test(sdkPath) ? sdkPath : join(sdkPath, "index.js");
  return { sdkPath, entry };
}

export function main(argv = process.argv.slice(2), { stderr = process.stderr } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    stderr.write(`${JSON.stringify(parsed)}\n`);
    return 2;
  }
  if (!existsSync(parsed.entry)) {
    stderr.write(
      `${JSON.stringify({
        error:
          `벤더 SDK 진입점이 없다: ${parsed.entry}\n` +
          "  벤더 런타임을 먼저 빌드한다: (cd vendor/ego-lite/package/ego-browser && npm ci --ignore-scripts && npm run build)",
        error_code: CODES.SDK_NOT_FOUND,
      })}\n`,
    );
    return 2;
  }
  const child = spawn(process.execPath, ["--import", PRELOAD, parsed.entry], {
    // 정확히 세 칸. 3번 이상은 Node 기본이 ignore 이며 여기서 절대 열지 않는다.
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
    shell: false,
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
  child.on("error", (error) => {
    stderr.write(
      `${JSON.stringify({ error: `SDK 실행 실패: ${error.message}`, error_code: CODES.SDK_NOT_FOUND })}\n`,
    );
    process.exitCode = 1;
  });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main();
  if (code !== 0) process.exit(code);
}
