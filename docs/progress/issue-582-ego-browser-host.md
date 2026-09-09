# #582 에이전트 브라우저 호스트 — ego-lite 공개 런타임 벤더링과 #499 실제 어댑터

작성 2026-09-09. 상태: 설계 5판(Codex 4차 조건부 승인의 착수 전 조건 반영. S0 진행 중, S2 착수 가능). 부모 #499, 조사 출처 #553, 형제 #583(QA 시간·포커스 원인).
역할: 분석·설계·사후 리뷰 Fable, 계획 적대 리뷰 Codex, 구현·실행 Opus.

## 1. 한 줄 요약

에이전트가 사람의 화면과 브라우저를 건드리지 않고 웹 작업을 하도록, ego-lite 의 공개 부분(MIT 헬퍼 런타임·사이트 학습 형식·스킬 명세)을 커밋 고정으로 벤더링하고, 비공개인 브라우저 본체 자리에 일반 Chromium 을 CDP 로 붙이는 우리 감독자(supervisor)를 둔다. 이 감독자로 #499 가 비워 둔 브라우저 포트의 실제 어댑터를 채운다.

목표를 정확히 적는다. 벤더 **런타임**은 무수정으로 돌린다. **스킬 문서**는 무수정이 아니라 우리 정책(비로그인 격리, 헤드리스에서 인계 불가)에 맞춘 파생본이며, 업스트림과의 차이를 추적한다. 지원하는 헬퍼의 범위는 약속이 아니라 측정 결과로 적는다.

## 2. 조사에서 확정된 사실

| 사실 | 근거 |
|---|---|
| ego-lite 저장소에 브라우저 소스가 없다. 156개 파일 전부 Node 헬퍼·스킬·문서. 브라우저는 macOS 전용 닫힌 바이너리 | 업스트림 CONTRIBUTING "This repo does not ship the browser binary", README "separate, free download" |
| 헬퍼가 브라우저에 기대는 것은 열두 메서드가 아니라 실행 ABI 전체다(4.2) | `package/ego-browser/src/browser-runtime.ts`, `index.ts`, `run.ts`, `helpers.ts`, `env.ts` |
| 스냅샷 참조는 `{backendNodeId, role, name}` 이고 본문은 `[ref=N, loc=..., url=...]` 주석이 달린 접근성 트리 텍스트다 | `browserSnapshotRefsToRefMap`, `ref-map.ts`, SKILL.md |
| 같은 계약을 일반 Chromium/Edge 위에 구현한 커뮤니티 PR 이 있다. #228 이 런타임 무수정·헤드리스·OS 중립(1,150줄 중 OS 의존 58줄). 단, 원문 CDP 통과 설계라 격리에는 못 쓴다 | citrolabs/ego-lite PR #228, #291, #202 |
| 업스트림 런타임은 손대지 않고 이 머신(Node 26)에서 빌드되고 단위 테스트 299건이 종료 코드 0 으로 통과한다. 빌드 스크립트가 `package/ego-browser` 두 단계 위를 저장소 루트로 보고 `skills/ego-browser` 를 찾는다 | 2026-09-09 실행 |
| 셸 임베디드 브라우저는 Tauri 자식 웹뷰이며 이미 `@eN` 참조 스냅샷을 낸다. 화면 캡처는 미구현 | `packages/shell/src-tauri/src/browser_webview.rs` |
| #499 는 도메인·포트·계약 테스트까지 있고 실제 어댑터와 조립 배선이 없다. FR-ENV-TOOL.2·6·9 는 Done 이지만 포트가 페이지·이동·다운로드·이벤트를 제공하지 않고, 증거 검사가 캡처를 보지 않으며, 실제 시간 제한·재연결이 없다 | `src/main/ports/env-tool.ts`, `src/main/domain/env-tool.ts:37-59`, `docs/requirements.md:950,954,957` |
| 현재 `skill_browser_*` 는 자동 허용되어 React 에서 Tauri 명령을 직접 부르며 `EnvironmentToolService` 를 거치지 않는다 | `packages/shell/src/apps/browser/BrowserCenterArea.tsx:122-134,521-546` |
| QC 카탈로그는 브라우저 도구(QC-025, QC-059)·앱 샌드박스·워크스페이스 항목을 갖고 있고 전부 수동이다. 번호는 추가만 허용, 다음 번호 QC-206 | `scripts/qa-qc-numbers.mjs`, `qa/qc-numbers.json` |
| 벤더 런타임 `dist/out/index.js` 는 서브커맨드 없이 stdin 의 코드를 실행하고 출력 통로는 `console.log` 다(`cliLog` 전역 없음). `ego-browser nodejs --sdk-path <dist>` 는 닫힌 브라우저 앱의 실행 파일이 받는 인자이며, 그 실행 파일이 Node 를 띄워 SDK 를 실행하고 `globalThis.ego` 를 주입한다. 벤더 SKILL.md(1.2.6, 07-20)는 런타임(08-24)보다 낡아 `cliLog` 를 안내한다. `state.ts` 가 모듈 로드 시점에 `.env` 를 읽으므로 환경은 SDK import 전에 자리잡아야 한다 | S1 검증(`run.ts:55-100`, `index.ts:175-180,255-265`, `state.ts:6`) |
| 업스트림 실브라우저 e2e 러너는 `ego-browser nodejs --sdk-path <dist>` 를 부르고, 공통 전문(preamble)이 `takeOver` 를 호출하며, 전체 묶음에 인계·회수·fetch·screencast·다운로드가 들어 있다 | `scripts/real-browser-e2e/runner.mjs:18-21,58-60,82-90`, `preamble.mjs:203-251` |

ego-lite 가 말하는 "2.5배 빠름"은 에이전트가 도구를 한 번씩 부르며 왕복하는 대신 자바스크립트 한 덩어리로 여러 단계를 실행하는 방식의 이득이다. 테스트 러너 속도가 아니다. 이 문서는 속도나 시간 절감을 수치로 주장하지 않는다.

## 3. 결정

브라우저 엔진 교체가 아니다. 셸 임베디드 웹뷰는 그대로 두고, 에이전트 전용 백그라운드 브라우저를 환경 도구로 추가한다. 셸 UI 검증은 계속 wdio+tauri-driver 가 맡고, 실기 e2e 의 포커스 문제는 #583 이 다룬다.

정책 결정을 먼저 못 박는다.

