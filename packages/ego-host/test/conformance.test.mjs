/**
 * #582 S2a — 실행 ABI 적합성과 전송 실패 모드.
 *
 * 판정 방식: **빌드된 벤더 런타임을 런처로 실제 실행**하고, 그 앞에 우리 감독자와 가짜 CDP
 * 백엔드를 둔다. 벤더 파일은 한 글자도 고치지 않는다. 실브라우저는 이 슬라이스에 없다 —
 * Chromium·정책 행렬·장부는 S2b~S2f 다.
 *
 * 테스트 이름의 `ABI n` 은 `docs/ego-runtime-abi.md` 의 절 번호이며, 그 문서의 각 행 끝에
 * 여기 이름이 병기돼 있다.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { CODES } from "../src/errors.mjs";
import { createFakeCdp } from "./helpers/fake-cdp.mjs";
import { closeAll, shortDir, startSupervisor } from "./helpers/supervisor-fixture.mjs";
import { cleanupAll } from "./helpers/live-browser.mjs";
import {
  cdpChannel,
  connectClient,
  startLiveSupervisor,
  stopAllLive,
  waitFor,
} from "./helpers/live-supervisor.mjs";
import {
  LAUNCHER,
  VENDOR_DIST,
  ensureVendorDist,
  json,
  line,
  runEgoScript,
} from "./helpers/vendor-runtime.mjs";

const liveServers = [];

after(async () => {
  await closeAll();
  for (const server of liveServers.splice(0)) await new Promise((done) => server.close(done));
  await stopAllLive();
  cleanupAll();
});

/**
 * 실브라우저 적합성용 로컬 픽스처.
 * 대화상자·링크·여러 탭을 만들 자리가 필요하다. 외부 네트워크로 나가지 않는다.
 */
async function startLiveFixture() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><meta charset=utf-8><title>naia 582 적합성 ${request.url}</title>` +
        "<body><h1>적합성</h1><button id=go>가기</button>" +
        '<a id="away" href="/other">다른 곳</a></body>',
    );
  });
  liveServers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { origin: `http://127.0.0.1:${server.address().port}` };
}

/** 실 감독자 + 실 Chromium + 벤더 런타임(런처로 실제 실행) 한 벌. */
async function liveStage() {
  const fixture = await startLiveFixture();
  const live = await startLiveSupervisor();
  return { fixture, live, token: () => live.server.issueToken({ grant: { tier: "workspace-write" } }) };
}

function runLive(stage, script, options = {}) {
  return runEgoScript({
    socketPath: stage.live.socketPath,
    token: stage.token(),
    script: `const BASE = ${JSON.stringify(stage.fixture.origin)};\n${script}`,
    ...options,
  });
}

before(() => ensureVendorDist(), { timeout: 900_000 });

/** 감독자 하나 + 토큰 하나. 테스트마다 새로 만든다(토큰은 단일 사용이다). */
async function stage(options = {}) {
  const backend = options.backend ?? createFakeCdp();
  const { server, socketPath } = await startSupervisor({ ...options, backend });
  const grant = options.grant ?? { tier: "workspace-write" };
  const token = server.issueToken({ grant });
  return { server, backend, socketPath, token, grant };
}

const USE_SPACE = 'const space = await taskSpaces.useOrCreate("t1");\n';

// ── ABI 0: globalThis.ego 표면 ───────────────────────────────────────────────

test("ABI 0: isBrowserRuntime 이 참이고 필수 12 메서드가 모두 함수다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script: `
      const need = ["sendCDPMessage","listTabs","createTab","snapshot","listTaskSpaces",
        "useTaskSpace","createTaskSpace","claimTaskSpace","closeTaskSpace","completeTaskSpace",
        "handOffTaskSpace","takeOverTaskSpace"];
      console.log("MISSING " + JSON.stringify(need.filter((n) => typeof globalThis.ego[n] !== "function")));
      console.log("SENDSYNC " + JSON.stringify(typeof globalThis.ego.sendCDPMessage === "function"));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(result, "MISSING"), []);
  assert.equal(json(result, "SENDSYNC"), true);
});

