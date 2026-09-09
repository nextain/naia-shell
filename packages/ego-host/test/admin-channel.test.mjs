/**
 * #582 S6c — 관리 연결(소유자 전용 통로)과 감독자 데몬 (계약 4.8, 9절 S6c).
 *
 * 판정하는 것 넷.
 *  (1) 비밀이 틀린 관리 핸드셰이크는 연결이 서지 않는다. 비밀 없이 띄운 감독자에는 통로가 없다.
 *  (2) 토큰으로 붙은 **작업 연결은 `issueToken` 을 부를 수 없다.** 부를 수 있으면 등급표가
 *      장식이 된다 — 관측 등급으로 붙은 heredoc 이 스스로 destructive 토큰을 만들어 다시 붙는다.
 *  (3) 관리 연결은 토큰을 발급하고, 그 토큰으로 선 작업 연결이 실제로 돈다. 관리 연결 자신은
 *      작업 RPC 를 부르지 못한다.
 *  (4) 데몬(`bin/supervisord.mjs`)이 SIGTERM 과 stdin EOF 에 각각 `stop()` 하고,
 *      그 뒤 Chromium 이 남지 않는다. 실 브라우저다 — 없으면 건너뛰지 않고 RED 다.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { CODES } from "../src/errors.mjs";
import { createFrameDecoder, encodeFrame } from "../src/supervisor/rpc-framing.mjs";
import { connectSupervisor } from "../src/client/rpc-client.mjs";
import { closeAll, connectClient, startSupervisor } from "./helpers/supervisor-fixture.mjs";
import { requireChromium, tempDir, trackPid, waitForExit, cleanupAll } from "./helpers/live-browser.mjs";

const SECRET = "s6c-관리-비밀-0123456789";
const DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "supervisord.mjs");

after(async () => {
  await closeAll();
  cleanupAll();
});

/**
 * 관리 연결 하나. 원시 소켓으로 연다 — `connectSupervisor` 는 토큰 경로 전용이고,
 * 관리 통로가 그 클라이언트를 거치지 않는다는 사실 자체가 이 테스트가 지키는 경계다.
 */
async function openAdmin(socketPath, secret) {
  const socket = connect(socketPath);
  await new Promise((resolveConnect, reject) => {
    socket.once("connect", resolveConnect);
    socket.once("error", reject);
  });
  const frames = [];
  const waiters = [];
  const decoder = createFrameDecoder({
    onFrame: (value) => {
      // 기다리는 쪽이 있으면 **큐에 넣지 않고** 바로 준다. 넣고 또 주면 같은 프레임이
      // 두 번 소비돼 다음 호출이 지난 응답을 자기 것으로 읽는다.
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else frames.push(value);
    },
  });
  socket.on("data", (chunk) => decoder.push(chunk));
  socket.on("error", () => {});
  const next = () =>
    new Promise((resolveFrame) => {
      if (frames.length > 0) return resolveFrame(frames.shift());
      waiters.push(resolveFrame);
      setTimeout(() => resolveFrame(null), 2_000).unref?.();
    });
  socket.write(encodeFrame({ type: "hello", admin: secret }));
  const greeting = await next();
  let nextId = 1;
  return {
    greeting,
    async call(method, params = {}) {
      const id = nextId++;
      socket.write(encodeFrame({ type: "rpc", id, method, params }));
      const frame = await next();
      return frame?.value ?? frame;
    },
    /**
     * 응답을 기다리지 않고 보낸다. `stop` 이 그런 RPC 다 — 감독자를 내리는 일이 소켓 서버를
     * 함께 닫으므로 응답이 돌아올 통로가 그 처리 도중에 사라진다. 그래서 판정은 응답이
     * 아니라 **프로세스**가 한다(셸의 Rust 도 같은 규율로 SIGTERM 을 함께 쓴다).
     */
    notify(method, params = {}) {
      socket.write(encodeFrame({ type: "rpc", id: nextId++, method, params }));
    },
    close() {
      socket.destroy();
    },
  };
}

test("비밀이 틀린 관리 핸드셰이크는 거부된다", async () => {
  const { socketPath } = await startSupervisor({ adminSecret: SECRET });
  const admin = await openAdmin(socketPath, "틀린-비밀-0123456789");
  assert.equal(admin.greeting?.type, "fatal");
  assert.equal(admin.greeting?.error_code, CODES.ADMIN_DENIED);
  admin.close();
});

test("비밀 없이 띄운 감독자에는 관리 통로가 없다", async () => {
  const { server, socketPath } = await startSupervisor();
  assert.equal(server.hasAdminChannel, false);
  const admin = await openAdmin(socketPath, SECRET);
  assert.equal(admin.greeting?.error_code, CODES.ADMIN_DENIED);
  admin.close();
});

test("작업 연결은 issueToken 을 부를 수 없다 — 스스로 등급을 올리는 길이 없다", async () => {
  const { server, socketPath } = await startSupervisor({ adminSecret: SECRET });
  // 관측 등급(grant 없음)과 변경 등급(grant 있음) 둘 다 막혀야 한다.
  const observer = await connectClient(server, socketPath, { grant: null });
  const writer = await connectClient(server, socketPath, { grant: { tier: "workspace-write" } });
  for (const client of [observer, writer]) {
    const denied = await client.call("issueToken", { grant: { tier: "destructive" } });
    assert.equal(denied.error_code, CODES.ADMIN_REQUIRED, denied.error);
  }
  // stop·switchAdk 도 같은 문이다.
  assert.equal((await writer.call("stop", {})).error_code, CODES.ADMIN_REQUIRED);
  assert.equal((await writer.call("switchAdk", {})).error_code, CODES.ADMIN_REQUIRED);
});

