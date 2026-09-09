# S2c 증거 — 작업 공간·타깃·세션 장부 (2026-09-10)

대상: 계약 `docs/progress/issue-582-ego-browser-host.md` 5판의 9절 S2c 행(4.3.1·4.4).
worktree `feat/582-ego-browser-host`. 실 Chromium(Playwright chromium)으로 검증했다.

## 만든 것

| 자리 | 무엇 |
|---|---|
| `src/supervisor/ledger.mjs` | 작업 공간(=격리 브라우저 컨텍스트) 장부, 배타 타깃 lease(세대·묘비), 세션 장부, 원자적 저장, 멱등 생성, `createLedgerRoute` |
| `src/supervisor/cdp-mux.mjs` | 장부를 라우팅·arbitration 의 정본으로 교체(내부 Map 세 개 제거), attach 예약·정산·철회, 예기치 않은 자식 fail-closed, 인자 재작성 통로 |
| `src/supervisor/rpc-server.mjs` | 임시 장부 → 새 장부, 탭 생성에 `browserContextId` 주입, `closeTaskSpace` 가 컨텍스트까지 폐기, `routeFactory` 이음매 |
| `src/supervisor/supervisor.mjs` | 시작 시 장부 복원(죽은 컨텍스트 정리), 기본 정책 훅 = `createLedgerRoute`, 테스트용 `wrapBackend` 이음매 |
| `test/ledger.test.mjs` | 실브라우저 10건 |
| `test/helpers/live-supervisor.mjs` | 실 감독자 지그 + CDP 통로 껍질(순서 강제·결함 주입) |
| `test/helpers/ledger-writer.mjs` | 저장 원자성 시험용 자식 프로세스 |
| 삭제: `src/supervisor/task-space-ledger.mjs` | S2a 의 임시 인메모리 장부. 새 장부가 ABI 모양을 그대로 이어받아 참조가 남지 않는다 |

## 검증 (전부 종료 코드)

| 명령 | 결과 |
|---|---|
| `cd packages/ego-host && npm test` | **EXIT=0** — tests 112, pass 108, fail 0, todo 4 |
| `node --test test/ledger.test.mjs` | EXIT=0 — 10건 전부 pass |
| `node scripts/sync-ego-lite.mjs --check` | EXIT=0 (126개 파일) |
| `npx tsc -p tsconfig.json` (worktree 루트) | EXIT=0 |
| `pnpm test` (worktree 루트) | EXIT=1 — 실패 7건이 기준선(`baseline-root-test-20260909.txt`)과 동일, 새 실패 0 |
| `pgrep -f 'naia-ego-marker'` (테스트 뒤) | 0건 |

S2a 의 68건 → S2b 의 102건 → S2c 의 112건. 늘어난 10건이 `ledger.test.mjs` 다.
남은 todo 4건: `isolation`·`mediator`(S2d), `cancel`·`no-interference`(S2e).

## 테스트 ↔ 계약 4.3.1 대응

| 계약 문장 | 테스트 |
|---|---|
| 작업 공간 = 격리 컨텍스트, `browserContextId` 는 장부 안에만 | `작업 공간 하나는 격리 브라우저 컨텍스트 하나이고 컨텍스트 id 는 밖으로 안 나간다` |
| 멱등 생성(S0 리뷰 2번) | `같은 idempotencyKey 의 공간 생성 재전송은 같은 공간을 준다` |
| 공간 닫기 = 컨텍스트 dispose + 장부 정리 | `공간을 닫으면 컨텍스트가 사라지고 장부에서 탭·타깃이 함께 나간다` |
| 동시 attach 는 한 연결만, 나머지는 원래 id 로 `EGO_TARGET_BUSY` | `같은 타깃에 두 연결이 동시에 attach 하면 …` (두 연결이 각자 id 1 을 씀) |
| 예약 중 연결 종료 → 예약 철회, 늦은 응답은 감독자가 detach | `예약 중 연결이 끊기면 예약을 철회하고 늦게 온 attach 응답의 세션을 감독자가 detach 한다` |
| 응답→이벤트, 이벤트→응답 두 순서 | `attach 응답과 attachedToTarget 이벤트는 어느 순서로 와도 같은 세션 하나가 된다` |
| 묘비 뒤 재사용 거부 | `detach 된 sessionId 는 묘비로 남아 재사용돼도 옛 세대의 요청을 거부한다` |
| 예기치 않은 자식 attach fail-closed + `waitingForDebugger` 처리 | `예기치 않은 자식 attachedToTarget 은 연결에 안 가고 감독자가 detach 한다` |
| 원자적 저장 | `장부 저장은 원자적이다 — 쓰는 도중 죽여도 이전 파일이 온전하다` |
| 연결 종료 정리는 그 연결에만 | `연결이 끊기면 그 연결의 세션·예약만 걷어내고 다른 연결은 그대로다` |

