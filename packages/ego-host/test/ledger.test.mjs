// #582 S2c — 작업 공간·타깃·세션 장부 (계약 4.3.1·4.4).
//
// 실 Chromium 이다. 브라우저가 없으면 건너뛰지 않고 RED 다 — 건너뛴 테스트는 초록으로 보이고,
// 초록으로 보이는 미검증은 나중에 "검증했다"로 보고된다.
//
// 순서(응답→이벤트 / 이벤트→응답)와 예기치 않은 자식 attach 는 Chromium 이 정하거나
// auto-attach 를 켜야만 생기는 일이라, **진짜 브라우저 메시지를 잠시 붙잡거나** 자식 이벤트
// 하나를 주입해 강제한다(live-supervisor.mjs 머리 주석에 이유를 적었다).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCdpMux } from "../src/supervisor/cdp-mux.mjs";
import { createLedger, spacesPath } from "../src/supervisor/ledger.mjs";
import { cleanupAll, tempDir } from "./helpers/live-browser.mjs";
import {
  cdpChannel,
  connectClient,
  startLiveSupervisor,
  stopAllLive,
  waitFor,
} from "./helpers/live-supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_WRITER = join(HERE, "helpers", "ledger-writer.mjs");

after(async () => {
  await stopAllLive();
  cleanupAll();
});

/** 공간 하나와 그 안의 탭 하나. 여기까지가 모든 시험의 출발선이다. */
async function spaceWithTab(live, client, name) {
  const space = await client.call("createTaskSpace", { name });
  assert.ok(space.id, `공간 생성 실패: ${JSON.stringify(space)}`);
  const tabs = await client.call("listTabs");
  return { space, targetId: tabs.tabs[0].targetId };
}

// ── 작업 공간 = 격리 컨텍스트 ────────────────────────────────────────────────

test("작업 공간 하나는 격리 브라우저 컨텍스트 하나이고 컨텍스트 id 는 밖으로 안 나간다", async () => {
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const a = await client.call("createTaskSpace", { name: "가" });
  const b = await client.call("createTaskSpace", { name: "나" });

  const contexts = live.ledger.inspect().contexts;
  assert.equal(contexts.length, 2);
  assert.ok(contexts.every((id) => typeof id === "string" && id.length > 0), "컨텍스트가 없다");
  assert.notEqual(contexts[0], contexts[1], "두 공간이 같은 컨텍스트를 쓴다");

  // ABI 모양은 S2a 그대로다(벤더 런타임이 이 필드들을 읽는다).
  for (const space of [a, b]) {
    assert.equal(typeof space.id, "number");
    assert.equal(space.taskId, String(space.id));
    assert.equal(space.ownership, "agent");
    assert.equal(space.browserContextId, undefined, "browserContextId 가 밖으로 샜다");
  }
  // 계약 4.4 의 공개 자원 모양.
  const resource = live.ledger.resourceOf(live.ledger.get(a.id));
  assert.deepEqual(Object.keys(resource).sort(), ["id", "mode", "ownership", "revision"]);
  assert.equal(resource.mode, "headless");

  // 그리고 그 격리가 실제로 도는지 — 같은 출처의 쿠키가 서로 안 보인다.
  await client.call("useTaskSpace", { id: a.id });
  const aTabs = await client.call("listTabs");
  const cdpA = cdpChannel(client);
  const sessionA = (
    await cdpA.call("Target.attachToTarget", { targetId: aTabs.tabs[0].targetId, flatten: true })
  ).sessionId;
  await cdpA.call("Page.navigate", { url: "about:blank" }, sessionA);
  await cdpA.call(
    "Runtime.evaluate",
    { expression: "document.cookie" },
    sessionA,
  );
  assert.ok(sessionA, "세션이 없다");
  await live.stop();
});

test("같은 idempotencyKey 의 공간 생성 재전송은 같은 공간을 준다 (S0 리뷰 2번)", async () => {
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const first = await client.call("createTaskSpace", { name: "재전송", idempotencyKey: "k-1" });
  const second = await client.call("createTaskSpace", { name: "재전송", idempotencyKey: "k-1" });
  assert.equal(second.id, first.id, "같은 키인데 공간이 둘 생겼다");
  assert.equal(live.ledger.inspect().spaces.length, 1);
  assert.equal(live.ledger.inspect().contexts.length, 1, "컨텍스트가 하나 더 생겼다");
  // 키가 다르면 다른 공간이다.
  const other = await client.call("createTaskSpace", { name: "다른키", idempotencyKey: "k-2" });
  assert.notEqual(other.id, first.id);
  await live.stop();
});

