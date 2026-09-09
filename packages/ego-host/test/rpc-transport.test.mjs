/**
 * #582 S2a — 감독자 RPC 전송 계층 (계약 4.2·4.3.1).
 *
 * 여기서 쓰는 CDP 백엔드는 **가짜**다. 실브라우저는 S2b 부터다. 이 파일이 판정하는 것은
 * 프레이밍·id 공간·순서·역압·단절·정책 거부의 영향 범위이며, 전부 종료 코드로 끝난다.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createFrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "../src/supervisor/rpc-framing.mjs";
import {
  RUNTIME_RESPONSE_TIMEOUT_MS,
  SUPERVISOR_REQUEST_DEADLINE_MS,
} from "../src/supervisor/cdp-mux.mjs";
import { CODES } from "../src/errors.mjs";
import { supervisorSocketPath, UNIX_SOCKET_PATH_MAX } from "../src/supervisor/socket-path.mjs";
import { createFakeCdp } from "./helpers/fake-cdp.mjs";
import { closeAll, connectClient, startSupervisor } from "./helpers/supervisor-fixture.mjs";

after(closeAll);

/** 다음 CDP 프레임 하나를 기다린다. 순서 시험은 이걸 여러 번 쓴다. */
function collector(client, count) {
  const seen = [];
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  const off = client.onCdp((raw) => {
    seen.push(JSON.parse(raw));
    if (seen.length >= count) {
      off();
      resolve(seen);
    }
  });
  return done;
}

// ── 프레이밍 ─────────────────────────────────────────────────────────────────

test("프레이밍: 청크가 어떻게 쪼개져도 프레임 경계가 복원된다", () => {
  const got = [];
  const decoder = createFrameDecoder({ onFrame: (v) => got.push(v) });
  const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "가".repeat(50) })]);
  for (let i = 0; i < bytes.length; i += 3) decoder.push(bytes.subarray(i, i + 3));
  assert.deepEqual(got, [{ a: 1 }, { b: "가".repeat(50) }]);
});

test("프레이밍: 상한을 넘는 프레임은 보내기 전에 형식 있는 오류로 거부된다", () => {
  assert.throws(
    () => encodeFrame({ big: "x".repeat(2048) }, { maxBytes: 1024 }),
    (error) => error.error_code === CODES.FRAME_TOO_LARGE,
  );
});

test("프레이밍: 상한을 넘는 길이 헤더는 본문을 기다리지 않고 즉시 오류다", () => {
  const errors = [];
  const decoder = createFrameDecoder({ maxBytes: 16, onError: (e) => errors.push(e.error_code) });
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES, 0);
  decoder.push(header);
  assert.deepEqual(errors, [CODES.FRAME_TOO_LARGE]);
  assert.equal(decoder.pendingBytes, 0, "상한 초과 뒤에도 버퍼를 들고 있으면 그것이 메모리 폭탄이다");
});

// ── 소켓 경로: 세 OS ─────────────────────────────────────────────────────────

test("소켓 경로: linux·darwin 은 unix 소켓, win32 는 named pipe 다", () => {
  const adkRoot = "/var/home/luke/alpha-adk";
  const linux = supervisorSocketPath({ adkRoot, platform: "linux", runtimeDir: "/run/user/1000" });
  const darwin = supervisorSocketPath({ adkRoot, platform: "darwin", runtimeDir: "/tmp" });
  const win32 = supervisorSocketPath({ adkRoot, platform: "win32" });
  assert.equal(linux.kind, "unix");
  assert.match(linux.path, /^\/run\/user\/1000\/naia-ego-host-[0-9a-f]{12}\.sock$/);
  assert.equal(darwin.kind, "unix");
  assert.match(darwin.path, /naia-ego-host-[0-9a-f]{12}\.sock$/);
  assert.equal(win32.kind, "pipe");
  assert.match(win32.path, /^\\\\\.\\pipe\\naia-ego-host-[0-9a-f]{12}$/);
  assert.equal(win32.dir, null, "named pipe 는 만들 디렉터리가 없다");
});

