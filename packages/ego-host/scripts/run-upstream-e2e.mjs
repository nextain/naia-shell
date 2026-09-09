#!/usr/bin/env node
// #582 S2f — 업스트림 실브라우저 e2e 케이스를 **벤더 무수정으로** 우리 감독자 위에서 돌린다
// (계약 9절 S2f, 2절 마지막 행).
//
// ## 벤더 러너를 그대로 쓰지 못한 이유 (실측)
//
// 벤더 러너(`scripts/real-browser-e2e/runner.mjs`)는 첫 케이스로 `nodejs bridge smoke` 를 돌리고
// **실패하면 그 자리에서 전체를 중단한다**(`runner.mjs:236-244`). 그 케이스의 통과 조건 하나가
// `Object.keys(globalThis.ego.helpers).length > 0` 인데, `ego.helpers` 는 벤더가
// **`installEgoSdk()` 경로에서만** 세운다(`src/index.ts:196`). 그리고 그 경로는 SDK 를
// **import 할 때만** 도는 가지다 — 직접 실행하면 `isDirectCli()` 가 참이라 `runMain()` 으로
// 간다(`src/index.ts:256-265`).
//
// 우리 런처는 계약 4.2.1 이 못박은 대로 **직접 실행** 경로를 쓴다(그래야 preload 가 벤더 모듈을
// 정적으로 import 하지 않고도 stdin 실행이 돈다). 그래서 `ego.helpers` 가 없고, 러너의 첫
// 케이스가 반드시 실패하며, 그 뒤 케이스가 하나도 돌지 않는다. 2026-09-10 실측:
//
//     Failures:
//       - nodejs bridge smoke: nodejs bridge smoke returned invalid runtime data:
//         {"egoType":"object","hasSendCDPMessage":"function","processVersion":"v26.7.0","helperCount":0}
//
// **`ego.helpers` 를 흉내 내지 않는다.** 그 값은 "SDK 설치 경로가 돌았다"는 신호이고, 우리
// 경로에서는 실제로 돌지 않는다. 채워 넣으면 그 신호가 거짓이 된다.
// (`--vendor-runner` 로 이 사실을 언제든 다시 재현할 수 있다.)
//
// 그래서 계약 9절 S2f 가 허용한 대안을 쓴다: **케이스 파일을 우리 하네스에서 직접 실행한다.**
// 벤더의 `cases/index.mjs`·`ego-source.mjs`(공통 전문 포함)·`fixture.mjs` 를 **그대로 import** 해
// 케이스 본문과 픽스처는 업스트림 것을 쓰고, 실행만 우리 런처·감독자로 한다.
//
// ## 전체 통과를 게이트로 삼지 않는다
//
// 업스트림 묶음에는 우리 정책이 **의도적으로 거부하는** 것들이 들어 있다(인계·회수·로그인 상속·
// screencast·다운로드·파일 업로드). 그래서 두 묶음으로 나눈다.
//
//   지원 묶음   아래 명단. **전부 통과**해야 하고, 그때 이 스크립트가 0 으로 끝난다.
//   거부 묶음   우리 정책이 거부하는 케이스들. 실패가 정답이며, **기대한 거부의 서명**(오류 코드나
//               정책 문구)이 출력에 있어야 통과다. 그냥 실패하는 것과 구별한다.
//
// 두 묶음의 명단은 **측정 결과**다(`--all` 로 다시 측정한다). 약속이 아니다.
//
// ## 러너의 전문이 `takeOver` 를 부르는 문제
//
// 공통 전문(`preamble.mjs:203-251` `resetHome()`)은 `taskSpaces.takeOver(taskName)` 를 부른다.
// 우리는 헤드리스에서 인계를 지원하지 않으므로(계약 3절 2) 이 호출은 원래 요청 id 를 가진
// `EGO_HANDOFF_UNSUPPORTED_HEADLESS` 로 거부된다. **전문을 고치지 않는다.** 전문이 그 호출을
// `.catch(() => {})` 로 감싸 두어 거부가 그대로 흡수되고, 뒤이은 `waitForAgentControl` 은 스냅샷이
// 정상으로 돌아오는 것을 제어권 신호로 읽어(ABI 7) 통과한다. 즉 **우리 거부가 전문을 멈추지
// 않는다.** 이것이 지원 묶음이 도는 이유이며, 여기 적어 둔다.
//
// 사용:
//   node scripts/run-upstream-e2e.mjs                지원 묶음 + 거부 묶음 (게이트)
//   node scripts/run-upstream-e2e.mjs --all          모든 케이스를 돌려 명단을 다시 측정
//   node scripts/run-upstream-e2e.mjs --list         케이스 이름만 출력
//   node scripts/run-upstream-e2e.mjs --vendor-runner  벤더 러너를 그대로 돌려 위 사실을 재현
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { startSupervisor } from "../src/supervisor/supervisor.mjs";
import { discoverBrowser } from "../src/supervisor/browser-discovery.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(PKG_ROOT, "bin", "ego-browser.mjs");
const VENDOR_PKG = join(PKG_ROOT, "vendor", "ego-lite", "package", "ego-browser");
const VENDOR_E2E = join(VENDOR_PKG, "scripts", "real-browser-e2e");
const VENDOR_SDK = join(VENDOR_PKG, "dist", "out", "index.js");
const VENDOR_RUNNER = join(VENDOR_PKG, "scripts", "run-real-browser-e2e.mjs");

