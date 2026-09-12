# S2d 증거 — CDP 중계기 기본 거부 행렬과 격리 검증 (2026-09-10)

대상: 계약 `docs/progress/issue-582-ego-browser-host.md` 5판의 9절 S2d 행(4.3.1·4.3.2).
worktree `feat/582-ego-browser-host`. 실 Chromium + 로컬 HTTP 픽스처.

## 만든 것

| 자리 | 무엇 |
|---|---|
| `src/supervisor/mediator-policy.mjs` | 정책표(데이터). 정확한 메서드 이름 76개 → `{scope, args?, session?}`. 접두사·와일드카드 없음 |
| `src/supervisor/mediator.mjs` | 판정 절차. 기본 거부, 컨텍스트 재작성, 세션 소유, Target 장부, 결과 필터 |
| `scripts/scan-cdp-methods.mjs` | 벤더 소스에서 CDP 호출의 첫 문자열 인자 추출(호출 자리만, 이벤트 구독은 제외) |
| `src/supervisor/cdp-mux.mjs` | 응답 정형 훅(`filterResponse`) 추가 |
| `src/supervisor/rpc-server.mjs`·`supervisor.mjs` | 기본 정책 = 중계기. 정책 훅이 `{route, filterResponse}` 를 줄 수 있게 |
| `test/mediator.test.mjs` | 13건(정책표 주도) |
| `test/isolation.test.mjs` | 2건(격리 행렬, 로컬 픽스처) |

## 검증 (전부 종료 코드)

| 명령 | 결과 |
|---|---|
| `cd packages/ego-host && npm test` | **EXIT=0** — tests 125, pass 123, fail 0, todo 2 |
| `node --test test/mediator.test.mjs test/isolation.test.mjs` | EXIT=0 — 15건 |
| `node scripts/sync-ego-lite.mjs --check` | EXIT=0 (126개 파일) |
| `npx tsc -p tsconfig.json` (worktree 루트) | EXIT=0 |
| `pnpm test` (worktree 루트) | EXIT=1 — 실패 7건이 기준선과 동일, 새 실패 0 |
| `pgrep -f 'naia-ego-marker'` (테스트 뒤) | 0건 |

남은 todo 2건은 `cancel`·`no-interference` 로 둘 다 S2e 다.

## 소스 스캔 ↔ 정책표

`node scripts/scan-cdp-methods.mjs` (계약 4.3.2 가 지목한 `driver/*.ts`·`element-resolver.ts`·
`browser-runtime.ts`): **메서드 26개, 호출 자리 57곳**.

```
Accessibility.getFullAXTree  Browser.setDownloadBehavior  DOM.getBoxModel  DOM.resolveNode
DOM.setFileInputFiles  Input.dispatchKeyEvent  Input.dispatchMouseEvent  Input.insertText
Network.disable  Network.enable  Network.getResponseBody  Page.captureScreenshot  Page.enable
Page.getFrameTree  Page.navigate  Page.screencastFrameAck  Page.setDownloadBehavior
Page.startScreencast  Page.stopScreencast  Runtime.callFunctionOn  Runtime.evaluate
Runtime.releaseObject  Target.activateTarget  Target.attachToTarget  Target.closeTarget
Target.getTargets
```

`--all`(벤더 `src` 전체, 테스트 제외): **27개, 60곳** — `Page.reload` 하나가 더 나온다
(`helpers.ts:697`). 미분류는 양쪽 다 **0** 이고, 테스트 파일 최상위에서 검사하므로 하나라도
빠지면 테스트가 하나도 돌지 않고 파일이 통째로 실패한다(수집 단계 실패).

정책표 76개의 등급 분포:

| 등급 | 수 | 비고 |
|---|---|---|
| deny | 9 | setAutoAttach·attachToBrowserTarget·sendMessageToTarget·exposeDevToolsProtocol·setIgnoreCertificateErrors·clearBrowserCookies·clearBrowserCache·setFileInputFiles·Page.crash |
| supervisor-only | 6 | createBrowserContext·disposeBrowserContext·getBrowserContexts·detachFromTarget·runIfWaitingForDebugger·Browser.close |
| context | 9 | createTarget, 두 setDownloadBehavior, Storage 4, 권한 2 |
| session | 35 | |
| operation | 12 | 자원 결속은 S2e |
| target-ledger | 5 | |

