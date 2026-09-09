// #582 S2d — CDP 중계 정책표 (계약 4.3.2).
//
// **정책은 코드가 아니라 데이터다.** 메서드 이름 하나하나가 열쇠이고, 접두사도 와일드카드도
// 없다. `Target.` 을 통째로 허용하면 `Target.sendMessageToTarget` 하나로 행렬 전체가 무효가
// 된다(2차 리뷰의 P0). 목록에 없는 메서드는 거부다.
//
// 등급(scope)은 "무엇을 확인해야 통과하는가"다.
//
//  deny            어떤 인자로도 통과하지 않는다.
//  supervisor-only 감독자만 부를 수 있다. 연결에는 노출하지 않는다(장부·컨텍스트·detach).
//  context         현재 작업 공간의 브라우저 컨텍스트로 **인자를 재작성**해서 통과시킨다.
//                  다른 컨텍스트를 지정하면 EGO_CONTEXT_MISMATCH.
//  session         최상위 sessionId 가 그 연결의 장부에 있어야 통과한다.
//  operation       세션 소유에 더해 작업·자원(requestId·objectId·GUID·스트림 핸들) 결속이
//                  필요하다. 이번 슬라이스는 **세션 소유까지** 강제하고 자원 결속은 S2e 의
//                  작업 장부가 생기면 붙도록 훅 자리(`operationHook`)를 비워 뒀다.
//  target-ledger   타깃이 이 연결의 장부에 있어야 하고, 결과·이벤트도 장부로 걸러진다.
//
// 표의 각 항목은 `{scope, args?, session?}` 이다.
//  - `args(params, ctx)` 는 **인자 제약이자 재작성기**다. `{ok:true, params}` 또는
//    `{ok:false, code, message}` 를 돌려준다. 하나의 함수로 둔 이유: 컨텍스트 강제는
//    "검사"와 "재작성"이 같은 판단이라 둘로 나누면 한쪽만 적용되는 구멍이 생긴다.
//  - `session:false` 는 세션이 없는 브라우저 수준 작업 메서드다(`Browser.cancelDownload`,
//    `IO.read/close`). 이들에 세션을 요구하면 취소 훅(계약 4.7)이 아예 못 돈다.
import { CODES } from "../errors.mjs";

export const SCOPES = Object.freeze([
  "deny",
  "supervisor-only",
  "context",
  "session",
  "operation",
  "target-ledger",
]);

export const CONTEXT_MISMATCH = "EGO_CONTEXT_MISMATCH";

/** 다른 컨텍스트를 지정했을 때의 거부. 컨텍스트를 안 쓰면 우리 것으로 채워 넣는다. */
function enforceContext(params, ctx, { field = "browserContextId" } = {}) {
  const given = params?.[field];
  if (!ctx.browserContextId) {
    return {
      ok: false,
      code: CODES.NO_TASK_SPACE,
      message:
        "이 연결에는 격리 컨텍스트를 가진 작업 공간이 없다. " +
        "taskSpaces.useOrCreate(name) 을 먼저 부른다(#582 계약 4.3.2).",
    };
  }
  if (typeof given === "string" && given !== ctx.browserContextId) {
    return {
      ok: false,
      code: CONTEXT_MISMATCH,
      message:
        `다른 브라우저 컨텍스트(${given})를 지정할 수 없다. 작업 공간의 컨텍스트 안에서만 ` +
        "돈다(#582 계약 4.3.2).",
    };
  }
  return { ok: true, params: { ...params, [field]: ctx.browserContextId } };
}

/**
 * 다운로드 경로 재작성. `Browser.setDownloadBehavior` 와 `Page.setDownloadBehavior` **둘 다**
 * 여기를 지난다. 어느 한쪽만 막으면 다른 쪽으로 우회된다(계약 4.3.2).
 */
function rewriteDownloadPath(params, ctx, { withContext }) {
  if (!ctx.downloadPath) {
    return {
      ok: false,
      code: CODES.NO_TASK_SPACE,
      message: "다운로드 경로를 정하려면 작업 공간이 먼저 있어야 한다",
    };
  }
  const next = { ...params, downloadPath: ctx.downloadPath };
  if (!withContext) return { ok: true, params: next };
  return enforceContext(next, ctx);
}