test("관리 연결은 토큰을 발급하고 그 토큰으로 선 작업 연결이 돈다", async () => {
  const { socketPath } = await startSupervisor({ adminSecret: SECRET });
  const admin = await openAdmin(socketPath, SECRET);
  assert.equal(admin.greeting?.type, "welcome");
  assert.equal(admin.greeting?.admin, true);

  const grant = { tier: "workspace-write" };
  const issued = await admin.call("issueToken", { operationId: "op-admin-1", grant });
  assert.equal(typeof issued.token, "string");

  const client = await connectSupervisor({
    socketPath,
    token: issued.token,
    grant,
    operationId: "op-admin-1",
    unref: false,
  });
  const version = await client.call("getBrowserVersion", {});
  assert.equal(version.updateAvailable, false);
  client.close();
  admin.close();
});

test("관리 연결은 작업 RPC 를 부르지 않는다 — 브라우저는 토큰을 받은 연결만 만진다", async () => {
  const { socketPath } = await startSupervisor({ adminSecret: SECRET });
  const admin = await openAdmin(socketPath, SECRET);
  const denied = await admin.call("createTaskSpace", { name: "관리가-만드는-공간" });
  assert.equal(denied.error_code, CODES.ADMIN_DENIED, denied.error);
  admin.close();
});

test("붙지 않은 관리 RPC 는 형식 있는 오류로 끝난다", async () => {
  const { socketPath } = await startSupervisor({ adminSecret: SECRET });
  const admin = await openAdmin(socketPath, SECRET);
  const missing = await admin.call("stop", {});
  assert.equal(missing.error_code, CODES.ADMIN_UNAVAILABLE, missing.error);
  admin.close();
});

// ── 데몬 (bin/supervisord.mjs) ────────────────────────────────────────────────

/** 데몬 하나를 띄우고 준비 줄을 읽는다. 준비 줄에 비밀이 실리면 그 자리에서 실패한다. */
async function startDaemon(extraArgs = []) {
  requireChromium();
  const adkDir = tempDir("ego-s6c-adk-");
  const runtimeDir = tempDir("ego-s6c-run-");
  const child = spawn(
    process.execPath,
    [DAEMON, "--adk", adkDir, "--runtime-dir", runtimeDir, ...extraArgs],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, EGO_HOST_ADMIN_SECRET: SECRET } },
  );
  trackPid(child.pid);
  let out = "";
  let err = "";
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`데몬 준비 줄이 오지 않았다: ${out}\n${err}`)), 60_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n").find((entry) => entry.trim() !== "");
      if (!line) return;
      clearTimeout(timer);
      try {
        resolveReady(JSON.parse(line));
      } catch (error) {
        reject(new Error(`준비 줄이 JSON 이 아니다: ${line} (${error.message})`));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`데몬이 준비 전에 종료했다(code ${code}): ${out}\n${err}`));
    });
  });
  assert.equal(ready.ready, true, `데몬이 서지 못했다: ${ready.error}`);
  assert.ok(!JSON.stringify(ready).includes(SECRET), "준비 줄에 관리 비밀이 실렸다");
  trackPid(ready.browserPid);
  return { child, ready: { ...ready, adkDir }, adkDir, stderr: () => err };
}

test("데몬은 SIGTERM 에 감독자를 내리고 Chromium 을 남기지 않는다", async () => {
  const { child, ready, stderr } = await startDaemon();
  assert.equal(typeof ready.browserPid, "number");
  assert.ok(existsSync(join(ready.adkDir, "ego-host", "lease.json")), "lease 를 남기지 않았다");

  child.kill("SIGTERM");
  const daemonGone = await waitForExit(child.pid, 20_000);
  assert.notEqual(daemonGone, null, `데몬이 SIGTERM 에 나가지 않았다: ${stderr()}`);
  const browserGone = await waitForExit(ready.browserPid, 20_000);
  assert.notEqual(browserGone, null, "SIGTERM 뒤에도 Chromium 이 남았다");
});

test("데몬은 stdin EOF 에도 감독자를 내린다 — 부모가 사라지면 통보는 그것뿐이다", async () => {
  const { child, ready, stderr } = await startDaemon();
  child.stdin.end();
  const daemonGone = await waitForExit(child.pid, 20_000);
  assert.notEqual(daemonGone, null, `데몬이 stdin EOF 에 나가지 않았다: ${stderr()}`);
  const browserGone = await waitForExit(ready.browserPid, 20_000);
  assert.notEqual(browserGone, null, "stdin EOF 뒤에도 Chromium 이 남았다");
});

test("데몬의 관리 통로로 hostInfo·stop 을 부를 수 있다", async () => {
  const { child, ready } = await startDaemon();
  const admin = await openAdmin(ready.socketPath, SECRET);
  assert.equal(admin.greeting?.type, "welcome");
  const info = await admin.call("hostInfo", {});
  assert.equal(info.browserPid, ready.browserPid);
  assert.equal(info.socketPath, ready.socketPath);
  assert.ok(!JSON.stringify(info).includes(SECRET), "hostInfo 가 관리 비밀을 흘렸다");

  admin.notify("stop", {});
  const browserGone = await waitForExit(ready.browserPid, 20_000);
  assert.notEqual(browserGone, null, "stop 뒤에도 Chromium 이 남았다");
  admin.close();
  child.kill("SIGTERM");
  await waitForExit(child.pid, 20_000);
});
