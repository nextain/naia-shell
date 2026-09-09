// #582 S2d — 로컬 출처에서 쿠키·localStorage·IndexedDB·CacheStorage·서비스 워커·권한·
// 다운로드 경로가 공간 사이에 새지 않는다 (계약 4.3.2 마지막 항).
//
// 두 가지를 지킨다.
//  (1) **먼저 심고, 심긴 것을 확인한다.** 없음(negative)만 확인하면 심는 데 실패한 것과
//      격리된 것을 구별할 수 없다. 공간 A 에서 일곱 가지를 심고 A 에서 보이는 것을 먼저
//      확인한 뒤, 공간 B 에서 같은 출처를 열어 하나도 안 보이는 것을 확인한다.
//  (2) **출처는 로컬**이다. 픽스처 HTTP 서버를 테스트 안에서 띄운다(계약 금지 사항: 외부
//      네트워크로 나가는 페이지). 127.0.0.1 은 브라우저가 안전한 출처로 취급하므로
//      서비스 워커·권한도 실제로 돈다.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupAll } from "./helpers/live-browser.mjs";
import {
  cdpChannel,
  connectClient,
  startLiveSupervisor,
  stopAllLive,
  waitFor,
} from "./helpers/live-supervisor.mjs";

const DOWNLOAD_NAME = "naia-582.bin";
const servers = [];

after(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await stopAllLive();
  cleanupAll();
});

/** 로컬 픽스처 하나. 페이지·서비스 워커 스크립트·첨부 파일 세 자리뿐이다. */
async function startFixture() {
  const server = createServer((request, response) => {
    if (request.url.startsWith("/sw.js")) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end("self.addEventListener('fetch', () => {});\n");
      return;
    }
    if (request.url.startsWith("/download.bin")) {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${DOWNLOAD_NAME}"`,
      });
      response.end("naia-582-payload");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><meta charset=utf-8><title>naia 582</title><body>ok</body>");
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, port };
}

/** 공간 하나 + 그 공간의 탭에 붙은 세션 하나 + 픽스처 열기까지. */
async function openSpace(live, client, name, origin) {
  const space = await client.call("createTaskSpace", { name });
  const tabs = await client.call("listTabs");
  const targetId = tabs.tabs[0].targetId;
  const channel = cdpChannel(client);
  const { sessionId } = await channel.call("Target.attachToTarget", { targetId, flatten: true });
  await channel.call("Page.navigate", { url: `${origin}/` }, sessionId);
  await waitForReady(channel, sessionId);
  return { space, targetId, channel, sessionId };
}

