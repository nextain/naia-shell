// #582 S2e — 무간섭 세 겹을 **디스플레이 안에서** 재는 탐침 (계약 4.6).
//
// 이 파일은 테스트가 아니라 테스트가 디스플레이 안에서 실행하는 프로그램이다. 활성 창은
// 디스플레이에 붙은 프로세스만 볼 수 있으므로, 재는 쪽이 그 안에 있어야 한다.
//
// 사용: `node no-interference-probe.mjs <결과 JSON 경로>`
//
// 세 겹(계약 4.6)과, **각 계기가 살아 있다는 증명**을 함께 남긴다. 살아 있음을 증명하지 않은
// 검사는 "언제나 통과"와 구별되지 않는다.
//
//  (1) 실제 Chromium 프로세스의 명령줄에 `--headless=new` 가 있다 — `/proc/<pid>/cmdline` 실측.
//      Chromium 은 argv 를 공백으로 재작성하므로 `\0` 과 공백 둘 다 경계로 본다(S2b 실측).
//  (2) 호스트 동작 전후로 활성 창 식별자가 같다.
//      계기 증명: 창 하나를 더 띄우면 활성 창이 **실제로 바뀐다**(A→B), 닫으면 되돌아온다(→A).
//  (3) 감독자 프로세스 트리의 어떤 PID 도 창을 소유하지 않는다 — `xdotool search --pid`.
//      계기 증명: 같은 Chromium 을 **창 있는 모드**로 띄우면 같은 검사가 창을 찾아낸다.
//      (창 있는 모드는 이 디스플레이 안에서만 돈다. 사람 화면에는 아무것도 뜨지 않는다.)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverBrowser } from "../../src/supervisor/browser-discovery.mjs";
import { launchBrowser } from "../../src/supervisor/chrome-launcher.mjs";
import { startSupervisor } from "../../src/supervisor/supervisor.mjs";
import { connectSupervisor } from "../../src/client/rpc-client.mjs";
import { windowsOfPid, xdotool } from "./x-display.mjs";

const outPath = process.argv[2];
const display = process.env.DISPLAY;

// 이 탐침 안에서 띄우는 브라우저는 **X 로만** 나가야 한다. Wayland 로 새면 창이 생겨도
// `xdotool` 이 못 보고, 그러면 3겹이 "창 0" 을 거짓으로 보고한다.
delete process.env.WAYLAND_DISPLAY;

const notes = [];
const openThings = [];

function log(message) {
  notes.push(message);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 15_000, stepMs = 100 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

function activeWindow() {
  return xdotool(["getactivewindow"], { display });
}

/** `/proc` 로 후손 PID 를 모은다. 창 소유 검사는 트리 전체에 걸어야 한다(계약 4.6 3겹). */
function descendantsOf(roots) {
  const children = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
    // comm 에 공백·괄호가 들어갈 수 있으니 마지막 ')' 뒤부터 읽는다.
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(tail[1]);
    if (!Number.isFinite(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(Number(entry));
    children.set(ppid, list);
  }
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return [...seen];
}

function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return "";
  }
}

/** Chromium 은 argv 를 공백으로 재작성한다. 두 경계를 모두 본다(S2b 실측). */
function cmdlineArgs(pid) {
  return cmdlineOf(pid)
    .split(/[\0 ]/)
    .filter(Boolean);
}

function openWindow(label) {
  const child = spawn("xmessage", ["-geometry", "220x120", label], {
    stdio: "ignore",
    env: { ...process.env, DISPLAY: display },
  });
  openThings.push(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  });
  return child;
}

