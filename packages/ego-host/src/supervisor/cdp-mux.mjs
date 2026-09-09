// #582 S2a — CDP 다중화 채널 (계약 4.2·4.3.1).
//
// 참조 구현: citrolabs/ego-lite PR #228 (커밋 4f99b181960a) 의
// `package/ego-windows-host/src/cdp-connection.ts` 에서 pending 맵·타이머·id 대조 골격을
// 가져왔다(MIT, THIRD_PARTY_NOTICES.md). **가져오지 않은 것이 더 중요하다**: #228 은
// 에이전트 연결 하나를 원문 그대로 통과시킨다(`sendRaw`). 우리는 그 설계를 쓰지 않는다.
// 연결마다 독립 id 공간을 두고 Chromium 쪽 id 만 재작성하며, 라우팅·필터·정책 훅을 통과한
// 것만 위로 올린다.
//
// 불변식 넷.
//  (1) 런타임 경계에서 id 를 보존한다. Chromium 쪽 id 만 {connection, clientId} ↔ upstreamId.
//  (2) **sessionId 는 재작성하지 않는다.** 라우팅 키는 최상위 sessionId 뿐이고, 중첩
//      params.sessionId 는 Target.attachedToTarget·detachedFromTarget 에서만 세션이다
//      (Page.screencastFrame 의 것은 Ack 용 프레임 토큰이지 세션이 아니다).
//  (3) 거부는 **원래 id 를 가진 CDP 오류 응답**이다. id 없는 통로는 연결 전체가 죽었을 때만.
//  (4) Chromium 에서 이미 받은 응답·이벤트는 단일 FIFO 순서를 유지한다.
import { CODES } from "../errors.mjs";

/** 감독자 쪽 요청 상한. 런타임의 15초(RESPONSE_TIMEOUT_MS)보다 반드시 먼저 만료해야 한다. */
export const SUPERVISOR_REQUEST_DEADLINE_MS = 13_000;

/** 런타임이 가진 상한. 우리 상한이 이보다 작다는 사실을 테스트가 읽는다. */
export const RUNTIME_RESPONSE_TIMEOUT_MS = 15_000;

/** 중첩 params.sessionId 를 세션으로 해석하는 메서드. 이 둘 말고는 세션이 아니다. */
export const NESTED_SESSION_METHODS = new Set([
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
]);

/** 기본 정책. S2d 의 `mediator-policy` 가 이 자리에 들어온다. */
function allowAll() {
  return { allow: true };
}

/**
 * @param {object} options
 * @param {{send(payload:string):void, onMessage(handler:(raw:string)=>void):void}} options.backend
 *   Chromium(또는 가짜 CDP 백엔드) 연결. S2b 가 실제 파이프 연결로 바꾼다.
 * @param {(method:string, params:object, sessionId:string|undefined, connection:object)=>{allow:boolean,message?:string,code?:string}} [options.route]
 *   장부·정책 훅. S2c(장부)·S2d(행렬)가 여기에 끼워 들어온다.
 */
