#!/usr/bin/env node
// #582 S2f — 지원 헬퍼 행렬을 **측정해서 생성한다** (계약 1절 "지원하는 헬퍼의 범위는 약속이
// 아니라 측정 결과로 적는다", 9절 S2f "헬퍼별 독립 probe 하네스").
//
// 손으로 쓰지 않는다. 벤더 스킬의 "Common helpers" 목록을 그 자리에서 파싱하고, 헬퍼마다
// **독립 heredoc**(자기 프로세스·자기 토큰·자기 연결)을 실 Chromium 위에서 돌려 판정한다.
// 헬퍼를 한 프로세스에 몰아 넣으면 앞 헬퍼가 남긴 상태가 뒤 헬퍼의 판정을 바꾼다.
//
// 판정은 셋뿐이다.
//
//   supported            호출이 우리 감독자를 지나 실제로 동작했다.
//   rejected(<코드>)     우리 정책이 형식 있는 오류로 거부했다. 코드가 이유다.
//   unsupported(<이유>)  고정 커밋의 런타임에 그 이름이 없거나, 헤드리스에서 도달할 수 없다.
//
// **벤더 스킬 문서가 런타임보다 낡았다는 사실**(ABI 문서 9절)이 여기서 그대로 드러난다.
// 스킬의 평면 이름(`snapshotText`, `cliLog` …)은 대부분 파사드(`page.snapshot`, `console.log`)로
// 옮겨졌다. 그래서 행렬은 이름마다 "고정 커밋 런타임에서 그 일을 하는 호출"을 함께 적는다.
//
// 사용:
//   node scripts/probe-helpers.mjs            행렬을 측정해 docs/helper-matrix.{json,md} 갱신
//   node scripts/probe-helpers.mjs --check    측정하고 커밋된 파일과 다르면 종료 코드 1
//   node scripts/probe-helpers.mjs --only a,b  일부만(테스트가 표본 재측정에 쓴다)
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectSupervisor } from "../src/client/rpc-client.mjs";
import { startSupervisor } from "../src/supervisor/supervisor.mjs";
import { discoverBrowser } from "../src/supervisor/browser-discovery.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_PATH = join(
  PKG_ROOT,
  "vendor",
  "ego-lite",
  "skills",
  "ego-browser",
  "SKILL.md",
);
export const MATRIX_JSON = join(PKG_ROOT, "docs", "helper-matrix.json");
export const MATRIX_MD = join(PKG_ROOT, "docs", "helper-matrix.md");
const LAUNCHER = join(PKG_ROOT, "bin", "ego-browser.mjs");
const UPSTREAM_COMMIT = "5ca3c36cba2240b8df2e22ba32127747029039d5";

// ── 1. 헬퍼 목록은 벤더 스킬에서 그 자리에 파싱한다 ─────────────────────────

/**
 * `## Common helpers` 절의 목록 항목에서 백틱 이름을 뽑는다.
 * 목록이 끝나는 곳(`Notes:` 또는 다음 제목)에서 멈춘다 — 그 뒤의 산문에도 백틱 이름이 많다.
 */
