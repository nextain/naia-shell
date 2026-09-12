// #582 S2b — Chromium 런처 (계약 4.2.1·4.6 (1)(3)·4.8·4.9).
//
// 인자 조립은 세 OS 를 이 머신에서(순수 함수), 기동·fd·창 확인은 실제 Chromium 으로 한다.
// **Chromium 이 없으면 건너뛰지 않고 RED 다.**
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  CDP_PIPE_READ_FD,
  CDP_PIPE_WRITE_FD,
  buildChromeArgs,
  launchBrowser,
  markerArg,
} from "../src/supervisor/chrome-launcher.mjs";
import { alive, cleanupAll, requireChromium, tempDir, trackPid, waitForExit } from "./helpers/live-browser.mjs";

after(cleanupAll);

/**
 * 어떤 프로세스가 들고 있는 익명 통로(inode)의 집합.
 * libuv 는 stdio `'pipe'` 를 **socketpair 로** 만든다 — `/proc/<pid>/fd` 링크가 `pipe:[N]` 이
 * 아니라 `socket:[N]` 으로 보인다(실측). `pipe:` 만 보면 탐침이 늘 빈손이라 통과한다.
 */
function anonLinks(pid = "self") {
  const dir = `/proc/${pid}/fd`;
  const out = new Set();
  for (const fd of readdirSync(dir)) {
    try {
      const link = readlinkSync(join(dir, fd));
      if (link.startsWith("pipe:") || link.startsWith("socket:")) out.add(link);
    } catch {
      /* 읽는 사이에 닫힌 fd */
    }
  }
  return out;
}

/**
 * `/proc/<pid>/cmdline` 의 인자 목록.
 * **Chromium 은 argv 를 통째로 다시 써서 공백으로 이어 붙인다**(실측 — NUL 이 끝에 하나뿐이다).
 * 그래서 `\0` 과 공백 둘 다로 자른다. `\0` 로만 자르면 인자가 통째로 한 덩어리가 되어
 * `includes("--headless=new")` 가 영원히 거짓이다.
 */
function cmdlineOf(pid) {
  return readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0\s]+/).filter(Boolean);
}

test("런처 인자: 헤드리스·파이프·프로필·marker 가 필요 최소로 들어간다", () => {
  const args = buildChromeArgs({ profileDir: "/tmp/p", marker: "n-1" });
  assert.deepEqual(args, [
    "--headless=new",
    "--remote-debugging-pipe",
    "--user-data-dir=/tmp/p",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--naia-ego-marker=n-1",
  ]);
  // 인자 조립은 플랫폼과 무관하다(계약 4.9: 헤드리스 인자와 CDP 전송은 세 OS 가 같다).
  assert.equal(markerArg("n-1"), "--naia-ego-marker=n-1");
});

test("런처 인자: profileDir 이 없으면 형식 있는 오류다", () => {
  assert.throws(() => buildChromeArgs({}), (error) => {
    assert.equal(error.error_code, "EGO_HOST_USAGE");
    return true;
  });
});

