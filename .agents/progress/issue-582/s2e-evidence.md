# S2e 증거 — 작업 장부·취소 훅·접근성 스냅샷·캡처·무간섭 (2026-09-10)

대상: 계약 `docs/progress/issue-582-ego-browser-host.md` 5판의 9절 S2e 행(4.3.2 작업·자원 소유
강제, 4.4, 4.5, 4.6, 4.7). worktree `feat/582-ego-browser-host`. 실 Chromium(Playwright
chromium 1234) + 로컬 HTTP 픽스처.

## 만든 것

| 자리 | 무엇 |
|---|---|
| `src/supervisor/operations.mjs` | 작업 장부. 자원 결속(requestId·objectId·다운로드 GUID·IO 핸들·screencast 프레임 토큰), 세션당 배타 슬롯, 도메인 참조 횟수, 취소 훅, deadline |
| `src/supervisor/ax-snapshot.mjs` | 실 접근성 스냅샷(`Accessibility.getFullAXTree` + `DOM.getDocument` 로케이터), 본문 형식 `[ref=N, loc=…, url=…]`, 노드·깊이 상한, 화면 캡처(감독자가 정한 증거 경로) |
| `src/supervisor/mediator.mjs` | `operationHook` 을 **허용된 모든 메서드**에 건다(배타 슬롯·참조 횟수가 세션 등급 메서드에 걸리기 때문). 인자 재작성을 훅보다 먼저 |
| `src/supervisor/cdp-mux.mjs` | `observer` 이음매(요청 종결·이벤트), `rejectOperation`(원래 id 오류로 in-flight 끊기), 감독자 자신의 attach 표시 |
| `src/supervisor/ledger.mjs` | 감독자 세션(host session) 구분, `claimTarget` 이 탭 목록에도 넣음(listTabs 비대칭 해소) |
| `src/supervisor/rpc-server.mjs` | 연결마다 뿌리 작업, `beginOperation`·`cancelOperation`·`endOperation`·`listOperations`·`screenshot` RPC, 임시 스냅샷 → 실 스냅샷 |
| `src/client/rpc-client.mjs` | `sendCdp(payload, {operationId})` — 한 연결이 작업을 여럿 가질 때의 표시 |
| `test/cancel.test.mjs` | 5건(취소·미소유 자원·동시 작업 무간섭·deadline·배타 슬롯) |
| `test/snapshot.test.mjs` | 6건(ref 실요소 확인·옵션·벤더 런타임 대조·캡처·관측 연결·탭 목록) |
| `test/operations.test.mjs` | 4건(도메인 참조 횟수·소유 없는 스트림·본문 잘림·로케이터) |
| `test/no-interference.test.mjs` + `test/helpers/no-interference-probe.mjs` + `test/helpers/x-display.mjs` | 무간섭 세 겹과 **계기 살아 있음 증명** |

## 검증 (전부 종료 코드)

| 명령 | 결과 |
|---|---|
| `cd packages/ego-host && npm test` | **EXIT=0** — tests 139, pass 139, fail 0, **todo 0** |
| `node --test test/cancel.test.mjs` | EXIT=0 — 5건 |
| `node --test test/snapshot.test.mjs` | EXIT=0 — 6건 |
| `node --test test/operations.test.mjs` | EXIT=0 — 4건 |
| `node --test test/no-interference.test.mjs` | EXIT=0 — 1건 |
| `node scripts/sync-ego-lite.mjs --check` | EXIT=0 |
| `npx tsc -p tsconfig.json` (worktree 루트) | EXIT=0 |
| `pnpm test` (worktree 루트) | EXIT=1 — 실패 7건이 기준선(`baseline-root-test-20260909.txt`)과 **파일·이름까지 동일**, 새 실패 0 |
| `pgrep -f 'naia-ego-marker'` (테스트 뒤) | 0건. cage 잔류 프로세스도 0 |

S2d 의 125건(todo 2) → S2e 의 139건(todo 0). 늘어난 14건이 취소 5 · 스냅샷 6 · 작업 4 ·
무간섭 1 에서 todo 2 를 뺀 수다.

## 무간섭 검증에 쓴 수단 — 왜 Xvfb 가 아닌가

계약 4.6·4.9 는 "Xvfb + xdotool 필수, 없으면 RED" 라고 적는다. 이 머신(linux3090)에는
**`xdotool` 은 있고 `Xvfb` 는 없다**. 그리고 사람 세션이 Wayland 라, `:0` 에서 재면 검사가
죽는다는 것을 먼저 실측했다.

```
$ DISPLAY=:0 xdotool getactivewindow      → 2097152 (세 번 연속 같은 값)
$ DISPLAY=:0 xdotool getwindowname 2097152 → (빈 문자열)
$ DISPLAY=:0 xdotool getwindowpid 2097152  → "window 2097152 has no pid associated with it."
$ DISPLAY=:0 xdotool search --pid <임의>    → (언제나 빈 결과)
```

