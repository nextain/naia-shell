# S3a 증거 — 셸 코어 어댑터·조립 (2026-09-10)

대상: `src/main/adapters/ego-browser-env.ts`, `src/main/composition/index.ts`,
`src/test/env-tool-browser-host.contract.test.ts`, 그리고 그 셋이 요구한 감독자 쪽 면.
계약: `docs/progress/issue-582-ego-browser-host.md` 4.2·4.4·4.5·4.7·4.8·4.9, 9절 S3a 행.

## 1. 검증 (전부 종료 코드)

| 명령 | 결과 |
|---|---|
| `npx tsc -p tsconfig.json` | `EXIT=0` |
| `npx vitest run src/test/env-tool-browser-host.contract.test.ts` | `EXIT=0`, 12건 통과 (실브라우저 9 + 순수 3), todo 0 |
| `pnpm test` | `EXIT=1`, 실패 7건 — `.agents/progress/issue-582/baseline-root-test-20260909.txt` 의 기준선 7건과 **같은 이름**이다. 새 실패 0. 총 1648건 중 1635 통과·4 skip·2 todo(남은 todo 는 S3b 골격 두 건) |
| `cd packages/ego-host && npm test` | `EXIT=0`, 148건 전부 통과 (S2f 시점 146 + S3a 신규 2) |
| `node scripts/check-file-anchors.mjs` | `EXIT=0`, 70 파일 |
| `node scripts/check-traceability.mjs --enforce` | `EXIT=0`, dead-link 0 · orphan 0 |
| `node scripts/check-uc-traceability.mjs` | `EXIT=0`, 새로 끊긴 UC 없음 (baseline 20 유지) |
| `pgrep -f 'naia-ego-[m]arker'` (테스트 뒤) | 없음. 계약 테스트의 `afterAll` 이 감독자를 내린 **뒤** 직접 재고, 남아 있으면 파일 전체를 실패시킨다 |

실브라우저 묶음의 소요는 이 기계에서 약 5초다. Chromium 은 Playwright 배치
(`~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`)를 썼다.

## 2. 감독자를 어떻게 물었나 — 자식 프로세스가 아니라 동적 import

어댑터는 `packages/ego-host/src/host-api.mjs` **한 파일만** 계산된 지정자로 동적 import 한다.
고른 이유는 셋이다.

1. **소유 단계가 하나 줄어든다.** 감독자는 Chromium 의 장기 소유자이고 그 소유자는 셸이다
   (계약 4.8). 감독자를 또 하나의 자식 프로세스로 두면 셸→감독자→Chromium 3단이 되어 가운데
   단이 죽는 경우가 새로 생기고, 파이프 부모 끝의 유일한 소유자라는 불변이 한 단계 멀어진다.
   셸 프로세스 안에서 돌리면 그 경우가 아예 없다.
2. **취소가 소켓을 거치지 않는다.** `CancellationPort.cancel` 은 감독자 작업 장부의
   `operations.cancel` 에 바로 닿는다. 취소가 늦게 도착하는 통로를 하나 줄이는 것이 계약 4.7 의
   요점이라, 이 이득은 부수적이지 않다.
3. **코어 tsconfig 가 다른 길을 막는다.** `rootDir: src` 이고 `.mjs` 는 컴파일 대상이 아니라
   정적 import 자체가 불가능하다. 계산된 지정자의 동적 import 만이 tsc 를 지나면서 런타임에
   실물을 문다.

지정자는 `new URL("../../../packages/ego-host/src/host-api.mjs", import.meta.url)` 다. 소스
(`src/main/adapters/`)에서도 산출물(`dist/main/adapters/`)에서도 저장소 루트로부터 **세 단계
아래**라 같은 상대 경로가 맞는다. 조립·테스트가 다른 구현을 꽂을 수 있도록 `loadApi` 를 열어 뒀다.

프로세스와 파일을 만지는 일은 전부 그 패키지 안에 남겼다. 코어 배포 표면(`src/main`)에는
`node:` import 이 한 줄도 없어야 하고(`core-dist-browser-safety.contract.test.ts`), 그 규칙이
이 설계의 경계를 그대로 정했다 — 어댑터는 **무엇을 넣을지**만 정하고, 넣는 일은 호스트 패키지가 한다.