test("공간을 닫으면 컨텍스트가 사라지고 장부에서 탭·타깃이 함께 나간다", async () => {
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { space, targetId } = await spaceWithTab(live, client, "닫을공간");
  assert.ok(live.ledger.knowsTarget(targetId));
  await client.call("closeTaskSpace");
  assert.equal(live.ledger.get(space.id), null);
  assert.equal(live.ledger.knowsTarget(targetId), false);
  const stored = JSON.parse(readFileSync(spacesPath(live.adkDir), "utf8"));
  assert.equal(stored.spaces.length, 0, "저장된 장부에 닫은 공간이 남아 있다");
  await live.stop();
});

// ── 타깃 lease (계약 4.3.1) ─────────────────────────────────────────────────

test("같은 타깃에 두 연결이 동시에 attach 하면 하나만 승인되고 나머지는 원래 id 로 EGO_TARGET_BUSY", async () => {
  const live = await startLiveSupervisor();
  const first = await connectClient(live);
  const second = await connectClient(live);
  const { space, targetId } = await spaceWithTab(live, first, "경주");
  await second.call("useTaskSpace", { id: space.id });

  const one = cdpChannel(first);
  const two = cdpChannel(second);
  // 두 CLI 모두 자기 id 공간의 1번을 쓴다. 같은 tick 에 넣어 arbitration 을 강제한다.
  const [a, b] = await Promise.all([
    one.fire(1, "Target.attachToTarget", { targetId, flatten: true }),
    two.fire(1, "Target.attachToTarget", { targetId, flatten: true }),
  ]);
  assert.equal(a.id, 1);
  assert.equal(b.id, 1);
  const winners = [a, b].filter((response) => response.result?.sessionId);
  const losers = [a, b].filter((response) => response.error);
  assert.equal(winners.length, 1, `한 연결만 승인해야 한다: ${JSON.stringify([a, b])}`);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].error.code, "EGO_TARGET_BUSY");
  assert.match(losers[0].error.message, /다른 연결/);
  assert.equal(live.ledger.inspect().sessions.length, 1);
  await live.stop();
});

test("예약 중 연결이 끊기면 예약을 철회하고 늦게 온 attach 응답의 세션을 감독자가 detach 한다", async () => {
  const live = await startLiveSupervisor({ wrap: true });
  const keeper = await connectClient(live);
  const doomed = await connectClient(live);
  const { space, targetId } = await spaceWithTab(live, keeper, "철회");
  await doomed.call("useTaskSpace", { id: space.id });

  const channel = cdpChannel(doomed);
  // 응답을 붙잡아 두고 그 사이에 연결을 끊는다 = "예약 중 연결 종료".
  live.backend.hold((message) => typeof message.result?.sessionId === "string");
  channel.fire(1, "Target.attachToTarget", { targetId, flatten: true }).catch(() => {});
  await waitFor(() => live.backend.heldCount() > 0, { timeoutMs: 10_000 });
  doomed.close();
  await waitFor(() => live.ledger.inspect().leases.length === 0, { timeoutMs: 10_000 });
  assert.equal(live.ledger.inspect().leases.length, 0, "끊긴 연결의 예약이 남아 있다");

  live.backend.release();
  const rejected = await waitFor(() => {
    const found = live.ledger.inspect().rejectedChildren;
    return found.length > 0 ? found : null;
  });
  assert.ok(rejected, "늦게 온 attach 응답을 감독자가 정리하지 않았다");
  assert.ok(
    ["revoked", "orphaned-attach-response"].includes(rejected[0].reason),
    `예상 못 한 정리 사유: ${rejected[0].reason}`,
  );
  const detaches = live.backend.sentMethods("Target.detachFromTarget");
  assert.ok(detaches.length >= 1, "감독자가 내부 detach 를 보내지 않았다");
  assert.equal(live.ledger.inspect().sessions.length, 0);
  await live.stop();
});

