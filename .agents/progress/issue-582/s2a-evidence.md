# S2a 증거 — 감독자 RPC 전송 계층·CDP 다중화·ego 프록시·런처·출처 게이트 (2026-09-09)

대상: 계약 `docs/progress/issue-582-ego-browser-host.md` 5판의 9절 S2a 행(4.2·4.2.1·4.3.1·4.4·4.8·6절).
worktree `feat/582-ego-browser-host`. 실브라우저는 이 슬라이스에 없다 — CDP 백엔드는 가짜다.

## 만든 것

| 자리 | 무엇 |
|---|---|
| `src/errors.mjs` | `{error, error_code}` 한 모양. 던지는 길과 resolve 하는 길이 같은 객체를 쓴다 |
| `src/supervisor/rpc-framing.mjs` | 4바이트 BE 길이 접두, 상한 8MiB, 스트림 디코더 |
| `src/supervisor/socket-path.mjs` | 소켓 경로 결정 한 곳. linux·darwin unix 소켓(104바이트 상한 검사), win32 named pipe |
| `src/supervisor/rpc-server.mjs` | 연결별 핸드셰이크·선택 공간·유한 송신 큐·단일 FIFO, RPC 표면 |
| `src/supervisor/cdp-mux.mjs` | 연결별 id 공간, Chromium 쪽 id 만 재작성, 세션 라우팅·이벤트 필터, 정책 훅 |
| `src/supervisor/task-space-ledger.mjs` | **임시** 인메모리 장부(S2c 가 대체한다) |
| `src/client/rpc-client.mjs` | 동기 `sendCdp`, RPC 호출, 대기 중에만 소켓 ref |
| `src/client/ego-proxy.mjs` | `globalThis.ego` 12 메서드 + 콜백 두 개 |
| `src/client/preload.mjs` | 최상위 await 핸드셰이크, 벤더 정적 import 없음, `isMainThread` 방어 |
| `bin/ego-browser.mjs` | `nodejs [--sdk-path <dist>]` → `node --import <preload> <dist>/index.js` |
| `scripts/sync-ego-lite.mjs` | `--provenance` 추가(트리 실체화 후 형식·모드·심링크·바이트·누락·추가 비교) |

## 검증 (전부 종료 코드)

| 명령 | 결과 |
|---|---|
| `cd packages/ego-host && npm test` | **EXIT=0** — tests 68, pass 63, fail 0, todo 5 |
| `node scripts/sync-ego-lite.mjs --check` | EXIT=0 (126개 파일) |
| `node scripts/sync-ego-lite.mjs --provenance --source <로컬 클론>` | EXIT=0 (126개 항목, 형식·모드·심링크·바이트) |
| `npx tsc -p tsconfig.json` (worktree 루트) | EXIT=0 |
| `pnpm test` (worktree 루트) | EXIT=1 — 실패 7건이 기준선과 파일·테스트 이름까지 동일(diff 0), 1622 passed |
| `bash scripts/enforce-root-structure.sh` | EXIT=1 — 기존 위반 2건(`tmp/`, `tsconfig.build.json`)만 |
| `node scripts/check-file-anchors.mjs` | EXIT=0 |
| `node scripts/check-traceability.mjs --enforce` | EXIT=0 |

테스트 68건의 내역: `vendor-install` 6(S1), `conformance` 24, `handshake` 11,
`rpc-transport` 16, `provenance` 6, 그리고 아직 골격인 todo 5건.

남은 todo 5건은 전부 S2a 범위 밖이다: `isolation`(S2d 격리 행렬), `mediator`(S2d 행렬),
`lease`(S2b), `cancel`(S2e), `no-interference`(S2e·실브라우저). S2a 가 채워야 했던
`conformance`·`handshake` 두 골격은 실제 테스트로 바뀌었다.

## ABI 문서 행 ↔ 테스트

`docs/ego-runtime-abi.md` 의 표 각 행 끝에 `— 테스트: <파일> "<이름>"` 을 붙였다(열 추가 없음).
슬라이스가 적힌 행(`**S2b**` 등)은 아직 테스트가 없고 그 슬라이스가 든다. 0~9절 전 행에 표기했다.

S2a 가 실제로 밟는 행은 다음과 같다.