1. **작업 공간은 비로그인 격리 공간이다.** 업스트림 스킬의 "사용자 로그인 상태 상속"은 온프레미스·무간섭·격리와 양립하지 않는다. 로그인이 필요한 작업은 자격증명 사용 권한(FR-ENV-TOOL.8)을 가진 별도 작업으로 나중에 설계한다.
2. **기본은 헤드리스이고, 헤드리스에서 사람 인계는 지원하지 않는다.** `handOffTaskSpace`·`takeOverTaskSpace`·`claimTaskSpace` 는 헤드리스 공간에서 원래 요청 id 를 가진 형식 있는 오류(`EGO_HANDOFF_UNSUPPORTED_HEADLESS`)로 거부한다. `agentDelegatedToUser` 와 `user` 소유 상태는 헤드리스에서 도달 불가능하다. 창이 있는 모드는 이번 범위 밖이다.
3. **Chromium 의 장기 소유자는 셸 코어가 소유한 감독자 하나다.** heredoc 마다 뜨는 CLI 는 소켓 클라이언트다. 취소·정리·장부는 감독자가 든다.
4. **진입점은 둘이고 권한 등급이 다르다.** 형식 있는 도구(`env_browser_*`)는 효과가 고정된 RPC 만 부르며 관측·워크스페이스 내부 변경 등급에서 돈다. 임의 자바스크립트 heredoc(`env_browser_script`)은 터미널 실행과 같은 등급으로 승인·샌드박스·경계를 적용하고, 승인 결과(grant)를 소켓 핸드셰이크로 감독자에 전달한다. 낮은 등급 도구가 임의 JS 로 승격되는 경로는 없다.
5. **관문 순서를 지킨다.** UC(P01)·테스트 매핑(P02)·요구사항(P03)을 코드보다 먼저 쓴다(9절 S-1).

## 4. 아키텍처

```
naia-agent(뇌) ──gRPC──▶ 셸 ──app_tool_call──▶ EnvironmentToolService (#499, 계약 보강 S0)
                                                    │ BrowserWorkspacePort · BrowserOperationPort · CancellationPort
                                                    ▼
                         src/main/adapters/ego-browser-env.ts  = 감독자 클라이언트 (S3)
                                                    │ loopback 소켓 RPC, 연결마다 핸드셰이크{operationId, workspaceId, deadline, grant}
                                                    ▼
              packages/ego-host/src/supervisor   장기 프로세스, 셸이 lease 로 소유 (S2)
              ├─ launcher(linux|win32)            Chromium --headless=new --remote-debugging-pipe, 별도 프로필
              ├─ ledger                           작업 공간·타깃·세션 장부(연결별 선택 공간), 원자적 JSON
              ├─ mediator                         method × 실행 대상 × 소유권 행렬, 기본 거부
              ├─ connections                      CLI 연결마다 독립 CDP 다중화 채널(id 공간·이벤트 필터 분리)
              ├─ ops                              작업별 세션·취소 훅·deadline·CAS
              ├─ ax-snapshot · screenshot · lease · rpc
              packages/ego-host/bin/ego-browser   런처: `nodejs [--sdk-path]` = `node --import <preload> <sdk>/index.js` (preload 가 핸드셰이크 후 globalThis.ego 주입)
              packages/ego-host/vendor/ego-lite   업스트림 그대로(package/ego-browser 전체 + skills + spec + LICENSE)
              packages/ego-host/skill/            파생 SKILL.md + UPSTREAM-DIFF.md + learnings/
              packages/ego-host/scripts/sync-ego-lite.mjs
```

### 4.1 배치와 구조 규칙

- 새 패키지 `packages/ego-host` (pnpm-workspace `packages/*`, 루트 디렉터리 신설 없음).
- 코어 어댑터는 `src/main/adapters/ego-browser-env.ts`. `.agents/context/module-manifest.json` 에 `{layer: adapter, uc: [UC-ENV-TOOL-BROWSE, UC-ENV-TOOL-CANCEL, UC-ENV-TOOL-SPACE, UC-ENV-TOOL-RECOVER], contract: docs/progress/issue-582-ego-browser-host.md}` 로 등록.
- 벤더 트리는 `vendor/ego-lite/package/ego-browser` 와 `vendor/ego-lite/skills/ego-browser` 로 업스트림 경로를 그대로 미러링한다(빌드 스크립트의 경로 가정 때문). 선례는 `packages/shell/scripts/stage-herdr.mjs`(버전 고정)와 `voxcpm2-activation-contract.json`(digest 고정, THIRD_PARTY_NOTICES) 이다.

### 4.2 실행 ABI(벤더 런타임이 실제로 기대는 것)

`packages/ego-host/docs/ego-runtime-abi.md` 에 고정 커밋 기준 근거 줄과 함께 적고, 적합성 테스트가 실제 감독자 + 벤더 런타임 조합으로 각 행을 검증한다. 요지는 다음과 같다.

| 항목 | 기대 | 감독자의 의무 |
|---|---|---|
| CDP 통로 | `sendCDPMessage(json)` 은 **동기 호출**이고 반환값을 기다리지 않는다. 런타임은 호출 전에 pending 과 15초 타이머를 만든다 | 벤더 런타임 실행 전에 소켓 연결·핸드셰이크를 끝낸다. `sendCDPMessage` 는 동기 enqueue 또는 동기 throw 만 한다. 길이 프레이밍, 최대 프레임, 유한 큐, 응답 우선, 감독자 쪽 deadline 14초 미만 |
| 요청 id | 각 CLI 런타임은 id 1 부터 시작한다 | 연결마다 독립 id 공간. 런타임 경계에서는 id 를 보존하고 Chromium 쪽 id 만 `{connection, clientId} ↔ upstreamId` 로 재작성한다. **sessionId 는 재작성하지 않는다**(4.3.1) |
| 오류 통로 | `onSendCDPMessageError` 에는 id 가 없어 한 번 호출되면 pending 전부가 실패한다 | 정책 거부·컨텍스트 불일치·메서드 금지는 **원래 id 를 가진 CDP 오류 응답**으로 `onCDPMessage` 에 보낸다. id 없는 오류는 소켓 단절처럼 연결 전체가 죽은 경우에만 |
| 세션 | `Target.attachToTarget({flatten:true})` 응답 모양, `Page.enable` 뒤 Target/Page 이벤트 지속 전달 | 응답과 이벤트의 원래 순서 보존. 아웃바운드 이벤트는 연결이 소유한 타깃·세션으로 필터 |
| 탭·공간 | `listTabs()` → `{tabs:[{targetId,url,title,active}]}`, `createTab` → `targetId`, `{taskSpaces:[...]}`, 숫자 `id`, `taskId`, `name`, ownership 문자열은 정확히 `agent`·`agentDelegatedToUser`·`user`, 메서드별 resolve/reject 규칙, `{error, error_code}` | 선택된 공간은 감독자 전역이 아니라 **연결별 상태**. 두 CLI 가 동시에 id 1 과 서로 다른 공간을 써도 섞이지 않는다 |
| 스냅샷 | `{content, refs:[{backendNodeId, role, name}]}`, 사람 제어 중이면 `EGO_TASK_SPACE_USER_IN_CONTROL` | 헤드리스에서는 사람 제어 상태가 없으므로 해당 오류는 나오지 않는다(문서에 명시) |
| 환경·경로 | Node 22 이상, `HOME`/`USERPROFILE`, `EGO_BROWSER_AGENT_WORKSPACE`, 런타임 위치 기준 `.env`, `<agentWorkspace>/agent_helpers.js` 동적 import, `nodejs --sdk-path <dist>` | 어댑터가 ADK 별 절대 경로를 spawn 시점 환경으로 주입(SDK import 뒤 주입은 늦다). 런처는 `nodejs [--sdk-path <dist>]` 를 받아 `node --import <preload.mjs> <dist>/index.js` 로 SDK 를 무수정 실행한다. preload 는 최상위 await 로 소켓 연결·핸드셰이크를 끝낸 뒤 `globalThis.ego` 를 세운다. 출력 통로는 `console.log` |
| 버전 | `getBrowserVersion()` 이 갱신 없음을 알려야 알림이 침묵 | 고정 문자열 |