## 격리 행렬 (실 Chromium + 로컬 픽스처 `http://127.0.0.1:<임의 포트>`)

공간 A 에 심고 → A 에서 보이는 것을 먼저 확인하고 → 같은 출처를 공간 B 에서 열어 확인했다.
(없음만 확인하면 "심기 실패"와 "격리 성공"을 구별할 수 없다.)

| 축 | 심은 방법 | A 에서 | B 에서 |
|---|---|---|---|
| 쿠키 | `document.cookie = 'naia582=planted'` | `naia582=planted` 보임 | 빈 문자열 |
| localStorage | `setItem('naia582','planted')` | `planted` | `null` |
| IndexedDB | `indexedDB.open('naia582')` | `databases()` 에 `naia582` | `[]` |
| CacheStorage | `caches.open('naia582').put(...)` | `keys()` 에 `naia582` | `[]` |
| 서비스 워커 | `navigator.serviceWorker.register('/sw.js')` | 등록 1건 | 0건 |
| 권한 | `Browser.grantPermissions(geolocation)` | `granted` | `granted` 아님(`prompt`) |
| 다운로드 | `location.href='/download.bin'` (첨부) | `<ADK>/ego-host/downloads/<A>/naia-582.bin` | 그 디렉터리 비어 있음 |

그리고 B 를 연 뒤에도 A 의 쿠키·다운로드는 그대로다(격리가 한쪽만 지우는 것이 아니다).
공간을 닫으면 그 컨텍스트의 저장소가 함께 사라지는 것도 별도 테스트로 확인했다.

인증서 예외의 공유 범위는 계약 10절의 양보 대상이라 검증하지 않고
`Security.setIgnoreCertificateErrors` 를 거부하는 것으로 대신했다.

## 정책표 주도 테스트

- 거부·감독자 전용 **15개 셀 전부**를 표에서 읽어 하나씩 보내고, 응답이 `{id, error}` 이며
  **원래 id** 를 달고 오는 것을 확인한다. `onSendCDPMessageError`(id 없는 통로)는 쓰지 않는다.
- 거부가 옆 요청을 죽이지 않는 것: 같은 tick 에 정상→거부→정상 셋을 넣고 양쪽 정상 요청의
  값(2, 4)이 그대로 오는 것을 확인한다.
- 컨텍스트 강제: `Target.createTarget` 이 **재작성된 인자로 Chromium 에 도달**하는 것을
  백엔드로 나간 실제 메시지에서 확인하고, `Target.getTargetInfo` 로 브라우저에게 되물어
  같은 `browserContextId` 인 것을 확인한다. 남의 컨텍스트를 지정하면 `EGO_CONTEXT_MISMATCH`.
  `Browser.setDownloadBehavior` 와 `Page.setDownloadBehavior` **둘 다** `downloadPath` 가
  공간 디렉터리로 재작성된다(한쪽만 막으면 우회된다).
- 세션 소유: 남의 세션 id 로 부르면 `Session not found`, 세션 없이 부르면 거부.
- Target 장부: 남의 공간 타깃에 대한 attach·activate·close·getTargetInfo 전부 거부,
  `Target.getTargets` 결과는 내 공간 것만. 비 flatten 첨부는 거부.
- 두 연결이 각자 id 1 로 서로 다른 공간을 써도 응답 값과 이벤트가 섞이지 않는다(실브라우저).

## 계약과 달랐던 판단

1. **소스 스캔 범위를 벤더 `src` 전체로 넓혔다.** 계약 4.3.2 는 `driver/*.ts`·
   `element-resolver.ts`·`browser-runtime.ts` 세 자리를 지목하는데, `helpers.ts:697` 이
   `Page.reload` 를 부른다. 계약이 지목한 범위만 보면 이 메서드가 표에 없어도 게이트가
   통과한다. 그래서 스캐너에 `--all` 을 두고 테스트는 **둘 다** 검사한다.
