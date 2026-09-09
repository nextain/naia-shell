/**
 * #582 S2a — 핸드셰이크와 연결별 상태 (계약 4.2 "탭·공간" 행, 4.2.1, 4.4).
 *
 * 판정하는 것 넷.
 *  (1) 토큰이 없거나 모르거나 이미 쓴 것이면 연결이 서지 않는다.
 *  (2) grant 없는 연결은 관측 RPC 밖으로 나가지 못하고, CDP 는 원래 id 오류로 거부된다.
 *  (3) 선택한 작업 공간은 **연결별 상태**다. 두 CLI 가 서로 다른 공간을 써도 섞이지 않는다.
 *  (4) 요청 상한은 두 값 중 짧은 쪽이 이긴다.
 */
import assert from "node:assert/strict";
import { connect } from "node:net";
import test, { after } from "node:test";
import { CODES } from "../src/errors.mjs";
import { SUPERVISOR_REQUEST_DEADLINE_MS } from "../src/supervisor/cdp-mux.mjs";
import { connectSupervisor } from "../src/client/rpc-client.mjs";
import { createFrameDecoder, encodeFrame } from "../src/supervisor/rpc-framing.mjs";
import { closeAll, connectClient, startSupervisor } from "./helpers/supervisor-fixture.mjs";

after(closeAll);

/** 원시 소켓으로 첫 프레임 하나만 보내고 돌아온 프레임을 읽는다. */
async function rawHello(socketPath, hello) {
  const socket = connect(socketPath);
  await new Promise((r) => socket.once("connect", r));
  const frames = [];
  const decoder = createFrameDecoder({ onFrame: (v) => frames.push(v) });
  socket.on("data", (chunk) => decoder.push(chunk));
  socket.write(encodeFrame(hello));
  await new Promise((resolve) => {
    socket.once("close", resolve);
    setTimeout(resolve, 500).unref();
  });
  socket.destroy();
  return frames;
}

test("토큰 없는 핸드셰이크는 거부된다", async () => {
  const { socketPath } = await startSupervisor();
  const frames = await rawHello(socketPath, { type: "hello" });
  assert.equal(frames.at(-1)?.error_code, CODES.TOKEN_MISSING);
});

test("모르는 토큰은 거부된다", async () => {
  const { socketPath } = await startSupervisor();
  const frames = await rawHello(socketPath, { type: "hello", token: "지어낸-토큰" });
  assert.equal(frames.at(-1)?.error_code, CODES.TOKEN_MISSING);
});

test("토큰 재사용은 즉시 거부된다 — fork·cluster 재시도가 여기서 닫힌다", async () => {
  const { server, socketPath } = await startSupervisor();
  const token = server.issueToken({ grant: null });
  const first = await rawHello(socketPath, { type: "hello", token });
  assert.equal(first.at(-1)?.type, "welcome", "첫 사용이 거부됐다");
  const second = await rawHello(socketPath, { type: "hello", token });
  assert.equal(second.at(-1)?.error_code, CODES.TOKEN_REUSED);
});

test("grant 가 토큰 발급분과 다르면 거부된다", async () => {
  const { server, socketPath } = await startSupervisor();
  const token = server.issueToken({ grant: { tier: "workspace-write", approvalRef: "a-1" } });
  const frames = await rawHello(socketPath, {
    type: "hello",
    token,
    grant: { tier: "destructive", approvalRef: "a-1" },
  });
  assert.equal(frames.at(-1)?.error_code, CODES.HANDSHAKE_INVALID);
});

test("grant 없는 연결은 관측 RPC 만 되고 변경 RPC 는 거부된다", async () => {
  const { server, socketPath } = await startSupervisor();
  const client = await connectClient(server, socketPath, { grant: null });
  assert.equal(client.greeting.observeOnly, true);

  const observed = await client.call("listTaskSpaces");
  assert.deepEqual(observed, { taskSpaces: [] }, "관측 RPC 가 막혔다");

  const denied = await client.call("createTaskSpace", { name: "몰래" });
  assert.equal(denied.error_code, CODES.GRANT_REQUIRED);
  assert.match(denied.error, /관측 RPC/, "사람이 읽을 설명이 없다");
});

