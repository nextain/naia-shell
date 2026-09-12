// #582 S2d — 기본 거부 행렬 각 셀: 거부는 원래 id 오류 응답, 컨텍스트 강제는 재작성,
// 헤드리스 인계·회수·claim 거부 (계약 4.3.2).
//
// 이 파일은 정책표를 **데이터로 읽어** 셀마다 실 Chromium 에 대고 확인한다. 표에 한 줄을
// 더하면 시험도 한 줄 늘어난다. 그리고 벤더 소스 스캔 결과가 표에 없으면 **수집 단계**에서
// 던진다(아래 최상위 검사). 테스트가 하나도 안 돌고 파일이 통째로 빨간색이 된다.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CODES } from "../src/errors.mjs";
import {
  CONTEXT_MISMATCH,
  POLICY,
  SCOPES,
  methodsByScope,
  policyFor,
  requiresSession,
} from "../src/supervisor/mediator-policy.mjs";
import { scanAllTargets, scanCdpMethods } from "../scripts/scan-cdp-methods.mjs";
import { cleanupAll } from "./helpers/live-browser.mjs";
import {
  cdpChannel,
  connectClient,
  startLiveSupervisor,
  stopAllLive,
  waitFor,
} from "./helpers/live-supervisor.mjs";

// ── 수집 단계 게이트 ─────────────────────────────────────────────────────────
// 벤더 런타임이 부르는데 표에 없는 메서드가 하나라도 있으면 여기서 던진다.
const CONTRACT_SCAN = scanCdpMethods();
const FULL_SCAN = scanCdpMethods({ files: scanAllTargets() });
{
  const missing = FULL_SCAN.methods.filter((method) => !policyFor(method));
  if (missing.length > 0) {
    throw new Error(
      `벤더 소스가 부르는 CDP 메서드가 정책표에 없다(미분류 ${missing.length}): ${missing.join(", ")}\n` +
        "src/supervisor/mediator-policy.mjs 에 등급을 정해 넣어야 한다(#582 계약 4.3.2).",
    );
  }
}

after(async () => {
  await stopAllLive();
  cleanupAll();
});

/** 공간 하나 + 탭 하나 + 붙은 세션 하나. 대부분의 셀이 여기서 출발한다. */
async function stage(live, name = "정책") {
  const client = await connectClient(live);
  const space = await client.call("createTaskSpace", { name });
  const tabs = await client.call("listTabs");
  const targetId = tabs.tabs[0].targetId;
  const channel = cdpChannel(client);
  const { sessionId } = await channel.call("Target.attachToTarget", { targetId, flatten: true });
  return { client, space, targetId, channel, sessionId };
}

// ── 표 자체의 건전성 ─────────────────────────────────────────────────────────

test("정책표는 정확한 메서드 이름만 쓰고 등급이 여섯 가지 중 하나다", () => {
  for (const [method, entry] of Object.entries(POLICY)) {
    assert.match(method, /^[A-Z][A-Za-z]*\.[a-z][A-Za-z]*$/, `메서드 이름 형식이 아니다: ${method}`);
    assert.ok(SCOPES.includes(entry.scope), `알 수 없는 등급: ${method} → ${entry.scope}`);
    if (entry.args) assert.equal(typeof entry.args, "function", `${method} 의 args 가 함수가 아니다`);
    assert.ok(!method.includes("*"), "와일드카드는 쓰지 않는다");
  }
  // 접두사 허용이 없다는 것을 값으로 확인한다: Target 계열이 등급별로 흩어져 있어야 한다.
  const targetScopes = new Set(
    Object.entries(POLICY)
      .filter(([method]) => method.startsWith("Target."))
      .map(([, entry]) => entry.scope),
  );
  assert.ok(targetScopes.size >= 3, "Target.* 이 한 등급으로 뭉쳐 있다 = 접두사 허용의 냄새");
});

test("벤더 소스가 부르는 CDP 메서드는 전부 정책표에 있다 (미분류 0)", () => {
  const missingContract = CONTRACT_SCAN.methods.filter((method) => !policyFor(method));
  assert.deepEqual(missingContract, [], "계약 4.3.2 가 지목한 세 자리의 메서드가 표에 없다");
  const missingAll = FULL_SCAN.methods.filter((method) => !policyFor(method));
  assert.deepEqual(missingAll, [], "벤더 src 전체의 메서드가 표에 없다");
  assert.ok(CONTRACT_SCAN.methods.length >= 26, `스캔이 너무 적게 잡았다: ${CONTRACT_SCAN.methods.length}`);
  assert.ok(FULL_SCAN.methods.length >= CONTRACT_SCAN.methods.length);
});