export function parseCommonHelpers(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Common helpers\s*$/.test(line));
  if (start < 0) throw new Error("벤더 SKILL.md 에서 'Common helpers' 절을 찾지 못했다");
  const groups = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{2,}\s/.test(line) || /^Notes:/.test(line)) break;
    const match = /^-\s+([^:]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const names = [...match[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (names.length > 0) groups.push({ category: match[1].trim(), names });
  }
  if (groups.length === 0) throw new Error("'Common helpers' 절에서 헬퍼를 하나도 못 읽었다");
  return groups;
}

// ── 2. 헬퍼마다 고정 커밋 런타임에서 그 일을 하는 호출 ──────────────────────
//
// `call` 은 heredoc 안에서 실행되는 본문이다. 마지막에 `report(값)` 을 부른다.
// `unsupported` 가 적혀 있으면 브라우저를 쓰지 않고 그 이유를 그대로 적는다.

const OPEN = 'const t = await browser.openOrReuseTab(BASE + "/", { wait: true, timeout: 15000 });\n';

export const PROBES = {
  // ── Task spaces ──────────────────────────────────────────────────────────
  listTaskSpaces: { runtime: "taskSpaces.list()", call: "report((await taskSpaces.list()).length);" },
  useOrCreateTaskSpace: {
    runtime: "taskSpaces.useOrCreate(nameOrId)",
    call: 'report((await taskSpaces.useOrCreate("probe-space")).id);',
  },
  claimTaskSpace: {
    runtime: "taskSpaces.claim(nameOrId)",
    call: 'report(await taskSpaces.claim("probe-space"));',
  },
  handOffTaskSpace: {
    runtime: "taskSpaces.handOff(nameOrId)",
    call: 'report(await taskSpaces.handOff("probe-space"));',
  },
  takeOverTaskSpace: {
    runtime: "taskSpaces.takeOver(nameOrId)",
    call: 'report(await taskSpaces.takeOver("probe-space"));',
  },
  waitForAgentControl: {
    runtime: "taskSpaces.waitForAgentControl(nameOrId, options)",
    call: OPEN + 'report(await taskSpaces.waitForAgentControl("probe-space", { interval: 0.1, timeout: 3 }));',
  },
  completeTaskSpace: {
    runtime: "taskSpaces.complete(nameOrId, {keep})",
    call: 'report(await taskSpaces.complete("probe-space", { keep: true }));',
  },

  // ── Navigation / state ───────────────────────────────────────────────────
  listTabs: { runtime: "browser.listTabs()", call: "report((await browser.listTabs()).length);" },
  openOrReuseTab: { runtime: "browser.openOrReuseTab(url, options)", call: OPEN + "report(Boolean(t.targetId));" },
  closeTab: {
    runtime: "browser.closeTab(target)",
    call:
      'const extra = await browser.openOrReuseTab(BASE + "/other", { wait: true, timeout: 15000 });\n' +
      "await browser.closeTab(extra.targetId);\n" +
      "report(!(await browser.listTabs()).some((tab) => tab.targetId === extra.targetId));",
  },
  gotoAndWait: {
    runtime: 'page.goto(url, {waitUntil:"load"})',
    call: OPEN + 'const nav = await page.goto(BASE + "/", { waitUntil: "load", timeout: 15000 });\nreport(nav.loaded === true);',
  },
  currentTab: { runtime: "browser.currentTab()", call: OPEN + "report(Boolean((await browser.currentTab()).targetId));" },
  switchTab: {
    runtime: "browser.switchTab(target)",
    call: OPEN + "await browser.switchTab(t.targetId);\nreport((await browser.currentTab()).targetId === t.targetId);",
  },
  gotoUrl: {
    runtime: 'page.goto(url, {waitUntil:"commit"})',
    call: OPEN + 'await page.goto(BASE + "/other", { waitUntil: "commit", timeout: 15000 });\nreport((await page.url()).includes("/other"));',
  },
  pageInfo: { runtime: "page.info()", call: OPEN + "const info = await page.info();\nreport(info.w > 0 && info.h > 0);" },
  ensureRealTab: { runtime: "browser.ensureRealTab()", call: OPEN + "report(Boolean(await browser.ensureRealTab()));" },

  // ── Observation ──────────────────────────────────────────────────────────
  snapshotText: { runtime: "page.snapshot()", call: OPEN + 'report((await page.snapshot()).includes("ref="));' },
  captureScreenshot: {
    runtime: "page.screenshot(options)",
    call: OPEN + "const shot = await page.screenshot({ path: SHOT });\nreport(shot === SHOT);",
  },
  drainEvents: { runtime: "page.drainEvents()", call: OPEN + "report(Array.isArray(await page.drainEvents()));" },

  // ── Scroll / mouse ───────────────────────────────────────────────────────
  scrollBy: {
    runtime: "page.mouse.wheel(dx, dy)",
    call: OPEN + "await page.mouse.wheel(0, 200);\nreport(true);",
  },
  scrollToBottomUntil: {
    runtime: "(없음) — page.mouse.wheel + page.evaluate 로 직접 짠다",
    unsupported: "고정 커밋 런타임에 이 이름의 헬퍼가 없다(벤더 SKILL 이 런타임보다 낡았다)",
  },
  scroll: {
    runtime: "page.locator(sel).scrollIntoViewIfNeeded()",
    call: OPEN + 'await page.locator("#bottom").scrollIntoViewIfNeeded();\nreport(true);',
  },
  click: { runtime: "page.locator(sel).click()", call: OPEN + 'await page.locator("#probe-button").click();\nreport(await page.evaluate("window.__clicked === true"));' },
  doubleClick: {
    runtime: "page.mouse.dblclick(x, y)",
    call: OPEN + 'const center = await page.locator("#probe-button").evaluate("(el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }");\nawait page.mouse.dblclick(center[0], center[1]);\nreport(true);',
  },
  hover: { runtime: "page.locator(sel).hover()", call: OPEN + 'await page.locator("#probe-button").hover();\nreport(true);' },
  dragMouse: {
    runtime: "page.mouse.drag(points)",
    call: OPEN + "await page.mouse.drag([[10, 10], [40, 40]]);\nreport(true);",
  },

  // ── Keyboard & input ─────────────────────────────────────────────────────
  typeText: {
    runtime: "page.keyboard.type(text)",
    call: OPEN + 'await page.locator("#probe-input").click();\nawait page.keyboard.type("naia");\nreport(await page.evaluate("document.querySelector(\'#probe-input\').value"));',
  },
  fillInput: {
    runtime: "page.locator(sel).fill(value)",
    call: OPEN + 'await page.locator("#probe-input").fill("582");\nreport(await page.evaluate("document.querySelector(\'#probe-input\').value"));',
  },
  pressKey: {
    runtime: "page.keyboard.press(key)",
    call: OPEN + 'await page.locator("#probe-input").click();\nawait page.keyboard.press("a");\nreport(await page.evaluate("document.querySelector(\'#probe-input\').value"));',
  },
  dispatchKey: {
    runtime: "page.keyboard.down(key) / page.keyboard.up(key)",
    call: OPEN + 'await page.locator("#probe-input").click();\nawait page.keyboard.down("Shift");\nawait page.keyboard.up("Shift");\nreport(true);',
  },

  // ── File ─────────────────────────────────────────────────────────────────
  uploadFile: {
    runtime: "page.locator(sel).setInputFiles(path)",
    call: OPEN + 'await page.locator("#probe-file").setInputFiles(UPLOAD);\nreport("업로드가 통과했다");',
  },

  // ── Wait ─────────────────────────────────────────────────────────────────
  wait: { runtime: "page.waitForTimeout(ms)", call: "await page.waitForTimeout(50);\nreport(true);" },
  waitForLoad: {
    runtime: "page.waitForLoadState(state)",
    call: OPEN + 'report(await page.waitForLoadState("load", { timeout: 10000 }));',
  },
  waitForElement: {
    runtime: "page.locator(sel).waitFor(options) / page.waitForSelector(sel)",
    call: OPEN + 'report(await page.locator("#probe-button").waitFor({ timeout: 5000, state: "visible" }));',
  },
  waitForNetworkIdle: {
    runtime: 'page.waitForLoadState("networkidle")',
    call: OPEN + 'report(await page.waitForLoadState("networkidle", { timeout: 10000 }));',
  },

  // ── Fetch ────────────────────────────────────────────────────────────────
  serverFetch: {
    runtime: "fetch.server(url, options)",
    call: 'const body = await fetch.server(BASE + "/json");\nreport(typeof body === "string" ? body.includes("naia") : JSON.stringify(body).includes("naia"));',
  },
  browserFetch: {
    runtime: "fetch.browser(url, options)",
    call: OPEN + 'const body = await fetch.browser(BASE + "/json");\nreport(typeof body === "string" ? body.includes("naia") : JSON.stringify(body).includes("naia"));',
  },

  // ── CDP / evaluate ───────────────────────────────────────────────────────
  js: { runtime: "page.evaluate(expression)", call: OPEN + 'report(await page.evaluate("1 + 1"));' },
  cdp: { runtime: "cdp(method, params)", call: OPEN + 'report(Boolean((await cdp("Page.getFrameTree", {})).frameTree));' },

  // ── Output ───────────────────────────────────────────────────────────────
  cliLog: {
    runtime: "console.log(value)",
    unsupported:
      "고정 커밋 런타임에서 `cliLog` 전역이 없어졌다(src/index.ts:175-186). 출력 통로는 console.log 다",
  },
  help: { runtime: "help(name)", call: 'report(typeof help("page") === "string");' },
};

// ── 3. 픽스처 ────────────────────────────────────────────────────────────────

const PAGE = `<!doctype html><meta charset="utf-8"><title>naia 582 헬퍼 탐침</title>
<body>
  <button id="probe-button" onclick="window.__clicked = true">누르기</button>
  <input id="probe-input" type="text">
  <input id="probe-file" type="file">
  <a id="probe-link" href="/other">다른 곳</a>
  <div style="height: 3000px"></div>
  <div id="bottom">바닥</div>
</body>`;

async function startFixture() {
  const server = createServer((request, response) => {
    if (request.url.startsWith("/json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ who: "naia", issue: 582 }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise((resolve_) => server.listen(0, "127.0.0.1", resolve_));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// ── 4. 헬퍼 하나를 독립 heredoc 으로 ────────────────────────────────────────

function scriptFor(probe, { origin, shotPath, uploadPath }) {
  return `
    const BASE = ${JSON.stringify(origin)};
    const SHOT = ${JSON.stringify(shotPath)};
    const UPLOAD = ${JSON.stringify(uploadPath)};
    function report(value) {
      console.log("PROBE " + JSON.stringify({ ok: true, value: value === undefined ? null : value }));
    }
    try {
      await taskSpaces.useOrCreate("probe-space");
      ${probe.call}
    } catch (error) {
      console.log("PROBE " + JSON.stringify({
        ok: false,
        message: String(error && error.message ? error.message : error),
        code: (error && error.error_code) || null,
      }));
    }
  `;
}

function runHeredoc({ script, socketPath, token, timeoutMs = 60_000 }) {
  return new Promise((resolve_) => {
    const env = { ...process.env, CI: "true", EGO_HOST_SOCKET: socketPath, EGO_HOST_TOKEN: token };
    env.EGO_HOST_GRANT = JSON.stringify({ tier: "workspace-write" });
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [LAUNCHER, "nodejs"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve_({ status: null, stdout, stderr: `${stderr}\n[탐침 상한 ${timeoutMs}ms 초과]` });
    }, timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve_({ status, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

/**
 * 실행마다 달라지는 값을 지운다. **생성물이 결정론적이어야** `--check` 가 게이트가 된다.
 * 지우는 것: 타깃·세션 id(대문자 16진 32자), 임시 경로, 포트 번호.
 */
export function sanitize(text) {
  return String(text ?? "")
    .replace(/\b[0-9A-F]{16,}\b/g, "<id>")
    .replace(/\/tmp\/[A-Za-z0-9._-]+/g, "<tmp>")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
}

/** heredoc 출력 → 판정. 이 함수 하나가 세 판정의 정의다. */
export function verdictOf(name, probe, result) {
  if (probe.unsupported) return { verdict: `unsupported(${probe.unsupported})`, kind: "unsupported" };
  const match = /^PROBE (.*)$/m.exec(result.stdout);
  if (!match) {
    const why = sanitize((result.stderr || result.stdout || "출력 없음").trim().split("\n").at(-1));
    return { verdict: `unsupported(탐침이 결과를 못 냈다: ${why})`, kind: "unsupported" };
  }
  const payload = JSON.parse(match[1]);
  if (typeof payload.message === "string") payload.message = sanitize(payload.message);
  if (payload.ok) return { verdict: "supported", kind: "supported", value: payload.value };
  // 코드는 두 통로로 온다. `ego` 메서드 거부는 `{error, error_code}` 로 오고(ABI 6), CDP 통로
  // 거부는 벤더가 `error.code` 를 버리므로 **문구 끝의 `[CODE]`** 로만 남는다(cdp-mux 주석).
  const embedded = /\[(EGO_[A-Z0-9_]+)\]/.exec(payload.message ?? "");
  const code = payload.code ?? embedded?.[1] ?? null;
  if (code) {
    return { verdict: `rejected(${code})`, kind: "rejected", message: payload.message };
  }
  if (/is not a function|undefined is not|is not defined/.test(payload.message)) {
    return {
      verdict: `unsupported(고정 커밋 런타임에 없다: ${payload.message})`,
      kind: "unsupported",
      message: payload.message,
    };
  }
  return {
    verdict: `unsupported(${payload.message})`,
    kind: "unsupported",
    message: payload.message,
  };
}

// ── 5. 행렬 생성 ────────────────────────────────────────────────────────────

export function renderMarkdown(matrix) {
  const lines = [];
  lines.push("# 지원 헬퍼 행렬 (측정 결과)");
  lines.push("");
  lines.push(
    "이 파일은 **생성물이다.** 손으로 고치지 않는다 — `node scripts/probe-helpers.mjs` 가 벤더 " +
      "스킬의 `Common helpers` 목록을 그 자리에서 파싱하고, 헬퍼마다 독립 heredoc 을 실 Chromium " +
      "위에서 돌려 다시 쓴다. `--check` 는 측정 결과가 이 파일과 다르면 종료 코드 1 이다.",
  );
  lines.push("");
  lines.push(`대상 업스트림 커밋: \`${matrix.upstreamCommit}\``);
  lines.push("");
  lines.push("판정은 셋뿐이다.");
  lines.push("");
  lines.push("- `supported` — 호출이 감독자를 지나 실제로 동작했다.");
  lines.push("- `rejected(<코드>)` — 우리 정책이 형식 있는 오류로 거부했다. 코드가 이유다.");
  lines.push(
    "- `unsupported(<이유>)` — 고정 커밋의 런타임에 그 이름이 없거나, 헤드리스에서 도달할 수 없다.",
  );
  lines.push("");
  const totals = matrix.totals;
  lines.push(
    `합계: 헬퍼 ${totals.total} 개 — supported ${totals.supported}, ` +
      `rejected ${totals.rejected}, unsupported ${totals.unsupported}.`,
  );
  lines.push("");
  lines.push(
    "**벤더 스킬 문서가 런타임보다 낡았다**(ABI 문서 9절). 스킬의 평면 이름은 대부분 파사드로 " +
      "옮겨졌으므로, 각 행에 고정 커밋 런타임에서 그 일을 하는 호출을 함께 적는다.",
  );
  lines.push("");
  for (const group of matrix.groups) {
    lines.push(`## ${group.category}`);
    lines.push("");
    lines.push("| 스킬의 이름 | 고정 커밋 런타임의 호출 | 판정 |");
    lines.push("|---|---|---|");
    for (const name of group.names) {
      const row = matrix.helpers[name];
      lines.push(`| \`${name}\` | \`${row.runtime}\` | ${row.verdict} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function summarize(groups, helpers) {
  const totals = { total: 0, supported: 0, rejected: 0, unsupported: 0 };
  for (const group of groups) {
    for (const name of group.names) {
      totals.total += 1;
      totals[helpers[name].kind] += 1;
    }
  }
  return totals;
}

async function measure({ only = null } = {}) {
  const groups = parseCommonHelpers(readFileSync(SKILL_PATH, "utf8"));
  const names = groups.flatMap((group) => group.names);
  const missing = names.filter((name) => !Object.hasOwn(PROBES, name));
  if (missing.length > 0) {
    throw new Error(
      `벤더 스킬의 헬퍼 중 탐침이 없는 것이 있다: ${missing.join(", ")}. ` +
        "행렬은 목록 전부를 덮어야 한다 — 탐침을 추가한다.",
    );
  }

  const fixture = await startFixture();
  const workDir = mkdtempSync(join(tmpdir(), "ego-probe-"));
  const adkDir = mkdtempSync(join(tmpdir(), "ego-probe-adk-"));
  const runtimeDir = mkdtempSync(join(tmpdir(), "ego-probe-run-"));
  const uploadPath = join(workDir, "upload.txt");
  writeFileSync(uploadPath, "naia 582 업로드 탐침\n");

  const supervisor = await startSupervisor({
    adkDir,
    executable: discoverBrowser({}).executable,
    runtimeDir,
    headless: true,
  });
  const helpers = {};
  try {
    for (const name of names) {
      if (only && !only.includes(name)) continue;
      const probe = PROBES[name];
      let result = { stdout: "", stderr: "" };
      if (!probe.unsupported) {
        const token = supervisor.server.issueToken({ grant: { tier: "workspace-write" } });
        result = await runHeredoc({
          script: scriptFor(probe, {
            origin: fixture.origin,
            shotPath: join(workDir, `${name}.png`),
            uploadPath,
          }),
          socketPath: supervisor.socketPath,
          token,
        });
      }
      const verdict = verdictOf(name, probe, result);
      helpers[name] = { runtime: probe.runtime, ...verdict };
      process.stderr.write(`  ${name.padEnd(24)} ${verdict.verdict}\n`);
    }
  } finally {
    await supervisor.stop();
    fixture.server.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(adkDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }

  const filtered = only
    ? groups.map((group) => ({ ...group, names: group.names.filter((n) => only.includes(n)) })).filter((g) => g.names.length > 0)
    : groups;
  return {
    upstreamCommit: UPSTREAM_COMMIT,
    source: "vendor/ego-lite/skills/ego-browser/SKILL.md — ## Common helpers",
    groups: filtered,
    helpers,
    totals: summarize(filtered, helpers),
  };
}

export { measure };

// ── 6. CLI ──────────────────────────────────────────────────────────────────

async function main(argv) {
  const check = argv.includes("--check");
  const onlyAt = argv.indexOf("--only");
  const only = onlyAt >= 0 ? (argv[onlyAt + 1] ?? "").split(",").filter(Boolean) : null;
  const matrix = await measure({ only });
  // 생성 결과에는 시각도 임시 경로도 넣지 않는다. 넣으면 --check 가 언제나 실패한다.
  const jsonText = `${JSON.stringify(matrix, null, 2)}\n`;
  const mdText = renderMarkdown(matrix);
  if (check) {
    const sameJson = readFileSync(MATRIX_JSON, "utf8") === jsonText;
    const sameMd = readFileSync(MATRIX_MD, "utf8") === mdText;
    if (sameJson && sameMd) {
      process.stderr.write("행렬이 커밋된 파일과 같다.\n");
      return 0;
    }
    process.stderr.write(
      `행렬이 커밋된 파일과 다르다(json ${sameJson ? "동일" : "다름"}, md ${sameMd ? "동일" : "다름"}). ` +
        "`node scripts/probe-helpers.mjs` 로 다시 생성한다.\n",
    );
    return 1;
  }
  writeFileSync(MATRIX_JSON, jsonText);
  writeFileSync(MATRIX_MD, mdText);
  process.stderr.write(
    `행렬을 갱신했다: supported ${matrix.totals.supported}, rejected ${matrix.totals.rejected}, ` +
      `unsupported ${matrix.totals.unsupported} (전체 ${matrix.totals.total}).\n`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
