// #582 S2e — 작업 장부와 취소 훅 (계약 4.3.2 "작업·자원 소유 강제", 4.4, 4.7).
//
// S2d 가 남긴 `operationHook` 자리를 이 파일이 채운다. S2d 의 작업 등급은 **세션 소유까지만**
// 강제했고, 그래서 같은 세션을 쓰는 연결이면 남이 연 `requestId`·`objectId`·다운로드 GUID 로도
// `Fetch.failRequest`·`Runtime.callFunctionOn`·`Browser.cancelDownload` 를 부를 수 있었다.
// 여기서 그 결속을 붙인다.
//
// ## 작업(operation)의 경계를 무엇으로 정했나
//
// 계약 4.4 는 작업의 상태(5상태·CAS)만 정하고 "CDP 한 통이 어느 작업의 것인가"는 정하지
// 않는다. 이 파일이 정한 규칙은 둘이다.
//
//  (1) **연결마다 뿌리 작업이 하나 있다.** 핸드셰이크의 `operationId` 가 그 id 이고, CLI
//      heredoc 하나가 곧 작업 하나라는 4.3 의 문장과 같은 뜻이다. 벤더 런타임은 작업을 모르고
//      `sendCDPMessage` 에 아무 표시도 달지 않으므로, 표시 없는 CDP 는 전부 뿌리 작업의 것이다.
//  (2) **한 연결이 작업을 더 열 수 있다.** `beginOperation` RPC 로 열고, CDP 프레임에
//      `operationId` 를 달아 그 작업의 것임을 밝힌다(우리 어댑터·테스트가 쓰는 길). 이것이
//      없으면 계약 4.7 의 "같은 세션의 다른 작업"을 실제로 만들 수 없어 무간섭을 시험할 수 없다.
//
// ## 자원 소유는 선언이 아니라 관측으로 등록된다
//
// 호출자가 "이 requestId 는 내 것"이라고 말하는 것을 믿지 않는다(계약 4.4 "권한은 호출자
// 선언을 믿지 않는다"). 응답과 이벤트가 지나갈 때 감독자가 직접 적는다.
//
//  - `Fetch.requestPaused` 이벤트의 `requestId` → 그 세션에서 Fetch 를 켠 작업(없으면 그 세션을
//    마지막으로 쓴 작업)
//  - `Network.requestWillBeSent` 의 `requestId` → 그 세션을 마지막으로 쓴 작업
//  - `Runtime.evaluate`·`Runtime.callFunctionOn` 응답의 `objectId` → 그 요청을 보낸 작업
//  - `Page.downloadWillBegin`·`Browser.downloadWillBegin` 의 `guid` → 그 세션(또는 그 프레임의
//    타깃)을 쓰는 작업. Chromium 에서 최상위 프레임의 `frameId` 는 그 타깃의 `targetId` 와 같다.
//  - `Page.screencastFrame` 의 `params.sessionId` 는 **세션이 아니라 프레임 토큰**이다
//    (계약 4.3.1). 토큰으로 등록하고 `Page.screencastFrameAck` 를 그 토큰에만 허용한다.
//  - IO 스트림 핸들을 만드는 메서드는 **정책표에 하나도 없다**(`Fetch.takeResponseBodyAsStream`,
//    `Network.takeResponseBodyForInterceptionAsStream` 둘 다 목록 밖이라 기본 거부다). 그래서
//    `IO.read`·`IO.close` 는 소유할 핸들이 생길 수 없고 언제나 거부된다. 등록 통로는 남겨 둔다 —
//    나중에 스트림 메서드가 정책표에 들어오면 그날 결속이 이미 있어야 한다.
//
// ## 세션당 배타 슬롯 (계약 4.7 "평가")
//
// `Runtime.terminateExecution` 은 세션 전체의 실행을 끊는다. 그래서 이동·평가는 세션당 한 번에
// 하나만 돈다. 두 번째는 **기다리지 않고 형식 있는 오류**(`EGO_SESSION_SLOT_BUSY`)로 거부한다.
// 기다리게 하면 취소·deadline 이 그 대기까지 책임져야 하고, 대기 중인 요청은 런타임의 15초
// 타이머를 그냥 태운다(ABI 1). 거부는 호출자가 즉시 알고 재시도할 수 있다.
// 같은 작업이 다시 부르는 것은 막지 않는다(재진입 계수) — 한 작업 안의 연속 평가는 정상이다.
import { CODES } from "../errors.mjs";