/** 벤더 모듈은 **읽기만** 한다. 케이스 본문·공통 전문·픽스처가 전부 업스트림 것이다. */
async function loadVendor() {
  const [cases, source, fixture] = await Promise.all([
    import(pathToFileURL(join(VENDOR_E2E, "cases", "index.mjs")).href),
    import(pathToFileURL(join(VENDOR_E2E, "ego-source.mjs")).href),
    import(pathToFileURL(join(VENDOR_E2E, "fixture.mjs")).href),
  ]);
  return { e2eCases: cases.e2eCases, egoSource: source.egoSource, ...fixture };
}

/**
 * **측정으로 고정한 지원 묶음.** `--all` 로 전체를 돌려 통과한 것을 적은 것이다.
 * 늘어나면 좋은 일이고, 줄어들면 회귀다.
 */
export const SUPPORTED_CASES = [
  "environment initialization",
  "helper surface",
  "navigation helpers",
  "observation helpers",
  "pointer click helpers",
  "pointer hover drag helpers",
  "scroll helpers",
  "pointer validation",
  "pointer interaction regression",
  "wait helpers",
  "fetch helpers",
  "cdp js help",
  "runtime regression",
  "screencast recording",
  "concert ticket rush",
  "adversarial stale ref falls back after replacement",
  "adversarial js serialization boundaries",
  "adversarial js wrapping boundaries",
  "adversarial fetch origin follows current page",
  "workflow multi-page navigation",
  "workflow form interaction chain",
  "workflow observation and recovery",
  "workflow locator waits without fixed sleeps",
  "pointer events handler tracking",
  "pointer events pressure tracking",
  "html5 dnd simulate drop via js",
  "html5 dnd drag cancel",
  "canvas draw single stroke",
  "canvas draw multiple strokes",
  "canvas draw zigzag path",
  "regression PWB-01 waitForURL predicate URL",
  "regression PWB-02 waitForURL default load",
  "regression PWB-03 page.url asynchronous contract",
  "regression PWB-04 transient page.info",
  "regression PWB-05 locator zero auto-wait",
  "regression PWB-06 locator strictness",
  "regression PWB-07 stale target guard",
  "regression PWB-08 target field guard",
];

/**
 * **우리 정책이 거부하는 묶음.** 실패가 정답이고, `expect` 중 하나가 출력에 있어야 통과다.
 * `expect` 는 우리 거부의 서명이다 — 아무 실패나 통과시키지 않는다.
 */
export const REJECTED_CASES = [
  {
    name: "task spaces and control",
    expect: ["EGO_HANDOFF_UNSUPPORTED_HEADLESS", "헤드리스로 돌아 사람에게 넘길 창이 없다"],
    why: "인계·회수·claim 은 헤드리스에서 지원하지 않는다(계약 3절 2, 4.4 표)",
  },
  {
    name: "keyboard and file helpers",
    expect: ["DOM.setFileInputFiles", "EGO_HOST_METHOD_DENIED"],
    why: "파일 업로드는 임의 호스트 경로를 페이지에 올린다. 이번 범위에서 거부다(계약 4.3.2)",
  },
  {
    name: "keyboard regression",
    expect: ["DOM.setFileInputFiles", "EGO_HOST_METHOD_DENIED"],
    why: "같은 이유(파일 업로드). 케이스 후반이 업로드를 쓴다",
  },
  {
    name: "download helpers",
    expect: ["ego-browser-downloads"],
    // 오류 문구만으로는 "우리가 경로를 바꿨다"와 "그냥 못 받았다"를 구별할 수 없다.
    // 그래서 감독자의 공간별 다운로드 디렉터리에 파일이 실제로 떨어졌는지 함께 본다.
    verifyRedirectedDownload: true,
    why:
      "다운로드 경로는 공간별 디렉터리로 재작성된다(계약 4.3.2). 벤더 케이스는 자기가 정한 " +
      "임시 경로에서 파일을 찾으므로 실패가 정답이다. 다운로드 자체는 FR-ENV-TOOL.2b(Pending)",
  },
];