async function evaluate(channel, sessionId, expression, { awaitPromise = true } = {}) {
  const result = await channel.call(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      `페이지 평가가 던졌다: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result?.value;
}

async function waitForReady(channel, sessionId) {
  const ready = await waitFor(
    async () => (await evaluate(channel, sessionId, "document.readyState")) === "complete",
    { timeoutMs: 15_000 },
  );
  assert.ok(ready, "픽스처 페이지가 뜨지 않았다");
}

/** 이 출처에서 보이는 것 전부. 심은 뒤와 남의 공간에서 각각 같은 함수로 읽는다. */
async function observe(channel, sessionId) {
  return {
    cookie: await evaluate(channel, sessionId, "document.cookie"),
    local: await evaluate(channel, sessionId, "localStorage.getItem('naia582')"),
    databases: await evaluate(
      channel,
      sessionId,
      "indexedDB.databases().then(list => list.map(d => d.name))",
    ),
    caches: await evaluate(channel, sessionId, "caches.keys()"),
    workers: await evaluate(
      channel,
      sessionId,
      "navigator.serviceWorker.getRegistrations().then(list => list.length)",
    ),
    geolocation: await evaluate(
      channel,
      sessionId,
      "navigator.permissions.query({name:'geolocation'}).then(s => s.state)",
    ),
  };
}

function downloadedFiles(live, workspaceId) {
  const dir = join(live.adkDir, "ego-host", "downloads", String(workspaceId));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.endsWith(".crdownload"));
}

test("공간 A 에 심은 쿠키·저장소·워커·권한·다운로드가 공간 B 에서 하나도 안 보인다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);

  // ── 공간 A: 일곱 가지를 심는다 ────────────────────────────────────────────
  const a = await openSpace(live, client, "격리A", fixture.origin);
  await evaluate(a.channel, a.sessionId, "document.cookie = 'naia582=planted; path=/'", {
    awaitPromise: false,
  });
  await evaluate(a.channel, a.sessionId, "localStorage.setItem('naia582','planted')", {
    awaitPromise: false,
  });
  await evaluate(
    a.channel,
    a.sessionId,
    "new Promise(done => { const r = indexedDB.open('naia582', 1); r.onsuccess = () => done('ok'); r.onerror = () => done('fail'); })",
  );
  await evaluate(
    a.channel,
    a.sessionId,
    "caches.open('naia582').then(c => c.put('/cached', new Response('x'))).then(() => 'ok')",
  );
  await evaluate(
    a.channel,
    a.sessionId,
    "navigator.serviceWorker.register('/sw.js').then(r => r.scope)",
  );
  // 권한은 페이지가 아니라 감독자 통로로 준다(컨텍스트 강제 셀).
  await a.channel.call("Browser.grantPermissions", {
    origin: fixture.origin,
    permissions: ["geolocation"],
  });
  // 다운로드 경로는 연결이 뭐라 적든 공간 디렉터리로 재작성된다.
  await a.channel.call("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: "/tmp/naia-582-should-not-be-used",
    eventsEnabled: true,
  });
  await evaluate(a.channel, a.sessionId, "location.href = '/download.bin'", { awaitPromise: false });

  const plantedFiles = await waitFor(() => {
    const files = downloadedFiles(live, a.space.id);
    return files.length > 0 ? files : null;
  });
  assert.ok(plantedFiles, "A 의 공간 디렉터리에 다운로드가 떨어지지 않았다");
  assert.ok(plantedFiles.includes(DOWNLOAD_NAME), `받은 파일 이름이 다르다: ${plantedFiles.join(", ")}`);

  // 심긴 것을 A 에서 먼저 확인한다 — 심기에 실패한 것을 격리로 오해하지 않기 위해서다.
  await a.channel.call("Page.navigate", { url: `${fixture.origin}/` }, a.sessionId);
  await waitForReady(a.channel, a.sessionId);
  const planted = await observe(a.channel, a.sessionId);
  assert.match(planted.cookie, /naia582=planted/, "쿠키가 안 심겼다");
  assert.equal(planted.local, "planted", "localStorage 가 안 심겼다");
  assert.ok(planted.databases.includes("naia582"), "IndexedDB 가 안 심겼다");
  assert.ok(planted.caches.includes("naia582"), "CacheStorage 가 안 심겼다");
  assert.ok(planted.workers >= 1, "서비스 워커가 등록되지 않았다");
  assert.equal(planted.geolocation, "granted", "권한이 부여되지 않았다");

  // ── 공간 B: 같은 출처인데 하나도 없어야 한다 ─────────────────────────────
  const b = await openSpace(live, client, "격리B", fixture.origin);
  const seen = await observe(b.channel, b.sessionId);
  assert.equal(seen.cookie, "", `쿠키가 샜다: ${seen.cookie}`);
  assert.equal(seen.local, null, "localStorage 가 샜다");
  assert.deepEqual(seen.databases, [], `IndexedDB 가 샜다: ${JSON.stringify(seen.databases)}`);
  assert.deepEqual(seen.caches, [], `CacheStorage 가 샜다: ${JSON.stringify(seen.caches)}`);
  assert.equal(seen.workers, 0, "서비스 워커 등록이 샜다");
  assert.notEqual(seen.geolocation, "granted", "권한이 샜다");
  assert.deepEqual(downloadedFiles(live, b.space.id), [], "A 의 다운로드가 B 의 디렉터리에 있다");

  // 그리고 A 의 것은 그대로 있다(B 를 열었다고 A 가 지워지지 않는다).
  const stillA = await observe(a.channel, a.sessionId);
  assert.match(stillA.cookie, /naia582=planted/);
  assert.deepEqual(downloadedFiles(live, a.space.id), plantedFiles);
  await live.stop();
});

test("공간을 닫으면 그 컨텍스트의 저장소가 함께 사라진다", async () => {
  const fixture = await startFixture();
  const live = await startLiveSupervisor();
  const client = await connectClient(live);

  const first = await openSpace(live, client, "닫힘전", fixture.origin);
  await evaluate(first.channel, first.sessionId, "localStorage.setItem('naia582','planted')", {
    awaitPromise: false,
  });
  assert.equal(
    await evaluate(first.channel, first.sessionId, "localStorage.getItem('naia582')"),
    "planted",
  );
  await client.call("closeTaskSpace");

  const second = await openSpace(live, client, "닫힘후", fixture.origin);
  assert.equal(
    await evaluate(second.channel, second.sessionId, "localStorage.getItem('naia582')"),
    null,
    "닫은 공간의 저장소가 새 공간에서 보인다",
  );
  await live.stop();
});
