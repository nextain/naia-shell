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

/**
 * S7 P1-4 — 불투명 id 는 작업과 **세션** 양쪽에 결박된다 (계약 4.3.2).
 *
 * 고치기 전에는 `map.has(id)` 만 봤다. 한 작업이 두 세션을 들면 S1 이 만든 objectId 를 S2 의
 * 명령에 넣어도 정책층이 통과시켜 Chromium 까지 갔다. 작업 결속은 있었지만 세션 격리가 없었다.
 */
test("같은 작업의 두 세션이 서로의 objectId·requestId 를 쓰지 못한다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { channel, sessionId: first } = await openSession(client, "교차", fixture.origin);

  // 같은 작업(뿌리 작업)이 두 번째 탭에도 붙는다 — 세션 둘, 작업 하나.
  const created = await channel.call("Target.createTarget", { url: `${fixture.origin}/` });
  const { sessionId: second } = await channel.call(
    "Target.attachToTarget",
    { targetId: created.targetId, flatten: true },
  );
  assert.notEqual(first, second, "두 번째 세션이 서지 않았다");

  // S1 에서 원격 객체 하나를 만든다. 등록은 감독자가 응답에서 직접 한다(선언을 믿지 않는다).
  const made = await channel.call("Runtime.evaluate", { expression: "({naia:1})" }, first);
  const objectId = made.result?.objectId;
  assert.ok(objectId, `objectId 를 못 받았다: ${JSON.stringify(made)}`);

  // 자기 세션에서는 쓸 수 있다.
  const own = await channel.call(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: "function(){return this.naia}", returnByValue: true },
    first,
  );
  assert.equal(own.result?.value, 1, `자기 세션에서 막혔다: ${JSON.stringify(own)}`);

  // 남의 세션에서는 **세션 불일치**로 거부다. 없는 것과 다른 세션 것은 다른 사실이다.
  const crossId = channel.nextId();
  const cross = await channel.send(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: "function(){return this.naia}", returnByValue: true },
    second,
  );
  assert.equal(cross.id, crossId, "거부가 원래 id 를 잃었다");
  assert.equal(cross.error.code, CODES.RESOURCE_NOT_OWNED, JSON.stringify(cross));
  assert.match(cross.error.message, new RegExp(`세션 ${first} 의 것이다`));

  // 아예 없는 id 는 소유 없음으로 거부된다(같은 코드, 다른 문구).
  const absent = await channel.send(
    "Runtime.callFunctionOn",
    { objectId: "지어낸-객체", functionDeclaration: "function(){return 1}" },
    first,
  );
  assert.equal(absent.error.code, CODES.RESOURCE_NOT_OWNED);
  assert.match(absent.error.message, /이 작업이 연 것이 아니다/);

  await live.stop();
});
