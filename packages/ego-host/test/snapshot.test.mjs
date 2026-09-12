// #582 S2e — 실 접근성 스냅샷·화면 캡처·탭 목록 (계약 4.4·4.5, ABI 7).
//
// 판정의 핵심은 "모양이 맞다"가 아니라 **그 ref 로 실제 요소를 잡을 수 있다** 이다. 그래서
// `refs[].backendNodeId` 를 `DOM.resolveNode` 에 넣어 원격 객체를 얻고, 그 객체 위에서 함수를
// 실행해 픽스처가 심어 둔 id 가 나오는지 본다. 모양만 보면 backendNodeId 가 전부 0 이어도
// 통과한다.
//
// 벤더 런타임 쪽도 같은 스냅샷을 받는지 **런처로 실제 실행**해 대조한다(모형 아님).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, before, test } from "node:test";
import { evidenceDir } from "../src/supervisor/ax-snapshot.mjs";
import { cleanupAll } from "./helpers/live-browser.mjs";
import {
  cdpChannel,
  connectClient,
  startLiveSupervisor,
  stopAllLive,
  waitFor,
} from "./helpers/live-supervisor.mjs";
import { ensureVendorDist, json, runEgoScript } from "./helpers/vendor-runtime.mjs";

const PAGE = `<!doctype html><meta charset="utf-8"><title>naia 582 스냅샷</title>
<body>
  <h1>스냅샷 픽스처</h1>
  <button id="send-button">보내기</button>
  <a id="home-link" href="/home">홈</a>
  <label for="query">검색어</label><input id="query" type="text" name="query">
</body>`;

const servers = [];

before(() => ensureVendorDist(), { timeout: 900_000 });

after(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await stopAllLive();
  cleanupAll();
});