// ── 거부 셀 ──────────────────────────────────────────────────────────────────

test("거부·감독자 전용 셀은 전부 원래 id 를 가진 CDP 오류 응답으로 돌아온다", async () => {
  const live = await startLiveSupervisor();
  const { channel } = await stage(live, "거부");
  const denied = [...methodsByScope("deny"), ...methodsByScope("supervisor-only")];
  assert.ok(denied.length >= 14, `거부 셀이 너무 적다: ${denied.length}`);
  for (const method of denied) {
    const id = channel.nextId();
    const response = await channel.send(method, {});
    assert.equal(response.id, id, `${method}: 거부가 원래 id 를 안 달았다`);
    assert.ok(response.error, `${method}: 거부되지 않았다`);
    assert.equal(response.error.code, CODES.METHOD_DENIED, `${method}: 코드가 다르다`);
    assert.equal(response.result, undefined);
  }
  await live.stop();
});

test("정책표에 없는 메서드는 거부다 (기본 거부)", async () => {
  const live = await startLiveSupervisor();
  const { channel } = await stage(live, "미등록");
  for (const method of ["Cast.enable", "Tracing.start", "Target.createBrowserContextV2", "Nope.nope"]) {
    const response = await channel.send(method, {});
    assert.ok(response.error, `${method} 가 통과했다`);
    assert.match(response.error.message, /정책표에 없는/);
  }
  await live.stop();
});

test("거부는 그 요청 하나만 실패시킨다 — 옆의 대기 요청은 멀쩡하다", async () => {
  const live = await startLiveSupervisor();
  const { channel, sessionId } = await stage(live, "무영향");
  // 같은 tick 에 셋을 넣는다: 정상 → 거부 → 정상.
  const before = channel.fire(11, "Runtime.evaluate", { expression: "1+1", returnByValue: true }, sessionId);
  const denied = channel.fire(12, "Network.clearBrowserCookies", {});
  const after_ = channel.fire(13, "Runtime.evaluate", { expression: "2+2", returnByValue: true }, sessionId);
  const [a, b, c] = await Promise.all([before, denied, after_]);
  assert.equal(a.id, 11);
  assert.equal(a.result.result.value, 2, "거부 앞의 요청이 죽었다");
  assert.equal(b.id, 12);
  assert.ok(b.error, "거부되지 않았다");
  assert.equal(c.id, 13);
  assert.equal(c.result.result.value, 4, "거부 뒤의 요청이 죽었다");
  await live.stop();
});

// ── 컨텍스트 강제 셀 ─────────────────────────────────────────────────────────

test("Target.createTarget 은 공간의 컨텍스트로 재작성되어 Chromium 에 도달한다", async () => {
  const live = await startLiveSupervisor({ wrap: true });
  const { channel, space } = await stage(live, "컨텍스트");
  const wanted = live.ledger.browserContextOf(live.ledger.get(space.id));
  assert.ok(wanted, "공간에 컨텍스트가 없다");

  // 연결은 컨텍스트를 지정하지 않는다. 중계기가 채워 넣어야 한다.
  const created = await channel.call("Target.createTarget", { url: "about:blank" });
  const sent = live.backend.sentMethods("Target.createTarget").at(-1);
  assert.equal(sent.params.browserContextId, wanted, "재작성된 인자가 Chromium 에 안 갔다");

  // 그리고 Chromium 이 실제로 그 컨텍스트에 열었는지 브라우저에게 되묻는다.
  const info = await channel.call("Target.getTargetInfo", { targetId: created.targetId });
  assert.equal(info.targetInfo.browserContextId, wanted, "다른 컨텍스트에 탭이 열렸다");

  // 남의 컨텍스트를 지정하면 EGO_CONTEXT_MISMATCH.
  const mismatch = await channel.send("Target.createTarget", {
    url: "about:blank",
    browserContextId: "DEADBEEFDEADBEEFDEADBEEFDEADBEEF",
  });
  assert.equal(mismatch.error.code, CONTEXT_MISMATCH);
  await live.stop();
});

/**
 * S7 P2 — 컨텍스트 인자의 **모양**을 본다.
 *
 * 고치기 전에는 문자열만 비교하고 나머지 타입은 조용히 우리 컨텍스트로 덮었다. 그래서
 * `browserContextId: null`·`["foreign"]`·`{}`·`3` 이 입력 오류 없이 통과했고, 호출자는 자기가
 * 지정한 컨텍스트에서 돌았다고 믿는다. 값이 아니라 **믿음이 틀리는** 자리다.
 */