### 4.2.1 런처 불변

- preload 는 벤더 모듈을 정적으로 import 하지 않는다. 최상위 await 로 소켓 연결·핸드셰이크를 끝낸 뒤 `globalThis.ego` 만 세운다. 벤더 index 는 `process.argv[1]` 로 직접 실행되어 `isDirectCli()` 가 참이 되고 `runMain()` 경로로 들어간다. `installEgoSdk()` 는 이 경로에서 호출되지 않는다.
- Node 는 `--import` 를 worker·fork·cluster 자식에도 전파한다. preload 는 `isMainThread` 가 아니면 아무것도 하지 않고, 핸드셰이크 토큰은 단일 사용이라 fork 가 재시도하면 감독자가 즉시 거부한다. S2a 에 worker·fork 탐침을 둔다.

### 4.3 CDP 중계: 기본 거부 행렬

#### 4.3.1 세션 라우팅과 타깃 lease

- **sessionId 는 보존한다**(별칭 없음). 라우팅 키는 최상위 `sessionId` 만이다. 중첩 `params.sessionId` 는 메서드별로 해석한다. `Target.attachedToTarget`·`Target.detachedFromTarget` 의 것만 자식 타깃 세션이고, `Page.screencastFrame.params.sessionId` 는 `Page.screencastFrameAck` 용 프레임 토큰이다. 중첩 필드를 포괄적으로 장부 조회·재작성하지 않는다.
- 장부는 둘로 나눈다. 영속 `targetId → workspace` 와 배타적 `targetId → {connection, generation}` **타깃 lease**. 같은 타깃에 두 연결이 동시에 attach 하면 원자적으로 한 연결만 승인하고 나머지는 원래 id 로 `EGO_TARGET_BUSY`. attach 요청마다 세대(generation)를 올리고, 응답이 오기 전에 `{connection, targetId, generation}` 으로 예약한다. 연결이 예약 중에 끊기면 예약을 철회하고, 그 뒤 도착한 늦은 응답은 감독자가 내부적으로 `Target.detachFromTarget` 한다. detach 된 sessionId 는 묘비(tombstone)로 남겨 같은 값이 재사용돼도 옛 세대의 요청·이벤트를 거부한다.
- 자식 타깃(iframe·worker) auto-attach 는 쓰지 않는다. `Target.setAutoAttach` 는 거부 목록이며, 예기치 않은 자식 `attachedToTarget` 이 오면 fail-closed 로 감독자가 detach 한다. `waitingForDebugger: true` 로 멈춘 타깃은 장부 등록 뒤 감독자 전용 `Runtime.runIfWaitingForDebugger` 로 풀거나 detach 한다. 이 두 메서드는 감독자 전용이라 연결에는 노출하지 않는다.
- 순서: Chromium 에서 이미 받은 응답·이벤트는 단일 FIFO 순서를 유지한다. 4.2 의 "응답 우선"은 아직 Chromium 으로 보내지 않은 요청과 감독자 자체 원격측정보다 응답 전달이 먼저라는 뜻으로 한정한다. attach 응답과 `attachedToTarget` 사이에 재정렬을 적용하지 않는다.
- 테스트는 응답→이벤트, 이벤트→응답 두 순서, 동시 attach, 예약 중 연결 종료, 묘비 뒤 재사용, 예기치 않은 자식 attach 를 각각 강제한다.

#### 4.3.2 행렬

원문 통과는 쓰지 않는다. 감독자는 CDP 스키마상의 **실행 대상**(브라우저 전역 / 브라우저 컨텍스트 / 타깃·세션)을 기준으로 메서드를 분류하고, `method × 실행 대상 × 소유권` 행렬을 기본 거부로 둔다. 행렬은 `packages/ego-host/src/supervisor/mediator-policy.ts` 에 데이터로 두고 테스트가 행렬을 그대로 읽어 각 셀을 검증한다.

행렬은 **접두사가 아니라 정확한 메서드 이름과 인자 제약**을 데이터로 갖는다(`mediator-policy.ts`). 목록에 없는 메서드는 거부다. 요지는 다음과 같고, 전체 목록은 정책 파일이 정본이다.

- **거부**: `Target.setAutoAttach`, `Target.attachToBrowserTarget`, `Target.createBrowserContext`, `Target.disposeBrowserContext`, `Target.sendMessageToTarget`, `Target.exposeDevToolsProtocol`, 비 flatten 첨부, `Security.setIgnoreCertificateErrors`, `Network.clearBrowserCookies`, `Network.clearBrowserCache`, 컨텍스트 없는 `Storage.clearDataForOrigin`, `DOM.setFileInputFiles`(임의 호스트 경로. 이번 범위에서 파일 업로드는 미지원으로 거부), `Page.crash`.
- **컨텍스트 강제**: `Target.createTarget`, `Storage.getCookies/setCookies/clearCookies`, `Browser.grantPermissions/resetPermissions`, `Storage.clearDataForOrigin`(컨텍스트 지정 시). `Browser.setDownloadBehavior` **와** `Page.setDownloadBehavior` 둘 다 `downloadPath` 를 컨텍스트별 디렉터리로 재작성한다(어느 한쪽만 막으면 우회된다). 다른 컨텍스트를 지정하면 `EGO_CONTEXT_MISMATCH`.
- **세션 소유 강제**: `Page.navigate/reload/stopLoading/enable/captureScreenshot/getLayoutMetrics/handleJavaScriptDialog/…`, `Runtime.evaluate/callFunctionOn/enable/…`, `DOM.getDocument/querySelector/getBoxModel/resolveNode/describeNode/…`, `Accessibility.getFullAXTree/…`, `Input.dispatchMouseEvent/dispatchKeyEvent/insertText`, `Emulation.*` 의 개별 메서드, `Network.setCookie`, `Fetch.enable/disable` 은 `{connection, sessionId, targetId, workspaceId}` 장부를 통과한 세션에서만. 정책 파일이 메서드 하나하나를 나열한다.
- **작업 소유 강제**: `Runtime.terminateExecution`, `Fetch.failRequest/fulfillRequest/continueRequest/continueWithAuth`, `Browser.cancelDownload`, `IO.read/close` 는 해당 작업(operation)이 소유한 세션·requestId·GUID·스트림 핸들에만 허용한다. 취소 훅(4.7)이 쓰는 메서드가 바로 이 묶음이며 허용 목록에 명시적으로 들어 있다.
- **Target 장부 통과**: `Target.getTargets/attachToTarget/activateTarget/closeTarget/getTargetInfo` 는 연결이 소유한 타깃으로 범위를 좁히고 결과·이벤트도 필터. 다운로드 GUID, `Fetch.requestPaused` 응답 의무, `IO` 스트림 핸들은 같은 장부에 묶고 작업 취소·연결 종료 시 정리한다.