즉 `:0` 에서는 활성 창 값이 **바뀔 수 없는 값**이라 "전후 동일"이 언제나 참이고, 창 소유
검사도 언제나 빈 결과다. 그 상태의 초록은 아무것도 증명하지 않는다. 계기를 살리려면 창을
띄워야 하는데 `:0` 에 창을 띄우는 것은 사람 화면을 건드리는 일이라 금지다.

그래서 **`cage` 를 wlroots 헤드리스 백엔드로 띄우고 그 안의 Xwayland 디스플레이(`:1`)** 에서
쟀다(`test/helpers/x-display.mjs`. `Xvfb`+`xvfb-run` 이 있으면 그쪽을 먼저 쓴다. 둘 다 없거나
`xdotool` 이 없으면 던져서 RED 다 — 건너뛰지 않는다).

```
[무간섭] 디스플레이 수단: cage (wlroots 헤드리스 백엔드 + Xwayland)
[무간섭] 활성 창 계기: 4194336 → 6291488 → 4194336
[무간섭] 창 소유 계기: 창 있는 Chromium(pid 2030448)에서 창 1 개 발견
```

| 겹 | 검사 | 계기가 살아 있다는 증명 |
|---|---|---|
| 1 | 실 Chromium `/proc/<pid>/cmdline` 에 `--headless=new` (Chromium 이 argv 를 공백으로 재작성하므로 `\0`·공백 둘 다 경계) | 같은 명령줄에서 다른 인자들도 읽힌다 |
| 2 | 호스트 동작 전후 활성 창 동일 | 창을 하나 더 띄우면 활성 창이 **실제로 바뀌고**(4194336→6291488) 닫으면 되돌아온다 |
| 3 | 감독자 프로세스 트리(`/proc` ppid 추적, 이번 실행 기준 후손 포함)의 어떤 PID 도 `xdotool search --pid` 로 창이 안 잡힌다 | **같은 Chromium 바이너리를 창 있는 모드로** 띄우면 같은 검사가 창을 찾아낸다 |

3겹의 계기 증명에 쓴 창 있는 Chromium 은 cage 안에서만 돌고, `--ozone-platform=x11` 로 X 에
못박아 `xdotool` 이 볼 수 있는 자리에 창을 만든다. 탐침은 시작하자마자 `WAYLAND_DISPLAY` 를
지운다 — 지우지 않으면 창이 Wayland 로 새어 `xdotool` 이 못 보고 3겹이 "창 0" 을 거짓으로
보고한다. 그리고 무간섭을 재는 동안 **에이전트가 실제로 일한다**(공간 생성·탭·이동·스냅샷·
캡처). 아무 일도 안 하고 잰 "창 0" 은 공허하므로 탐침 결과의 `refs > 0` 과 캡처 파일을 함께
판정한다.

## 계약과 달랐던 판단

1. **작업의 경계를 정의해야 했다.** 계약 4.4 는 작업의 상태만 정하고 "CDP 한 통이 어느
   작업의 것인가"는 정하지 않는다. 규칙 둘로 못박았다. (가) **연결마다 뿌리 작업 하나** —
   핸드셰이크의 `operationId` 이며, 표시 없는 CDP 는 전부 그 작업의 것이다(벤더 런타임은
   작업을 모르고 아무 표시도 붙이지 않는다). (나) **한 연결이 `beginOperation` 으로 작업을 더
   열 수 있고**, CDP 프레임에 `operationId` 를 달아 밝힌다. (나)가 없으면 계약 4.7 이 요구하는
   "같은 세션의 다른 작업"을 만들 수 없어 동시 작업 무간섭을 시험할 수 없다. 남의 작업 id 를
   다는 길은 막혀 있다(작업은 연결에 결박된다).
2. **훅을 작업 등급 메서드에만 걸 수 없었다.** S2d 는 `scope:"operation"` 셀에만 훅을 걸었는데,
   계약 4.7 의 배타 슬롯은 `Page.navigate`·`Runtime.evaluate`(세션 등급)에, 도메인 참조 횟수는
   `Fetch.enable`·`Network.disable`(세션 등급)에 걸린다. 훅을 허용된 모든 메서드가 지나게 했다.
3. **취소 훅의 순서를 계약과 다르게 했다 — 가로채기가 이동보다 먼저다.** 계약 4.7 은 이동을
   먼저 적는다. 그 순서로 하면 `Page.stopLoading` 이 멈춘 요청을 먼저 없애 버려 뒤따르는
   `Fetch.failRequest` 가 실패하고, "가로챈 요청을 우리가 끊었다"가 거짓이 된다. 첫 실행에서
   실제로 밟았다(`failedRequests: []`). 순서를 뒤집으니 통과한다.
4. **자원은 사는 세션과 함께 적는다.** `Fetch.failRequest`·`Runtime.releaseObject` 는 세션 위에서만
   도는 명령이라, requestId·objectId 만 들고 있으면 정리가 브라우저 수준으로 나가 조용히
   실패한다. `requestId → sessionId`, `objectId → sessionId` 로 적는다.