| ABI 절 | 행 | 테스트 |
|---|---|---|
| 0 | 필수 12 메서드·표면 판정 | `ABI 0: isBrowserRuntime 이 참이고 필수 12 메서드가 모두 함수다` |
| 0 | 콜백 두 개를 덮어쓰지 않음 | `ABI 0: 런타임이 대입한 onCDPMessage·onSendCDPMessageError 를 감독자가 덮어쓰지 않는다` |
| 1 | 요청 모양·id 보존 | `ABI 1: 요청 id 를 보존한 응답이 대기 항목을 푼다` |
| 1 | 오류 응답 `{id, error:{message}}` | `ABI 1: 오류 응답 {id, error:{message}} 는 그 요청만 거부한다` |
| 1 | 15초 제한 | `ABI 1: 감독자 상한이 런타임 15초 타임아웃보다 먼저 원래 id 오류를 돌려준다` |
| 1 | 동기 throw | `프레이밍: 상한을 넘는 프레임은 보내기 전에 형식 있는 오류로 거부된다` |
| 1 | 세션 상실 문구 재시도 | `ABI 1: 세션 상실 문구에 런타임의 자동 재접속이 돈다` |
| 1 | 이벤트 순서·상한 | `Chromium 에서 받은 응답·이벤트는 단일 FIFO 순서를 유지한다`, `이벤트 폭주로 송신 큐가 넘치면 그 연결만 끊기고 다른 연결은 산다` |
| 2 | id 없는 통로의 영향 범위 | `ABI 2: 연결이 죽으면 onSendCDPMessageError 가 in-flight 전부를 같은 오류로 거부한다` |
| 3 | flatten·`Page.enable` 뒤 이벤트 지속 | `ABI 3: attachToTarget flatten 뒤 Page.enable 은 세션당 한 번이고 이벤트가 계속 온다` |
| 3 | 세션 버리기 | `중첩 params.sessionId 는 Target.attachedToTarget 에서만 세션으로 해석된다` |
| 4 | `{tabs}` 모양·항목 필드·active | `ABI 4: listTabs 는 {tabs} 를 주고 항목이 {targetId,title,url,active} 다` |
| 4 | `createTab` → `targetId` | `ABI 4: createTab 은 targetId 를 주고 새 탭이 목록에 들어온다` |
| 4 | `{error}` resolve 승격 | `공간을 고르지 않은 연결의 listTabs 는 형식 있는 오류다` |
| 5 | `{taskSpaces}`·숫자 id·ownership | `ABI 5: listTaskSpaces 는 {taskSpaces} 와 숫자 id, ownership 'agent' 를 준다` |
| 5 | 연결별 선택 공간 | `ABI 5: 선택 공간은 연결별이라 두 CLI 가 서로 다른 공간에서 일한다` |
| 6 | 미지 코드 + 사람이 읽을 설명 | `ABI 6: 헤드리스 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 와 설명으로 거부된다` |
| 7 | `{content, refs}`·ref 키 | `ABI 7: snapshot 은 {content, refs} 를 주고 ref 키가 backendNodeId 와 같다` |
| 7 | snapshot 만 reject | `ABI 7: snapshot 은 resolve 가 아니라 reject 로 사람 제어를 알린다` |
| 8 | spawn 시점 환경 | `ABI 8: EGO_BROWSER_AGENT_WORKSPACE 의 agent_helpers.js 가 spawn 시점 환경으로 잡힌다` |
| 9 | 런처·stdin·출력 통로 | `ABI 9: 런처가 nodejs 를 받아 stdin 을 그대로 넘기고 console.log 가 stdout 으로 나온다` |
| 9 | `--sdk-path` | `ABI 9: 런처가 --sdk-path 로 받은 dist 를 쓴다` |
| 9 | 형식 있는 사용법·SDK 부재 오류 | `ABI 9: 런처 인자가 틀리거나 sdk 가 없으면 형식 있는 오류로 끝난다` |
| 9 | 호스트 부재 | `ABI 9: 호스트가 없으면 첫 ego 접촉에서 형식이 맞는 오류로 죽는다` |
| 9 | `getBrowserVersion` 침묵 | `ABI 9: getBrowserVersion 이 고정 문자열이라 업데이트 알림이 침묵한다` |

### 이 슬라이스가 밟지 못한 행 (명시)

- **선택 메서드** `animationHighlightMouseToPosition`·`setAgentTaskState` — 구현하지 않는다.
  헤드리스에는 시각 강조도 상태 표시도 없고, 런타임이 `?.` 로 degrade 한다. 문서에 "범위 밖"으로 적었다.
- **`Page.javascriptDialogOpening/Closed` 추적**(3절), **캡처 임시 경로**(7절 마지막 행),
  **`Target.activateTarget/closeTarget` 전환·닫기**(4절 마지막 행) — S2d·S2e.
- **`completeTaskSpace{keep:false}`·`closeTaskSpace` 의 실제 컨텍스트 정리** — S2c.
- **사용자 소유 공간 표**(5절 두 번째 표)의 대부분 — 헤드리스에서 도달 불가능한 상태다.
  거부가 오는 자리는 `ABI 6` 이 확인한다.
- **`.env` 두 곳 읽기·`EGO_BROWSER_NAME`·`HOME`/`USERPROFILE` 주입** — S3a 어댑터가 든다.

## 계약과 달랐던 판단

1. **`useTaskSpace` 를 관측 RPC 로 분류했다.** 계약 4.4 는 "grant 없는 연결은 관측 RPC 외 거부"만
   적는다. 공간 선택은 브라우저를 바꾸지 않고 **연결별 상태**만 바꾸므로 관측 쪽에 뒀다.
   막으면 관측 연결이 아무것도 볼 수 없어 "관측은 허용"이 빈 말이 된다. 근거를
   `OBSERVE_RPCS` 주석에 남겼다.