test("ABI 0: 런타임이 대입한 onCDPMessage·onSendCDPMessageError 를 감독자가 덮어쓰지 않는다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      `
      await cdp("Page.getFrameTree", {});
      console.log("CALLBACKS " + JSON.stringify([
        typeof globalThis.ego.onCDPMessage,
        typeof globalThis.ego.onSendCDPMessageError,
      ]));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json(result, "CALLBACKS"), ["function", "function"]);
});

// ── ABI 1: CDP 통로 ──────────────────────────────────────────────────────────

test("ABI 1: 요청 id 를 보존한 응답이 대기 항목을 푼다", async () => {
  const { socketPath, token, backend } = await stage();
  backend.respondTo("Echo.method", (data) => ({ result: { seen: data.params.n } }));
  const result = await runEgoScript({
    socketPath,
    token,
    script: USE_SPACE + `console.log("ECHO " + JSON.stringify(await cdp("Echo.method", { n: 42 })));`,
  });
  assert.equal(result.status, 0, result.stderr);
  // `cdp()` 는 응답 봉투가 아니라 `.result` 를 돌려준다(vendor src/cdp-eval.ts:12-16).
  assert.equal(json(result, "ECHO").seen, 42);
  const runtimeIds = backend.sent.filter((m) => m.method === "Echo.method").map((m) => m.id);
  assert.ok(runtimeIds[0] > 1, "상류 id 가 런타임 id 와 같은 발번이면 재작성을 확인할 수 없다");
});

test("ABI 1: 오류 응답 {id, error:{message}} 는 그 요청만 거부한다", async () => {
  const { socketPath, token, backend } = await stage();
  backend.respondTo("Bad.method", () => ({ error: { message: "그 메서드는 안 된다" } }));
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      `
      try { await cdp("Bad.method", {}); console.log("ERR none"); }
      catch (e) { console.log("ERR " + e.message); }
      console.log("STILL " + JSON.stringify(await cdp("Page.getFrameTree", {})));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(line(result, "ERR"), /그 메서드는 안 된다/);
  assert.ok(line(result, "STILL"), "한 요청의 거부가 다음 요청까지 죽였다");
});

test("ABI 1: 세션 상실 문구에 런타임의 자동 재접속이 돈다", async () => {
  const { socketPath, token, backend } = await stage();
  let firstTry = true;
  backend.respondTo("Flaky.method", () => {
    if (firstTry) {
      firstTry = false;
      return { error: { message: "Session not found" } };
    }
    return { result: { recovered: true } };
  });
  const result = await runEgoScript({
    socketPath,
    token,
    script: USE_SPACE + `console.log("FLAKY " + JSON.stringify(await cdp("Flaky.method", {})));`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result, "FLAKY").recovered, true);
  const attaches = backend.sent.filter((m) => m.method === "Target.attachToTarget");
  assert.ok(attaches.length >= 2, "세션 상실 뒤 재접속이 일어나지 않았다");
});

test("ABI 1: 감독자 상한이 런타임 15초 타임아웃보다 먼저 원래 id 오류를 돌려준다", async () => {
  const backend = createFakeCdp();
  backend.silence("Never.answers");
  const { socketPath, token } = await stage({ backend, requestDeadlineMs: 400 });
  const started = Date.now();
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      `try { await cdp("Never.answers", {}); console.log("DEADLINE none"); }
       catch (e) { console.log("DEADLINE " + e.message); }`,
  });
  assert.equal(result.status, 0, result.stderr);
  const message = line(result, "DEADLINE");
  assert.match(message, /감독자 상한/, `런타임 15초 타임아웃이 먼저 왔다: ${message}`);
  assert.ok(Date.now() - started < 15_000, "런타임 15초 상한 안에 끝나야 한다");
});

// ── ABI 2: id 없는 오류 통로 ─────────────────────────────────────────────────

test("ABI 2: 연결이 죽으면 onSendCDPMessageError 가 in-flight 전부를 같은 오류로 거부한다", async () => {
  const backend = createFakeCdp();
  backend.silence("Slow.one");
  const staged = await stage({ backend, requestDeadlineMs: 10_000 });
  backend.respondTo("Kill.now", () => {
    for (const connection of staged.server.connections) connection.socket.destroy();
    return undefined;
  });
  const result = await runEgoScript({
    socketPath: staged.socketPath,
    token: staged.token,
    script:
      USE_SPACE +
      `
      const a = cdp("Slow.one", {});
      const b = cdp("Kill.now", {});
      const settled = await Promise.allSettled([a, b]);
      console.log("STATES " + JSON.stringify(settled.map((s) => s.status)));
      console.log("CODES " + JSON.stringify(settled.map((s) => s.reason?.error_code ?? null)));
    `,
  });
  assert.deepEqual(json(result, "STATES"), ["rejected", "rejected"]);
  assert.deepEqual(json(result, "CODES"), [CODES.DISCONNECTED, CODES.DISCONNECTED]);
});

// ── ABI 3: 세션 ──────────────────────────────────────────────────────────────

test("ABI 3: attachToTarget flatten 뒤 Page.enable 은 세션당 한 번이고 이벤트가 계속 온다", async () => {
  const backend = createFakeCdp();
  backend.respondTo("Page.enable", (data, self) => {
    // 응답 뒤에 그 세션으로 이벤트를 흘린다. 재정렬 없이 순서대로 와야 한다.
    setTimeout(() => self.push({ sessionId: data.sessionId, method: "Page.loadEventFired", params: {} }), 10);
    return { result: {} };
  });
  const { socketPath, token } = await stage({ backend });
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      `
      await cdp("Page.getFrameTree", {});
      await cdp("Page.getFrameTree", {});
      await new Promise((r) => setTimeout(r, 200));
      console.log("EVENTS " + JSON.stringify(page.drainEvents().map((e) => e.method)));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(json(result, "EVENTS").includes("Page.loadEventFired"), "Page.enable 뒤 이벤트가 오지 않았다");
  const enables = backend.sent.filter((m) => m.method === "Page.enable");
  assert.equal(enables.length, 1, `Page.enable 이 세션당 한 번이어야 한다 (${enables.length}회)`);
});