5. **감독자 자신의 세션을 장부에서 구분해야 했다.** 스냅샷·캡처는 감독자 내부 CDP 로 도는데
   (S2a 리뷰 지적: 승인 없는 관측 연결도 받아야 한다), 그때 오는 `Target.attachedToTarget` 은
   예약도 소유도 없어 "예기치 않은 자식"으로 보인다. S2c·S2d 의 fail-closed 가 그것을 끊어
   **감독자가 자기 세션을 스스로 끊었다** — 실측: 두 번째 캡처부터 `Session with given id
   not found`. attach 를 보내기 전에 표시해 두고 짝 이벤트는 아무에게도 주지 않고 지나보낸다
   (끊지도 않는다). 이 결함은 S2c·S2d 시점에 이미 있었고 스냅샷을 실 브라우저로 처음 돌린
   이번에 드러났다.
6. **`DOM.resolveNode` 의 objectId 도 작업에 등록한다.** 계약 4.3.2 는 `Runtime.evaluate` 계열만
   적는다. 스냅샷의 ref 로 실제 요소를 잡는 유일한 길이 `DOM.resolveNode` 이고, 여기서 나온
   objectId 를 등록하지 않으면 바로 뒤의 `Runtime.callFunctionOn` 이 "소유하지 않은 objectId" 로
   거부된다 — 스냅샷이 쓸모없어진다.
7. **배타 슬롯은 기다리지 않고 거부한다**(선택지 둘 중 형식 오류 쪽). 코드 `EGO_SESSION_SLOT_BUSY`.
   기다리게 하면 취소·deadline 이 그 대기까지 책임져야 하고, 대기 중인 요청은 벤더 런타임의
   15초 타이머(ABI 1)를 그냥 태운다. 거부는 호출자가 즉시 알고 재시도할 수 있다. 같은 작업의
   재진입은 막지 않는다(한 작업 안의 연속 평가는 정상이다).
8. **`IO.read`·`IO.close` 는 언제나 거부된다.** 스트림 핸들을 만드는 메서드
   (`Fetch.takeResponseBodyAsStream`, `Network.takeResponseBodyForInterceptionAsStream`)가
   정책표에 하나도 없어 소유가 성립할 수 없다. fail-closed 이며 테스트가 그 사실을 고정한다.
   등록 통로는 남겨 뒀다 — 나중에 스트림 메서드가 정책표에 들어오는 날 결속이 이미 있어야 한다.
9. **스냅샷의 `scope` 옵션은 지원하지 않는다(무시하고 전체 문서).** 뷰포트 판정은 노드마다
   `DOM.getBoxModel` 을 불러야 해 왕복이 노드 수만큼 늘고, 헤드리스 창 크기는 사람이 보는
   뷰포트가 아니라 잘라 낼 근거가 없다. 벤더 기본값도 `full_page` 다. ABI 문서 7절에 적었다.
   `includeStableLocator`·`includeActionMarks` 는 지원한다.
10. **`claimTarget` 이 탭 목록에도 넣는다(S2d 가 남긴 비대칭).** 원시 CDP `Target.createTarget`
    으로 만든 탭이 `Target.getTargetInfo` 는 통과하는데 `listTabs` 에는 없으면, 에이전트가 자기가
    만든 탭을 다시 찾지 못한다. 두 표면을 같은 장부에서 뽑는다.
11. **`ABI 7` 적합성 테스트 한 건의 기대를 고쳤다.** 본문 주석이 `[ref=N]` → `[ref=N, loc=…]`
    으로 바뀌었다. 기계 계약은 `ref=N` 과 `refs[].backendNodeId` 가 같은 값이라는 것 하나뿐이고
    (벤더는 본문을 파싱하지 않는다), 형식은 벤더 SKILL.md:182 의 예시를 따른다.

## S2f·S3 으로 넘긴 것

- **`Page.javascriptDialogOpening`/`Closed` 추적**(ABI 3 의 남은 행) — 대화상자 추적은 벤더
  런타임이 하고 우리 몫은 그 이벤트를 세션에 실어 주는 것이다. 실브라우저 적합성으로 S2f 가 든다.
- **벤더 헬퍼 `captureScreenshot()` 경로에 증거 디렉터리 물리기** — 우리 캡처 통로(`screenshot`
  RPC)는 감독자가 경로를 정한다. 벤더 헬퍼를 그대로 쓰는 경로에 `options.path` 를 항상 넣는
  일은 어댑터 몫이다(S3a).
- **다운로드 GUID 결속의 실측** — 등록 통로는 있으나(`Page.downloadWillBegin`·
  `Browser.downloadWillBegin`) 다운로드는 FR-ENV-TOOL.2b(Pending) 라 이번 범위 밖이다.
  `Browser.cancelDownload` 의 소유 검사는 코드로 있고 미소유 거부만 시험된다.
- **작업 상태를 #499 도메인의 5상태와 잇는 일** — 감독자 쪽 작업 장부는 같은 5상태를 쓰지만
  어댑터가 그것을 `EnvOperation` 으로 옮기는 것은 S3a 다.