2. **감독자 상한을 13초로 못 박았다.** 계약은 "14초 미만"만 적는다. 13초를 상수로 두고
   테스트가 `< 14000` 과 `< 15000`(런타임 상수)을 둘 다 읽는다.
3. **핸드셰이크 `deadline` 은 짧은 쪽이 이긴다.** 계약에 방향이 없었다. 호출자가 긴 시한을 적어
   감독자 상한을 늘리는 길을 막았다.
4. **attach 요청 시점에 타깃 예약을 넣었다.** 계약 4.3.1 의 "응답이 오기 전에 예약한다"를 따랐다.
   다만 세대(generation)·묘비·`EGO_TARGET_BUSY` 배타 arbitration 은 **S2c/S2d 의 `route` 훅**에
   맡기고 여기서는 이벤트 라우팅에 필요한 소유만 기록한다. 예약 없이는 attach 응답보다 먼저 온
   이벤트에 주인이 없어 조용히 버려진다(테스트가 이 순서를 강제한다).
5. **주인 없는 이벤트는 버린다(fail-closed).** 계약은 "연결이 소유한 타깃·세션으로 필터"만 적고
   미소유 브라우저 수준 이벤트의 처분을 적지 않았다. 방송하면 그것이 곧 누수라 버리고,
   버린 사실을 `mux.inspect().droppedEvents` 에 남긴다.
6. **`snapshot` 을 감독자가 실제로 구현했다.** S2a 는 전송 계층이지만, ABI 7 행(`{content, refs}`,
   ref 키 = `String(backendNodeId)`)을 벤더 런타임으로 통과시키려면 응답이 실제로 있어야 한다.
   가짜 백엔드의 `Accessibility.getFullAXTree` 를 최소 렌더러로 옮긴다. **실 AX 렌더러와 캡처는 S2e** 다.
7. **`npm test` 를 `--test-concurrency=1` 로 돌린다.** `vendor-install` 과 `provenance` 가 같은 벤더
   파일을 잠시 변조했다 되돌리므로 병렬로 돌면 서로의 복원을 밟는다. 이유를 package.json 에 적었다.
8. **클라이언트 소켓을 대기 중에만 ref 한다.** 계속 unref 하면 `await ego.listTabs()` 하나만 남았을 때
   이벤트 루프가 비어 최상위 await 가 미해결로 프로세스가 13번으로 죽는다(실제로 밟았다).
   계속 ref 하면 스크립트가 끝나도 CLI 가 안 죽는다.
9. **하드 스톱 관측은 stderr 로 한다.** `EGO_TASK_SPACE_*` 가 걸리면 벤더 출력 싱크가 stdout 버퍼를
   버리고 안내문으로 갈아치운다. 그래서 그 테스트만 `console.error` 로 관측한다(테스트 지그에 기록).
10. **`cdp()` 는 응답 봉투가 아니라 `.result` 를 돌려준다**(`src/cdp-eval.ts:12-16`). ABI 문서 1절이
    응답 봉투 기준으로 적혀 있어 처음 테스트가 어긋났다. 문서는 런타임 내부 계약을 옳게 적은 것이고
    헬퍼 표면이 한 겹 벗긴다는 사실만 테스트 주석에 남겼다.

## OS 세 갈래 (루크 추가 지시)

- 소켓 경로 결정은 `src/supervisor/socket-path.mjs` **한 함수**에 모았다. `platform` 을 인자로 받아
  주입 가능하고, `process.platform` 분기는 그 파일과 `bin/ego-browser.mjs` 밖으로 나가지 않는다.
- linux·darwin 은 unix 소켓이며 경로가 104바이트를 넘으면 bind 전에 던진다(ADK 경로 대신 sha256 앞 12자).
- win32 는 `\\.\pipe\naia-ego-host-<해시>` named pipe. 디렉터리도 unlink 도 없다.
- 런처·preload·클라이언트는 `path` 모듈·배열 인자·`shell:false` 만 쓴다. 경로 구분자·줄바꿈·셸 인용
  가정이 없다.
- 테스트가 세 플랫폼 값을 각각 주입해 형식을 검증한다(`소켓 경로: linux·darwin 은 unix 소켓, win32 는
  named pipe 다`). **실행 실측은 linux 뿐이다. darwin·win32 는 단위 수준까지이며 미실측이다.**
  README 의 OS 표에도 "미실측"으로 적었다.

## 벤더 무결성

벤더 파일은 한 글자도 고치지 않았다. 변조 탐침이 도는 테스트가 다섯 개지만 전부 원본 바이트를
메모리에 들고 있다가 `finally` 에서 되돌리고, 되돌린 뒤 다시 `--provenance` 0 을 확인한다.
커밋 시점의 `--check`·`--provenance` 는 둘 다 0 이다.
`dist/`·`node_modules/` 는 벤더 `.gitignore` 와 `IGNORED_VENDOR_PATHS` 양쪽이 무시한다.