test("grant 없는 연결의 CDP 는 원래 id 오류로 거부되고 연결은 살아 있다", async () => {
  const { server, socketPath } = await startSupervisor();
  const client = await connectClient(server, socketPath, { grant: null });
  const seen = [];
  const fatal = [];
  client.onCdp((raw) => seen.push(JSON.parse(raw)));
  client.onCdpError((message, code) => fatal.push(code));
  client.sendCdp(JSON.stringify({ id: 9, method: "Page.navigate", params: { url: "https://x.test" } }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 9, "거부가 원래 id 를 잃었다");
  assert.equal(seen[0].error.code, CODES.GRANT_REQUIRED);
  assert.deepEqual(fatal, [], "한 요청의 거부에 id 없는 통로를 썼다");
  assert.equal(server.connections.size, 2 - 1, "연결이 죽었다");
});

test("선택 공간은 연결별 상태다 — 두 CLI 가 서로 다른 공간을 써도 섞이지 않는다", async () => {
  const { server, socketPath } = await startSupervisor();
  const a = await connectClient(server, socketPath);
  const b = await connectClient(server, socketPath);

  const spaceA = await a.call("createTaskSpace", { name: "가" });
  const spaceB = await b.call("createTaskSpace", { name: "나" });
  assert.equal(spaceA.ownership, "agent");
  assert.equal(typeof spaceA.id, "number");
  assert.notEqual(spaceA.id, spaceB.id);

  const tabsA = await a.call("listTabs");
  const tabsB = await b.call("listTabs");
  assert.equal(tabsA.tabs.length, 1);
  assert.equal(tabsB.tabs.length, 1);
  assert.notEqual(tabsA.tabs[0].targetId, tabsB.tabs[0].targetId, "두 연결이 같은 탭을 봤다");

  // 두 연결 모두 목록에서는 공간 둘을 본다. 선택만 각자의 것이다.
  const listed = await a.call("listTaskSpaces");
  assert.equal(listed.taskSpaces.length, 2);

  // A 가 B 의 공간으로 갈아타도 B 의 선택은 그대로다.
  await a.call("useTaskSpace", { id: spaceB.id });
  const tabsAAfter = await a.call("listTabs");
  assert.equal(tabsAAfter.tabs[0].targetId, tabsB.tabs[0].targetId);
  const tabsBAfter = await b.call("listTabs");
  assert.equal(tabsBAfter.tabs[0].targetId, tabsB.tabs[0].targetId, "B 의 선택이 A 때문에 바뀌었다");
});

test("공간을 고르지 않은 연결의 listTabs 는 형식 있는 오류다", async () => {
  const { server, socketPath } = await startSupervisor();
  const client = await connectClient(server, socketPath);
  const result = await client.call("listTabs");
  assert.equal(result.error_code, CODES.NO_TASK_SPACE);
  assert.match(result.error, /useOrCreate/);
});

test("헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 로 거부된다", async () => {
  const { server, socketPath } = await startSupervisor();
  const client = await connectClient(server, socketPath);
  await client.call("createTaskSpace", { name: "가" });
  for (const method of ["handOffTaskSpace", "takeOverTaskSpace", "claimTaskSpace"]) {
    const result = await client.call(method, { id: 1, name: "가" });
    assert.equal(result.error_code, "EGO_HANDOFF_UNSUPPORTED_HEADLESS", method);
    assert.match(result.error, /헤드리스/, `${method}: 사람이 읽을 설명이 없다`);
  }
});

test("요청 상한은 호출자 시한과 감독자 상한 중 짧은 쪽이다", async () => {
  const { server, socketPath } = await startSupervisor();
  const short = await connectClient(server, socketPath, { deadline: 500 });
  assert.equal(short.greeting.deadlineMs, 500);
  const greedy = await connectClient(server, socketPath, { deadline: 600_000 });
  assert.equal(
    greedy.greeting.deadlineMs,
    SUPERVISOR_REQUEST_DEADLINE_MS,
    "호출자가 적은 긴 시한이 감독자 상한을 늘렸다",
  );
});

test("첫 프레임이 hello 가 아니면 연결째 거부된다", async () => {
  const { socketPath } = await startSupervisor();
  const frames = await rawHello(socketPath, { type: "rpc", id: 1, method: "listTaskSpaces" });
  assert.equal(frames.at(-1)?.error_code, CODES.HANDSHAKE_REQUIRED);
});