// ── ABI 4: 탭 ────────────────────────────────────────────────────────────────

test("ABI 4: listTabs 는 {tabs} 를 주고 항목이 {targetId,title,url,active} 다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      `
      console.log("RAW " + JSON.stringify(await globalThis.ego.listTabs()));
      console.log("TABS " + JSON.stringify(await browser.listTabs()));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  const raw = json(result, "RAW");
  assert.ok(Array.isArray(raw.tabs), "listTabs 가 {tabs} 모양이 아니다 — 헬퍼는 result.tabs 만 본다");
  const tabs = json(result, "TABS");
  assert.equal(tabs.length, 1);
  assert.deepEqual(Object.keys(tabs[0]).sort(), ["active", "index", "targetId", "title", "url"]);
  assert.equal(tabs[0].active, true, "active 인 탭이 없으면 세션을 붙일 곳이 없다");
});

test("ABI 4: createTab 은 targetId 를 주고 새 탭이 목록에 들어온다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      `
      const created = await globalThis.ego.createTab("https://naia.test/x");
      console.log("CREATED " + JSON.stringify(created));
      console.log("AFTER " + JSON.stringify((await browser.listTabs()).map((t) => t.targetId)));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  const created = json(result, "CREATED");
  assert.equal(typeof created.targetId, "string");
  assert.ok(json(result, "AFTER").includes(created.targetId));
});

// ── ABI 5: 작업 공간 ─────────────────────────────────────────────────────────

test("ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      `
      console.log("SPACE " + JSON.stringify(space));
      console.log("RAW " + JSON.stringify(await globalThis.ego.listTaskSpaces()));
      console.log("LIST " + JSON.stringify(await taskSpaces.list()));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  const space = json(result, "SPACE");
  assert.equal(typeof space.id, "number", "숫자가 아닌 id 는 헬퍼가 던진다");
  assert.equal(space.ownership, "agent");
  assert.ok(Array.isArray(json(result, "RAW").taskSpaces), "{taskSpaces:[...]} 모양이 아니다");
  assert.equal(json(result, "LIST").length, 1);
});