벤더 런타임의 `driver/*.ts` 와 `element-resolver.ts`·`browser-runtime.ts` 가 실제로 부르는 CDP 메서드 전수표(4차 리뷰가 소스에서 뽑음). 이것이 `mediator-policy.ts` 의 초안이며, 소스에 있는 메서드가 정책표에 없으면 테스트 수집 단계에서 실패한다.

| 분류 | 메서드 |
|---|---|
| 거부 | `DOM.setFileInputFiles` |
| 컨텍스트 강제 | `Browser.setDownloadBehavior`, `Page.setDownloadBehavior` |
| 세션 소유 강제 | `Page.enable`, `Page.navigate`, `Page.reload`, `Page.getFrameTree`, `Page.captureScreenshot`, `Page.startScreencast`, `Page.stopScreencast`, `Runtime.evaluate`, `DOM.resolveNode`, `DOM.getBoxModel`, `Accessibility.getFullAXTree`, `Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`, `Input.insertText`, `Network.enable`, `Network.disable` |
| 작업·자원 소유 강제 | `Network.getResponseBody`(requestId), `Page.screencastFrameAck`(프레임 토큰), `Runtime.callFunctionOn`·`Runtime.releaseObject`(objectId) — 세션 검사만으로는 부족해 작업·자원 장부와 결속 |
| Target 장부 | `Target.getTargets`, `Target.attachToTarget`, `Target.activateTarget`, `Target.closeTarget` |
| 감독자 전용(연결 비노출) | `Target.detachFromTarget`, `Runtime.runIfWaitingForDebugger`, `Target.createBrowserContext/disposeBrowserContext`, `Browser.close` |

취소 훅(4.7)이 쓰는 `Page.stopLoading`, `Fetch.failRequest`, `Browser.cancelDownload`, `Runtime.terminateExecution` 은 작업·자원 소유 강제 묶음에 속한다.

- **격리 검증**은 같은 출처(로컬 HTTP 픽스처)에서 쿠키·localStorage·IndexedDB·CacheStorage·서비스 워커·권한·다운로드 경로를 공간 A 에서 심은 뒤 공간 B 에서 보이지 않음을 negative 로 확인한다. 인증서 예외 공유는 범위 밖(양보)이며 관련 명령을 막는 것으로 대신한다.

### 4.4 작업·자원·권한

- **작업(operation)** 은 #499 의 5상태(accepted·running·completed·failed·cancelled)를 따른다. 종결 상태는 CAS 로 한 번만 쓴다. 취소와 완료가 경주하면 먼저 종결한 쪽이 남는다. 실패 사유는 형식이 있다: `timeout`·`cancelled`·`disconnected`·`process-exit`·`partial`·`context-mismatch`·`method-denied`.
- **자원**은 작업과 다른 수명을 가진다. `BrowserWorkspace { id, mode: "headless", ownership: "agent" | "agentDelegatedToUser" | "user", revision }` 와 `BrowserPage { id, workspaceId, url, urlRevision }`. `browserContextId` 는 원시 CDP 능력이므로 공개 자원에 넣지 않고 어댑터 안의 매핑으로 둔다.
- **소유권 전이 표**(헤드리스). 업스트림 스킬의 헬퍼별 동작 표와 1:1 로 대응시키되 헤드리스에서 불가능한 셀은 거부 코드로 채운다.

| 헬퍼 | agent 소유 | agentDelegatedToUser | user 소유 |
|---|---|---|---|
| `useOrCreateTaskSpace` / `switchTaskSpace` | 선택 | 도달 불가 | 도달 불가 |
| `claimTaskSpace` | `EGO_HANDOFF_UNSUPPORTED_HEADLESS` | 도달 불가 | 도달 불가 |
| `handOffTaskSpace` | `EGO_HANDOFF_UNSUPPORTED_HEADLESS` | 도달 불가 | 도달 불가 |
| `takeOverTaskSpace` / `waitForAgentControl` | `EGO_HANDOFF_UNSUPPORTED_HEADLESS` | 도달 불가 | 도달 불가 |
| `completeTaskSpace({keep:false})` | 닫음 | 도달 불가 | 도달 불가 |
| `completeTaskSpace({keep:true})` | 유지 | 도달 불가 | 도달 불가 |

- **권한**은 호출자 선언을 믿지 않는다. 형식 있는 도구는 효과가 고정된 RPC(열기·이동·스냅샷·클릭·입력·평가·캡처·닫기)만 부르고, 각 RPC 의 등급은 서비스가 정한다(관측: 스냅샷·캡처, 워크스페이스 내부 변경: 이동·클릭·입력·평가). heredoc 은 터미널 실행과 같은 등급이며 승인 없이는 감독자가 핸드셰이크에서 거부한다. 캡처 경로는 사용자 인자가 아니라 감독자가 `<ADK>/ego-host/evidence/` 아래로 정한다.

### 4.5 화면 캡처와 증거

감독자는 `Page.captureScreenshot` 으로 PNG 를 `<ADK>/ego-host/evidence/<operationId>-<n>.png` 에 쓰고, 어댑터는 그 경로를 `BrowserEvidence.screenshotRef` 로 돌려준다. `hasEvidence` 는 캡처 참조도 검사한다.

### 4.6 무간섭

브라우저는 `--headless=new` 로 띄운다. 검증은 세 겹이다. (1) 실제 Chromium 프로세스의 명령줄에 헤드리스 인자가 있다. (2) 호스트 동작 전후로 활성 창 식별자가 같다. 이 검사는 조건부가 아니다. 실브라우저 테스트 환경은 Xvfb·창 관리자·`xdotool` 을 필수 의존으로 고정하고, 없으면 RED 다. (3) 감독자 프로세스 트리의 어떤 PID 도 창을 소유하지 않는다(`xdotool search --pid`).