test("소켓 경로: 같은 ADK 는 같은 이름, 다른 ADK 는 다른 이름이다", () => {
  const a = supervisorSocketPath({ adkRoot: "/a", platform: "linux", runtimeDir: "/tmp" });
  const b = supervisorSocketPath({ adkRoot: "/a", platform: "linux", runtimeDir: "/tmp" });
  const c = supervisorSocketPath({ adkRoot: "/b", platform: "linux", runtimeDir: "/tmp" });
  assert.equal(a.path, b.path);
  assert.notEqual(a.path, c.path);
});

test("소켓 경로: unix 경로 상한을 넘으면 bind 전에 던진다", () => {
  assert.throws(
    () =>
      supervisorSocketPath({
        adkRoot: "/a",
        platform: "linux",
        runtimeDir: `/tmp/${"d".repeat(UNIX_SOCKET_PATH_MAX)}`,
      }),
    /상한/,
  );
});

// ── id 공간·순서 ─────────────────────────────────────────────────────────────

test("동시 두 CLI 가 각자 id 1 부터 써도 섞이지 않는다", async () => {
  const { server, backend, socketPath } = await startSupervisor();
  const a = await connectClient(server, socketPath);
  const b = await connectClient(server, socketPath);
  backend.respondTo("Marker", (data) => ({ result: { echo: data.params.who } }));

  const gotA = collector(a, 1);
  const gotB = collector(b, 1);
  a.sendCdp(JSON.stringify({ id: 1, method: "Marker", params: { who: "a" } }));
  b.sendCdp(JSON.stringify({ id: 1, method: "Marker", params: { who: "b" } }));

  const [[ra], [rb]] = await Promise.all([gotA, gotB]);
  assert.equal(ra.id, 1, "런타임 경계에서 id 를 보존해야 한다");
  assert.equal(rb.id, 1);
  assert.equal(ra.result.echo, "a", "다른 연결의 응답이 섞였다");
  assert.equal(rb.result.echo, "b");
  const upstreamIds = backend.sent.map((m) => m.id);
  assert.equal(new Set(upstreamIds).size, upstreamIds.length, "Chromium 쪽 id 가 충돌했다");
  a.close();
  b.close();
  await server.close();
});

test("Chromium 에서 받은 응답·이벤트는 단일 FIFO 순서를 유지한다", async () => {
  const backend = createFakeCdp({ autoRespond: false });
  const { server, socketPath } = await startSupervisor({ backend });
  const client = await connectClient(server, socketPath);

  client.sendCdp(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "T1" } }));
  await new Promise((r) => setTimeout(r, 20));
  const upstream = backend.lastId();
  // 이벤트 → 응답 → 이벤트 순으로 밀어 넣는다. 재정렬이 있으면 여기서 드러난다.
  const got = collector(client, 3);
  backend.push({ method: "Ev.one", params: { targetId: "T1" } });
  backend.push({ id: upstream, result: { sessionId: "S9" } });
  backend.push({ sessionId: "S9", method: "Ev.two", params: {} });
  const seen = await got;
  assert.deepEqual(
    seen.map((m) => m.method ?? `resp:${m.id}`),
    ["Ev.one", "resp:1", "Ev.two"],
  );
  client.close();
  await server.close();
});

test("sessionId 는 재작성하지 않는다 — 라우팅 키는 최상위 sessionId 뿐이다", async () => {
  const { server, backend, socketPath } = await startSupervisor();
  const client = await connectClient(server, socketPath);
  // 클라이언트 id 는 50 부터 쓴다. 상류 id 가 우연히 같은 값이 되면 재작성 여부를 못 읽는다.
  const attached = collector(client, 1);
  client.sendCdp(JSON.stringify({ id: 50, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } }));
  const [response] = await attached;
  const sessionId = response.result.sessionId;
  assert.equal(response.id, 50, "런타임 경계에서 id 를 보존해야 한다");

  const echoed = collector(client, 1);
  client.sendCdp(JSON.stringify({ id: 51, method: "Page.enable", params: {}, sessionId }));
  await echoed;
  const upstreamPageEnable = backend.sent.find((m) => m.method === "Page.enable");
  assert.equal(upstreamPageEnable.sessionId, sessionId, "sessionId 가 재작성됐다");
  assert.deepEqual(
    backend.sent.map((m) => m.id),
    [1, 2],
    "상류 id 는 클라이언트 id 와 무관한 mux 자체 발번이어야 한다",
  );
  client.close();
  await server.close();
});