test("attach 응답과 attachedToTarget 이벤트는 어느 순서로 와도 같은 세션 하나가 된다", async () => {
  // (1) 응답 → 이벤트
  const first = await startLiveSupervisor({ wrap: true });
  const clientA = await connectClient(first);
  const a = await spaceWithTab(first, clientA, "순서1");
  const channelA = cdpChannel(clientA);
  first.backend.hold((message) => message.method === "Target.attachedToTarget");
  const responseFirst = await channelA.send("Target.attachToTarget", {
    targetId: a.targetId,
    flatten: true,
  });
  assert.ok(responseFirst.result.sessionId, "attach 응답이 세션을 안 줬다");
  first.backend.release();
  const eventAfter = await waitFor(() =>
    channelA.eventsOf("Target.attachedToTarget").length > 0
      ? channelA.eventsOf("Target.attachedToTarget")
      : null,
  );
  assert.ok(eventAfter, "응답 뒤에 온 attachedToTarget 이 연결에 전달되지 않았다");
  assert.equal(first.ledger.inspect().sessions.length, 1);
  await first.stop();

  // (2) 이벤트 → 응답
  const second = await startLiveSupervisor({ wrap: true });
  const clientB = await connectClient(second);
  const b = await spaceWithTab(second, clientB, "순서2");
  const channelB = cdpChannel(clientB);
  second.backend.hold((message) => typeof message.result?.sessionId === "string");
  const pending = channelB.send("Target.attachToTarget", { targetId: b.targetId, flatten: true });
  const eventBefore = await waitFor(() =>
    channelB.eventsOf("Target.attachedToTarget").length > 0
      ? channelB.eventsOf("Target.attachedToTarget")[0]
      : null,
  );
  assert.ok(eventBefore, "응답보다 먼저 온 attachedToTarget 이 버려졌다");
  second.backend.release();
  const responseSecond = await pending;
  assert.equal(
    responseSecond.result.sessionId,
    eventBefore.params.sessionId,
    "이벤트와 응답이 서로 다른 세션을 가리킨다",
  );
  assert.equal(second.ledger.inspect().sessions.length, 1, "세션이 둘로 갈라졌다");
  await second.stop();
});

test("detach 된 sessionId 는 묘비로 남아 재사용돼도 옛 세대의 요청을 거부한다", async () => {
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { targetId } = await spaceWithTab(live, client, "묘비");
  const channel = cdpChannel(client);
  const sessionId = (await channel.call("Target.attachToTarget", { targetId, flatten: true }))
    .sessionId;
  assert.ok(await channel.call("Runtime.evaluate", { expression: "1+1" }, sessionId));

  // 탭을 닫으면 Chromium 이 detachedFromTarget 을 준다 = 세션이 죽는다.
  await channel.call("Target.closeTarget", { targetId });
  await waitFor(() => live.ledger.isTombstoned(sessionId));
  assert.equal(live.ledger.isTombstoned(sessionId), true, "묘비가 서지 않았다");

  const deniedId = channel.nextId();
  const denied = await channel.send("Runtime.evaluate", { expression: "1+1" }, sessionId);
  assert.equal(denied.id, deniedId, "거부는 **원래 id** 를 달고 와야 한다");
  assert.match(denied.error.message, /Session not found/);
  await live.stop();
});

test("예기치 않은 자식 attachedToTarget 은 연결에 안 가고 감독자가 detach 한다 (fail-closed)", async () => {
  const live = await startLiveSupervisor({ wrap: true });
  const client = await connectClient(live);
  const { targetId } = await spaceWithTab(live, client, "자식");
  const channel = cdpChannel(client);
  await channel.call("Target.attachToTarget", { targetId, flatten: true });

  // auto-attach 는 절대 켜지 않으므로 자식 세션은 주입으로만 만들 수 있다(증거에 명시).
  live.backend.inject({
    method: "Target.attachedToTarget",
    params: {
      sessionId: "CHILD-SESSION-1",
      targetInfo: { targetId: "UNKNOWN-CHILD-TARGET", type: "iframe", attached: true },
      waitingForDebugger: true,
    },
  });
  const rejected = await waitFor(() => {
    const found = live.ledger
      .inspect()
      .rejectedChildren.filter((entry) => entry.sessionId === "CHILD-SESSION-1");
    return found.length > 0 ? found : null;
  });
  assert.ok(rejected, "예기치 않은 자식 세션을 감독자가 끊지 않았다");
  assert.equal(rejected[0].reason, "unexpected-child");
  assert.equal(
    channel.eventsOf("Target.attachedToTarget").some((e) => e.params.sessionId === "CHILD-SESSION-1"),
    false,
    "예기치 않은 자식 이벤트가 연결로 샜다",
  );
  const detach = live.backend
    .sentMethods("Target.detachFromTarget")
    .find((message) => message.params?.sessionId === "CHILD-SESSION-1");
  assert.ok(detach, "감독자가 Target.detachFromTarget 을 보내지 않았다");
  assert.equal(live.ledger.isTombstoned("CHILD-SESSION-1"), true);
  await live.stop();
});

// ── 원자적 저장 ──────────────────────────────────────────────────────────────