### 4.7 취소

`Page.stopLoading` 만으로는 부족하다. 작업마다 취소 훅을 두되, 훅이 **작업보다 넓은 상태를 파괴하지 않게** 한다.

- 이동: `Page.stopLoading` 과, 그 작업이 만든 세션이고 다른 사용자가 없을 때만 세션 detach.
- Fetch 가로채기: 작업이 소유한 requestId 만 `Fetch.failRequest`. `Fetch.disable`·`Network.disable` 은 도메인 참조 횟수(refcount)가 0 이 될 때만.
- 다운로드: 작업이 소유한 GUID 만 `Browser.cancelDownload`.
- 평가: `Runtime.terminateExecution` 은 세션 전체에 작용하므로 이동·평가는 세션당 배타 슬롯으로 돌려 같은 세션에 다른 작업이 없을 때만 부른다.
- 취소 뒤 확인하는 것: 최종 상태가 cancelled 로 유지되는지, 취소 장벽 뒤 **그 작업에 결속된** 이벤트가 0 인지(세션 전체 이벤트가 아니라), 그 작업이 연 가로채기·스트림·세션이 0 인지, 부분 효과가 기록됐는지, 같은 세션의 다른 작업이 영향을 받지 않았는지.

### 4.8 소유·lease·정리

- Chromium 은 `--remote-debugging-pipe` 로 띄운다(자식 쪽 fd 3·4). Chromium 은 파이프 EOF 를 연결 해제로 처리해 브라우저를 닫는다. 이것이 성립하려면 **부모 쪽 파이프 끝의 유일한 소유자가 감독자**여야 한다. Node 의 공개 `child_process` API 로는 부모 fd 에 CLOEXEC 나 Windows 비상속 플래그를 사후 설정할 수 없으므로, 규율로 집행한다. Chromium spawn 에서만 `stdio` 배열의 3·4번에 `'pipe'` 를 두고, 부모 쪽 스트림은 감독자 내부 클로저에만 보관하며, 감독자의 다른 모든 spawn(CLI 포함)은 명시적 stdio 허용 목록만 쓰고 스트림·숫자 fd 를 절대 넘기지 않는다(fd 3 이상은 Node 기본이 `ignore`). 리눅스에서는 후손 프로세스의 `/proc/<pid>/fd` 에 파이프가 없음을 실측하고, 감독자 SIGKILL 뒤 제한 시간 안에 Chromium PID 가 소멸함을 확인한다. 소멸하지 않으면 lease 기반 강제 회수가 그 사실을 기록하며 회수한다. Windows 의 HANDLE 비상속은 실측 전까지 추측이며 windows4060 게이트 항목이다.
- 감독자의 소유자는 셸이다. 기존 에이전트 lease 와 같은 형식(nonce·marker·started-at·runtime 경로·PID)으로 `<ADK>/ego-host/lease.json` 을 쓴다. 시작 시 조정에서 marker 가 일치하는 프로세스만 입양하거나 회수한다. 셸 크래시 뒤 다음 시작에서 고아 0 을 이 경로가 보장한다.
- ADK 전환은 A 의 감독자 정상 종료 → B 의 lease 조정 순서를 어댑터가 강제한다.
- Reset·재시작·종료 경로에서 셸(Rust)의 소유 런타임 정리 목록에 감독자를 넣는다(S6b). 검증은 `test:e2e:tauri` 로 셸→IPC→Rust→감독자→Chromium 전체를 돈다.
- CLI 가 heredoc 도중 죽으면 감독자는 그 연결의 세션·가로채기·스트림을 정리하고 작업을 `failed(process-exit)` 로 기록한다. 작업 공간과 탭은 유지되어 다음 heredoc 이 같은 공간에 재접속한다.

## 5. 워크스페이스·설치 앱·브라우저의 공통 추상화 검토

루크의 가설은 "세 가지가 같은 방식의 계층이 아닐까"였다. 코드로 확인한 결과는 다음과 같다.

| 축 | 워크스페이스(Herdr) | 설치 앱 | 임베디드 브라우저 | 이번 호스트 |
|---|---|---|---|---|
| UI 등록 | `AppDescriptor` (id `workspace`) | `AppDescriptor` (app.json → 제네릭 iframe) | `AppDescriptor` (id `browser`) | 없음(화면 없음, environment 처럼 상시 표면) |
| 에이전트 도달 | `skill_environment` → `app_tool_call` → Herdr 소켓 | app.json tools → postMessage | `skill_browser_*` → Tauri 명령(서비스 우회) | `app_tool_call` → EnvironmentToolService → 포트 |
| 세션 단위 | Herdr 세션 | 앱 샌드박스 | 웹뷰 하나 | 작업 공간(격리 컨텍스트) |
| 관측 | `observe` | 앱이 정하는 대로 | `snapshot` (`@eN`) | `snapshot` (`ref=N`) |
| 행위 | `run`, `focus`, `interrupt` | 앱 도구 | `click/fill/press/eval` | 형식 RPC + 승인된 heredoc |
| 증거 | 출력 스트림 | 없음 | 스냅샷(캡처 없음) | 스냅샷+캡처+주소 개정 |
| 소유권·인계 | 없음 | 없음 | 없음 | 자원 소유권(헤드리스에서는 agent 만) |
| 취소·시간 제한 | #499 계약 | 없음 | 없음 | #499 계약(실제 훅) |

결론은 두 겹이다. UI 쪽은 이미 `AppDescriptor` 하나로 셋이 묶여 있고 더 묶을 것이 없다. 에이전트가 보는 환경 쪽은 #499 계약이 브라우저와 터미널을 같은 모양(작업 5상태·안정 참조·증거·취소·권한 비상속)으로 정의해 두었고, 워크스페이스는 아직 그 계약 밖에 있다. ego-lite 에서 가져올 새 축은 "자원의 소유권과 인계"이며, 이것은 작업 상태와 수명이 다르므로 별도 자원 타입으로 둔다(4.4). 이번 작업은 새 아키텍처 계층을 만들지 않고, 브라우저 자원에만 소유권 규칙(FR-ENV-TOOL.10)을 붙인다. 셸은 소유 상태와 배타성만 집행하고 인계·회수의 결정은 뇌의 의도로 내려온다(#497 경계). 워크스페이스와 설치 앱을 같은 자원 계약 아래로 옮기는 일은 각 자원의 인계 의미가 정의될 때까지 FR-ENV-TOOL.10 에서 제외하고 #502 에 맡긴다.

## 6. 업스트림 추적