## 계약과 달랐던 판단

1. **타깃 소유를 둘로 나눴다 — 이벤트 라우팅 주인 ≠ 배타 lease.** 처음에는 탭을 만든 연결에
   lease 를 걸었는데, 그러자 같은 작업 공간을 공유하는 두 번째 연결이 그 탭에 영영 붙지
   못했다(첫 실행에서 실제로 `EGO_TARGET_BUSY` 로 막혔다). 계약 4.3.1 의 배타는 **attach** 에
   대한 것이므로, 탭을 만든 연결은 그 탭의 브라우저 수준 이벤트를 받는 주인으로만 적고
   배타 lease 는 attach 예약에서만 건다.
2. **감독자 자신의 CDP 요청(`hostRequest`)은 장부의 소유를 만들지 않는다.** 감독자가 만든 탭의
   주인이 "감독자"가 되면 정작 그 탭을 쓸 연결이 자기 탭에 못 붙는다. 이것도 첫 실행에서
   실제로 밟았다. 이제 `hostRequest` 응답은 장부를 건드리지 않는다.
3. **대기 항목이 사라진 뒤 도착한 attach 응답도 detach 한다.** 계약은 "예약 중 연결이 끊기면"
   만 적는다. 연결이 끊기면 mux 의 pending 도 함께 걷히므로, 늦은 응답은 주인도 대기 항목도
   없이 도착한다. 그 경우까지 감독자가 세션을 끊도록 했다(사유 `orphaned-attach-response`).
   그러지 않으면 주인 없는 세션이 브라우저에 남아 이벤트를 계속 만든다.
4. **감독자 시작 시 장부 복원은 `Target.getBrowserContexts` 로 검증한다.** 계약은 영속 매핑만
   적는다. 감독자가 다시 시작하면 Chromium 도 새 프로세스라 옛 컨텍스트는 존재하지 않는다.
   복원한 공간 중 살아 있는 컨텍스트가 없는 것은 조용히 걷어낸다(죽은 컨텍스트를 살아 있는
   것으로 들고 있으면 첫 사용에서야 알게 된다).
5. **S2a 테스트 한 건의 기대를 계약에 맞춰 고쳤다.** `rpc-transport.test.mjs` 의
   "중첩 params.sessionId 는 Target.attachedToTarget 에서만 세션으로 해석된다" 는 예약 없는
   자식 세션을 **등록**하는 것을 확인하고 있었다(S2a 시점의 임시 동작). 계약 4.3.1 이
   fail-closed 를 요구하므로, 이제 등록하지 않고 감독자가 detach 하는 것을 확인한다.
   해석 자체(중첩 sessionId 는 이 이벤트에서만 세션, `Page.screencastFrame` 의 것은 프레임
   토큰)는 그대로다.
6. **두 가지는 진짜 브라우저 메시지를 붙잡거나 주입해서 강제했다.** 응답·이벤트 순서는
   Chromium 이 정하므로 **진짜 메시지를 잠시 붙잡았다가** 원하는 순서로 흘려보낸다(만든
   메시지가 아니다). 예기치 않은 자식 `attachedToTarget` 은 auto-attach 를 켜야만 생기는데
   우리는 절대 켜지 않으므로 그 이벤트 하나만 주입한다. 두 자리 모두 `wrapBackend` 라는
   테스트 전용 이음매를 지나며, 운영 경로는 `null` 이다.
7. **`createTaskSpace` 가 `idempotencyKey` 를 받는다.** 계약 4.4 에는 없고 S0 리뷰 2번이
   요구한 것이다. 벤더 런타임은 이 인자를 보내지 않으므로(키 없으면 늘 새 공간) ABI 는
   그대로고, 어댑터(S3a)가 재연결 뒤 같은 키로 재전송할 수 있다.

## S2d·S2e 로 넘긴 것

- **메서드 전수표(기본 거부)** — S2c 의 `createLedgerRoute` 는 감독자 전용 능력
  (`Target.createBrowserContext/dispose/detachFromTarget/setAutoAttach/sendMessageToTarget/
  attachToBrowserTarget/exposeDevToolsProtocol`, `Runtime.runIfWaitingForDebugger`,
  `Browser.close`)만 막고 `Target.createTarget` 에 컨텍스트를 강제한다. 나머지는 S2d.
- **작업·자원 결속**(requestId·objectId·다운로드 GUID·IO 핸들) — S2e 의 작업 장부.
- **`Target.getTargets` 결과 필터·이벤트 필터의 정책화** — S2d.