test("컨텍스트 인자의 null·배열·객체·숫자·빈 문자열은 조용히 덮이지 않고 거부된다", async () => {
  const live = await startLiveSupervisor({ wrap: true });
  const { channel } = await stage(live, "컨텍스트타입");
  const sentBefore = live.backend.sentMethods("Target.createTarget").length;

  for (const bad of [null, ["foreign"], { id: "foreign" }, 3, ""]) {
    const denied = await channel.send("Target.createTarget", {
      url: "about:blank",
      browserContextId: bad,
    });
    assert.equal(
      denied.error?.code,
      CONTEXT_MISMATCH,
      `${JSON.stringify(bad)} 가 통과했다: ${JSON.stringify(denied)}`,
    );
    assert.match(denied.error.message, /비지 않은 문자열/);
  }
  assert.equal(
    live.backend.sentMethods("Target.createTarget").length,
    sentBefore,
    "거부된 인자가 Chromium 까지 갔다",
  );

  // 권한 계열도 같은 규칙을 쓴다(같은 강제기를 지난다).
  const permission = await channel.send("Browser.grantPermissions", {
    browserContextId: ["foreign"],
    permissions: [],
  });
  assert.equal(permission.error?.code, CONTEXT_MISMATCH, JSON.stringify(permission));
  await live.stop();
});

test("Browser.setDownloadBehavior 와 Page.setDownloadBehavior 는 둘 다 downloadPath 가 재작성된다", async () => {
  const live = await startLiveSupervisor({ wrap: true });
  const { channel, space, sessionId } = await stage(live, "다운로드");
  const mine = `${live.adkDir}/ego-host/downloads/${space.id}`;

  await channel.call("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: "/tmp/naia-582-not-here",
  });
  const browserSent = live.backend.sentMethods("Browser.setDownloadBehavior").at(-1);
  assert.equal(browserSent.params.downloadPath, mine, "Browser 쪽 경로가 재작성되지 않았다");
  assert.equal(
    browserSent.params.browserContextId,
    live.ledger.browserContextOf(live.ledger.get(space.id)),
    "Browser 쪽에 컨텍스트가 안 붙었다",
  );

  await channel.call(
    "Page.setDownloadBehavior",
    { behavior: "allow", downloadPath: "/tmp/naia-582-not-here" },
    sessionId,
  );
  const pageSent = live.backend.sentMethods("Page.setDownloadBehavior").at(-1);
  assert.equal(pageSent.params.downloadPath, mine, "Page 쪽 경로가 재작성되지 않았다 = 우회 통로");
  await live.stop();
});

test("Storage·권한 메서드에도 컨텍스트가 강제된다", async () => {
  const live = await startLiveSupervisor({ wrap: true });
  const { channel, space } = await stage(live, "저장소");
  const wanted = live.ledger.browserContextOf(live.ledger.get(space.id));
  for (const method of ["Storage.getCookies", "Browser.resetPermissions"]) {
    await channel.call(method, {});
    const sent = live.backend.sentMethods(method).at(-1);
    assert.equal(sent.params.browserContextId, wanted, `${method} 에 컨텍스트가 안 붙었다`);
  }
  const mismatch = await channel.send("Storage.clearDataForOrigin", {
    origin: "http://127.0.0.1",
    storageTypes: "all",
    browserContextId: "OTHERCONTEXT0000000000000000000",
  });
  assert.equal(mismatch.error.code, CONTEXT_MISMATCH);
  await live.stop();
});

// ── 세션 소유 셀 ─────────────────────────────────────────────────────────────

test("세션 등급 메서드는 남의 세션 id 로 부르면 거부된다", async () => {
  const live = await startLiveSupervisor();
  const mine = await stage(live, "내세션");
  const theirs = await stage(live, "남세션");

  const stolen = await mine.channel.send(
    "Runtime.evaluate",
    { expression: "1+1" },
    theirs.sessionId,
  );
  assert.ok(stolen.error, "남의 세션으로 평가가 통과했다");
  assert.match(stolen.error.message, /Session not found/);

  // 세션 없이 부르면 브라우저 수준으로 새어 나간다. 그것도 거부다.
  const naked = await mine.channel.send("Runtime.evaluate", { expression: "1+1" });
  assert.ok(naked.error, "세션 없는 Runtime.evaluate 가 통과했다");
  assert.match(naked.error.message, /세션 위에서만/);
  await live.stop();
});