test("장부 저장은 원자적이다 — 쓰는 도중 죽여도 이전 파일이 온전하다", async () => {
  const adkDir = tempDir("ego-atomic-");
  const child = spawn(process.execPath, [LEDGER_WRITER, adkDir], { stdio: ["ignore", "pipe", "pipe"] });
  const path = spacesPath(adkDir);
  const grew = await waitFor(() => {
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      return data.spaces.length >= 5 ? data.spaces.length : null;
    } catch {
      return null;
    }
  });
  assert.ok(grew, "저장이 시작되지 않았다");
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));

  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw); // 반쯤 쓰인 파일이면 여기서 던진다
  assert.equal(parsed.version, 1);
  assert.ok(parsed.spaces.length >= grew, "저장된 공간 수가 뒷걸음쳤다");
  for (const space of parsed.spaces) {
    assert.equal(typeof space.id, "number");
    assert.equal(typeof space.name, "string");
  }
  // 임시 파일은 본 파일과 같은 이름을 쓰지 않는다(rename 대상이 본 파일 하나뿐이다).
  const strays = readdirSync(join(adkDir, "ego-host")).filter((name) => name.startsWith("spaces.json.tmp."));
  assert.ok(strays.length <= 1, `임시 파일이 여러 개 남았다: ${strays.join(", ")}`);

  // 그리고 그 파일을 새 장부가 그대로 읽는다.
  const reopened = createLedger({ adkDir });
  assert.equal(reopened.list().length, parsed.spaces.length);
});

test("연결이 끊기면 그 연결의 세션·예약만 걷어내고 다른 연결은 그대로다", async () => {
  const live = await startLiveSupervisor();
  const keeper = await connectClient(live);
  const leaving = await connectClient(live);
  const kept = await spaceWithTab(live, keeper, "유지");
  const going = await spaceWithTab(live, leaving, "이탈");

  const keptChannel = cdpChannel(keeper);
  const goingChannel = cdpChannel(leaving);
  const keptSession = (
    await keptChannel.call("Target.attachToTarget", { targetId: kept.targetId, flatten: true })
  ).sessionId;
  const goingSession = (
    await goingChannel.call("Target.attachToTarget", { targetId: going.targetId, flatten: true })
  ).sessionId;

  leaving.close();
  await waitFor(() => live.ledger.isTombstoned(goingSession));
  assert.equal(live.ledger.isTombstoned(goingSession), true);
  assert.equal(live.ledger.isTombstoned(keptSession), false, "남은 연결의 세션이 함께 죽었다");
  const still = await keptChannel.call("Runtime.evaluate", { expression: "2+2" }, keptSession);
  assert.equal(still.result.value, 4);
  // 공간은 남는다 — CLI 가 죽어도 다음 heredoc 이 같은 공간에 다시 붙는다(계약 4.8).
  assert.ok(live.ledger.get(going.space.id), "연결이 끊겼다고 작업 공간을 지우면 안 된다");
  await live.stop();
});

// ── S7 P1-1·P1-2 (적대 리뷰 지적) ────────────────────────────────────────────

test("묘비 sessionId 는 lease 가 살아 있어도 재등록되지 않고 그 attach 는 감독자가 detach 한다", async () => {
  const live = await startLiveSupervisor({ wrap: true });
  const client = await connectClient(live);
  const { targetId } = await spaceWithTab(live, client, "묘비재사용");
  const channel = cdpChannel(client);
  const { sessionId } = await channel.call("Target.attachToTarget", { targetId, flatten: true });

  // gen1 이 죽는다 — 탭을 닫으면 Chromium 이 detachedFromTarget 을 준다.
  await channel.call("Target.closeTarget", { targetId });
  await waitFor(() => (live.ledger.isTombstoned(sessionId) ? true : null));

  // gen2: 새 탭에 진짜 attach 를 걸어 **예약(lease)을 살려 둔다.** 그 상태에서 옛 sessionId 를
  // 재사용하는 attach 이벤트가 오면, 고치기 전 장부는 묘비를 지우고 gen2 의 세션으로 등록했다.
  // Chromium 은 sessionId 를 재사용하지 않으므로 그 순간은 주입으로만 만들 수 있다.
  const created = await client.call("createTab", { url: "about:blank" });
  live.backend.hold((message) => typeof message.result?.sessionId === "string");
  const pending = channel.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  live.backend.inject({
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      targetInfo: { targetId: created.targetId, type: "page", attached: true },
      waitingForDebugger: false,
    },
  });
  const rejected = await waitFor(() => {
    const found = live.ledger
      .inspect()
      .rejectedChildren.filter((entry) => entry.sessionId === sessionId);
    return found.length > 0 ? found[0] : null;
  });
  assert.equal(rejected.reason, "tombstoned", "묘비 재사용이 자식 오탐이 아니라 묘비로 거부돼야 한다");
  assert.equal(
    live.ledger.inspect().sessions.includes(sessionId),
    false,
    "묘비 sessionId 가 다시 장부에 올랐다",
  );

  // 진짜 짝은 그대로 선다 — 거부가 정상 attach 를 망가뜨리지 않는다.
  live.backend.release();
  const settled = await pending;
  assert.ok(settled.result.sessionId, "정상 attach 응답이 세션을 안 줬다");
  assert.notEqual(settled.result.sessionId, sessionId);

  // gen1 의 지연 요청도 여전히 거부다(원래 id 보존).
  const deniedId = channel.nextId();
  const denied = await channel.send("Runtime.evaluate", { expression: "1+1" }, sessionId);
  assert.equal(denied.id, deniedId);
  assert.ok(denied.error, "묘비 세션의 지연 요청이 통과했다");
  await live.stop();
});