## 3. 계약과 달랐던 판단

### 3.1 `.env` 는 두 곳이 아니라 **작업 공간 한 곳**에만 놓는다

ABI 8 은 벤더가 `<SDK REPO_ROOT>/.env` 와 `<agentWorkspace>/.env` 두 곳을 읽는다고 적었고,
착수 지시도 "`.env` 두 곳 배치"였다. 두 곳에 놓았다가 **실측으로 되돌렸다.**

`<SDK REPO_ROOT>` 는 벤더 산출물 디렉터리(`vendor/ego-lite/package/ego-browser/dist`)이며 이
기계의 **모든 ADK 가 공유하는 자리**다. 거기에 ADK 별 값을 적자 그 뒤의 모든 벤더 실행이 남의
값을 물고 돌았다 — `packages/ego-host` 묶음의 `ABI 5 실브라우저` 케이스가
`작업 s3a-op-18 는 이 연결의 것이 아니다` 로 실패했다. 코어 계약 테스트가 쓴 작업 id 가 공유
`.env` 를 통해 감독자 묶음의 실행으로 새어 들어간 것이다. 게다가 그 파일에는 **단일 사용
핸드셰이크 토큰**까지 평문으로 남았다.

그래서 규칙을 둘로 좁혔다.

- 자리는 `<ADK>/ego-host/agent-workspace/.env` 하나. ADK 를 따라다니는 자리라 남의 ADK 에
  섞이지 않는다.
- 내용은 ADK 를 따라다니는 값뿐(`ENV_FILE_KEYS` = `HOME`/`USERPROFILE`,
  `EGO_BROWSER_AGENT_WORKSPACE`, `EGO_HOST_EVIDENCE_DIR`). 소켓·토큰·작업 id·시한은 실행마다
  다르므로 **spawn 환경으로만** 간다.

계약 테스트가 이 둘을 반증 가능한 형태로 못 박는다: 작업 공간 `.env` 에
`EGO_HOST_TOKEN`·`EGO_HOST_OPERATION_ID` 가 없고, 공유 자리에는 `.env` 자체가 생기지 않는다.

### 3.2 `script` 의 등급은 `workspace-write` 이고 승인은 따로 요구한다

계약 3절 4번은 heredoc 이 "터미널 실행과 같은 등급"이며 승인이 필요하다고 적는다. 그런데
`capability.ts` 에서 승인이 필요한 등급은 `credential` 이상이고, 터미널 실행의 바닥은
`workspace-write`(승인 불필요)다. 두 문장을 등급 하나로 만족시킬 수 없다.

등급을 `credential` 로 올리는 길은 쓰지 않았다. 그러면 heredoc 하나 때문에 자격증명 등급이
부여돼야 하고, 그것은 "권한은 상속되지 않는다"를 정면으로 어긴다. 대신
`BROWSER_RPCS_REQUIRING_APPROVAL` 이라는 **RPC 단위 승인 목록**을 두고 `script` 만 넣었다.
등급은 터미널 바닥과 같고(`TERMINAL_EXEC_TIER_FLOOR`), 승인은 목록이 요구한다. 승인 없는
호출은 **자식 프로세스가 뜨기 전에** 서비스가 거부한다 — 감독자 핸드셰이크는 마지막 방어선이지
첫 방어선이 아니다. 반증 자리도 함께 뒀다: 나머지 열한 RPC 는 그 목록에 없다.

### 3.3 낡은 참조 판정은 `DOM.resolveNode` 가 아니라 **지금 스냅샷의 refs**로 한다

처음에는 `DOM.resolveNode`·`DOM.getBoxModel` 이 실패하는 것을 낡은 참조로 봤다. 실브라우저에서
**통과했다** — `backendNodeId` 는 문서가 바뀌어도 재사용되므로, 옛 페이지에서 딴 참조가 새
페이지의 엉뚱한 요소로 풀린다. 그대로 뒀으면 "낡은 참조를 막는다"는 초록 위에서 실제로는 다른
요소를 누르고 있었을 것이다.

