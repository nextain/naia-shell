// #582 S2e — 작업 장부의 나머지 셀: 도메인 참조 횟수, 소유 없는 자원, 본문 잘림.
//
// 취소·deadline·배타 슬롯은 `cancel.test.mjs`, 스냅샷·캡처는 `snapshot.test.mjs` 가 든다.
// 여기 있는 것은 그 둘에 안 들어가는 판정들이다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { CODES } from "../src/errors.mjs";
import { MAX_SNAPSHOT_DEPTH, renderSnapshot, stableLocator } from "../src/supervisor/ax-snapshot.mjs";
import { cleanupAll } from "./helpers/live-browser.mjs";
import { cdpChannel, connectClient, startLiveSupervisor, stopAllLive } from "./helpers/live-supervisor.mjs";

const servers = [];

after(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await stopAllLive();
  cleanupAll();
});

async function startFixture() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><meta charset=utf-8><title>naia 582 작업</title><body>ok</body>");
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}` };
}

async function openSession(client, name, origin) {
  await client.call("createTaskSpace", { name });
  const tabs = await client.call("listTabs");
  const channel = cdpChannel(client);
  const { sessionId } = await channel.call(
    "Target.attachToTarget",
    { targetId: tabs.tabs[0].targetId, flatten: true },
  );
  await channel.call("Page.navigate", { url: `${origin}/` }, sessionId);
  return { channel, sessionId };
}

test("도메인 참조 횟수: 다른 작업이 Fetch 를 쓰는 동안에는 Fetch.disable 이 거부된다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { channel, sessionId } = await openSession(client, "참조", fixture.origin);

  const b = await client.call("beginOperation", { timeoutMs: 20_000 });
  const bChannel = cdpChannel(client, { operationId: b.operationId });

  // 두 작업이 같은 세션에서 Fetch 를 켠다 → 참조 2.
  await channel.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
  await bChannel.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);

  const denied = await bChannel.send("Fetch.disable", {}, sessionId);
  assert.equal(denied.error.code, CODES.DOMAIN_IN_USE, JSON.stringify(denied));
  assert.match(denied.error.message, /참조 횟수가 0 일 때만/);

  // 뿌리 작업이 손을 떼면 참조가 1 이 되고 B 가 끌 수 있다.
  await client.call("cancelOperation", { operationId: client.greeting.operationId });
  const allowed = await bChannel.send("Fetch.disable", {}, sessionId);
  assert.equal(allowed.error, undefined, JSON.stringify(allowed));
  await live.stop();
});

test("소유 없는 자원: IO.read 는 소유할 핸들이 생길 수 없어 언제나 거부된다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { channel } = await openSession(client, "스트림", fixture.origin);

  // 스트림 핸들을 만드는 CDP 메서드는 정책표에 하나도 없다(기본 거부). 그래서 이 자원은
  // 소유가 성립할 수 없고, 결속 검사가 언제나 걸린다 — fail-closed 다.
  const read = await channel.send("IO.read", { handle: "1" });
  assert.equal(read.error.code, CODES.RESOURCE_NOT_OWNED, JSON.stringify(read));
  const close = await channel.send("IO.close", { handle: "1" });
  assert.equal(close.error.code, CODES.RESOURCE_NOT_OWNED);
  // 스트림을 만드는 메서드 자체도 정책표 밖이라 거부다.
  const take = await channel.send("Fetch.takeResponseBodyAsStream", { requestId: "x" });
  assert.equal(take.error.code, CODES.METHOD_DENIED);
  await live.stop();
});

test("스냅샷 본문: 노드·깊이 상한을 넘으면 잘렸다고 본문에 적는다", () => {
  // 한 줄로 이어진 깊은 사슬. 깊이 상한을 넘는 가지가 생긴다.
  const chain = [];
  for (let i = 0; i < MAX_SNAPSHOT_DEPTH + 10; i += 1) {
    chain.push({
      nodeId: String(i),
      parentId: i === 0 ? undefined : String(i - 1),
      childIds: i === MAX_SNAPSHOT_DEPTH + 9 ? [] : [String(i + 1)],
      backendDOMNodeId: 1000 + i,
      role: { value: "button" },
      name: { value: `n${i}` },
    });
  }
  const deep = renderSnapshot({ nodes: chain });
  assert.equal(deep.truncated, true);
  assert.match(deep.content, /잘림: 노드 상한/);
  assert.ok(deep.refs.length <= MAX_SNAPSHOT_DEPTH + 1, `깊이 상한이 안 걸렸다: ${deep.refs.length}`);

  const wide = renderSnapshot({
    nodes: [
      { nodeId: "root", childIds: ["a", "b"], role: { value: "main" }, backendDOMNodeId: 1 },
      { nodeId: "a", parentId: "root", role: { value: "button" }, name: { value: "가" }, backendDOMNodeId: 2 },
      { nodeId: "b", parentId: "root", role: { value: "button" }, name: { value: "나" }, backendDOMNodeId: 3 },
    ],
    maxNodes: 2,
  });
  assert.equal(wide.truncated, true);
  assert.equal(wide.refs.length, 2);
  assert.match(wide.content, /잘림: 노드 상한 2/);
});

test("로케이터: css → href → role 순으로 고르고 없으면 붙이지 않는다", () => {
  assert.equal(stableLocator({ dom: { id: "send", tag: "button" } }), "css:#send");
  assert.equal(stableLocator({ dom: { tag: "a", href: "/home" } }), "href:/home");
  assert.equal(stableLocator({ dom: { tag: "input", name: "q" } }), 'css:input[name="q"]');
  assert.equal(stableLocator({ role: "button", name: "보내기" }), 'role:button[name="보내기"]');
  assert.equal(stableLocator({}), null);
});
