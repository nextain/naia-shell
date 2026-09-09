// #582 S2e — 취소 훅·deadline·배타 슬롯 (계약 4.7).
//
// 판정은 전부 **실 Chromium + 로컬 픽스처**로 한다. 취소는 "요청을 보냈다"가 아니라 "그 뒤에
// 아무 일도 안 일어난다"가 성립해야 하는 성질이라, 가짜 백엔드로는 시험되지 않는다.
//
// 픽스처의 `/hang` 는 **응답을 영원히 보내지 않는 주소**다. 그 위에 Fetch 가로채기를 켜면
// 이동은 멈춘 채로 남고 가로챈 requestId 가 작업 장부에 등록된다 — 계약 4.7 이 요구하는
// "멈춘 이동 + 열린 가로채기" 상태가 실제로 만들어진다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { CODES } from "../src/errors.mjs";
import { cleanupAll } from "./helpers/live-browser.mjs";
import {
  cdpChannel,
  connectClient,
  startLiveSupervisor,
  stopAllLive,
  waitFor,
} from "./helpers/live-supervisor.mjs";

const servers = [];
/** `/hang` 로 들어와 응답 없이 붙잡아 둔 소켓. 서버를 닫을 때 함께 끊는다. */
const hung = [];

after(async () => {
  for (const response of hung.splice(0)) {
    try {
      response.destroy();
    } catch {}
  }
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await stopAllLive();
  cleanupAll();
});