async function startFixture() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}` };
}

async function openPage(client, name, origin) {
  const space = await client.call("createTaskSpace", { name });
  const tabs = await client.call("listTabs");
  const targetId = tabs.tabs[0].targetId;
  const channel = cdpChannel(client);
  const { sessionId } = await channel.call("Target.attachToTarget", { targetId, flatten: true });
  await channel.call("Page.navigate", { url: `${origin}/` }, sessionId);
  const ready = await waitFor(async () => {
    const result = await channel.call(
      "Runtime.evaluate",
      { expression: "document.readyState", returnByValue: true },
      sessionId,
    );
    return result.result?.value === "complete";
  });
  assert.ok(ready, "픽스처 페이지가 뜨지 않았다");
  return { space, targetId, channel, sessionId };
}

test("스냅샷: 본문은 [ref=N, loc=…] 이고 refs 의 backendNodeId 로 실제 요소를 잡는다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { channel, sessionId } = await openPage(client, "스냅샷", fixture.origin);

  const snapshot = await client.call("snapshot", { options: {} });
  assert.equal(typeof snapshot.content, "string");
  assert.ok(Array.isArray(snapshot.refs) && snapshot.refs.length > 0, "refs 가 비었다");
  for (const ref of snapshot.refs) {
    assert.deepEqual(Object.keys(ref).sort(), ["backendNodeId", "name", "role"]);
    assert.equal(typeof ref.backendNodeId, "number");
  }

  // 본문 형식 — 벤더 SKILL.md:182 의 `[ref=N, loc=..., url=...]`.
  assert.match(snapshot.content, /\[ref=\d+, loc=css:#send-button\]/, snapshot.content);
  assert.match(snapshot.content, /\[ref=\d+, loc=css:#home-link, url=[^\]]*\/home\]/, snapshot.content);
  // 조작 가능한 역할에는 표시가 붙는다(includeActionMarks 기본 참).
  assert.match(snapshot.content, /- \*button "보내기"/, snapshot.content);

  // 본문의 ref 번호와 refs 의 backendNodeId 가 같은 값이다(ABI 7 의 유일한 기계 계약).
  const inContent = [...snapshot.content.matchAll(/\[ref=(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    inContent.sort((a, b) => a - b),
    snapshot.refs.map((ref) => ref.backendNodeId).sort((a, b) => a - b),
  );

  // ── ref 가 진짜 요소를 가리키는가 ────────────────────────────────────────
  const button = snapshot.refs.find((ref) => ref.name === "보내기");
  assert.ok(button, `보내기 버튼이 refs 에 없다: ${JSON.stringify(snapshot.refs)}`);
  const resolved = await channel.call(
    "DOM.resolveNode",
    { backendNodeId: button.backendNodeId },
    sessionId,
  );
  const objectId = resolved.object?.objectId;
  assert.ok(objectId, "DOM.resolveNode 가 원격 객체를 주지 않았다");
  const identity = await channel.call(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: "function () { return this.id + '/' + this.tagName; }",
      returnByValue: true,
    },
    sessionId,
  );
  assert.equal(identity.result.value, "send-button/BUTTON", "ref 가 다른 요소를 가리킨다");
  await live.stop();
});

test("스냅샷: includeStableLocator·includeActionMarks 는 지원하고 scope 는 무시한다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  await openPage(client, "옵션", fixture.origin);

  const plain = await client.call("snapshot", {
    options: { includeStableLocator: false, includeActionMarks: false },
  });
  assert.doesNotMatch(plain.content, /loc=/, "includeStableLocator:false 인데 로케이터가 붙었다");
  assert.doesNotMatch(plain.content, /- \*/, "includeActionMarks:false 인데 표시가 붙었다");

  // `scope` 는 우리 감독자가 지원하지 않는다 — 무시하고 전체 문서를 준다(문서화된 사실).
  const viewport = await client.call("snapshot", { options: { scope: "only_within_viewport" } });
  const full = await client.call("snapshot", { options: { scope: "full_page" } });
  assert.equal(viewport.content, full.content, "scope 가 결과를 바꿨다 — 지원하지 않기로 한 옵션이다");
  await live.stop();
});

test("스냅샷: 벤더 런타임의 snapshotText() 도 같은 본문과 refs 를 받는다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { space } = await openPage(client, "벤더", fixture.origin);
  const direct = await client.call("snapshot", { options: {} });

  const token = live.server.issueToken({ grant: { tier: "workspace-write" } });
  const result = await runEgoScript({
    socketPath: live.socketPath,
    token,
    script: `
      await taskSpaces.useOrCreate(${space.id});
      const raw = await page.snapshotRaw({});
      console.log("REFS " + JSON.stringify(raw.refs));
      console.log("HASBUTTON " + JSON.stringify(raw.content.includes("loc=css:#send-button")));
      console.log("TEXT " + JSON.stringify(await page.snapshot()));
    `,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(result, "HASBUTTON"), true);
  assert.deepEqual(
    json(result, "REFS").map((ref) => ref.backendNodeId),
    direct.refs.map((ref) => ref.backendNodeId),
    "벤더 런타임이 받은 refs 가 RPC 결과와 다르다",
  );
  assert.equal(json(result, "TEXT"), direct.content, "벤더 snapshotText() 본문이 다르다");
  await live.stop();
});

test("캡처: 감독자가 정한 경로에 PNG 가 생기고 사용자 인자 경로는 무시된다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  await openPage(client, "캡처", fixture.origin);

  const first = await client.call("screenshot", {});
  assert.equal(
    dirname(first.path),
    evidenceDir(live.adkDir),
    `캡처가 감독자 증거 디렉터리 밖에 떨어졌다: ${first.path}`,
  );
  assert.match(first.path, new RegExp(`${client.greeting.operationId}-1\\.png$`));
  const bytes = readFileSync(first.path);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "PNG 매직 바이트가 아니다");

  // 두 번째 캡처는 일련번호가 올라간다.
  const second = await client.call("screenshot", {});
  assert.match(second.path, new RegExp(`${client.greeting.operationId}-2\\.png$`));

  // 사용자가 경로를 적어 보내도 감독자 경로를 쓴다(계약 4.4).
  const forced = await client.call("screenshot", { path: "/tmp/naia-582-should-not-be-used.png" });
  assert.equal(dirname(forced.path), evidenceDir(live.adkDir));
  await live.stop();
});

test("캡처·스냅샷: 승인 없는 관측 연결도 RPC 로 받는다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const worker = await connectClient(live);
  const { space } = await openPage(worker, "관측", fixture.origin);

  // 승인 없는 연결 — 원시 CDP 는 못 보낸다(S2a). 스냅샷·캡처는 감독자가 대신 실행한다.
  const observer = await connectClient(live, { grant: null });
  assert.equal(observer.greeting.observeOnly, true);
  await observer.call("useTaskSpace", { id: space.id });

  const snapshot = await observer.call("snapshot", { options: {} });
  assert.ok(snapshot.refs?.length > 0, `관측 연결의 스냅샷이 비었다: ${JSON.stringify(snapshot)}`);
  const shot = await observer.call("screenshot", {});
  assert.equal(dirname(shot.path), evidenceDir(live.adkDir));
  assert.ok(shot.bytes > 0);

  // 그래도 원시 CDP 는 여전히 막혀 있다.
  const channel = cdpChannel(observer);
  const denied = await channel.send("Page.getFrameTree", {});
  assert.equal(denied.error.code, "EGO_HOST_GRANT_REQUIRED");
  await live.stop();
});

test("탭 목록: 원시 CDP Target.createTarget 으로 만든 탭도 listTabs 에 보인다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  const { channel } = await openPage(client, "탭", fixture.origin);

  const before = await client.call("listTabs");
  const created = await channel.call("Target.createTarget", { url: `${fixture.origin}/raw` });
  const after = await client.call("listTabs");

  assert.equal(after.tabs.length, before.tabs.length + 1, "원시 CDP 로 만든 탭이 목록에 없다");
  const raw = after.tabs.find((tab) => tab.targetId === created.targetId);
  assert.ok(raw, `${created.targetId} 가 listTabs 에 없다`);
  assert.equal(raw.url, `${fixture.origin}/raw`);
  // 그리고 `Target.getTargetInfo` 도 같은 탭을 자기 것으로 본다(두 표면이 같은 장부를 본다).
  const info = await channel.call("Target.getTargetInfo", { targetId: created.targetId });
  assert.equal(info.targetInfo.targetId, created.targetId);
  await live.stop();
});