test("중첩 params.sessionId 는 Target.attachedToTarget 에서만 세션으로 해석된다", async () => {
  const { server, backend, socketPath } = await startSupervisor();
  const client = await connectClient(server, socketPath);
  const attached = collector(client, 1);
  client.sendCdp(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } }));
  const [response] = await attached;
  const parent = response.result.sessionId;

  const child = collector(client, 1);
  backend.push({
    sessionId: parent,
    method: "Target.attachedToTarget",
    params: { sessionId: "CHILD", targetInfo: { targetId: "T2" } },
  });
  await child;
  assert.ok(
    server.mux.inspect().sessions.includes("CHILD"),
    "attachedToTarget 의 중첩 sessionId 를 세션으로 잡지 못했다",
  );

  // screencastFrame 의 params.sessionId 는 Ack 용 프레임 토큰이지 세션이 아니다.
  backend.push({
    sessionId: parent,
    method: "Page.screencastFrame",
    params: { sessionId: 4242, data: "" },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    !server.mux.inspect().sessions.includes("4242"),
    "screencastFrame 의 프레임 토큰을 세션으로 오해했다",
  );
  client.close();
  await server.close();
});

test("아웃바운드 이벤트는 연결이 소유한 세션·타깃으로만 간다", async () => {
  const { server, backend, socketPath } = await startSupervisor();
  const a = await connectClient(server, socketPath);
  const b = await connectClient(server, socketPath);
  const attached = collector(a, 1);
  a.sendCdp(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } }));
  const [response] = await attached;
  const sessionId = response.result.sessionId;

  const seenByB = [];
  b.onCdp((raw) => seenByB.push(JSON.parse(raw)));
  const seenByA = collector(a, 1);
  backend.push({ sessionId, method: "Page.loadEventFired", params: {} });
  await seenByA;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seenByB, [], "남의 세션 이벤트가 다른 연결로 샜다");

  // 아무도 소유하지 않은 세션의 이벤트는 아무에게도 가지 않는다(fail-closed).
  backend.push({ sessionId: "ORPHAN", method: "Page.loadEventFired", params: {} });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(server.mux.inspect().droppedEvents.includes("Page.loadEventFired"));
  a.close();
  b.close();
  await server.close();
});

// ── 실패 모드 ────────────────────────────────────────────────────────────────

test("감독자 deadline 은 런타임 15초보다 앞서고 원래 id 오류로 끝난다", async () => {
  assert.ok(
    SUPERVISOR_REQUEST_DEADLINE_MS < 14_000,
    `감독자 상한이 14초 미만이어야 한다: ${SUPERVISOR_REQUEST_DEADLINE_MS}`,
  );
  assert.ok(SUPERVISOR_REQUEST_DEADLINE_MS < RUNTIME_RESPONSE_TIMEOUT_MS);

  const backend = createFakeCdp();
  backend.silence("Never.answers");
  const { server, socketPath } = await startSupervisor({ backend, requestDeadlineMs: 120 });
  const client = await connectClient(server, socketPath);
  const got = collector(client, 1);
  client.sendCdp(JSON.stringify({ id: 7, method: "Never.answers", params: {} }));
  const [message] = await got;
  assert.equal(message.id, 7, "상한 초과 응답이 원래 id 를 잃었다");
  assert.equal(message.error.code, CODES.DEADLINE);
  client.close();
  await server.close();
});

test("정책 거부는 원래 id 오류로 오고 다른 pending 은 영향받지 않는다", async () => {
  const { server, socketPath } = await startSupervisor({
    route: (method) =>
      method === "Denied.method"
        ? { allow: false, message: "이 메서드는 정책이 막는다", code: CODES.METHOD_DENIED }
        : { allow: true },
  });
  const client = await connectClient(server, socketPath);
  const got = collector(client, 2);
  client.sendCdp(JSON.stringify({ id: 1, method: "Allowed.method", params: {} }));
  client.sendCdp(JSON.stringify({ id: 2, method: "Denied.method", params: {} }));
  const seen = await got;
  const allowed = seen.find((m) => m.id === 1);
  const denied = seen.find((m) => m.id === 2);
  assert.ok(allowed.result, "허용된 요청이 거부에 말려들었다");
  assert.equal(denied.error.code, CODES.METHOD_DENIED);
  assert.match(denied.error.message, /정책/);
  client.close();
  await server.close();
});