그래서 참조를 쓸 때마다 감독자 스냅샷을 한 번 조회해 `refs` 에 그 `backendNodeId` 가 있는지 먼저
본다(`assertLiveRef`). 없으면 조작하지 않고 `context-mismatch` 다. 조회는 증거를 남기지 않도록
`snapshot` RPC 에 `record:false` 를 더했다 — 조회마다 파일이 쌓이면 증거 디렉터리가 무엇이 실제
관측이었는지 말해 주지 못한다. 왕복이 하나 늘지만 속도는 이 작업의 주장이 아니다(계약 10절).

### 3.4 작업 종결은 RPC 가 아니라 감독자 장부에 바로 적는다

`endOperation` RPC 는 관측 등급 연결(grant 없음)이 부를 수 없다. RPC 로 적으면 성공한 관측
작업이 장부에 `failed(process-exit)` 로 남아 장부가 거짓이 된다. 어댑터는 감독자와 같은
프로세스에 있으므로 `operations.complete` 를 직접 부른다. 종결은 CAS 라 이미 만료·취소된
작업은 그대로다.

### 3.5 `cancel(unknownId)` 는 상태가 아니라 사실 한 칸으로 구별한다

S0 리뷰 3번. `Termination` 에 `known` 을 더했다. 상태는 `cancelled` 그대로여서 기존 호출부와
테스트가 그대로 돈다(`env-tool-live` 의 "추적하지 않는 작업의 취소는 효과를 지어내지 않는다"
포함). 모르는 작업이면 `known:false` 다.

## 4. 감독자 쪽에 더한 것 (S3a 때문에 필요했다)

| 자리 | 무엇 | 왜 |
|---|---|---|
| `src/supervisor/ledger.mjs` | 탭마다 `urlRevision`, `resources()` | 개정은 장부가 세는 값이라 세션에서는 셀 수 없다. `resources()` 는 계약 4.4 의 공개 자원 모양 |
| `src/supervisor/rpc-server.mjs` | `pageInfo` RPC(관측 등급), `listTaskSpaces` 에 `resources`, `createTaskSpace` 에 `resource`, `snapshot` 의 증거 파일과 `record:false` | 어댑터의 증거 셋 중 `url`·`urlRevision` 이 `pageInfo` 에서 온다. 관측 등급 연결도 주소를 알아야 해서 관측 목록에 넣었다 |
| `src/supervisor/ax-snapshot.mjs` | `writeSnapshotFile` | `snapshotRef` 가 대화 안의 휘발성 문자열이 아니라 다시 열어 볼 수 있는 파일이어야 한다(계약 4.5). 이름 규칙은 캡처와 같은 `<operationId>-<n>` 이고 확장자만 다르다 |
| `src/client/script-runner.mjs` | 런처 자식 spawn, `.env` 쓰기, 디렉터리 만들기 | 코어에 `node:` import 을 둘 수 없다. `process.env` 를 섞지 않는다 — 섞으면 셸의 변수가 에이전트 브라우저로 조용히 샌다 |
| `src/host-api.mjs` | 어댑터가 보는 유일한 면 | 어댑터가 감독자 내부 파일을 여러 개 집어 오면 그 순간 패키지 내부 구조가 코어의 계약이 된다 |
| `test/page-info.test.mjs` | 새 면의 감독자 쪽 테스트 2건 | 이 면이 깨지면 원인은 감독자다. 원인이 있는 자리에서 실패해야 다음 사람이 두 번 찾지 않는다 |
| `test/handshake.test.mjs` | `listTaskSpaces` 응답 모양 단언 갱신 | 그 테스트가 재는 것은 grant 이지 응답 키 목록이 아니다. `taskSpaces`·`resources` 를 각각 본다 |

## 5. 계약 테스트가 실제로 밟은 것

전부 **실제 어댑터 + 실제 감독자 + 실제 Chromium** 이고 페이지는 이 프로세스가 띄운 로컬
픽스처다(외부 네트워크 0). Chromium 이 없으면 건너뛰지 않고 RED 다.