/** 작업 하나가 들 수 있는 자원 수 상한. 넘으면 오래된 것부터 버린다(메모리 상한). */
export const MAX_TRACKED_PER_KIND = 4096;

/** 자원 종류. 오류 문구가 종류 이름을 그대로 쓴다. */
export const RESOURCE_KINDS = Object.freeze([
  "requestIds",
  "objectIds",
  "downloads",
  "streams",
  "frameTokens",
]);

/** 배타 슬롯을 잡는 메서드 (계약 4.7 "이동·평가"). */
export const EXCLUSIVE_SLOT_METHODS = new Set([
  "Page.navigate",
  "Page.reload",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
]);

/** 도메인 참조 횟수를 세는 메서드. 값은 `[도메인, +1|-1]`. */
const DOMAIN_METHODS = new Map([
  ["Fetch.enable", ["Fetch", 1]],
  ["Fetch.disable", ["Fetch", -1]],
  ["Network.enable", ["Network", 1]],
  ["Network.disable", ["Network", -1]],
]);

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function addCapped(set, value) {
  if (value === undefined || value === null) return;
  if (set.size >= MAX_TRACKED_PER_KIND) {
    const oldest = set.keys().next().value;
    set.delete(oldest);
  }
  if (set instanceof Map) set.set(value, null);
  else set.add(value);
}

/**
 * 자원과 **그 자원이 사는 세션**을 함께 적는다.
 * `Fetch.failRequest`·`Runtime.releaseObject` 는 그 세션 위에서만 도는 명령이라, 세션을 잃으면
 * 취소 훅이 브라우저 수준으로 보내고 "Fetch domain not enabled" 로 조용히 실패한다.
 */
function addCappedWithSession(map, value, sessionId) {
  if (value === undefined || value === null) return;
  if (!map.has(value) && map.size >= MAX_TRACKED_PER_KIND) {
    map.delete(map.keys().next().value);
  }
  map.set(value, sessionId ?? null);
}

/**
 * 작업 장부 하나.
 *
 * @param {object} options
 * @param {(method:string, params?:object, sessionId?:string)=>Promise<object>} options.hostRequest
 *   **감독자 전용** CDP 통로. 취소 훅의 정리 명령은 전부 이 통로로 나간다 — 연결이 이미 죽었을
 *   때도 정리는 돌아야 하고, 정리 자체가 정책 판정을 다시 받을 이유가 없다.
 * @param {object} options.ledger 타깃·세션 장부(S2c)
 * @param {(message:string)=>void} [options.log]
 */