- `packages/ego-host/vendor/ego-lite/UPSTREAM.md`: 업스트림 URL, 고정 커밋(`5ca3c36cba2240b8df2e22ba32127747029039d5`, 2026-08-24), 복사 허용 목록(`package/ego-browser/**` 전체: src·scripts·test·package.json·package-lock.json·tsconfig.json, `skills/ego-browser/**`, `spec/agent-skills-spec.md`, `LICENSE`, `AGENTS.md`, `.github/workflows/publish-ego-browser-skill.yml` — 벤더 단위 테스트 하나가 이 파일을 읽는다), 로컬 변경 0건 원칙, 마지막 동기화 날짜와 실행자.
- `scripts/sync-ego-lite.mjs --ref <commit>`: 업스트림을 받아 허용 목록만 복사하고, 허용 목록 밖 파일이 vendor 에 있으면 실패하며, `MANIFEST.sha256` 을 갱신하고 diff 요약을 출력한다. `--check` 는 네트워크 없이 매니페스트와 대조한다(로컬 변조 탐지). 매니페스트·벤더·UPSTREAM.md 를 함께 바꾸면 `--check` 는 속을 수 있으므로, **출처 게이트**(`--provenance`)를 따로 둔다. 고정 커밋의 트리를 임시 디렉터리에 실체화해 벤더와 직접 비교하거나, 허용 subtree 의 업스트림 tree hash 를 독립 상수로 대조한다. CI 는 `--provenance` 를 돈다(S2a 에서 추가).
- 벤더 파일은 편집하지 않는다. 필요한 변경은 감독자 쪽에서 흡수하거나 업스트림에 PR 한다.
- 스킬은 파생본이다. `packages/ego-host/skill/SKILL.md` 는 업스트림 스킬에서 파생하며 `UPSTREAM-DIFF.md` 에 바꾼 문장과 이유(로그인 상속 삭제, 헤드리스 인계 정책, 지원 헬퍼 행렬, 승인 등급, 낡은 `cliLog` 를 `console.log` 로)를 적는다. 동기화 시 업스트림 스킬이 바뀌면 3자 diff 를 출력한다.
- 참조 구현 #228 에서 가져온 부분은 파일 머리에 출처와 커밋(`4f99b181960a`)을 적고 `THIRD_PARTY_NOTICES.md` 에 MIT 저작권을 남긴다.
- 설치 검증: 벤더 트리를 임의 디렉터리에 스테이징해 빌드·테스트가 0 으로 끝나고, 생성된 bin 이 임의 cwd 에서 도는 테스트를 둔다.
- 공식 리눅스·윈도우 앱이 나오면 감독자 안에 공식 앱 소켓 어댑터를 하나 더 두고 선택 스위치로 바꾼다. 어댑터·스킬·학습은 그대로다.

## 7. 프로세스 관문(P01~P05)

P01~P03 은 코드보다 먼저 쓴다(S-1). 기존 FR-ENV-TOOL.2·6·9 는 In-progress 로 재개방한다.

| 관문 | 산출물 | 이번 작업 |
|---|---|---|
| P01 UC | `docs/user-scenarios.md`, `02.user-scenarios/INDEX.md` | UC-ENV-TOOL-BROWSE·CANCEL 재개. 신규 **UC-ENV-TOOL-SPACE** "에이전트는 자기 공간에서만 일한다"(비로그인 격리, 사람의 창과 포커스 불변, 로그인·captcha 가 필요하면 멈추고 보고). 신규 **UC-ENV-TOOL-RECOVER** "셸이 죽어도 브라우저가 남지 않는다". 신규 **UC-ENV-TOOL-SCRIPT** "묶음 실행은 승인이 먼저다"(heredoc 은 터미널 등급 승인). |
| P02 테스트 매핑 | Test Coverage Map | 9절의 검증 항목을 UC 별로 표에 추가 |
| P03 요구사항 | `docs/requirements.md`, `01.requirements/INDEX.md`, `04.features/INDEX.md` | **FR-ENV-TOOL.2 를 .2a(지원: 컨텍스트·페이지·스냅샷·안정 참조·이동·평가·캡처·닫기)와 .2b(보류: 다운로드·이벤트 스트림)로 분리**하고 .2b 는 Pending 으로 정직하게 남긴다. **.6** 캡처 필수 증거 재개방. **.9** 실제 deadline·재연결·취소 훅 재개방. **FR-ENV-TOOL.10** 브라우저 작업 공간 자원의 격리와 소유권(브라우저 한정, 헤드리스 전이 표). **.11** 무간섭(헤드리스, 활성 창 불변, 세 겹 검증). **.12** 사이트 학습 형식. **.13** 기존 `skill_browser_*` 와 새 `env_browser_*` 의 이름·권한·증거 분리와 기능 플래그. **.14** 두 진입점의 권한 등급(형식 RPC 대 heredoc). **NFR-ENV-TOOL-VENDOR.1** 벤더 무수정·매니페스트 검사·스킬 파생 diff. **NFR-ENV-TOOL-ABI.1** 실행 ABI 문서와 전송 실패 모드 적합성 테스트. |
| P04 테스트 | 9절 | 실브라우저 테스트는 리눅스 필수 게이트(Chromium·Xvfb·xdotool 부재 = RED). Windows 는 windows4060 별도 필수 게이트, 통과 전 기능 플래그 Windows 기본 끔. Rust 변경은 `test:e2e:tauri` 로 검증. |
| P05 | requirements.md 상태, process-status.json | 커밋 전 |

## 8. QC 조각(초안, 번호는 회차 뒤에)

파일 `.agents/progress/issue-582/qa-browser-host-cases.json`, 형식 `naia-shell.qa-round.v1`. 번호 부여는 진행 중인 Linux 2회차가 끝난 뒤 `qa-qc-numbers.mjs` 로 QC-206 부터 append 한다. 이번 세션은 `qa/qc-numbers.json` 을 건드리지 않는다.