/**
 * 가짜 CDP 백엔드 하나. 감독자 attach 예약은 **응답·이벤트의 순서와 실패 경로**가 판정
 * 대상이라, 어느 쪽이 먼저 올지 Chromium 이 정하는 실브라우저로는 두 순서를 다 강제할 수 없다.
 * 이 자리에서만 백엔드를 가짜로 쓴다(위의 모든 시험은 실 Chromium 이다).
 */
function scriptedBackend() {
  const handlers = new Set();
  const sent = [];
  return {
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    onMessage(handler) {
      handlers.add(handler);
    },
    on() {},
    emit(message) {
      const raw = JSON.stringify(message);
      for (const handler of handlers) handler(raw);
    },
  };
}

test("감독자 attach 예약은 응답·이벤트 두 순서에서 정확히 한 번 소비된다", async () => {
  for (const order of ["response-first", "event-first"]) {
    const ledger = createLedger();
    const backend = scriptedBackend();
    const mux = createCdpMux({ backend, ledger });
    const targetId = `T-${order}`;
    const sessionId = `S-${order}`;

    const request = mux.hostRequest("Target.attachToTarget", { targetId, flatten: true });
    const sent = backend.sent.at(-1);
    assert.equal(ledger.inspect().hostReservations.length, 1, `${order}: 예약이 서지 않았다`);

    const response = { id: sent.id, result: { sessionId } };
    const event = {
      method: "Target.attachedToTarget",
      params: { sessionId, targetInfo: { targetId, type: "page", attached: true } },
    };
    if (order === "response-first") {
      backend.emit(response);
      await request;
      backend.emit(event);
    } else {
      backend.emit(event);
      backend.emit(response);
      await request;
    }

    assert.equal(ledger.isHostSession(sessionId), true, `${order}: 감독자 세션으로 안 잡혔다`);
    assert.equal(
      ledger.inspect().hostReservations.length,
      0,
      `${order}: 예약이 남았다 — 남은 예약은 예기치 않은 자식이 주워 간다`,
    );
    assert.deepEqual(ledger.inspect().rejectedChildren, [], `${order}: 짝을 자식으로 끊었다`);
  }
});

test("attach 가 실패하면 예약이 걷히고 늦게 온 자식 attach 는 그것을 소비하지 못한다", async () => {
  const ledger = createLedger();
  const backend = scriptedBackend();
  const mux = createCdpMux({ backend, ledger });

  const failed = mux.hostRequest("Target.attachToTarget", { targetId: "T-fail", flatten: true });
  const sent = backend.sent.at(-1);
  assert.equal(ledger.inspect().hostReservations.length, 1);
  backend.emit({ id: sent.id, error: { message: "No target with given id" } });
  await assert.rejects(failed, /No target with given id/);
  assert.equal(ledger.inspect().hostReservations.length, 0, "실패 뒤에도 예약이 남았다");

  // 그 타깃에 예기치 않은 자식이 붙는다. 남은 예약이 없으므로 감독자 세션이 되지 못한다.
  backend.emit({
    method: "Target.attachedToTarget",
    params: {
      sessionId: "CHILD-AFTER-FAILURE",
      targetInfo: { targetId: "T-fail", type: "iframe", attached: true },
      waitingForDebugger: true,
    },
  });
  assert.equal(ledger.isHostSession("CHILD-AFTER-FAILURE"), false, "자식이 감독자 세션으로 승인됐다");
  assert.deepEqual(
    ledger.inspect().rejectedChildren.map((entry) => entry.sessionId),
    ["CHILD-AFTER-FAILURE"],
    "실패 뒤 자식이 끊기지 않았다",
  );
});