async function startFixture() {
  const server = createServer((request, response) => {
    if (request.url.startsWith("/hang")) {
      // 응답을 보내지 않는다. 연결만 붙잡는다.
      hung.push(response);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><meta charset=utf-8><title>naia 582 취소</title><body>ok</body>");
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}` };
}

/** 공간 하나 + 그 공간의 탭에 붙은 세션 하나. 세션은 뿌리 작업(연결)이 만든다. */
async function openSession(client, name, origin) {
  const space = await client.call("createTaskSpace", { name });
  const tabs = await client.call("listTabs");
  const targetId = tabs.tabs[0].targetId;
  const channel = cdpChannel(client);
  const { sessionId } = await channel.call("Target.attachToTarget", { targetId, flatten: true });
  await channel.call("Page.navigate", { url: `${origin}/` }, sessionId);
  return { space, targetId, channel, sessionId };
}

function operationOf(live, id) {
  return live.server.operations.inspect().operations.find((op) => op.id === id) ?? null;
}

test("취소: 멈춘 이동과 열린 가로채기가 그 작업 범위에서 끝나고 상태는 cancelled 로 남는다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const rootId = client.greeting.operationId;
  const { channel, sessionId } = await openSession(client, "취소", fixture.origin);

  // 가로채기를 켜고 멈춘 주소로 이동한다. 이동 응답은 오지 않는다(요청이 가로채여 멈춘다).
  await channel.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
  const navigationId = channel.nextId();
  const navigation = channel.send("Page.navigate", { url: `${fixture.origin}/hang` }, sessionId);

  const paused = await waitFor(() => {
    const op = operationOf(live, rootId);
    return op && op.requestIds.length > 0 ? op : null;
  });
  assert.ok(paused, "가로챈 requestId 가 작업 장부에 등록되지 않았다");
  assert.ok(
    paused.domains.some((key) => key === `Fetch:${sessionId}`),
    `Fetch 도메인 참조가 작업에 안 잡혔다: ${JSON.stringify(paused.domains)}`,
  );
  const pausedRequestId = paused.requestIds[0];
  const eventsBeforeBarrier = channel.events.length;

  // ── 취소 장벽 ────────────────────────────────────────────────────────────
  const cancelled = await client.call("cancelOperation", { operationId: rootId });
  assert.equal(cancelled.status, "cancelled");
  assert.ok(
    cancelled.cleanup.failedRequests.includes(pausedRequestId),
    `가로챈 요청이 실패 처리되지 않았다: ${JSON.stringify(cancelled.cleanup)}`,
  );
  assert.ok(
    cancelled.cleanup.disabledDomains.includes(`Fetch:${sessionId}`),
    "참조가 0 이 됐는데 Fetch.disable 이 안 나갔다",
  );
  assert.ok(
    cancelled.cleanup.detachedSessions.includes(sessionId),
    "그 작업이 만든 세션이 detach 되지 않았다",
  );
  assert.ok(cancelled.cleanup.stopLoading.includes(sessionId), "Page.stopLoading 이 안 나갔다");

  // 멈춰 있던 이동 요청은 **원래 id** 로 끊긴다(ABI 2 의 id 없는 통로가 아니다).
  const navigationResult = await navigation;
  assert.equal(navigationResult.id, navigationId, "원래 id 가 아닌 응답이 왔다");
  assert.equal(navigationResult.error.code, CODES.OPERATION_CANCELLED);

  // 그 작업이 연 것이 0 이다.
  const after = operationOf(live, rootId);
  assert.equal(after.status, "cancelled");
  assert.deepEqual(after.requestIds, [], "가로채기가 남았다");
  assert.deepEqual(after.domains, [], "도메인 참조가 남았다");
  assert.deepEqual(after.sessions, [], "세션이 남았다");
  assert.deepEqual(after.streams, [], "스트림이 남았다");

  // 취소 장벽 뒤에 그 작업에 결속된 이벤트가 0 이다.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const boundAfter = channel.events
    .slice(eventsBeforeBarrier)
    .filter((event) => event.sessionId === sessionId);
  assert.deepEqual(
    boundAfter.map((event) => event.method),
    [],
    "취소 뒤에도 그 작업의 세션 이벤트가 왔다",
  );

  // 최종 상태는 유지된다 — 종결은 CAS 라 나중에 온 완료가 덮어쓰지 않는다(계약 4.4).
  const again = await client.call("endOperation", { operationId: rootId, status: "completed" });
  assert.equal(again.changed, false);
  assert.equal(again.status, "cancelled");
  await live.stop();
});

test("취소: 소유하지 않은 requestId 의 Fetch.failRequest 는 원래 id 오류다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const rootId = client.greeting.operationId;
  const { channel, sessionId } = await openSession(client, "미소유", fixture.origin);

  await channel.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
  channel.send("Page.navigate", { url: `${fixture.origin}/hang` }, sessionId).catch(() => {});
  const paused = await waitFor(() => {
    const op = operationOf(live, rootId);
    return op && op.requestIds.length > 0 ? op : null;
  });
  assert.ok(paused, "가로챈 요청이 없다");

  // 같은 연결의 **다른 작업**이 남의 requestId 를 끊으려 한다.
  const other = await client.call("beginOperation", { timeoutMs: 20_000 });
  const otherChannel = cdpChannel(client, { operationId: other.operationId });
  const denied = await otherChannel.send(
    "Fetch.failRequest",
    { requestId: paused.requestIds[0], errorReason: "Aborted" },
    sessionId,
  );
  assert.equal(denied.id, 1, "원래 id 가 보존되지 않았다");
  assert.equal(denied.error.code, CODES.RESOURCE_NOT_OWNED);
  assert.match(denied.error.message, /소유한 requestId/);

  // 그리고 가로채기는 그대로 살아 있다(거부가 남의 상태를 건드리지 않았다).
  assert.deepEqual(operationOf(live, rootId).requestIds, paused.requestIds);
  await live.stop();
});

test("취소: 같은 세션의 다른 작업은 영향받지 않는다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const rootId = client.greeting.operationId;
  const { channel, sessionId } = await openSession(client, "동시", fixture.origin);

  // 작업 B 가 같은 세션을 쓴다(세션을 만든 것은 뿌리 작업 A 다).
  const b = await client.call("beginOperation", { timeoutMs: 20_000 });
  const bChannel = cdpChannel(client, { operationId: b.operationId });
  await bChannel.call("Runtime.evaluate", { expression: "1+1", returnByValue: true }, sessionId);

  // A 가 오래 걸리는 평가를 시작해 배타 슬롯을 잡는다.
  const slow = channel.call(
    "Runtime.evaluate",
    {
      expression: "new Promise(done => setTimeout(() => done('a-survived'), 2500))",
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  // B 를 취소한다. 슬롯을 A 가 들고 있으므로 terminateExecution 은 나가면 안 된다.
  const cancelled = await client.call("cancelOperation", { operationId: b.operationId });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(
    cancelled.cleanup.terminated,
    [],
    "다른 작업이 평가 중인데 Runtime.terminateExecution 을 보냈다",
  );
  assert.deepEqual(
    cancelled.cleanup.detachedSessions,
    [],
    "B 가 만들지 않은 세션을 detach 했다",
  );

  // A 의 평가가 끝까지 살아남는다.
  const survived = await slow;
  assert.equal(survived.result.value, "a-survived", "B 의 취소가 A 의 평가를 끊었다");
  assert.equal(operationOf(live, rootId).status, "running");

  // A 는 계속 쓸 수 있다.
  const still = await channel.call(
    "Runtime.evaluate",
    { expression: "'still-here'", returnByValue: true },
    sessionId,
  );
  assert.equal(still.result.value, "still-here");
  await live.stop();
});

test("deadline: 짧은 시한의 작업은 EGO_OPERATION_TIMEOUT 으로 끝나고 정리는 취소와 같다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { channel, sessionId } = await openSession(client, "시한", fixture.origin);

  const op = await client.call("beginOperation", { timeoutMs: 900 });
  const opChannel = cdpChannel(client, { operationId: op.operationId });
  await opChannel.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
  const navigation = opChannel.send("Page.navigate", { url: `${fixture.origin}/hang` }, sessionId);

  const timedOut = await navigation;
  assert.equal(timedOut.error.code, CODES.OPERATION_TIMEOUT, JSON.stringify(timedOut));
  assert.match(timedOut.error.message, /시한 900ms/);

  // 종결(상태)과 정리(CDP 왕복)는 다른 시점이다. **정리가 끝난 뒤**를 봐야 한다 —
  // 상태만 보고 읽으면 아직 걷히는 중인 자원을 "안 걷혔다"로 읽는다.
  const record = await waitFor(() => {
    const found = operationOf(live, op.operationId);
    return found && found.status !== "running" && found.cleanup ? found : null;
  });
  assert.equal(record.status, "failed");
  assert.equal(record.failureReason, "timeout");
  assert.deepEqual(record.requestIds, [], "만료 뒤에도 가로채기가 남았다");
  assert.deepEqual(record.domains, [], "만료 뒤에도 도메인 참조가 남았다");
  assert.ok(record.cleanup.stopLoading.includes(sessionId), "만료 정리가 이동을 멈추지 않았다");
  // 만료된 작업의 CDP 는 장벽에 걸린다.
  const afterBarrier = await opChannel.send("Runtime.evaluate", { expression: "1" }, sessionId);
  assert.equal(afterBarrier.error.code, CODES.OPERATION_TIMEOUT);
  await live.stop();
});

test("배타 슬롯: 같은 세션에 두 작업이 동시에 평가하면 두 번째는 형식 있는 오류다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { channel, sessionId } = await openSession(client, "슬롯", fixture.origin);

  const b = await client.call("beginOperation", { timeoutMs: 20_000 });
  const bChannel = cdpChannel(client, { operationId: b.operationId });

  // A 가 슬롯을 잡는다(끝나지 않는 평가).
  const first = channel.send(
    "Runtime.evaluate",
    {
      expression: "new Promise(done => setTimeout(() => done('done'), 2000))",
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));

  const second = await bChannel.send(
    "Runtime.evaluate",
    { expression: "2+2", returnByValue: true },
    sessionId,
  );
  assert.equal(second.error.code, CODES.SESSION_SLOT_BUSY, JSON.stringify(second));
  assert.match(second.error.message, /한 번에 하나/);

  // 같은 작업이 이어서 부르는 것은 막지 않는다(재진입).
  await first;
  const again = await channel.call(
    "Runtime.evaluate",
    { expression: "3+3", returnByValue: true },
    sessionId,
  );
  assert.equal(again.result.value, 6);

  // 슬롯이 풀린 뒤에는 B 도 쓸 수 있다.
  const afterRelease = await bChannel.call(
    "Runtime.evaluate",
    { expression: "4+4", returnByValue: true },
    sessionId,
  );
  assert.equal(afterRelease.result.value, 8);
  await live.stop();
});