/**
 * 어느 묶음도 아닌 것. **우리 정책과 무관한 이유**로 이 기기에서 실패한다.
 * 거부 묶음에 넣으면 "우리가 막았다"는 거짓 서명이 되고, 지원 묶음에 넣으면 게이트가 항상 빨갛다.
 */
export const OUT_OF_SCOPE_CASES = [
  {
    name: "macOS bare Meta input isolation",
    why: "케이스가 `process.platform === 'darwin'` 을 단언한다. 이 기기는 리눅스다(계약 4.9)",
  },
  {
    name: "regression PWB-10 permission capability",
    why:
      "케이스는 브라우저가 `clipboardReadWrite` 권한을 **지원하지 않는 것**을 기대한다. 우리가 쓰는 " +
      "일반 Chromium 은 그 권한을 지원하므로 성공한다. 브라우저 능력 차이이며 우리 정책과 무관하다",
  },
];

/** 감독자가 정한 공간별 다운로드 디렉터리에 실제로 떨어진 파일들. */
function downloadedFiles(adkDir) {
  const root = join(adkDir, "ego-host", "downloads");
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (!entry.name.endsWith(".crdownload")) found.push(join(dir, entry.name));
    }
  };
  walk(root);
  return found;
}

function runHeredoc({ script, socketPath, token, cwd, timeoutMs = 120_000 }) {
  return new Promise((done) => {
    const env = {
      ...process.env,
      CI: "true",
      EGO_HOST_SOCKET: socketPath,
      EGO_HOST_TOKEN: token,
      EGO_HOST_GRANT: JSON.stringify({ tier: "workspace-write" }),
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [LAUNCHER, "nodejs", "--sdk-path", VENDOR_SDK], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ status: null, stdout, stderr: `${stderr}\n[상한 ${timeoutMs}ms 초과]` });
    }, timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

/** 케이스 하나. 판정은 벤더가 쓰는 `case-result.json` 을 그대로 읽는다. */
async function runCase({ vendor, context, supervisor, name, body }) {
  const resultPath = join(context.tempDir, "case-result.json");
  rmSync(resultPath, { force: true });
  const token = supervisor.server.issueToken({ grant: { tier: "workspace-write" } });
  const run = await runHeredoc({
    script: vendor.egoSource(body, { ...context, keepTaskSpace: false }),
    socketPath: supervisor.socketPath,
    token,
    cwd: VENDOR_PKG,
  });
  let verdict = { ok: false, assertions: 0, error: "case-result.json 이 없다" };
  try {
    verdict = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    /* 아래에서 출력으로 설명한다 */
  }
  return { name, ...verdict, status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

/** 벤더 러너를 그대로 한 번 돌린다. 붙지 않는다는 사실을 재현하는 용도다(파일 머리 주석). */
function runVendorRunner({ env, timeoutMs = 600_000 }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [VENDOR_RUNNER], {
      cwd: VENDOR_PKG,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ status: null });
    }, timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status });
    });
  });
}

function shimSource(brokerUrl) {
  return `#!/usr/bin/env node
// #582 S2f — 벤더 러너가 PATH 에서 찾는 \`ego-browser\` 의 껍질.
// 하는 일은 둘뿐이다: 토큰을 새로 하나 받고(단일 사용이라 실행마다 새로), 우리 런처를 부른다.
import { spawn } from "node:child_process";
const response = await fetch(${JSON.stringify(brokerUrl)});
const token = (await response.text()).trim();
const child = spawn(process.execPath, [${JSON.stringify(LAUNCHER)}, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, EGO_HOST_TOKEN: token },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
`;
}