test("ABI 5: 선택 공간은 연결별이라 두 CLI 가 서로 다른 공간에서 일한다", async () => {
  const { server, socketPath } = await stage();
  const first = await runEgoScript({
    socketPath,
    token: server.issueToken({ grant: { tier: "workspace-write" } }),
    script: `const s = await taskSpaces.useOrCreate("가"); console.log("A " + JSON.stringify(s.id));
             console.log("ATABS " + JSON.stringify((await browser.listTabs()).map((t) => t.targetId)));`,
  });
  const second = await runEgoScript({
    socketPath,
    token: server.issueToken({ grant: { tier: "workspace-write" } }),
    script: `const s = await taskSpaces.useOrCreate("나"); console.log("B " + JSON.stringify(s.id));
             console.log("BTABS " + JSON.stringify((await browser.listTabs()).map((t) => t.targetId)));`,
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(json(first, "A"), json(second, "B"));
  assert.notDeepEqual(json(first, "ATABS"), json(second, "BTABS"));
});

// ── ABI 6: {error, error_code} ───────────────────────────────────────────────

test("ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      `
      const out = [];
      for (const [name, run] of [
        ["handOff", () => taskSpaces.handOff()],
        ["takeOver", () => taskSpaces.takeOver()],
        ["claim", () => taskSpaces.claim(space.id)],
      ]) {
        try { await run(); out.push([name, null, null]); }
        catch (e) { out.push([name, e.error_code ?? null, e.message]); }
      }
      console.log("HANDOFF " + JSON.stringify(out));
      console.log("STILL " + JSON.stringify((await taskSpaces.list()).length));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const [name, code, message] of json(result, "HANDOFF")) {
    assert.equal(code, "EGO_HANDOFF_UNSUPPORTED_HEADLESS", name);
    assert.match(message, /헤드리스/, `${name}: 미지의 코드에는 error 문구가 유일한 설명이다`);
  }
  assert.equal(json(result, "STILL"), 1, "거부가 다른 호출까지 죽였다");
});

// ── ABI 7: 스냅샷 ────────────────────────────────────────────────────────────

test("ABI 7: snapshot 은 {content, refs} 를 주고 ref 키가 backendNodeId 와 같다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      `
      const raw = await page.snapshotRaw({});
      console.log("SNAP " + JSON.stringify(raw));
      console.log("TEXT " + JSON.stringify(await page.snapshot()));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  const snap = json(result, "SNAP");
  assert.equal(typeof snap.content, "string");
  assert.deepEqual(Object.keys(snap.refs[0]).sort(), ["backendNodeId", "name", "role"]);
  for (const ref of snap.refs) {
    // S2e 부터 본문 주석은 `[ref=N, loc=..., url=...]` 다(벤더 SKILL.md:182 의 형식).
    // 기계 계약은 `ref=N` 과 `refs[].backendNodeId` 가 같은 값이라는 것 하나뿐이다.
    assert.match(
      snap.content,
      new RegExp(`\\[ref=${ref.backendNodeId}[,\\]]`),
      "본문 주석과 ref 키가 어긋났다",
    );
  }
  assert.equal(json(result, "TEXT"), snap.content);
});

test("ABI 7: snapshot 은 resolve 가 아니라 reject 로 사람 제어를 알린다", async () => {
  const { socketPath, token } = await stage({
    snapshotProvider: () => {
      const error = new Error("사람이 이 작업 공간을 쓰고 있다");
      error.error_code = "EGO_TASK_SPACE_USER_IN_CONTROL";
      throw error;
    },
  });
  const result = await runEgoScript({
    socketPath,
    token,
    script:
      USE_SPACE +
      // 하드 스톱은 stdout 싱크를 안내문으로 갈아치우므로 관측은 stderr 로 한다.
      `try { await page.snapshotRaw({}); console.error("SNAPERR none"); }
       catch (e) { console.error("SNAPERR " + JSON.stringify([e.error_code ?? null, e.message])); }`,
  });
  const [code, message] = json(result, "SNAPERR", "stderr");
  assert.equal(code, "EGO_TASK_SPACE_USER_IN_CONTROL");
  assert.match(message, /snapshot/, "buildEgoError 가 op 를 앞에 붙인다");
});