2. **스캔은 문자열 리터럴이 아니라 호출 자리를 본다.** 리터럴을 통째로 긁으면 이벤트 이름
   (`Page.screencastFrame`, `Network.loadingFinished` 등)까지 들어와 정책표가 이벤트로
   오염된다. `cdp(...)`·`rawCdp(...)`·`browserCdp(...)`·`send(cdp, ...)` 의 첫 문자열 인자만
   뽑는다(주석은 먼저 지운다).
3. **정책표 항목에 `session` 필드를 하나 더 뒀다.** 계약이 적은 모양은 `{scope, args?}` 다.
   그런데 작업 등급 중 `Browser.cancelDownload`·`IO.read`·`IO.close` 는 브라우저 수준이라
   세션이 아예 없다. 세션을 요구하면 취소 훅(4.7)이 돌지 못하므로 `session:false` 로 끈다.
   `Page.setDownloadBehavior` 는 반대로 컨텍스트 등급이면서 세션 위에서 도는 유일한 예라
   `session:true` 를 명시했다.
4. **`args` 는 검사기가 아니라 재작성기다.** 컨텍스트 강제는 "검사"만 하면 인자를 비워 보내는
   호출이 기본 컨텍스트로 새어 나간다. 그래서 같은 함수가 검사하고 채워 넣는다.
5. **원시 CDP 로 만든 탭도 장부에 묶는다.** 연결이 `Target.createTarget` 을 직접 부르면 그
   탭은 RPC `createTab` 을 안 지나므로 장부에 없었다. 그러면 바로 뒤의 `Target.getTargetInfo`
   가 "장부에 없는 타깃"으로 거부된다. 응답을 받을 때 연결이 고른 공간에 묶도록 했다.
   다만 그렇게 만든 탭은 ABI `listTabs` 목록에는 들어가지 않는다(벤더는 `createTab` RPC 를
   쓴다). 이 비대칭은 S2e·S3a 에서 탭 목록을 장부에서 뽑을 때 정리한다.
6. **S2c 의 `createLedgerRoute` 를 지웠다.** 중계기가 그 자리를 완전히 대신한다(감독자 전용
   목록이 정책표 안으로 들어갔다). 남겨 두면 두 개의 정책이 공존해 어느 것이 도는지 코드를
   읽어야 알게 된다.
7. **정책 훅이 응답도 정형한다.** 계약은 "`Target.getTargets` 결과와 이벤트를 연결 소유로
   필터"라고만 적는다. 이벤트는 mux 가 소유 기준으로 이미 거르지만 응답은 거를 자리가
   없어서 `filterResponse` 훅을 mux 에 하나 더 뒀다(감독자 자신의 요청에는 걸지 않는다).

## S2e 로 넘긴 훅

- **`operationHook(method, params, ctx)`** — `mediator.mjs` 의 인자로 이미 자리가 있고 지금은
  `null` 이다. 작업 장부가 생기면 여기서 `Network.getResponseBody` 의 `requestId`,
  `Runtime.callFunctionOn`·`releaseObject` 의 `objectId`, `Browser.cancelDownload` 의 GUID,
  `IO.read/close` 의 스트림 핸들을 작업에 결속한다. **이번 슬라이스의 작업 등급은 세션 소유
  까지만 강제한다.**
- `Page.screencastFrameAck` 의 프레임 토큰(`params.sessionId`)은 세션이 아니므로 장부 조회를
  하지 않는다(계약 4.3.1). 프레임 토큰과 작업의 결속도 S2e 다.
- `Runtime.terminateExecution` 의 세션당 배타 슬롯(같은 세션에 다른 작업이 없을 때만),
  `Fetch.disable`·`Network.disable` 의 도메인 참조 횟수 — 둘 다 계약 4.7 이고 S2e 다.
- 캡처·스냅샷의 실제 렌더러와 무간섭 세 겹도 S2e 다(todo 2건이 그 자리다).