/**
 * 정책표. 키는 **정확한 메서드 이름**이다.
 * 벤더 런타임이 실제로 부르는 메서드(scripts/scan-cdp-methods.mjs)가 여기 없으면
 * 테스트 수집 단계에서 실패한다 — 표가 소스보다 낡는 것을 그렇게 막는다.
 */
export const POLICY = Object.freeze({
  // ── 거부 (계약 4.3.2 "거부" 행) ──────────────────────────────────────────
  // 자식 auto-attach 는 쓰지 않는다. 켜지면 예기치 않은 자식 세션이 장부 밖에서 생긴다.
  "Target.setAutoAttach": { scope: "deny" },
  // 브라우저 타깃에 붙으면 그 위에서 아무 브라우저 수준 명령이나 돈다 = 행렬 우회.
  "Target.attachToBrowserTarget": { scope: "deny" },
  // 봉투 안에 든 메서드는 우리가 못 본다. 도메인 허용 목록을 통째로 우회하는 통로다.
  "Target.sendMessageToTarget": { scope: "deny" },
  "Target.exposeDevToolsProtocol": { scope: "deny" },
  // 인증서 예외의 공유 범위는 검증하지 않기로 양보했다(계약 10절). 그래서 명령을 막는다.
  "Security.setIgnoreCertificateErrors": { scope: "deny" },
  // 브라우저 전역 파괴. 다른 공간의 쿠키·캐시까지 지운다.
  "Network.clearBrowserCookies": { scope: "deny" },
  "Network.clearBrowserCache": { scope: "deny" },
  // 임의 호스트 경로를 페이지에 올린다. 파일 업로드는 이번 범위에서 미지원이다.
  "DOM.setFileInputFiles": { scope: "deny" },
  "Page.crash": { scope: "deny" },

  // ── 감독자 전용 (연결 비노출) ────────────────────────────────────────────
  "Target.createBrowserContext": { scope: "supervisor-only" },
  "Target.disposeBrowserContext": { scope: "supervisor-only" },
  "Target.getBrowserContexts": { scope: "supervisor-only" },
  "Target.detachFromTarget": { scope: "supervisor-only" },
  "Runtime.runIfWaitingForDebugger": { scope: "supervisor-only" },
  "Browser.close": { scope: "supervisor-only" },

  // ── 컨텍스트 강제 ────────────────────────────────────────────────────────
  "Target.createTarget": { scope: "context", args: (params, ctx) => enforceContext(params, ctx) },
  "Browser.setDownloadBehavior": {
    scope: "context",
    args: (params, ctx) => rewriteDownloadPath(params, ctx, { withContext: true }),
  },
  // Page 쪽은 세션 위에서 돌아 컨텍스트 인자가 없다. 경로만 재작성한다.
  "Page.setDownloadBehavior": {
    scope: "context",
    session: true,
    args: (params, ctx) => rewriteDownloadPath(params, ctx, { withContext: false }),
  },
  "Storage.getCookies": { scope: "context", args: (params, ctx) => enforceContext(params, ctx) },
  "Storage.setCookies": { scope: "context", args: (params, ctx) => enforceContext(params, ctx) },
  "Storage.clearCookies": { scope: "context", args: (params, ctx) => enforceContext(params, ctx) },
  // 컨텍스트를 안 주면 브라우저 전역이 지워진다. 그래서 항상 우리 컨텍스트를 채운다.
  "Storage.clearDataForOrigin": {
    scope: "context",
    args: (params, ctx) => enforceContext(params, ctx),
  },
  "Browser.grantPermissions": { scope: "context", args: (params, ctx) => enforceContext(params, ctx) },
  "Browser.resetPermissions": { scope: "context", args: (params, ctx) => enforceContext(params, ctx) },

  // ── 세션 소유 강제 ───────────────────────────────────────────────────────
  "Page.enable": { scope: "session" },
  "Page.disable": { scope: "session" },
  "Page.navigate": { scope: "session" },
  "Page.reload": { scope: "session" },
  "Page.stopLoading": { scope: "session" },
  "Page.getFrameTree": { scope: "session" },
  "Page.getLayoutMetrics": { scope: "session" },
  "Page.captureScreenshot": { scope: "session" },
  "Page.startScreencast": { scope: "session" },
  "Page.stopScreencast": { scope: "session" },
  "Page.handleJavaScriptDialog": { scope: "session" },
  "Runtime.enable": { scope: "session" },
  "Runtime.disable": { scope: "session" },
  "Runtime.evaluate": { scope: "session" },
  "DOM.enable": { scope: "session" },
  "DOM.getDocument": { scope: "session" },
  "DOM.querySelector": { scope: "session" },
  "DOM.querySelectorAll": { scope: "session" },
  "DOM.describeNode": { scope: "session" },
  "DOM.resolveNode": { scope: "session" },
  "DOM.getBoxModel": { scope: "session" },
  "Accessibility.enable": { scope: "session" },
  "Accessibility.getFullAXTree": { scope: "session" },
  "Accessibility.getPartialAXTree": { scope: "session" },
  "Input.dispatchKeyEvent": { scope: "session" },
  "Input.dispatchMouseEvent": { scope: "session" },
  "Input.insertText": { scope: "session" },
  "Network.enable": { scope: "session" },
  "Network.disable": { scope: "session" },
  "Network.setCookie": { scope: "session" },
  "Fetch.enable": { scope: "session" },
  "Fetch.disable": { scope: "session" },
  "Emulation.setDeviceMetricsOverride": { scope: "session" },
  "Emulation.clearDeviceMetricsOverride": { scope: "session" },
  "Emulation.setEmulatedMedia": { scope: "session" },

  // ── 작업·자원 소유 강제 (자원 결속은 S2e) ────────────────────────────────
  // requestId 는 그 작업이 연 요청이어야 한다. 지금은 세션 소유까지.
  "Network.getResponseBody": { scope: "operation" },
  // params.sessionId 는 **세션이 아니라 프레임 토큰**이다(계약 4.3.1). 장부 조회를 하지 않는다.
  "Page.screencastFrameAck": { scope: "operation" },
  // objectId 는 그 작업이 만든 원격 객체여야 한다. 지금은 세션 소유까지.
  "Runtime.callFunctionOn": { scope: "operation" },
  "Runtime.releaseObject": { scope: "operation" },
  // 세션 전체에 작용한다. 같은 세션에 다른 작업이 없을 때만 부르는 것은 S2e 의 배타 슬롯이 든다.
  "Runtime.terminateExecution": { scope: "operation" },
  "Fetch.failRequest": { scope: "operation" },
  "Fetch.fulfillRequest": { scope: "operation" },
  "Fetch.continueRequest": { scope: "operation" },
  "Fetch.continueWithAuth": { scope: "operation" },
  // 아래 셋은 브라우저 수준이라 세션이 없다. GUID·핸들 결속이 S2e 에서 붙는다.
  "Browser.cancelDownload": { scope: "operation", session: false },
  "IO.read": { scope: "operation", session: false },
  "IO.close": { scope: "operation", session: false },

  // ── Target 장부 ──────────────────────────────────────────────────────────
  "Target.getTargets": { scope: "target-ledger" },
  "Target.attachToTarget": {
    scope: "target-ledger",
    args: (params) =>
      params?.flatten === true
        ? { ok: true, params }
        : {
            ok: false,
            code: CODES.METHOD_DENIED,
            // 비 flatten 첨부는 sendMessageToTarget 봉투 경로를 되살린다(계약 4.3.2).
            message: "flatten:true 없는 attachToTarget 은 지원하지 않는다(#582 계약 4.3.2).",
          },
  },
  "Target.activateTarget": { scope: "target-ledger" },
  "Target.closeTarget": { scope: "target-ledger" },
  "Target.getTargetInfo": { scope: "target-ledger" },
});

/** 정확한 이름 조회. 접두사 매칭은 없다. */
export function policyFor(method) {
  return Object.hasOwn(POLICY, method) ? POLICY[method] : null;
}

export function methodsByScope(scope) {
  return Object.entries(POLICY)
    .filter(([, entry]) => entry.scope === scope)
    .map(([method]) => method)
    .sort();
}

/** 세션 소유를 확인해야 하는 등급인가. `session:false` 로 끌 수 있다. */
export function requiresSession(entry) {
  if (entry.session === false) return false;
  if (entry.session === true) return true;
  return entry.scope === "session" || entry.scope === "operation";
}
