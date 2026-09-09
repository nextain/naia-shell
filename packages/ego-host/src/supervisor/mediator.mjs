// #582 S2d — CDP 중계기 (계약 4.3.1·4.3.2).
//
// 중계기는 **판정만** 한다. 표는 `mediator-policy.mjs` 에 데이터로 있고, 장부는
// `ledger.mjs` 에 있다. 여기 있는 것은 그 둘을 CDP 한 통에 적용하는 절차뿐이다.
//
// 세 가지를 지킨다.
//
//  (1) **기본 거부**. 표에 없는 메서드는 거부다. 접두사 허용이 없으므로 업스트림이 새 메서드를
//      부르기 시작하면 소스 스캔이 테스트 수집 단계에서 먼저 실패한다(scan-cdp-methods.mjs).
//  (2) **거부는 원래 id 를 가진 CDP 오류 응답**이다. `onSendCDPMessageError` 는 쓰지 않는다 —
//      그 통로에는 id 가 없어서 한 번 부르면 그 연결의 pending 전부가 같이 죽는다(ABI 2).
//      그래서 거부당한 요청 하나만 실패하고 옆의 요청은 멀쩡하다.
//  (3) **컨텍스트 강제는 검사가 아니라 재작성**이다. 인자를 고쳐 Chromium 에 보낸다. 검사만
//      하면 인자를 비워 보내는 호출이 기본 컨텍스트로 새어 나간다.
import { mkdirSync } from "node:fs";
import { CODES } from "../errors.mjs";
import { downloadsDir } from "./ledger.mjs";
import { policyFor, requiresSession } from "./mediator-policy.mjs";

/**
 * @param {object} options
 * @param {import("./ledger.mjs").createLedger} options.ledger
 * @param {string|null} [options.adkDir]  다운로드 재작성 경로의 뿌리
 * @param {((method:string, params:object, ctx:object)=>{ok:boolean,code?:string,message?:string})|null} [options.operationHook]
 *   **S2e 자리**. 작업·자원 결속(requestId·objectId·다운로드 GUID·IO 스트림 핸들)은 작업 장부가
 *   생겨야 판정할 수 있다. 이번 슬라이스는 세션 소유까지 강제하고 이 훅을 비워 둔다.
 */
export function createMediator({ ledger, adkDir = null, operationHook = null } = {}) {
  /** workspaceId -> 만들어 둔 다운로드 디렉터리. mkdir 을 요청마다 하지 않는다. */
  const downloadDirs = new Map();

  function deny(code, message) {
    return { allow: false, code, message };
  }

  function downloadPathFor(workspace) {
    if (!adkDir || !workspace) return null;
    const cached = downloadDirs.get(workspace.id);
    if (cached) return cached;
    const dir = downloadsDir(adkDir, workspace.id);
    mkdirSync(dir, { recursive: true });
    downloadDirs.set(workspace.id, dir);
    return dir;
  }

  function contextOf(connection) {
    const workspace =
      connection.selectedSpaceId === null || connection.selectedSpaceId === undefined
        ? null
        : ledger.get(connection.selectedSpaceId);
    return {
      connection,
      workspace,
      browserContextId: workspace ? ledger.browserContextOf(workspace) : null,
      downloadPath: downloadPathFor(workspace),
      ledger,
    };
  }

  /** 타깃이 이 연결이 쓸 수 있는 것인가. 장부에 없거나 남의 공간이면 아니다. */
  function checkTarget(params, ctx) {
    const targetId = params?.targetId;
    if (typeof targetId !== "string" || targetId === "") {
      return deny(CODES.METHOD_DENIED, "targetId 없이 타깃 메서드를 부를 수 없다");
    }
    const workspace = ledger.workspaceOfTarget(targetId);
    if (!workspace) {
      return deny(
        CODES.METHOD_DENIED,
        `장부에 없는 타깃이다: ${targetId}. 감독자가 만든 탭만 다룰 수 있다(#582 계약 4.3.2).`,
      );
    }
    if (!ctx.workspace || workspace.id !== ctx.workspace.id) {
      return deny(
        CODES.METHOD_DENIED,
        `타깃 ${targetId} 는 이 연결이 고른 작업 공간의 것이 아니다(#582 계약 4.3.2).`,
      );
    }
    return null;
  }

  function route(method, params, sessionId, connection) {
    const entry = policyFor(method);
    if (!entry) {
      return deny(
        CODES.METHOD_DENIED,
        `정책표에 없는 CDP 메서드다: ${method}. 이 호스트는 목록에 있는 메서드만 중계한다 ` +
          "(#582 계약 4.3.2, 기본 거부).",
      );
    }
    if (entry.scope === "deny") {
      return deny(CODES.METHOD_DENIED, `${method} 는 거부 목록이다(#582 계약 4.3.2).`);
    }
    if (entry.scope === "supervisor-only") {
      return deny(
        CODES.METHOD_DENIED,
        `${method} 는 감독자 전용이다. 연결에는 노출하지 않는다(#582 계약 4.3.2).`,
      );
    }

    const ctx = contextOf(connection);

    if (requiresSession(entry)) {
      if (typeof sessionId !== "string" || sessionId === "") {
        return deny(
          CODES.METHOD_DENIED,
          `${method} 는 세션 위에서만 돈다. 최상위 sessionId 없이 부르면 브라우저 수준으로 ` +
            "새어 나간다(#582 계약 4.3.2).",
        );
      }
      // 소유·묘비는 장부가 판정한다. 여기서 다시 보는 이유는 정책 단계에서 같은 답이 나와야
      // 정책표만 읽고도 각 셀을 시험할 수 있기 때문이다.
      if (ledger.sessionOwner(sessionId) !== connection) {
        return deny(CODES.METHOD_DENIED, `Session not found: ${sessionId}`);
      }
    }

    if (entry.scope === "target-ledger" && method !== "Target.getTargets") {
      const denial = checkTarget(params, ctx);
      if (denial) return denial;
    }

    if (entry.scope === "operation" && operationHook) {
      const verdict = operationHook(method, params, ctx);
      if (verdict && verdict.ok === false) {
        return deny(verdict.code ?? CODES.METHOD_DENIED, verdict.message ?? `${method} 거부`);
      }
    }

    if (entry.args) {
      const verdict = entry.args(params ?? {}, ctx);
      if (!verdict.ok) return deny(verdict.code ?? CODES.METHOD_DENIED, verdict.message);
      return { allow: true, params: verdict.params };
    }
    return { allow: true };
  }

  /**
   * 결과 필터. `Target.getTargets` 는 브라우저의 모든 타깃을 준다 — 다른 공간의 탭까지.
   * 연결이 고른 공간의 것만 남긴다. 이벤트 쪽 필터는 mux 가 소유 기준으로 이미 한다.
   */
  function filterResponse(entry, data) {
    if (entry.method !== "Target.getTargets") return data;
    const infos = data?.result?.targetInfos;
    if (!Array.isArray(infos)) return data;
    const ctx = contextOf(entry.connection);
    const mine = infos.filter((info) => {
      const workspace = ledger.workspaceOfTarget(info?.targetId);
      return Boolean(workspace && ctx.workspace && workspace.id === ctx.workspace.id);
    });
    return { ...data, result: { ...data.result, targetInfos: mine } };
  }

  return { route, filterResponse };
}