export function createCdpMux({
  backend,
  route = allowAll,
  requestDeadlineMs = SUPERVISOR_REQUEST_DEADLINE_MS,
} = {}) {
  let nextUpstreamId = 1;
  /** upstreamId -> {connection, clientId, method, timer} */
  const pending = new Map();
  /** sessionId -> connection */
  const sessionOwner = new Map();
  /** targetId -> connection */
  const targetOwner = new Map();
  /** 버려진 세션. 같은 값이 재사용돼도 옛 세대의 요청·이벤트를 거부한다. */
  const tombstones = new Set();
  const dropped = [];

  function ownedSessionsOf(connection) {
    return [...sessionOwner.entries()].filter(([, c]) => c === connection).map(([s]) => s);
  }

  function errorResponse(connection, clientId, message, code) {
    connection.deliverCdp(JSON.stringify({ id: clientId, error: { message, code } }));
  }

  /** 연결이 보낸 원문 페이로드 하나. 동기적으로 판정하고 동기적으로 백엔드에 넣는다. */
  function fromClient(connection, payload) {
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      // id 를 못 읽으면 그 요청만 거부할 방법이 없다. 연결 전체가 죽은 경우로 처리한다.
      connection.deliverCdpFatal("CDP 페이로드가 JSON 이 아니다", CODES.FRAME_MALFORMED);
      return;
    }
    const clientId = data.id;
    if (typeof clientId !== "number") {
      connection.deliverCdpFatal("CDP 요청에 숫자 id 가 없다", CODES.FRAME_MALFORMED);
      return;
    }
    const method = String(data.method || "");
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;

    if (sessionId && tombstones.has(sessionId)) {
      errorResponse(connection, clientId, `Session not found: ${sessionId}`, CODES.METHOD_DENIED);
      return;
    }
    if (sessionId && sessionOwner.get(sessionId) !== connection) {
      // 남의 세션. 런타임이 재접속을 시도하도록 세션 상실 문구를 쓴다(ABI 1).
      errorResponse(connection, clientId, `Session not found: ${sessionId}`, CODES.METHOD_DENIED);
      return;
    }

    let verdict;
    try {
      verdict = route(method, data.params ?? {}, sessionId, connection) ?? { allow: true };
    } catch (error) {
      verdict = { allow: false, message: `정책 판정 실패: ${error.message}` };
    }
    if (!verdict.allow) {
      errorResponse(
        connection,
        clientId,
        verdict.message || `메서드가 거부됐다: ${method}`,
        verdict.code || CODES.METHOD_DENIED,
      );
      return;
    }

    // 예약: attach 응답이 오기 전에 도착한 이벤트도 주인이 있어야 한다(4.3.1).
    // 배타 arbitration(EGO_TARGET_BUSY)·세대·묘비는 S2c/S2d 의 장부가 route 훅으로 든다.
    if (method === "Target.attachToTarget" || method === "Target.createTarget") {
      const targetId = data.params?.targetId;
      if (typeof targetId === "string") targetOwner.set(targetId, connection);
    }

    const upstreamId = nextUpstreamId++;
    const timer = setTimeout(() => {
      pending.delete(upstreamId);
      errorResponse(
        connection,
        clientId,
        `감독자 상한 ${requestDeadlineMs}ms 를 넘겼다: ${method}`,
        CODES.DEADLINE,
      );
    }, requestDeadlineMs);
    timer.unref?.();
    pending.set(upstreamId, { connection, clientId, method, params: data.params ?? {}, timer });

    // sessionId 는 그대로 둔다. 재작성하는 것은 id 하나뿐이다.
    const rewritten = { ...data, id: upstreamId };
    try {
      backend.send(JSON.stringify(rewritten));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(upstreamId);
      errorResponse(connection, clientId, `백엔드 송신 실패: ${error.message}`, CODES.DISCONNECTED);
    }
  }

  /** 응답에서 얻은 세션·타깃 소유를 장부에 남긴다. */
  function recordFromResponse(entry, data) {
    const result = data.result || {};
    if (entry.method === "Target.attachToTarget" && typeof result.sessionId === "string") {
      sessionOwner.set(result.sessionId, entry.connection);
      tombstones.delete(result.sessionId);
      const targetId = entry.params?.targetId;
      if (typeof targetId === "string") targetOwner.set(targetId, entry.connection);
    }
    if (entry.method === "Target.createTarget" && typeof result.targetId === "string") {
      targetOwner.set(result.targetId, entry.connection);
    }
  }

  /** 이벤트의 주인. 못 찾으면 아무에게도 주지 않는다(fail-closed). */
  function ownerOfEvent(data) {
    const top = typeof data.sessionId === "string" ? data.sessionId : null;
    if (top) return sessionOwner.get(top) ?? null;
    if (NESTED_SESSION_METHODS.has(data.method)) {
      const nested = typeof data.params?.sessionId === "string" ? data.params.sessionId : null;
      if (nested && sessionOwner.has(nested)) return sessionOwner.get(nested);
    }
    const targetId =
      data.params?.targetId ?? data.params?.targetInfo?.targetId ?? null;
    if (typeof targetId === "string") return targetOwner.get(targetId) ?? null;
    return null;
  }

  /** 이벤트가 세션 장부를 바꾸는 경우. 중첩 sessionId 는 이 두 메서드에서만 세션이다. */
  function applyEventToLedger(data, owner) {
    if (data.method === "Target.attachedToTarget") {
      const child = data.params?.sessionId;
      if (typeof child === "string" && owner) {
        sessionOwner.set(child, owner);
        tombstones.delete(child);
      }
      const targetId = data.params?.targetInfo?.targetId;
      if (typeof targetId === "string" && owner) targetOwner.set(targetId, owner);
    }
    if (data.method === "Target.detachedFromTarget") {
      const gone = data.params?.sessionId ?? data.sessionId;
      if (typeof gone === "string") {
        sessionOwner.delete(gone);
        tombstones.add(gone);
      }
    }
    if (data.method === "Target.targetDestroyed") {
      const targetId = data.params?.targetId;
      if (typeof targetId === "string") targetOwner.delete(targetId);
    }
  }

  backend.onMessage((raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (Object.hasOwn(data, "id")) {
      const entry = pending.get(data.id);
      // 늦게 도착한 응답. 상한이 이미 원래 id 오류를 돌려줬으므로 조용히 버린다.
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      recordFromResponse(entry, data);
      entry.connection.deliverCdp(JSON.stringify({ ...data, id: entry.clientId }));
      return;
    }
    const owner = ownerOfEvent(data);
    applyEventToLedger(data, owner);
    if (!owner) {
      dropped.push(data.method);
      return;
    }
    owner.deliverCdp(raw);
  });

  return {
    fromClient,
    /** 감독자 자신의 CDP 요청. 연결 id 공간과 섞이지 않고 정책도 통과하지 않는다. */
    hostRequest(method, params = {}, sessionId = undefined) {
      const id = nextUpstreamId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`감독자 내부 CDP 상한 초과: ${method}`));
        }, requestDeadlineMs);
        timer.unref?.();
        pending.set(id, {
          connection: {
            deliverCdp(raw) {
              const data = JSON.parse(raw);
              if (data.error) reject(new Error(data.error.message || "CDP 오류"));
              else resolve(data.result ?? {});
            },
            deliverCdpFatal(message) {
              reject(new Error(message));
            },
          },
          clientId: id,
          method,
          params,
          timer,
        });
        try {
          backend.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    /** 연결이 사라졌다. 그 연결의 예약·세션만 걷어낸다. 다른 연결은 건드리지 않는다. */
    detach(connection) {
      for (const [upstreamId, entry] of [...pending]) {
        if (entry.connection !== connection) continue;
        clearTimeout(entry.timer);
        pending.delete(upstreamId);
      }
      for (const sessionId of ownedSessionsOf(connection)) {
        sessionOwner.delete(sessionId);
        tombstones.add(sessionId);
      }
      for (const [targetId, owner] of [...targetOwner]) {
        if (owner === connection) targetOwner.delete(targetId);
      }
    },
    claimTarget(connection, targetId) {
      targetOwner.set(targetId, connection);
    },
    releaseTarget(targetId) {
      targetOwner.delete(targetId);
    },
    /** 시험용 관측 창. 판정에 쓰지 않는다. */
    inspect() {
      return {
        pending: pending.size,
        sessions: [...sessionOwner.keys()],
        targets: [...targetOwner.keys()],
        tombstones: [...tombstones],
        droppedEvents: [...dropped],
      };
    },
  };
}