export function createOperations({ hostRequest = null, ledger = null, log = () => {} } = {}) {
  /** operationId -> op */
  const operations = new Map();
  /** sessionId -> [operationId...] — 마지막 원소가 그 세션을 가장 최근에 쓴 작업이다. */
  const sessionUsers = new Map();
  /** sessionId -> {operationId, depth} — 이동·평가 배타 슬롯 */
  const slots = new Map();
  /** `${domain}:${sessionId}` -> Set<operationId> — 도메인 참조 횟수 */
  const domainRefs = new Map();
  /** targetId -> operationId — 다운로드 GUID 를 프레임으로만 만났을 때의 귀속처 */
  const targetUsers = new Map();
  /** 취소·만료가 in-flight 요청을 끊을 때 부르는 콜백(감독자가 mux 에 연결한다). */
  const rejectors = new Set();
  /** 시험용 관측: 취소 장벽 뒤에 버린 이벤트 */
  const droppedAfterBarrier = [];

  function nowMs() {
    return Date.now();
  }

  function newOperation({ id, connection = null, deadlineAt = null }) {
    return {
      id,
      connection,
      status: "running",
      failureReason: null,
      startedAt: nowMs(),
      deadlineAt,
      timer: null,
      /** 이 작업이 attach 해서 **만든** 세션. detach 대상 판정이 이 집합이다. */
      createdSessions: new Set(),
      /** 이 작업이 건드린 세션(만든 것 포함). 취소 훅의 stopLoading·terminate 대상. */
      usedSessions: new Set(),
      /** requestId -> sessionId (그 요청을 가로챈 세션) */
      requestIds: new Map(),
      /** objectId -> sessionId (그 원격 객체가 사는 세션) */
      objectIds: new Map(),
      downloads: new Set(),
      streams: new Set(),
      frameTokens: new Set(),
      /** `${domain}:${sessionId}` */
      domains: new Set(),
      evidence: [],
      cleanup: null,
    };
  }

  function isRunning(op) {
    return op != null && op.status === "running";
  }

  function useSession(op, sessionId) {
    if (!sessionId) return;
    op.usedSessions.add(sessionId);
    const users = sessionUsers.get(sessionId) ?? [];
    const at = users.indexOf(op.id);
    if (at >= 0) users.splice(at, 1);
    users.push(op.id);
    sessionUsers.set(sessionId, users);
    const record = ledger?.sessionRecord?.(sessionId);
    if (record?.targetId) targetUsers.set(record.targetId, op.id);
  }

  /** 그 세션을 가장 최근에 쓴 **살아 있는** 작업. */
  function lastUserOf(sessionId) {
    const users = sessionUsers.get(sessionId);
    if (!users) return null;
    for (let i = users.length - 1; i >= 0; i -= 1) {
      const op = operations.get(users[i]);
      if (op && op.status === "running") return op;
    }
    return null;
  }

  function domainKey(domain, sessionId) {
    return `${domain}:${sessionId}`;
  }

  function domainHolders(domain, sessionId) {
    return domainRefs.get(domainKey(domain, sessionId)) ?? new Set();
  }

  function addDomainRef(op, domain, sessionId) {
    const key = domainKey(domain, sessionId);
    const holders = domainRefs.get(key) ?? new Set();
    holders.add(op.id);
    domainRefs.set(key, holders);
    op.domains.add(key);
  }

  function dropDomainRef(op, key) {
    const holders = domainRefs.get(key);
    if (!holders) return 0;
    holders.delete(op.id);
    if (holders.size === 0) domainRefs.delete(key);
    op.domains.delete(key);
    return holders.size;
  }

  function releaseSlotsOf(op) {
    for (const [sessionId, slot] of [...slots]) {
      if (slot.operationId === op.id) slots.delete(sessionId);
    }
  }

  // ── 판정 훅 ────────────────────────────────────────────────────────────────

  function deny(code, message) {
    return { ok: false, code, message };
  }

  function ownershipDenial(kind, method, value) {
    return deny(
      CODES.RESOURCE_NOT_OWNED,
      `${method} 는 이 작업이 소유한 ${kind} 에만 쓸 수 있다. ${JSON.stringify(value ?? null)} 는 ` +
        "이 작업이 연 것이 아니다(#582 계약 4.3.2 작업·자원 소유 강제).",
    );
  }

  /**
   * 중계기가 부르는 훅. **허용된 모든 메서드**가 여기를 지난다(S2d 는 작업 등급만 지나게
   * 했는데, 이동·평가의 배타 슬롯과 도메인 참조 횟수는 세션 등급 메서드에 걸린다).
   *
   * @param {string} method
   * @param {object} params
   * @param {object} ctx `{connection, workspace, sessionId, operationId}`
   */
  function hook(method, params = {}, ctx = {}) {
    const sessionId = ctx.sessionId ?? null;
    const op = operations.get(ctx.operationId);
    if (!op) {
      return deny(
        CODES.OPERATION_NOT_FOUND,
        `작업 ${JSON.stringify(ctx.operationId ?? null)} 를 장부에서 찾지 못했다. ` +
          "감독자는 작업에 결속되지 않은 CDP 를 중계하지 않는다(#582 계약 4.4).",
      );
    }
    if (op.connection && ctx.connection && op.connection !== ctx.connection) {
      // 남의 작업 id 를 달아 보내는 길을 막는다. 작업은 연결에 결박된다.
      return deny(
        CODES.OPERATION_NOT_FOUND,
        `작업 ${op.id} 는 이 연결의 것이 아니다(#582 계약 4.4).`,
      );
    }
    if (!isRunning(op)) {
      const code =
        op.failureReason === "timeout" ? CODES.OPERATION_TIMEOUT : CODES.OPERATION_CANCELLED;
      return deny(
        code,
        `작업 ${op.id} 는 이미 ${op.status}(${op.failureReason ?? "-"}) 다. 종결된 작업의 CDP 는 ` +
          "중계하지 않는다(#582 계약 4.7 취소 장벽).",
      );
    }

    // 자원 결속 — 소유하지 않은 것을 지목하면 거부다.
    switch (method) {
      case "Fetch.failRequest":
      case "Fetch.fulfillRequest":
      case "Fetch.continueRequest":
      case "Fetch.continueWithAuth":
      case "Network.getResponseBody":
        if (!op.requestIds.has(params?.requestId)) {
          return ownershipDenial("requestId", method, params?.requestId);
        }
        break;
      case "Runtime.callFunctionOn":
      case "Runtime.releaseObject":
        if (!op.objectIds.has(params?.objectId)) {
          return ownershipDenial("objectId", method, params?.objectId);
        }
        break;
      case "Browser.cancelDownload":
        if (!op.downloads.has(params?.guid)) {
          return ownershipDenial("다운로드 GUID", method, params?.guid);
        }
        break;
      case "IO.read":
      case "IO.close":
        if (!op.streams.has(params?.handle)) {
          return ownershipDenial("IO 스트림 핸들", method, params?.handle);
        }
        break;
      case "Page.screencastFrameAck":
        // 여기서만 `params.sessionId` 는 프레임 토큰이다(계약 4.3.1). 장부 조회를 하지 않는다.
        if (!op.frameTokens.has(params?.sessionId)) {
          return ownershipDenial("screencast 프레임 토큰", method, params?.sessionId);
        }
        break;
      case "Runtime.terminateExecution": {
        const slot = sessionId ? slots.get(sessionId) : null;
        if (slot && slot.operationId !== op.id) {
          return deny(
            CODES.SESSION_SLOT_BUSY,
            `세션 ${sessionId} 에서 다른 작업(${slot.operationId})이 이동·평가 중이다. ` +
              "Runtime.terminateExecution 은 세션 전체를 끊으므로 그 작업이 끝난 뒤에만 부른다" +
              "(#582 계약 4.7).",
          );
        }
        break;
      }
      default:
        break;
    }

    // 도메인 참조 횟수 (계약 4.7 "Fetch.disable·Network.disable 은 참조 0 일 때만")
    const domain = DOMAIN_METHODS.get(method);
    if (domain && sessionId) {
      const [name, delta] = domain;
      if (delta < 0) {
        const holders = domainHolders(name, sessionId);
        const others = [...holders].filter((id) => id !== op.id);
        if (others.length > 0) {
          return deny(
            CODES.DOMAIN_IN_USE,
            `${method} 는 세션 ${sessionId} 에서 ${name} 도메인을 쓰는 다른 작업(${others.join(", ")})이 ` +
              "있는 동안에는 부를 수 없다. 참조 횟수가 0 일 때만 끈다(#582 계약 4.7).",
          );
        }
      }
    }

    // 배타 슬롯 — 판정과 획득이 같은 동기 구간에 있어야 두 요청이 같은 tick 에 들어와도 안 겹친다.
    let tookSlot = false;
    if (EXCLUSIVE_SLOT_METHODS.has(method) && sessionId) {
      const slot = slots.get(sessionId);
      if (slot && slot.operationId !== op.id) {
        return deny(
          CODES.SESSION_SLOT_BUSY,
          `세션 ${sessionId} 의 이동·평가 슬롯을 다른 작업(${slot.operationId})이 쓰고 있다. ` +
            "같은 세션에서 이동·평가는 한 번에 하나다(#582 계약 4.7). 기다리지 않고 거부한다.",
        );
      }
      slots.set(sessionId, { operationId: op.id, depth: (slot?.depth ?? 0) + 1 });
      tookSlot = true;
    }

    if (domain && sessionId) {
      const [name, delta] = domain;
      if (delta > 0) addDomainRef(op, name, sessionId);
      else dropDomainRef(op, domainKey(name, sessionId));
    }

    useSession(op, sessionId);
    return { ok: true, operationId: op.id, tookSlot };
  }

  // ── 관측 등록 ──────────────────────────────────────────────────────────────

  /** mux 가 요청 하나를 끝냈다(응답·상한·송신 실패). 슬롯을 놓고 결과에서 자원을 적는다. */
  function settled(entry, data) {
    if (!entry) return;
    if (entry.tookSlot && entry.sessionId) {
      const slot = slots.get(entry.sessionId);
      if (slot && slot.operationId === entry.operationId) {
        if (slot.depth <= 1) slots.delete(entry.sessionId);
        else slots.set(entry.sessionId, { ...slot, depth: slot.depth - 1 });
      }
    }
    const op = operations.get(entry.operationId);
    if (!op || !data) return;
    const result = data.result ?? {};
    if (entry.method === "Runtime.evaluate" || entry.method === "Runtime.callFunctionOn") {
      const objectId = result?.result?.objectId;
      if (typeof objectId === "string") addCappedWithSession(op.objectIds, objectId, entry.sessionId);
      const exceptionObject = result?.exceptionDetails?.exception?.objectId;
      if (typeof exceptionObject === "string") {
        addCappedWithSession(op.objectIds, exceptionObject, entry.sessionId);
      }
    }
    if (entry.method === "DOM.resolveNode") {
      // 스냅샷의 ref 로 실제 요소를 잡는 유일한 길이다. 여기서 등록하지 않으면 바로 뒤의
      // `Runtime.callFunctionOn` 이 "소유하지 않은 objectId" 로 거부된다.
      const objectId = result?.object?.objectId;
      if (typeof objectId === "string") addCappedWithSession(op.objectIds, objectId, entry.sessionId);
    }
    if (entry.method === "Target.attachToTarget" && typeof result.sessionId === "string") {
      op.createdSessions.add(result.sessionId);
      useSession(op, result.sessionId);
    }
    // 스트림 핸들을 만드는 메서드는 지금 정책표에 없다. 통로만 둔다(파일 머리 주석).
    if (typeof result.stream === "string") addCapped(op.streams, result.stream);
  }

  /**
   * 이벤트 하나. 자원을 등록하고, **취소 장벽 뒤에 그 작업에 결속된 이벤트**는 버린다.
   * @returns {boolean} 이 이벤트를 연결에 전달해도 되는가
   */
  function event(data) {
    const sessionId = typeof data?.sessionId === "string" ? data.sessionId : null;
    const method = data?.method;
    let owner = sessionId ? lastUserOf(sessionId) : null;

    if (method === "Fetch.requestPaused" && sessionId) {
      const holders = [...domainHolders("Fetch", sessionId)];
      const holder = holders.map((id) => operations.get(id)).find((op) => isRunning(op));
      const target = holder ?? owner;
      if (target) {
        addCappedWithSession(target.requestIds, data.params?.requestId, sessionId);
        owner = target;
      }
    } else if (
      (method === "Network.requestWillBeSent" || method === "Network.responseReceived") &&
      owner
    ) {
      addCappedWithSession(owner.requestIds, data.params?.requestId, sessionId);
    } else if (method === "Page.screencastFrame" && owner) {
      // params.sessionId 는 프레임 토큰이다(계약 4.3.1). 세션으로 읽지 않는다.
      addCapped(owner.frameTokens, data.params?.sessionId);
    } else if (method === "Page.downloadWillBegin" && owner) {
      addCapped(owner.downloads, data.params?.guid);
    } else if (method === "Browser.downloadWillBegin") {
      // 브라우저 수준 이벤트라 최상위 sessionId 가 없다. Chromium 에서 최상위 프레임의
      // frameId 는 그 타깃의 targetId 와 같으므로 그 타깃을 쓰던 작업에 귀속한다.
      const frameId = data.params?.frameId;
      const opId = frameId ? targetUsers.get(frameId) : null;
      const target = opId ? operations.get(opId) : null;
      if (target && isRunning(target)) {
        addCapped(target.downloads, data.params?.guid);
        owner = target;
      }
    }

    if (owner && !isRunning(owner)) {
      droppedAfterBarrier.push({ method, operationId: owner.id });
      return false;
    }
    return true;
  }

  // ── 취소·정리 (계약 4.7) ───────────────────────────────────────────────────

  async function call(method, params, sessionId) {
    if (!hostRequest) return { skipped: true };
    try {
      return await hostRequest(method, params, sessionId);
    } catch (error) {
      log(`정리 명령 실패(무시): ${method} — ${error.message}`);
      return { failed: error.message };
    }
  }

  /**
   * 취소 훅 본체. **작업보다 넓은 상태를 파괴하지 않는다**(계약 4.7).
   * 만료(deadline)와 취소가 같은 정리를 쓴다 — 다른 정리를 쓰면 둘 중 하나만 시험된다.
   */
  async function cleanupOperation(op) {
    const done = {
      stopLoading: [],
      failedRequests: [],
      disabledDomains: [],
      cancelledDownloads: [],
      closedStreams: [],
      terminated: [],
      detachedSessions: [],
      releasedObjects: [],
    };

    // 1) Fetch 가로채기 — 소유한 requestId 만, 그 요청을 가로챈 **세션 위에서** 실패시킨다.
    //
    // 계약 4.7 은 이동을 먼저 적지만 순서는 **가로채기가 먼저**여야 한다. `Page.stopLoading`
    // 이 먼저 나가면 멈춰 있던 요청이 그 자리에서 사라지고, 뒤따르는 `Fetch.failRequest` 는
    // "Invalid InterceptionId" 로 실패한다. 실측으로 확인한 순서다(S2e 증거).
    for (const [requestId, sessionId] of op.requestIds) {
      if (sessionId && ledger?.isTombstoned?.(sessionId)) continue;
      const result = await call(
        "Fetch.failRequest",
        { requestId, errorReason: "Aborted" },
        sessionId ?? undefined,
      );
      if (!result?.failed) done.failedRequests.push(requestId);
    }
    op.requestIds.clear();

    // 2) 이동 — 그 작업이 쓴 세션에서만 멈춘다.
    for (const sessionId of op.usedSessions) {
      if (ledger?.isTombstoned?.(sessionId)) continue;
      await call("Page.stopLoading", {}, sessionId);
      done.stopLoading.push(sessionId);
    }

    // 3) 다운로드 — 소유한 GUID 만.
    for (const guid of op.downloads) {
      await call("Browser.cancelDownload", { guid });
      done.cancelledDownloads.push(guid);
    }
    op.downloads.clear();

    // 4) IO 스트림 — 소유한 핸들만.
    for (const handle of op.streams) {
      await call("IO.close", { handle });
      done.closedStreams.push(handle);
    }
    op.streams.clear();

    // 5) 평가 — 배타 슬롯이 비었거나 내 것일 때만 세션 실행을 끊는다.
    for (const sessionId of op.usedSessions) {
      if (ledger?.isTombstoned?.(sessionId)) continue;
      const slot = slots.get(sessionId);
      if (slot && slot.operationId !== op.id) continue;
      await call("Runtime.terminateExecution", {}, sessionId);
      done.terminated.push(sessionId);
    }

    // 6) 원격 객체 해제 — 그 객체가 사는 세션 위에서. 세션을 놓기 전에 한다.
    for (const [objectId, sessionId] of op.objectIds) {
      if (!sessionId || ledger?.isTombstoned?.(sessionId)) continue;
      await call("Runtime.releaseObject", { objectId }, sessionId);
      done.releasedObjects.push(objectId);
    }
    op.objectIds.clear();

    // 7) 도메인 — 참조 횟수가 0 이 될 때만 끈다.
    for (const key of [...op.domains]) {
      const remaining = dropDomainRef(op, key);
      if (remaining > 0) continue;
      const at = key.indexOf(":");
      const domain = key.slice(0, at);
      const sessionId = key.slice(at + 1);
      if (ledger?.isTombstoned?.(sessionId)) continue;
      await call(`${domain}.disable`, {}, sessionId);
      done.disabledDomains.push(key);
    }

    // 8) 세션 — **그 작업이 만든** 세션이고 다른 작업이 안 쓰는 것만 detach.
    for (const sessionId of op.createdSessions) {
      const users = (sessionUsers.get(sessionId) ?? []).filter((id) => {
        const other = operations.get(id);
        return id !== op.id && other && other.status === "running";
      });
      if (users.length > 0) continue;
      if (!ledger?.isTombstoned?.(sessionId)) {
        await call("Target.detachFromTarget", { sessionId });
      }
      ledger?.dropSession?.(sessionId);
      done.detachedSessions.push(sessionId);
    }

    for (const sessionId of [...op.usedSessions]) {
      const users = (sessionUsers.get(sessionId) ?? []).filter((id) => id !== op.id);
      if (users.length === 0) sessionUsers.delete(sessionId);
      else sessionUsers.set(sessionId, users);
    }
    releaseSlotsOf(op);
    op.usedSessions.clear();
    op.createdSessions.clear();
    op.frameTokens.clear();
    op.cleanup = done;
    return done;
  }

  /** 종결은 CAS 다. 먼저 종결한 쪽이 남는다(계약 4.4). */
  function settle(op, status, reason = null) {
    if (!op || TERMINAL.has(op.status)) return false;
    op.status = status;
    op.failureReason = reason;
    if (op.timer) {
      clearTimeout(op.timer);
      op.timer = null;
    }
    return true;
  }

  function rejectPending(operationId, code, message) {
    for (const reject of rejectors) reject(operationId, code, message);
  }

  async function finish(op, status, reason, { code, message }) {
    const first = settle(op, status, reason);
    if (!first) return { changed: false, status: op.status, cleanup: op.cleanup };
    // 판정을 먼저 바꾸고(그래야 뒤따라 오는 CDP 가 장벽에 걸린다) 그 다음 정리한다.
    rejectPending(op.id, code, message);
    const cleanup = await cleanupOperation(op);
    return { changed: true, status: op.status, cleanup };
  }

  return {
    // ── 수명 ────────────────────────────────────────────────────────────────
    /**
     * 작업 하나를 연다. `deadlineMs` 는 핸드셰이크 deadline 과 요청 timeoutMs 중 **짧은 쪽**을
     * 감독자가 이미 고른 값이다(계약 4.2 "짧은 쪽이 이긴다").
     */
    begin({ id, connection = null, deadlineMs = null }) {
      if (operations.has(id)) return operations.get(id);
      const op = newOperation({
        id,
        connection,
        deadlineAt: deadlineMs ? nowMs() + deadlineMs : null,
      });
      operations.set(id, op);
      if (deadlineMs) {
        op.timer = setTimeout(() => {
          finish(op, "failed", "timeout", {
            code: CODES.OPERATION_TIMEOUT,
            message:
              `작업 ${op.id} 가 시한 ${deadlineMs}ms 를 넘겼다. 취소와 같은 정리를 마쳤다` +
              "(#582 계약 4.7).",
          }).catch((error) => log(`만료 정리 실패: ${error.message}`));
        }, deadlineMs);
        op.timer.unref?.();
      }
      return op;
    },
    get(id) {
      return operations.get(id) ?? null;
    },
    list() {
      return [...operations.values()].map((op) => ({
        id: op.id,
        status: op.status,
        failureReason: op.failureReason,
        deadlineAt: op.deadlineAt,
      }));
    },
    /** 취소. 종결 상태는 CAS 라 완료와 경주하면 먼저 종결한 쪽이 남는다. */
    cancel(id, { reason = "cancelled" } = {}) {
      const op = operations.get(id);
      if (!op) {
        return Promise.resolve({ changed: false, status: "unknown", cleanup: null });
      }
      return finish(op, "cancelled", reason, {
        code: CODES.OPERATION_CANCELLED,
        message: `작업 ${id} 가 취소됐다(#582 계약 4.7).`,
      });
    },
    /** 정상 종결. 정리는 취소와 같은 훅을 쓴다 — 남긴 자원이 없어야 하는 것은 같다. */
    complete(id, { status = "completed", reason = null } = {}) {
      const op = operations.get(id);
      if (!op) return Promise.resolve({ changed: false, status: "unknown", cleanup: null });
      return finish(op, status, reason, {
        code: CODES.OPERATION_CANCELLED,
        message: `작업 ${id} 가 ${status} 로 끝났다.`,
      });
    },
    /** 연결이 사라졌다. 그 연결의 작업만 종결한다(계약 4.8 `failed(process-exit)`). */
    async detachConnection(connection) {
      const gone = [];
      for (const op of [...operations.values()]) {
        if (op.connection !== connection) continue;
        if (TERMINAL.has(op.status)) continue;
        await finish(op, "failed", "process-exit", {
          code: CODES.DISCONNECTED,
          message: `작업 ${op.id} 의 연결이 끊겼다.`,
        });
        gone.push(op.id);
      }
      return gone;
    },
    forget(id) {
      const op = operations.get(id);
      if (!op) return false;
      if (op.timer) clearTimeout(op.timer);
      operations.delete(id);
      return true;
    },

    // ── 중계기·mux 이음매 ───────────────────────────────────────────────────
    hook,
    settled,
    event,
    /** in-flight 요청을 끊는 통로. 감독자가 mux 의 것을 여기 등록한다. */
    onReject(fn) {
      rejectors.add(fn);
      return () => rejectors.delete(fn);
    },

    // ── 증거 ────────────────────────────────────────────────────────────────
    /** 캡처 파일 하나를 작업에 적는다. 파일 이름의 일련번호가 여기서 나온다. */
    nextEvidenceIndex(id) {
      const op = operations.get(id);
      if (!op) return 1;
      return op.evidence.length + 1;
    },
    recordEvidence(id, path) {
      const op = operations.get(id);
      if (op) op.evidence.push(path);
      return path;
    },
    evidenceOf(id) {
      return [...(operations.get(id)?.evidence ?? [])];
    },

    /** 시험용 관측 창. 판정에 쓰지 않는다. */
    inspect() {
      return {
        operations: [...operations.values()].map((op) => ({
          id: op.id,
          status: op.status,
          failureReason: op.failureReason,
          sessions: [...op.usedSessions],
          createdSessions: [...op.createdSessions],
          requestIds: [...op.requestIds.keys()],
          objectIds: [...op.objectIds.keys()],
          downloads: [...op.downloads],
          streams: [...op.streams],
          frameTokens: [...op.frameTokens],
          domains: [...op.domains],
          evidence: [...op.evidence],
          cleanup: op.cleanup,
        })),
        slots: [...slots.entries()].map(([sessionId, slot]) => ({ sessionId, ...slot })),
        domainRefs: [...domainRefs.entries()].map(([key, holders]) => ({
          key,
          holders: [...holders],
        })),
        droppedAfterBarrier: [...droppedAfterBarrier],
      };
    },
  };
}