// ── ABI 8: 환경·경로 ────────────────────────────────────────────────────────

test("ABI 8: EGO_BROWSER_AGENT_WORKSPACE 의 agent_helpers.js 가 spawn 시점 환경으로 잡힌다", async () => {
  const { socketPath, token } = await stage();
  const workspace = mkdtempSync(join(tmpdir(), "ego-ws-"));
  writeFileSync(
    join(workspace, "agent_helpers.js"),
    "export function naiaProbe() { return '주입됨'; }\n",
  );
  const result = await runEgoScript({
    socketPath,
    token,
    env: { EGO_BROWSER_AGENT_WORKSPACE: workspace },
    script: `console.log("HELPER " + JSON.stringify(typeof naiaProbe === "function" ? naiaProbe() : null));`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result, "HELPER"), "주입됨");
});

// ── ABI 9: CLI 진입점 ───────────────────────────────────────────────────────

test("ABI 9: 런처가 nodejs 를 받아 stdin 을 그대로 넘기고 console.log 가 stdout 으로 나온다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script: `console.log("STDIN 통과")`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^STDIN 통과$/m);
});

test("ABI 9: 런처가 --sdk-path 로 받은 dist 를 쓴다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    args: ["nodejs", "--sdk-path", VENDOR_DIST],
    script: `console.log("SDKPATH ok")`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^SDKPATH ok$/m);
});

test("ABI 9: 런처 인자가 틀리거나 sdk 가 없으면 형식 있는 오류로 끝난다", async () => {
  const bad = await runEgoScript({ script: "", args: ["python"], socketPath: null, token: null });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stderr.trim()).error_code, CODES.USAGE);

  const missing = await runEgoScript({
    script: "",
    args: ["nodejs", "--sdk-path", join(shortDir(), "없는-dist")],
    socketPath: null,
    token: null,
  });
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stderr.trim()).error_code, CODES.SDK_NOT_FOUND);
});

test("ABI 9: 호스트가 없으면 첫 ego 접촉에서 형식이 맞는 오류로 죽는다", async () => {
  const result = await runEgoScript({
    script: `console.log(await browser.listTabs())`,
    socketPath: null,
    token: null,
    grant: null,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /browser runtime is not available/);
});

test("ABI 9: getBrowserVersion 이 고정 문자열이라 업데이트 알림이 침묵한다", async () => {
  const { socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script: `console.log("VERSION " + JSON.stringify(await globalThis.ego.getBrowserVersion()));`,
  });
  assert.equal(result.status, 0, result.stderr);
  const info = json(result, "VERSION");
  assert.equal(info.updateAvailable, false);
  const { composeNotice } = await import(pathToFileURL(join(VENDOR_DIST, "index.js")).href).catch(
    async () => import(pathToFileURL(join(VENDOR_DIST, "..", "src", "update-notice.js")).href),
  );
  assert.equal(
    typeof composeNotice === "function" ? composeNotice(info) : null,
    null,
    "고정 버전이 알림 한 줄을 만들었다",
  );
});

// ── 4.2.1: worker·fork·cluster 에서 preload 는 fail-closed ──────────────────