| id | 제목 | 방법 요지 | 기대 결과 |
|---|---|---|---|
| BROWSER-HOST-001 | 호스트가 사람의 창을 건드리지 않는다 | 활성 창을 기록하고 에이전트에게 웹 작업을 시킨다 | 작업 전후 활성 창 동일, 감독자 트리에 창 0 |
| BROWSER-HOST-002 | 작업 공간끼리 상태가 새지 않는다 | 공간 A 에서 쿠키·저장소·서비스 워커를 심고 공간 B 에서 같은 출처를 연다 | B 에 아무것도 없음 |
| BROWSER-HOST-003 | 헤드리스 인계는 형식이 맞게 거부된다 | 에이전트가 인계·회수·claim 을 시도 | 원래 id 를 가진 `EGO_HANDOFF_UNSUPPORTED_HEADLESS`, 다른 대기 요청은 영향 없음, 에이전트가 사람에게 보고 |
| BROWSER-HOST-004 | 증거가 셋 다 남는다 | 클릭 한 번 | 스냅샷 참조·캡처 파일(감독자가 정한 경로)·주소 개정 모두 존재 |
| BROWSER-HOST-005 | 재시작·종료·Reset 에 브라우저가 남지 않는다 | 호스트 동작 중 셸 재시작 | 이전 Chromium PID 없음 |
| BROWSER-HOST-006 | 벤더가 고정 커밋과 같다 | `sync-ego-lite.mjs --check` | 종료 코드 0 |
| BROWSER-HOST-007 | 취소가 실제로 멈춘다 | 응답을 멈춘 페이지로 이동 + Fetch 가로채기 켠 채 취소 | 후속 이벤트 0, 열린 가로채기·스트림·세션 0, 상태 cancelled 유지 |
| BROWSER-HOST-008 | 감독자가 강제 종료돼도 Chromium 이 남지 않는다 | 감독자 SIGKILL | Chromium PID 소멸(파이프 닫힘), 다음 시작 조정에서 고아 0 |
| BROWSER-HOST-009 | 두 에이전트가 동시에 써도 섞이지 않는다 | CLI 두 개가 동시에 id 1 로 서로 다른 공간을 쓴다 | 응답·이벤트가 각자에게만 |
| BROWSER-HOST-010 | 기존 브라우저 앱 도구는 그대로 돈다 | `skill_browser_navigate` 로 임베디드 웹뷰 열기 | 기존 동작 불변, 새 도구와 이름·권한이 겹치지 않음 |
| BROWSER-HOST-011 | 묶음 실행은 승인이 먼저다 | 승인 없이 `env_browser_script` 호출 | 감독자 핸드셰이크에서 거부, 관측 도구는 영향 없음 |

기존 QC-025·QC-059 는 임베디드 웹뷰 대상이라 그대로 두고 `automationGap` 에 이 호스트로 자동화 가능한 범위를 적는다.

## 9. 실행 계획(슬라이스)

각 슬라이스는 독립 커밋이며 종료 코드 증거를 남긴다. 담당은 Opus(S-1 은 Fable), 리뷰는 Fable. 순서는 고정이다.

| 슬라이스 | 내용 | 검증(전부 종료 코드) |
|---|---|---|
| **S-1 관문 문서(P01~P03)** | 7절의 UC·FR·INDEX·Coverage Map. QC 조각 초안 | `check-traceability.mjs --enforce` 0 |
| **S0a 도메인 스키마** | `BrowserWorkspace`·`BrowserPage` 자원 타입, 소유권 전이 표(헤드리스), 형식 있는 실패 사유, `EnvOperationRequest` 에 `workspaceId`·`pageId?`·`expectedRevision?`, `hasEvidence` 가 캡처 검사 | `pnpm test` 0 (기준선 7건 외 새 실패 없음) |
| **S0b 동시성·deadline** | 종결 상태 CAS, 진행 중 멱등 공유(같은 키 동시 요청은 포트 호출 1회), 실제 deadline 타이머와 `AbortSignal` 전파, 오류 코드를 뭉개지 않음. 경주·동시 멱등·deadline 계약 테스트 | `pnpm test` 0 |
| **S0c 포트** | `BrowserWorkspacePort {create, list, close}`, `BrowserOperationPort {open, navigate, snapshot, click, fill, evaluate, screenshot, close}`, `CancellationPort.cancel` 이 포트까지 내려감, 서비스에 등급 고정 RPC 표. 대역 갱신 | `pnpm test` 0 |
| **S1 벤더링** | 4.1·6 절대로. `vendor/ego-lite` 전체, UPSTREAM.md, MANIFEST.sha256, THIRD_PARTY_NOTICES.md, `sync-ego-lite.mjs`, `docs/ego-runtime-abi.md`(근거 줄 정정), 임의 디렉터리 설치 테스트 | `sync --check` 0, 벤더 `npm test` 0, 설치 테스트 0 |
| **S2a RPC·CLI ABI** | 소켓 프레이밍·핸드셰이크·연결별 id 공간·이벤트 필터·유한 큐·14초 deadline, CLI `nodejs --sdk-path`. 가짜 CDP 백엔드로 전송 실패 모드 테스트(15초 경계, 동시 두 CLI 같은 id, 순서 보존, 이벤트 폭주, 단절, id 없는 오류의 영향 범위), worker·fork·cluster 에서 preload fail-closed, `sync --provenance`(고정 커밋 실체화 후 형식·모드·심링크·바이트·누락·추가 비교) | 0 |
| **S2b 런처·lease** | `--remote-debugging-pipe` 런처(linux, win32 경로 탐색), lease 파일, 시작 조정. 실브라우저: 감독자 SIGKILL → Chromium 소멸, 조정 → 고아 0 | 0 |
| **S2c 장부** | 작업 공간(격리 컨텍스트)·타깃·세션 장부, 연결별 선택 공간, 원자적 저장 | 0 |
| **S2d 중계기** | 4.3.2 전수표를 데이터로, 기본 거부. 소스 스캔으로 뽑은 메서드가 정책표에 없으면 수집 단계 실패(미분류 0). 각 셀을 실브라우저에서 검증(거부 셀은 원래 id 오류 응답, 컨텍스트 강제 셀은 재작성 확인). 4.3.1 세션 경주표 전부 강제. 격리 행렬 negative | 0 |
| **S2e 작업·스냅샷·캡처** | 작업별 세션, 취소 훅(4.7), deadline, 접근성 스냅샷, 캡처, 무간섭 세 겹 | 0 |
| **S2f 적합성** | 실제 감독자 + 벤더 런타임으로 ABI 각 행. 업스트림 `real-browser-e2e` 는 `EGO_BROWSER_REAL_E2E_ONLY` 로 지원 케이스만 고정한 통과 묶음과, 미지원 헬퍼의 형식 있는 거부 묶음으로 분리. 지원 헬퍼 행렬은 헬퍼별 독립 probe 하네스(manifest)로 생성. 리눅스 후손 프로세스 fd 부재, SIGKILL→EOF→PID 소멸, 취소와 동시 작업 무간섭 | 0, 행렬 파일 산출 |
| **S3a 어댑터·조립** | `ego-browser-env.ts` = 감독자 클라이언트, ADK 별 절대 경로 환경 주입, composition 배선, module-manifest 등록. `env-tool-browser-host.contract.test.ts` 로 S0 계약 전체를 실제 어댑터로(경주·동시 멱등·deadline·취소 부작용 정지·재연결·stale ref·캡처 파일·작업/자원 id 일치) | 0, `check-file-anchors` 0 |
| **S3b ADK 전환** | A 종료 → B 조정 순서, lease 격리 테스트 | 0 |
| **S4 스킬(파생)·학습** | `skill/SKILL.md` + `UPSTREAM-DIFF.md`, S2f 행렬 반영, `learnings/naia-land/` 첫 예시, `validate-site-skills` | 0 |
| **S5 P05** | requirements.md 상태·process-status.json | — |
| **S6a 셸 도구·권한** | `env_browser_*` 형식 도구와 `env_browser_script` 를 `EnvironmentToolService` 경유로만 노출, 기능 플래그(리눅스 기본 켬, Windows 기본 끔), 권한 정책 매핑, 기존 `skill_browser_*` 불변 | Playwright e2e(도구 호출 → 증거, 승인 없는 script 거부), 기존 브라우저 앱 e2e 불변 |
| **S6b Rust 생명주기** | 셸 소유 런타임 정리 목록에 감독자 편입 | `test:e2e:tauri` 로 reset·재시작·정상 종료·SIGKILL 뒤 PID·marker·lease 검증 |