test("런처: 자식 stdio 는 정확히 다섯 칸이고 3·4 만 파이프다", () => {
  const calls = [];
  const fakeChild = {
    pid: 4242,
    stdio: [null, { on() {} }, { on() {} }, { on() {}, write() {}, end() {} }, { on() {} }],
    stderr: { on() {} },
    stdout: { on() {} },
    once() {},
    kill() {},
  };
  launchBrowser({
    executable: "/bin/true",
    profileDir: "/tmp/p",
    spawn: (exe, args, options) => {
      calls.push({ exe, args, options });
      return fakeChild;
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe", "pipe", "pipe"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(CDP_PIPE_READ_FD, 3);
  assert.equal(CDP_PIPE_WRITE_FD, 4);
});

test("런처: 반환 핸들은 파이프 스트림도 child 객체도 노출하지 않는다 (계약 4.8 규율)", () => {
  const handle = launchBrowser({
    executable: "/bin/true",
    profileDir: "/tmp/p",
    spawn: () => ({
      pid: 1,
      stdio: [null, { on() {} }, { on() {} }, { on() {}, write() {}, end() {} }, { on() {} }],
      stderr: { on() {} },
      stdout: { on() {} },
      once() {},
      kill() {},
    }),
  });
  assert.equal(handle.child, undefined);
  assert.equal(handle.stdio, undefined);
  for (const value of Object.values(handle)) {
    assert.notEqual(typeof value?.pipe, "function", "핸들에 스트림이 새어 나왔다");
  }
});

test("런처 실기동: Chromium 이 뜨고 파이프로 Browser.getVersion 응답이 온다", async () => {
  const executable = requireChromium();
  const browser = launchBrowser({ executable, profileDir: tempDir("ego-prof-"), marker: "live-1" });
  trackPid(browser.pid);
  const version = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser.getVersion 응답이 오지 않았다")), 15_000);
    browser.onMessage((raw) => {
      const data = JSON.parse(raw);
      if (data.id === 1) {
        clearTimeout(timer);
        resolve(data.result);
      }
    });
    browser.send({ id: 1, method: "Browser.getVersion", params: {} });
  });
  assert.match(version.product, /Chrome|Chromium/);
  // 무간섭 (1): 실제 명령줄에 헤드리스 인자와 marker 가 있다.
  const cmdline = cmdlineOf(browser.pid);
  assert.ok(cmdline.includes("--headless=new"), `명령줄에 --headless=new 가 없다: ${cmdline.join(" ")}`);
  assert.ok(cmdline.includes("--remote-debugging-pipe"));
  assert.ok(cmdline.includes(markerArg("live-1")));
  assert.match(version.userAgent, /Headless/);
  browser.close();
  assert.notEqual(await waitForExit(browser.pid, 10_000), null, "파이프를 닫았는데 Chromium 이 남았다");
});

test("무간섭 (3): xdotool search --pid 가 Chromium PID 에 대해 빈 결과다", async () => {
  // xdotool 은 필수 의존이다(계약 4.6). 없으면 건너뛰지 않고 RED 다.
  const which = execFileSync("sh", ["-c", "command -v xdotool || true"], { encoding: "utf8" }).trim();
  assert.ok(which, "xdotool 이 이 머신에 없다 — 계약 4.6 의 무간섭 3겹을 확인할 수 없으므로 RED");
  const browser = launchBrowser({
    executable: requireChromium(),
    profileDir: tempDir("ego-prof-"),
    marker: "live-window",
  });
  trackPid(browser.pid);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("브라우저가 응답하지 않았다")), 15_000);
    browser.onMessage(() => {
      clearTimeout(timer);
      resolve();
    });
    browser.send({ id: 1, method: "Browser.getVersion", params: {} });
  });
  let stdout = "";
  try {
    stdout = execFileSync(which, ["search", "--pid", String(browser.pid)], { encoding: "utf8" });
  } catch (error) {
    // 일치하는 창이 없으면 xdotool 은 종료 코드 1 이다. 그것이 우리가 원하는 결과다.
    stdout = String(error.stdout ?? "");
  }
  assert.equal(stdout.trim(), "", `헤드리스인데 창을 소유했다: ${stdout}`);
  browser.close();
  await waitForExit(browser.pid, 10_000);
});

test("후손 fd 부재: 런처 뒤에 spawn 한 다른 자식의 /proc/<pid>/fd 에 CDP 파이프가 없다 (계약 4.8)", async () => {
  const before = anonLinks();
  const browser = launchBrowser({
    executable: requireChromium(),
    profileDir: tempDir("ego-prof-"),
    marker: "live-fd",
  });
  trackPid(browser.pid);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("브라우저가 응답하지 않았다")), 15_000);
    browser.onMessage(() => {
      clearTimeout(timer);
      resolve();
    });
    browser.send({ id: 1, method: "Browser.getVersion", params: {} });
  });
  const afterLaunch = anonLinks();
  const launchPipes = [...afterLaunch].filter((link) => !before.has(link));
  // 탐침이 헛돌지 않게: 런처가 실제로 부모 쪽 파이프를 새로 열었어야 한다.
  assert.ok(launchPipes.length >= 2, `런처가 연 부모 쪽 파이프를 못 찾았다: ${launchPipes.join(",")}`);

  // 런처 **뒤에** 다른 자식을 띄운다. fd 3 이상은 Node 기본이 ignore 라 상속되지 않아야 한다.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackPid(child.pid);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const childPipes = anonLinks(child.pid);
  const leaked = launchPipes.filter((link) => childPipes.has(link));
  assert.deepEqual(leaked, [], `자식이 CDP 파이프를 상속했다: ${leaked.join(",")}`);
  child.kill("SIGKILL");
  browser.close();
  assert.notEqual(await waitForExit(browser.pid, 10_000), null, "파이프 EOF 뒤에도 Chromium 이 남았다");
  assert.equal(alive(browser.pid), false);
});