test("작업 등급(Runtime.callFunctionOn·Network.getResponseBody)도 세션 소유를 지난다", async () => {
  const live = await startLiveSupervisor();
  const mine = await stage(live, "작업내");
  const theirs = await stage(live, "작업남");
  for (const method of ["Runtime.callFunctionOn", "Network.getResponseBody"]) {
    assert.equal(policyFor(method).scope, "operation");
    assert.equal(requiresSession(policyFor(method)), true);
    const stolen = await mine.channel.send(method, {}, theirs.sessionId);
    assert.ok(stolen.error, `${method} 가 남의 세션에서 통과했다`);
  }
  await live.stop();
});

// ── Target 장부 셀 ───────────────────────────────────────────────────────────

test("Target 장부: 남의 공간 타깃은 거부되고 getTargets 결과는 내 공간으로 걸러진다", async () => {
  const live = await startLiveSupervisor();
  const mine = await stage(live, "장부내");
  const theirs = await stage(live, "장부남");

  for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo"]) {
    const params = method === "Target.attachToTarget"
      ? { targetId: theirs.targetId, flatten: true }
      : { targetId: theirs.targetId };
    const response = await mine.channel.send(method, params);
    assert.ok(response.error, `${method} 가 남의 타깃에 통했다`);
  }

  const listed = await mine.channel.call("Target.getTargets", {});
  const ids = listed.targetInfos.map((info) => info.targetId);
  assert.ok(ids.includes(mine.targetId), "내 탭이 목록에 없다");
  assert.equal(ids.includes(theirs.targetId), false, "남의 탭이 목록에 샜다");

  // 비 flatten 첨부는 거부다(sendMessageToTarget 봉투 경로가 되살아난다).
  const nonFlatten = await mine.channel.send("Target.attachToTarget", { targetId: mine.targetId });
  assert.ok(nonFlatten.error, "flatten 없는 attach 가 통과했다");
  assert.match(nonFlatten.error.message, /flatten/);
  await live.stop();
});

// ── 헤드리스 인계 (계약 4.4) ─────────────────────────────────────────────────

test("헤드리스 인계·회수·claim RPC 는 형식 있는 거부다", async () => {
  const live = await startLiveSupervisor();
  const client = await connectClient(live);
  await client.call("createTaskSpace", { name: "인계" });
  for (const method of ["claimTaskSpace", "handOffTaskSpace", "takeOverTaskSpace"]) {
    const result = await client.call(method, {});
    assert.equal(result.error_code, "EGO_HANDOFF_UNSUPPORTED_HEADLESS", `${method} 가 통과했다`);
    assert.match(result.error, /헤드리스/);
  }
  await live.stop();
});

// ── 두 연결의 무간섭 ─────────────────────────────────────────────────────────

test("두 연결이 각자 id 1 로 서로 다른 공간을 써도 응답·이벤트가 섞이지 않는다 (실브라우저)", async () => {
  const live = await startLiveSupervisor();
  const a = await stage(live, "공간A");
  const b = await stage(live, "공간B");

  await a.channel.sendWithId(50, "Page.enable", {}, a.sessionId);
  await b.channel.sendWithId(50, "Page.enable", {}, b.sessionId);

  // 두 연결 모두 id 1 을 다시 쓴다. 서로 다른 표현식이라 섞이면 값으로 드러난다.
  const [ra, rb] = await Promise.all([
    a.channel.sendWithId(1, "Runtime.evaluate", { expression: "'A'", returnByValue: true }, a.sessionId),
    b.channel.sendWithId(1, "Runtime.evaluate", { expression: "'B'", returnByValue: true }, b.sessionId),
  ]);
  assert.equal(ra.id, 1);
  assert.equal(rb.id, 1);
  assert.equal(ra.result.result.value, "A");
  assert.equal(rb.result.result.value, "B");

  // A 에서만 이동을 일으킨다. 그 이벤트는 B 로 가지 않는다.
  await a.channel.call("Page.navigate", { url: "about:blank#a" }, a.sessionId);
  await waitFor(() => a.channel.events.length > 0);
  assert.ok(a.channel.events.length > 0, "A 가 자기 이벤트를 못 받았다");
  assert.equal(
    b.channel.events.some((event) => event.sessionId === a.sessionId),
    false,
    "A 의 이벤트가 B 로 샜다",
  );
  await live.stop();
});