async function main() {
  const result = { display, ok: false, notes };

  // ── 계기 증명 (2겹): 창을 하나 더 띄우면 활성 창이 바뀐다 ──────────────────
  const first = openWindow("naia-582-anchor");
  const anchor = await waitFor(() => activeWindow());
  if (!anchor) throw new Error("디스플레이에 활성 창을 만들지 못했다. 계기를 증명할 수 없다");
  const second = openWindow("naia-582-probe");
  const moved = await waitFor(() => {
    const now = activeWindow();
    return now && now !== anchor ? now : null;
  });
  if (!moved) {
    throw new Error(
      `활성 창 검사가 살아 있지 않다: 창을 하나 더 띄웠는데 ${anchor} 그대로다. ` +
        "이 상태의 '전후 동일'은 아무것도 증명하지 못한다",
    );
  }
  second.kill("SIGKILL");
  const back = await waitFor(() => {
    const now = activeWindow();
    return now === anchor ? now : null;
  });
  result.activeWindowInstrument = { anchor, moved, back };
  log(`활성 창 계기: ${anchor} → ${moved} → ${back ?? "(복귀 실패)"}`);

  // ── 계기 증명 (3겹): 같은 Chromium 을 창 있는 모드로 띄우면 창이 잡힌다 ────
  const executable = discoverBrowser({}).executable;
  const headfulProfile = mkdtempSync(join(tmpdir(), "ego-headful-"));
  const headful = launchBrowser({
    executable,
    profileDir: headfulProfile,
    headless: false,
    marker: "naia-ego-marker-headful-probe",
    // 이 디스플레이의 X 로 나가게 못박는다. 계기 증명이 목적이라 운영 인자와 다르다.
    extraArgs: ["--ozone-platform=x11"],
    env: { ...process.env, DISPLAY: display },
  });
  openThings.push(() => {
    try {
      headful.kill("SIGKILL");
      headful.dispose();
    } catch {}
  });
  const headfulWindows = await waitFor(() => {
    const found = windowsOfPid(headful.pid, { display });
    return found.length > 0 ? found : null;
  });
  result.windowSearchInstrument = {
    headfulPid: headful.pid,
    windows: headfulWindows ?? [],
  };
  if (!headfulWindows) {
    throw new Error(
      "창 소유 검사가 살아 있지 않다: 창 있는 모드의 Chromium 조차 `xdotool search --pid` 로 " +
        "찾지 못했다. 이 상태의 '창 0' 은 아무것도 증명하지 못한다",
    );
  }
  log(`창 소유 계기: 창 있는 Chromium(pid ${headful.pid})에서 창 ${headfulWindows.length} 개 발견`);
  headful.kill("SIGKILL");
  headful.dispose();
  await waitFor(() => windowsOfPid(headful.pid, { display }).length === 0);
  await waitFor(() => activeWindow() === anchor);

  // ── 본 측정 ───────────────────────────────────────────────────────────────
  const fixture = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><meta charset=utf-8><title>naia 582 무간섭</title><body>ok</body>");
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  openThings.push(() => fixture.close());

  const before = activeWindow();
  const adkDir = mkdtempSync(join(tmpdir(), "ego-adk-ni-"));
  const runtimeDir = mkdtempSync(join(tmpdir(), "ego-run-ni-"));
  const supervisor = await startSupervisor({ adkDir, executable, runtimeDir, headless: true });
  openThings.push(() => supervisor.stop());

  // 1겹 — 실제 프로세스의 명령줄.
  const args = cmdlineArgs(supervisor.browserPid);
  result.headlessArgs = { pid: supervisor.browserPid, args };

  // 에이전트가 실제로 일한다 — 공간·탭·이동·스냅샷·캡처까지.
  const token = supervisor.server.issueToken({ grant: { tier: "workspace-write" } });
  const client = await connectSupervisor({
    socketPath: supervisor.socketPath,
    token,
    grant: { tier: "workspace-write" },
    unref: false,
  });
  openThings.push(() => client.close());
  const space = await client.call("createTaskSpace", { name: "무간섭" });
  const tabs = await client.call("listTabs");
  const targetId = tabs.tabs[0].targetId;
  let nextId = 1;
  const send = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`CDP 응답 없음: ${method}`)), 20_000);
      const off = client.onCdp((raw) => {
        const data = JSON.parse(raw);
        if (data.id !== id) return;
        clearTimeout(timer);
        off();
        if (data.error) reject(new Error(`${method}: ${data.error.message}`));
        else resolve(data.result ?? {});
      });
      client.sendCdp(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const attached = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.navigate", { url: `${origin}/` }, attached.sessionId);
  await sleep(700);
  const snapshot = await client.call("snapshot", { options: {} });
  const shot = await client.call("screenshot", {});
  result.work = {
    workspaceId: space.id,
    refs: snapshot.refs?.length ?? 0,
    screenshot: shot.path ?? null,
  };

  // 3겹 — 감독자 트리의 어떤 PID 도 창을 갖지 않는다.
  const tree = descendantsOf([process.pid, supervisor.browserPid]);
  const owners = [];
  for (const pid of tree) {
    const windows = windowsOfPid(pid, { display });
    if (windows.length > 0) owners.push({ pid, windows, cmdline: cmdlineOf(pid).slice(0, 200) });
  }
  result.tree = { size: tree.length, owners };

  // 2겹 — 활성 창 전후 비교.
  const after = activeWindow();
  result.activeWindow = { before, after, anchor };

  await supervisor.stop();
  result.ok = true;
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  writeFileSync(
    outPath,
    `${JSON.stringify({ ok: false, error: error.message, stack: error.stack, notes }, null, 2)}\n`,
  );
} finally {
  for (const close of openThings.reverse()) {
    try {
      await close();
    } catch {}
  }
  // cage 안에서는 이 프로세스가 끝나야 컴포지터가 끝난다.
  process.exit(0);
}