test("이벤트 폭주로 송신 큐가 넘치면 그 연결만 끊기고 다른 연결은 산다", async () => {
  const backend = createFakeCdp();
  const { server, socketPath } = await startSupervisor({ backend, maxQueuedFrames: 4 });
  const victim = await connectClient(server, socketPath);
  const bystander = await connectClient(server, socketPath);

  const attached = collector(victim, 1);
  victim.sendCdp(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } }));
  const [response] = await attached;
  const sessionId = response.result.sessionId;

  const closed = new Promise((resolve) => victim.onClose(resolve));
  // 소켓을 읽지 못하게 막고(멈춘 CLI 를 흉내) 큰 이벤트를 쏟아붓는다.
  // 작은 이벤트로는 커널 소켓 버퍼가 다 삼켜 큐가 자라지 않는다 — 그러면 게이트가 아니라 운이다.
  victim.pause();
  const payload = "x".repeat(64 * 1024);
  for (let i = 0; i < 500; i += 1) {
    backend.push({ sessionId, method: "Ev.flood", params: { i, payload } });
  }
  // 멈춘 소켓은 FIN 도 읽지 않으므로 클라이언트 close 를 먼저 기다리면 영원히 기다린다.
  // 판정은 감독자 장부에서 하고, 그 뒤에 읽기를 풀어 연결이 실제로 끊겼음을 확인한다.
  for (let waited = 0; waited < 100 && !server.rejected.some((r) => r.code === CODES.BACKPRESSURE); waited += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(
    server.rejected.some((r) => r.code === CODES.BACKPRESSURE),
    "감독자 장부에 역압으로 끊은 사실이 없다",
  );
  victim.resume();
  const error = await closed;
  assert.ok(
    [CODES.BACKPRESSURE, CODES.DISCONNECTED].includes(error.error_code),
    `끊긴 이유가 형식 있는 오류여야 한다: ${error.error_code}`,
  );

  // 방관자는 멀쩡해야 한다.
  const stillAlive = await bystander.call("getBrowserVersion");
  assert.equal(stillAlive.updateAvailable, false);
  bystander.close();
  await server.close();
});

test("단절: id 없는 오류가 그 연결의 pending 만 죽인다", async () => {
  const backend = createFakeCdp();
  backend.silence("Slow.method");
  const { server, socketPath } = await startSupervisor({ backend, requestDeadlineMs: 5_000 });
  const dying = await connectClient(server, socketPath);
  const survivor = await connectClient(server, socketPath);

  const dyingErrors = [];
  dying.onCdpError((message, code) => dyingErrors.push(code));
  const survivorErrors = [];
  survivor.onCdpError((message, code) => survivorErrors.push(code));

  dying.sendCdp(JSON.stringify({ id: 1, method: "Slow.method", params: {} }));
  survivor.sendCdp(JSON.stringify({ id: 1, method: "Slow.method", params: {} }));
  await new Promise((r) => setTimeout(r, 30));
  const pendingBefore = server.mux.inspect().pending;
  assert.equal(pendingBefore, 2);

  const [dyingConnection] = [...server.connections];
  dyingConnection.socket.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.mux.inspect().pending, 1, "죽은 연결의 pending 만 걷어야 한다");
  assert.deepEqual(survivorErrors, [], "살아 있는 연결에 id 없는 오류가 갔다");
  dying.close();
  survivor.close();
  await server.close();
});

test("핸드셰이크 전 CDP 프레임은 연결째 거부된다", async () => {
  const { server, socketPath } = await startSupervisor();
  const { connect } = await import("node:net");
  const socket = connect(socketPath);
  await new Promise((r) => socket.once("connect", r));
  const frames = [];
  const decoder = createFrameDecoder({ onFrame: (v) => frames.push(v) });
  socket.on("data", (c) => decoder.push(c));
  socket.write(encodeFrame({ type: "cdp", payload: JSON.stringify({ id: 1, method: "X" }) }));
  await new Promise((r) => socket.once("close", r));
  assert.equal(frames.at(-1)?.error_code, CODES.HANDSHAKE_REQUIRED);
  await server.close();
});