1. 열기·이동·스냅샷·안정 참조 클릭·입력·평가·캡처·닫기. 증거 셋은 파일 존재와 PNG 매직으로
   확인하고, 입력이 실제로 들어갔는지는 평가로 되읽는다.
2. 취소와 완료의 경주 — 먼저 종결한 쪽이 남고, 늦은 종결 시도는 장부에만 남는다.
3. 모르는 작업의 취소가 `known:false` 로 구별된다.
4. 같은 멱등 키의 동시 5건이 포트 호출 1회. 나머지 넷은 `deduplicated`.
5. 실제 상한 만료(2.5초) → `timeout`, 그리고 만료 뒤 같은 세션에서 다음 작업이 돈다 —
   감독자의 배타 슬롯·세션 정리가 실제로 돌았다는 반증 가능한 확인이다.
6. heredoc 실행기 SIGKILL → `process-exit`, 그 뒤 같은 작업 공간에 그대로 재접속(계약 4.8).
   같은 테스트가 `.env` 위생도 확인한다.
7. 낡은 참조와 개정 불일치 — 둘 다 `context-mismatch` 이고, 실패한 조작이 페이지를 바꾸지 않았다.
8. 작업 id 와 자원 id 일치 — 증거 파일 이름이 작업 id 로 시작하고, 만든 공간이 목록에 같은 id 로 있다.
9. 승인 없는 묶음 실행은 포트에 닿기 전에 거부된다(포트 호출 0).

여기에 순수 함수 3건(상대·공백·빈 cwd 에서 같은 환경, 학습 루트와 `~` 확장, 윈도우
`USERPROFILE`·역슬래시)이 ABI 8 의 `**S3a**` 두 행을 채운다.

## 6. 루트 `pnpm test` 에 실브라우저를 넣은 이유

`env-tool-live.contract.test.ts` 는 Herdr 가 없으면 `describe.skip` 한다. 같은 관례를 따르지
않았다. 계약 4.6·9절 S3a 가 "Chromium 부재 = RED" 를 명시하고, 건너뛴 실행은 초록으로 보이며
초록으로 보이는 미검증은 다음 사람에게 "검증했다"로 읽히기 때문이다(이 저장소가 이미 여러 번 겪은
자리다). 대신 값은 치렀다 — 루트 묶음이 약 5초 길어지고, Chromium 이 없는 기계에서는 이 파일이
빨갛다. 그 빨강이 사실이다.

## 7. S4·S6 으로 넘긴 것

- **벤더 헬퍼 `page.screenshot()` 의 증거 경로.** 우리 `screenshot` RPC 는 감독자가 경로를
  정하지만 벤더 헬퍼는 호출자가 정한다. 어댑터는 `EGO_HOST_EVIDENCE_DIR` 을 환경으로 알려 주는
  데까지 했고, heredoc 본문이 그 값을 `options.path` 에 넣게 만드는 것은 스킬 파생본(S4) 몫이다.
  지금은 환경 변수만 있고 강제는 없다 — 그 사실을 여기 적어 둔다.
- **`env_browser_*` 도구와 권한 정책 매핑, 기능 플래그의 실제 읽는 자리(S6a).** 조립은
  `egoHostEnabled(platform, flag)` 와 `makeEnvironmentToolService(deps)` 까지다. `NAIA_EGO_HOST`
  를 환경에서 읽어 넘기는 것은 셸이며, 이 슬라이스는 그 값을 받는 문만 냈다.
- **셸(Rust) 생명주기에 감독자 편입(S6b).** 어댑터는 `stop()`·`restart()`·`switchAdk()` 를
  내놓았고, reset·재시작·종료 경로에 그것을 부르는 일은 S6b 다.
- **다운로드·이벤트 스트림(FR-ENV-TOOL.2b)** 은 Pending 그대로다. 어댑터에 통로를 내지 않았다.
- **좌표 조작 경로**는 포트 계약대로 열어 뒀지만 계약 테스트는 참조 경로만 밟는다. 좌표는 예외
  경로이고(FR-ENV-TOOL.3) 실브라우저에서 좌표를 쓰는 사용자 시나리오가 아직 없다.