async function main(argv) {
  const vendor = await loadVendor();
  if (argv.includes("--list")) {
    for (const testCase of vendor.e2eCases) console.log(testCase.name);
    return 0;
  }

  const all = argv.includes("--all");
  const wanted = all
    ? vendor.e2eCases.filter(
        (testCase) => !OUT_OF_SCOPE_CASES.some((entry) => entry.name === testCase.name),
      )
    : vendor.e2eCases.filter(
        (testCase) =>
          SUPPORTED_CASES.includes(testCase.name) ||
          REJECTED_CASES.some((entry) => entry.name === testCase.name),
      );

  const adkDir = mkdtempSync(join(tmpdir(), "ego-e2e-adk-"));
  const runtimeDir = mkdtempSync(join(tmpdir(), "ego-e2e-run-"));
  const tempDir = mkdtempSync(join(tmpdir(), "ego-e2e-"));
  const artifactDir = join(tempDir, "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const taskName = `naia ego-host upstream e2e ${Date.now()}`;
  const uploadPath = join(tempDir, "fixture-upload.txt");
  const uploadPathTwo = join(tempDir, "fixture-upload-two.txt");
  writeFileSync(uploadPath, "ego-browser upload fixture\n");
  writeFileSync(uploadPathTwo, "second upload fixture\n");

  const fixture = await vendor.startFixtureServer(taskName);
  const context = {
    taskName,
    baseUrl: fixture.baseUrl,
    artifactDir,
    tempDir,
    uploadPath,
    uploadPathTwo,
    explicitScreenshotPath: join(artifactDir, "explicit-shot.png"),
    environmentScreenshotPath: join(artifactDir, "environment-shot.png"),
    metadataPath: join(tempDir, "metadata.json"),
  };
  // 러너가 케이스 실행 전에 쓰는 파일(`runner.mjs:initializeE2eEnvironment`)과 같은 모양.
  writeFileSync(
    context.metadataPath,
    JSON.stringify({ baseUrl: fixture.baseUrl, taskName, tempDir, artifactDir }, null, 2),
  );

  const supervisor = await startSupervisor({
    adkDir,
    executable: discoverBrowser({}).executable,
    runtimeDir,
    headless: true,
  });

  const results = [];
  let failed = false;
  try {
    if (argv.includes("--vendor-runner")) {
      const binDir = mkdtempSync(join(tmpdir(), "ego-e2e-bin-"));
      const broker = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(supervisor.server.issueToken({ grant: { tier: "workspace-write" } }));
      });
      await new Promise((done) => broker.listen(0, "127.0.0.1", done));
      const shimPath = join(binDir, "ego-browser");
      writeFileSync(shimPath, shimSource(`http://127.0.0.1:${broker.address().port}/token`));
      chmodSync(shimPath, 0o755);
      console.log("== 벤더 러너 그대로 (붙지 않는다는 사실의 재현) ==");
      const run = await runVendorRunner({
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CI: "true",
          EGO_HOST_SOCKET: supervisor.socketPath,
          EGO_HOST_GRANT: JSON.stringify({ tier: "workspace-write" }),
        },
      });
      console.log(`벤더 러너 종료 코드: ${run.status} (0 이 아니면 파일 머리 주석의 사실 그대로다)`);
      await new Promise((done) => broker.close(done));
      rmSync(binDir, { recursive: true, force: true });
      return 0;
    }

    for (const testCase of wanted) {
      const outcome = await runCase({
        vendor,
        context,
        supervisor,
        name: testCase.name,
        body: testCase.body(),
      });
      results.push(outcome);
      const rejection = REJECTED_CASES.find((entry) => entry.name === testCase.name);
      if (rejection) {
        const matched = rejection.expect.filter((needle) => outcome.output.includes(needle));
        let redirected = null;
        if (rejection.verifyRedirectedDownload) {
          redirected = downloadedFiles(adkDir);
          outcome.redirectedDownloads = redirected;
        }
        const ok =
          !outcome.ok && matched.length > 0 && (!rejection.verifyRedirectedDownload || redirected.length > 0);
        outcome.expectedRejection = { matched, ok, why: rejection.why };
        if (!ok && !all) failed = true;
        console.log(
          `  [거부] ${testCase.name}: ${ok ? `기대한 거부 (${matched.join(", ")})` : "서명 없음"}` +
            `${outcome.error ? ` — ${String(outcome.error).slice(0, 160)}` : ""}`,
        );
        continue;
      }
      if (!outcome.ok && !all) failed = true;
      console.log(
        `  [지원] ${testCase.name}: ${outcome.ok ? `통과 (단언 ${outcome.assertions})` : "실패"}` +
          `${outcome.ok ? "" : ` — ${String(outcome.error).slice(0, 200)}`}`,
      );
    }
  } finally {
    await supervisor.stop();
    await vendor.closeFixtureServer(fixture.server);
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(adkDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }

  if (all) {
    console.log("\n== 전체 측정 결과 (명단 갱신에 쓴다) ==");
    for (const outcome of results) {
      console.log(
        `${outcome.ok ? "PASS" : "FAIL"}  ${outcome.name}  단언 ${outcome.assertions}` +
          `${outcome.ok ? "" : `  — ${String(outcome.error).replace(/\s+/g, " ").slice(0, 220)}`}`,
      );
    }
    return 0;
  }

  const passed = results.filter((r) => !r.expectedRejection && r.ok).length;
  const rejectedOk = results.filter((r) => r.expectedRejection?.ok).length;
  console.log(
    `\n== 요약 ==\n지원 묶음 ${passed}/${SUPPORTED_CASES.length} 통과, ` +
      `거부 묶음 ${rejectedOk}/${REJECTED_CASES.length} 이 기대한 거부, ` +
      `범위 밖 ${OUT_OF_SCOPE_CASES.length} (${OUT_OF_SCOPE_CASES.map((e) => e.name).join(", ")}).`,
  );
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