S6b 착수 전에 진행 중 QA 세션의 수정 worktree 변경 파일 목록을 다시 확인한다(같은 Rust 파일을 건드릴 수 있다).

## 10. 적대 리뷰 경계

리뷰가 무한 하드닝으로 흐르지 않도록 양보한 것을 먼저 적는다.

- 감독자는 셸과 같은 신뢰 경계에서 돈다. 악의적 Chromium 바이너리, 다중 사용자, 원격 CDP 노출은 위협 모델 밖이다. CDP 는 파이프·loopback 에만 있다.
- 페이지 내용은 자료다(FR-ENV-TOOL.4). 계약 테스트가 지키며 이번 작업은 그 테스트를 실제 어댑터로 다시 돈다.
- 공식 ego 앱과의 완전 호환은 목표가 아니다. 목표는 벤더 **런타임**이 무수정으로 도는 것과, 지원 헬퍼 범위를 측정해 적는 것이다. 스킬은 파생본이다.
- 속도 개선은 주장하지 않는다.
- 인증서 예외의 공유 범위는 검증하지 않고 관련 명령을 막는다.
- 창이 있는 모드, 로그인 상속, 다운로드·이벤트 스트림(FR-ENV-TOOL.2b)은 이번 범위 밖이며 Pending 으로 남긴다.

## 11. 리뷰 기록

- 2026-09-09 Codex 1차(gpt-5.6-sol, high): 반려 15건. 전부 2판에 반영, 인증서 예외만 양보 목록으로.
- 2026-09-09 Codex 2차: 반려. 판정 표에서 해소 6, 부분 해소 8, 미해소 1("스킬 무수정"). 새 P0: 연결별 공간·id·이벤트 계약 부재, id 없는 오류 통로 오용, 도메인 수준 허용 목록 우회(`Target.sendMessageToTarget` 등), Storage/Network/Fetch 결속, 두 진입점 권한 미연결, FR-ENV-TOOL.2 미충족, 업스트림 e2e 러너와 헤드리스 정책 충돌, P01~P03 역순. P1: 동기 `sendCDPMessage`·역압·15초, 감독자 SIGKILL 시 Chromium 생존, 소유권 enum 불일치, 슬라이스 과대, 조건부 포커스 검사, 취소의 불충분한 증거, Rust 변경의 검증 수단. 전부 3판에 반영: 스킬 무수정 목표 철회(1절·10절), 연결별 상태와 `--remote-debugging-pipe`(4.2·4.8), 기본 거부 행렬(4.3), 두 진입점 등급(3절 4·4.4), .2a/.2b 분리(7절), S-1 선행과 슬라이스 분할(9절), QC-003 을 거부 검증으로 교체(8절). 관문 순서 위반 사실은 S1 벤더링이 S-1 보다 먼저 착수된 점으로 남아 있으며, S-1 문서를 S0 착수 전에 완료하는 것으로 바로잡는다.
- 2026-09-09 S1 완료(커밋 1fa2e7ed). S1 의 설치 테스트는 "재현 가능한 설치·빌드 표면"이며 ABI 적합성 판정은 S2f 전에는 주장하지 않는다. 구현 중 확정한 사실: 허용 목록에 워크플로 파일 하나 추가, CLI 는 런처 형태(위 2절·4.2), `listTabs` 는 `{tabs}` 로 통일, 세션 상실 문구는 `Session not found` 계열 정규식에 걸려야 자동 재접속이 돈다, 미지의 `error_code` 는 그대로 통과하므로 사람이 읽을 설명은 `error` 문자열에 담는다. ABI 문서의 근거 줄 여섯 행을 정정했다.

- 2026-09-09 Codex 3차: 반려. 2차 지적 32건 중 26 해소·6 부분 해소. 남은 P0 둘은 S2 세부(flatten sessionId 라우팅·attach 경주, 접두사 허용이 기본 거부를 무효화). P1: `--import` 의 worker·fork 전파, 파이프 fd 상속 금지 불변, ABI 문서 CLI 주입 행 오기, `--check` 는 출처 증명이 아님. 전부 4판에 반영(4.2.1·4.3.1·4.3.2·4.8·6절). S0 는 막힌 항목이 없어 착수한다. S2 착수 전 4.2~4.3·4.8 을 대상으로 4차 리뷰를 받는다.

- 2026-09-09 Codex 4차(S2 정책 한정): 조건부 승인. 3차 잔여 P0 둘 중 접두사 문제 해소, 세션 라우팅은 부분 해소. 착수 전 조건 넷(중첩 sessionId 메서드별 해석, 타깃 lease·세대·묘비·자식 attach·waitingForDebugger, 누락 CDP 메서드 8개와 감독자 전용 메서드 분류, 취소 배타성·refcount 와 파이프 구현 문구)을 5판에 반영(4.3.1·4.3.2·4.7·4.8). 슬라이스별 확인 조건은 9절 S2a·S2d·S2f 행에 반영.

## 12. 위험과 미결

- Windows 는 이 세션에서 실측할 수 없다. 런처의 Edge/Chrome 탐색 경로는 #228 을 따르되 windows4060 기기에서 별도 필수 게이트로 남긴다.
- `--remote-debugging-pipe` 는 Chromium 계열 전반이 지원하지만, Flatpak 으로 설치된 Chrome 은 샌드박스 때문에 추가 fd 전달이 막힐 수 있다. S2b 에서 Playwright 의 chromium 바이너리를 기본 후보로 두고 Flatpak Chrome 은 감지만 한다.
- 헬퍼의 `serverFetch`·`browserFetch`·`uploadFile`·비디오 녹화는 S2f 의 probe 결과로만 지원 여부를 적는다.
- 라이선스: 저장소 내용은 MIT 이고 브라우저 앱은 쓰지 않으므로 재배포 문제가 없다. THIRD_PARTY_NOTICES 로 표기한다.
