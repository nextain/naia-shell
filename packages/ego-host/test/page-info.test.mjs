// #582 S3a — 어댑터가 읽는 감독자 표면: `pageInfo`, 스냅샷 증거 파일, 주소 개정.
//
// 이 셋은 S3a 에서 새로 생긴 감독자 쪽 면이다. 어댑터의 계약 테스트(코어 쪽)가 이미 실브라우저로
// 밟지만, 감독자 자신의 묶음에서도 재는 이유는 하나다 — 이 면이 깨지면 코어가 아니라 여기가
// 원인이며, 원인이 있는 자리에서 실패해야 다음 사람이 두 번 찾지 않는다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { after, test } from "node:test";
import { cleanupAll } from "./helpers/live-browser.mjs";
import { cdpChannel, connectClient, startLiveSupervisor, stopAllLive, waitFor } from "./helpers/live-supervisor.mjs";

const FIRST = `<!doctype html><meta charset="utf-8"><title>첫</title><body><h1>첫 페이지</h1>
<button id="go">가기</button></body>`;
const SECOND = `<!doctype html><meta charset="utf-8"><title>둘째</title><body><h1>둘째 페이지</h1></body>`;

const servers = [];

after(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await stopAllLive();
  cleanupAll();
});

async function startFixture() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end((request.url ?? "/").startsWith("/second") ? SECOND : FIRST);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function ready(channel, sessionId) {
  const done = await waitFor(async () => {
    const result = await channel.call(
      "Runtime.evaluate",
      { expression: "document.readyState", returnByValue: true },
      sessionId,
    );
    return result.result?.value === "complete";
  });
  assert.ok(done, "페이지가 뜨지 않았다");
}

test("pageInfo 는 지금 보는 탭의 주소를 주고 주소가 바뀔 때만 개정이 오른다", async () => {
  const origin = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  await client.call("createTaskSpace", { name: "개정" });
  const created = await client.call("createTab", { url: `${origin}/` });
  const channel = cdpChannel(client);
  const { sessionId } = await channel.call("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  await ready(channel, sessionId);

  const first = await client.call("pageInfo", {});
  assert.equal(first.targetId, created.targetId);
  assert.equal(first.url, `${origin}/`);
  assert.ok(first.urlRevision >= 1, `개정이 없다: ${JSON.stringify(first)}`);

  // 같은 주소를 다시 읽어도 개정은 그대로다. 오르면 "바뀌었다"가 뜻을 잃는다.
  const again = await client.call("pageInfo", {});
  assert.equal(again.urlRevision, first.urlRevision, "주소가 그대로인데 개정이 올랐다");

  await channel.call("Page.navigate", { url: `${origin}/second` }, sessionId);
  await ready(channel, sessionId);
  const moved = await client.call("pageInfo", {});
  assert.equal(moved.url, `${origin}/second`);
  assert.ok(moved.urlRevision > first.urlRevision, "주소가 바뀌었는데 개정이 그대로다");
  await live.stop();
});

test("스냅샷은 증거 파일로 남고 record:false 는 남기지 않는다", async () => {
  const origin = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  await client.call("createTaskSpace", { name: "증거" });
  const created = await client.call("createTab", { url: `${origin}/` });
  const channel = cdpChannel(client);
  const { sessionId } = await channel.call("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  await ready(channel, sessionId);

  const recorded = await client.call("snapshot", { options: {} });
  assert.equal(typeof recorded.path, "string");
  assert.ok(existsSync(recorded.path), `스냅샷 증거 파일이 없다: ${recorded.path}`);
  assert.match(recorded.path, /\.snapshot\.txt$/);
  assert.equal(readFileSync(recorded.path, "utf8"), recorded.content);

  // 조회는 증거를 남기지 않는다 — 조회마다 파일이 쌓이면 무엇이 실제 관측이었는지 못 읽는다.
  const peeked = await client.call("snapshot", { options: { record: false } });
  assert.equal(peeked.path, undefined, "record:false 인데 증거를 남겼다");
  assert.ok(Array.isArray(peeked.refs) && peeked.refs.length > 0);
  await live.stop();
});