test("4.2.1: worker 자식에서 preload 는 아무 핸드셰이크도 하지 않는다", async () => {
  const { server, socketPath, token } = await stage();
  const result = await runEgoScript({
    socketPath,
    token,
    script: `
      const { Worker } = await import("node:worker_threads");
      const worker = new Worker("require('node:worker_threads').parentPort.postMessage(typeof globalThis.ego)", { eval: true });
      const seen = await new Promise((r) => worker.once("message", r));
      await worker.terminate();
      console.log("WORKER " + JSON.stringify(seen));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result, "WORKER"), "undefined", "worker 가 ego 를 얻었다 — isMainThread 방어가 뚫렸다");
  assert.equal(server.rejected.length, 0, "worker 가 핸드셰이크를 시도했다");
});

test("4.2.1: fork 자식은 토큰 재사용으로 거부돼 fail-closed 로 죽는다", async () => {
  const { server, socketPath, token } = await stage();
  const dir = shortDir("ego-fork-");
  const probe = join(dir, "fork-probe.mjs");
  writeFileSync(probe, 'console.log("FORK_CHILD " + typeof globalThis.ego);\n');
  const result = await runEgoScript({
    socketPath,
    token,
    script: `
      const { fork } = await import("node:child_process");
      const child = fork(${JSON.stringify(probe)}, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let out = "", err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      const status = await new Promise((r) => child.on("close", r));
      console.log("FORK " + JSON.stringify({ status, sawEgo: out.includes("FORK_CHILD object") }));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  const fork = json(result, "FORK");
  assert.notEqual(fork.status, 0, "fork 자식이 성공으로 끝났다 — 토큰이 두 번 쓰였다");
  assert.equal(fork.sawEgo, false, "fork 자식이 ego 를 얻었다");
  assert.ok(
    server.rejected.some((r) => r.code === CODES.TOKEN_REUSED),
    `감독자가 토큰 재사용으로 거부한 기록이 없다: ${JSON.stringify(server.rejected)}`,
  );
});

test("런처는 stdio 를 정확히 세 칸의 명시 목록으로만 넘긴다 (계약 4.8)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(LAUNCHER, "utf8");
  assert.match(source, /stdio: \["inherit", "inherit", "inherit"\]/);
  assert.ok(!/stdio:\s*\[[^\]]*\d/.test(source), "stdio 목록에 숫자 fd 가 들어 있다");
});

// ── S2f: 실 감독자 + 실 Chromium + 벤더 런타임으로 다시 밟는 행들 ───────────
//
// 위의 ABI 테스트는 가짜 CDP 백엔드로 **전송 계약**을 고정한다(그대로 둔다). 아래는 같은 행을
// 진짜 브라우저에서 다시 밟는다 — 가짜 백엔드는 우리가 쓴 대로 답하므로, 우리 가정이 틀렸다는
// 것은 진짜 브라우저만 알려 준다.

test("ABI 3 실브라우저: 대기 중 대화상자를 pageInfo 가 알리고 handleJavaScriptDialog 가 푼다", async () => {
  const stage = await liveStage();
  const result = await runLive(
    stage,
    `
      await taskSpaces.useOrCreate("dialog");
      await browser.openOrReuseTab(BASE + "/dialog", { wait: true, timeout: 15000 });
      // alert 은 페이지 자바스크립트를 멈춘다. 먼저 돌려주고 나서 뜨게 한다.
      await page.evaluate("setTimeout(() => alert('naia-582'), 0)");
      await page.waitForTimeout(500);
      console.log("DURING " + JSON.stringify(await page.info()));
      await cdp("Page.handleJavaScriptDialog", { accept: true });
      await page.waitForTimeout(300);
      console.log("AFTER " + JSON.stringify(await page.info()));
    `,
  );
  assert.equal(result.status, 0, result.stderr);
  const during = json(result, "DURING");
  assert.ok("dialog" in during, `대화상자 중에도 pageInfo 가 평범한 값을 줬다: ${JSON.stringify(during)}`);
  const after = json(result, "AFTER");
  assert.ok(!("dialog" in after), "대화상자를 처리한 뒤에도 dialog 가 남았다");
  assert.ok(after.url.includes("/dialog"));
  await stage.live.stop();
});

test("ABI 4 실브라우저: 탭 전환·닫기가 Target 장부를 지나고 목록이 실제와 맞는다", async () => {
  const stage = await liveStage();
  const result = await runLive(
    stage,
    `
      await taskSpaces.useOrCreate("tabs");
      const first = await browser.openOrReuseTab(BASE + "/one", { wait: true, timeout: 15000 });
      const second = await browser.openOrReuseTab(BASE + "/two", { wait: true, timeout: 15000 });
      console.log("BOTH " + JSON.stringify((await browser.listTabs()).map((t) => t.url)));
      await browser.switchTab(first.targetId);
      console.log("CURRENT " + JSON.stringify((await browser.currentTab()).targetId === first.targetId));
      await browser.closeTab(second.targetId);
      console.log("AFTER " + JSON.stringify((await browser.listTabs()).map((t) => t.targetId)));
      console.log("CLOSED " + JSON.stringify(second.targetId));
    `,
  );
  assert.equal(result.status, 0, result.stderr);
  const both = json(result, "BOTH");
  assert.ok(
    both.some((url) => url.includes("/one")) && both.some((url) => url.includes("/two")),
    `탭 목록의 주소가 실제와 다르다: ${JSON.stringify(both)}`,
  );
  assert.equal(json(result, "CURRENT"), true, "Target.activateTarget 뒤 현재 탭이 안 바뀌었다");
  assert.ok(
    !json(result, "AFTER").includes(json(result, "CLOSED")),
    "닫은 탭이 목록에 유령으로 남았다",
  );
  await stage.live.stop();
});

test("ABI 5 실브라우저: completeTaskSpace{keep:true} 는 유지하고 closeTaskSpace 는 컨텍스트까지 닫는다", async () => {
  const stage = await liveStage();
  const client = await connectClient(stage.live);
  const kept = await runLive(
    stage,
    `
      const space = await taskSpaces.useOrCreate("유지");
      await browser.openOrReuseTab(BASE + "/keep", { wait: true, timeout: 15000 });
      console.log("DONE " + JSON.stringify(await taskSpaces.complete(space.id, { keep: true })));
      console.log("ID " + JSON.stringify(space.id));
    `,
  );
  assert.equal(kept.status, 0, kept.stderr);
  const keptId = json(kept, "ID");
  const stillThere = await client.call("listTaskSpaces");
  assert.ok(
    stillThere.taskSpaces.some((space) => space.id === keptId),
    "keep:true 인데 공간이 사라졌다",
  );

  const closed = await runLive(
    stage,
    `
      const space = await taskSpaces.useOrCreate("닫기");
      await browser.openOrReuseTab(BASE + "/close", { wait: true, timeout: 15000 });
      await ego.closeTaskSpace();
      console.log("ID " + JSON.stringify(space.id));
    `,
  );
  assert.equal(closed.status, 0, closed.stderr);
  const closedId = json(closed, "ID");
  const after = await client.call("listTaskSpaces");
  assert.ok(
    !after.taskSpaces.some((space) => space.id === closedId),
    "closeTaskSpace 뒤에도 공간이 장부에 남았다",
  );
  // 컨텍스트까지 사라졌는지는 브라우저에게 되묻는다.
  const contexts = await stage.live.supervisor.server.mux.hostRequest("Target.getBrowserContexts", {});
  const ledgerContexts = stage.live.ledger.inspect().contexts.filter(Boolean);
  for (const contextId of ledgerContexts) {
    assert.ok(
      contexts.browserContextIds.includes(contextId),
      "장부가 든 컨텍스트가 브라우저에 없다",
    );
  }
  assert.equal(
    ledgerContexts.length,
    after.taskSpaces.length,
    "장부의 컨텍스트 수와 공간 수가 어긋났다",
  );
  await stage.live.stop();
});

test("ABI 8 실브라우저: EGO_BROWSER_NAME 은 작업 공간을 나누지 않는다 — 장부는 감독자가 든다", async () => {
  const stage = await liveStage();
  const first = await runLive(
    stage,
    `
      const space = await taskSpaces.useOrCreate("이름-무관");
      console.log("ID " + JSON.stringify(space.id));
    `,
    { env: { EGO_BROWSER_NAME: "instance-a" } },
  );
  assert.equal(first.status, 0, first.stderr);
  const second = await runLive(
    stage,
    `
      const spaces = await taskSpaces.list();
      console.log("NAMES " + JSON.stringify(spaces.map((s) => s.name)));
    `,
    { env: { EGO_BROWSER_NAME: "instance-b" } },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.ok(
    json(second, "NAMES").includes("이름-무관"),
    "인스턴스 이름이 다르다고 작업 공간이 갈라졌다 — 장부는 감독자 하나가 든다",
  );
  await stage.live.stop();
});
