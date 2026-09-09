# S2f 증거 — 실브라우저 적합성·업스트림 e2e 분리·생성된 헬퍼 행렬 (2026-09-10)

대상: 계약 `docs/progress/issue-582-ego-browser-host.md` 5판의 9절 S2f 행(4.2 ABI 표, 1절 "지원
헬퍼 범위는 측정 결과"). worktree `feat/582-ego-browser-host`. 실 Chromium + 로컬 픽스처.

## 만든 것

| 자리 | 무엇 |
|---|---|
| `test/conformance.test.mjs` | 실 감독자 + 실 Chromium + 벤더 런타임으로 ABI 3·4·5·8 의 남은 행 4건 추가(S2a 의 가짜 백엔드 테스트는 그대로 둔다) |
| `scripts/run-upstream-e2e.mjs` | 업스트림 e2e 케이스를 우리 런처·감독자로 실행. 지원 묶음(38) / 형식 있는 거부 묶음(4) / 범위 밖(2) |
| `scripts/probe-helpers.mjs` | 헬퍼 행렬 생성기. 벤더 스킬을 파싱하고 헬퍼마다 독립 heredoc 으로 측정 |
| `docs/helper-matrix.md` · `docs/helper-matrix.json` | **생성물.** 손으로 쓰지 않는다 |
| `test/helper-matrix.test.mjs` | 목록 일치·마크다운 재현·표본 재측정 3건 |
| `docs/ego-runtime-abi.md` | 남아 있던 S2c·S2d·S2e 표시 행 6개에 테스트 이름 병기. 새 행 둘(`--sdk-path` 파일 형태, `ego.helpers` 분기) |
| `bin/ego-browser.mjs` | `--sdk-path` 가 **디렉터리도 파일도** 받는다 |
| `src/supervisor/ledger.mjs`·`cdp-mux.mjs`·`rpc-server.mjs` | 탭 목록을 브라우저와 맞추는 `syncTabs`, `Target.activateTarget`·`closeTarget` 응답의 장부 반영 |

## 검증 (전부 종료 코드)

| 명령 | 결과 |
|---|---|
| `cd packages/ego-host && npm test` | **EXIT=0** — tests 146, pass 146, fail 0, **todo 0** |
| `node scripts/probe-helpers.mjs` | EXIT=0 — supported 35, rejected 4, unsupported 2 (전체 41) |
| `node scripts/probe-helpers.mjs --check` | EXIT=0 — "행렬이 커밋된 파일과 같다" |
| `node scripts/run-upstream-e2e.mjs` | **EXIT=0** — 지원 38/38 통과, 거부 4/4 이 기대한 거부, 범위 밖 2 |
| `node scripts/sync-ego-lite.mjs --check` | EXIT=0 |
| `npx tsc -p tsconfig.json` (worktree 루트) | EXIT=0 |
| `pnpm test` (worktree 루트) | EXIT=1 — 실패 7건이 기준선과 **이름까지 동일**, 새 실패 0 |
| `pgrep -f 'naia-ego-marker'`, `pgrep -x cage` (테스트 뒤) | 각각 0건 |

S2e 의 139건 → S2f 의 146건. 늘어난 7건이 실브라우저 적합성 4 + 헬퍼 행렬 3 이다.

## 업스트림 e2e — 러너가 붙지 않은 이유와 대안

**벤더 러너를 그대로 붙이는 데 실패했다.** 러너는 첫 케이스로 `nodejs bridge smoke` 를 돌리고
실패하면 그 자리에서 전체를 중단한다(`runner.mjs:236-244`). 그 케이스의 통과 조건 하나가
`Object.keys(globalThis.ego.helpers).length > 0` 인데, `ego.helpers` 는 벤더가
`installEgoSdk()` 경로에서만 세우고(`src/index.ts:196`) 그 경로는 **SDK 를 import 할 때만** 도는
가지다(`:256-265`). 우리 런처는 계약 4.2.1 이 못박은 **직접 실행** 경로를 쓰므로
`runMain()` 으로 가고 `ego.helpers` 는 생기지 않는다. 실측:

```
Failures:
  - nodejs bridge smoke: nodejs bridge smoke returned invalid runtime data:
    {"egoType":"object","hasSendCDPMessage":"function","processVersion":"v26.7.0","helperCount":0}
```

`ego.helpers` 를 **흉내 내지 않았다.** 그 값은 "SDK 설치 경로가 돌았다"는 신호이고 우리
경로에서는 실제로 돌지 않는다. 채우면 그 신호가 거짓이 된다. 대신 계약 9절 S2f 가 허용한
대안을 썼다: 벤더의 `cases/index.mjs`·`ego-source.mjs`(공통 전문 포함)·`fixture.mjs` 를
**그대로 import** 해 케이스 본문과 픽스처는 업스트림 것을 쓰고 실행만 우리 런처·감독자로 한다.
`node scripts/run-upstream-e2e.mjs --vendor-runner` 로 위 사실을 언제든 재현할 수 있다(그때는
PATH 앞에 `ego-browser` 껍질을 두고 토큰 발급 창구를 열어 러너를 그대로 돌린다).

`EGO_BROWSER_REAL_E2E_ONLY` 는 러너의 필터라 우리 하네스에서는 케이스 이름 목록으로 같은 일을
한다.

### 세 묶음 (측정 결과, `--all` 로 다시 잰다)

| 묶음 | 수 | 판정 |
|---|---|---|
| 지원 | 38 | 전부 통과해야 스크립트가 0 으로 끝난다 |
| 거부 | 4 | 실패가 정답이되 **우리 거부의 서명**이 있어야 통과 |
| 범위 밖 | 2 | 우리 정책과 무관한 이유로 이 기기에서 실패 |

거부 묶음의 서명:

| 케이스 | 서명 | 이유 |
|---|---|---|
| task spaces and control | `EGO_HANDOFF_UNSUPPORTED_HEADLESS` | 인계·회수·claim 미지원(계약 3절 2) |
| keyboard and file helpers | `DOM.setFileInputFiles` + `EGO_HOST_METHOD_DENIED` | 파일 업로드 거부(4.3.2) |
| keyboard regression | 같음 | 케이스 후반이 업로드를 쓴다 |
| download helpers | `ego-browser-downloads` + **감독자 다운로드 디렉터리에 파일이 실제로 있음** | 다운로드 경로가 공간별 디렉터리로 재작성된다(4.3.2). 오류 문구만으로는 "우리가 옮겼다"와 "그냥 못 받았다"를 구별할 수 없어 파일 위치를 함께 본다 |

범위 밖 둘: `macOS bare Meta input isolation`(케이스가 `process.platform === "darwin"` 을
단언한다. 이 기기는 리눅스), `regression PWB-10 permission capability`(케이스는 브라우저가
`clipboardReadWrite` 권한을 **지원하지 않기를** 기대한다. 일반 Chromium 은 지원한다 — 브라우저
능력 차이이며 우리 정책과 무관하다). 거부 묶음에 넣으면 "우리가 막았다"는 거짓 서명이 되고,
지원 묶음에 넣으면 게이트가 항상 빨갛다.

## 헬퍼 행렬 — 측정 결과 요약

벤더 스킬의 `## Common helpers` 41개를 그 자리에서 파싱해 헬퍼마다 **독립 heredoc**으로 쟀다.

| 판정 | 수 | 목록 |
|---|---|---|
| supported | 35 | 작업 공간 4, 탐색·상태 9, 관측 3, 스크롤·마우스 6, 키보드·입력 4, 대기 4, fetch 2, CDP·평가 2, 출력 1 |
| rejected | 4 | `claimTaskSpace`·`handOffTaskSpace`·`takeOverTaskSpace`(`EGO_HANDOFF_UNSUPPORTED_HEADLESS`), `uploadFile`(`EGO_HOST_METHOD_DENIED`) |
| unsupported | 2 | `scrollToBottomUntil`(고정 커밋 런타임에 그 이름이 없다), `cliLog`(전역이 없어졌다 — 출력은 `console.log`) |

`--check` 가 게이트다: 측정 결과가 커밋된 두 파일과 바이트로 다르면 종료 코드 1. 그래서 생성물에
시각·임시 경로·타깃 id 를 넣지 않고(실행마다 달라져 게이트가 항상 실패한다) 문구를 정규화한다.
테스트(`test/helper-matrix.test.mjs`)는 41개를 다시 재지 않는다 — 41 × 각자 프로세스라 분 단위다.
대신 (1) 목록이 벤더 스킬 파싱 결과와 같은지, (2) 마크다운이 JSON 에서 그대로 렌더링되는지,
(3) 세 판정 종류를 하나씩 뽑은 표본을 **실제로 다시 측정**해 같은 판정이 나오는지 본다.
전수 재측정은 `node scripts/probe-helpers.mjs --check` 의 몫이며 위 표에 종료 코드가 있다.

## 행렬이 잡아낸 결함 셋 (전부 이 슬라이스에서 고쳤다)

측정이 없었으면 셋 다 S3a 어댑터에서야 드러났을 것이다.

1. **닫은 탭이 목록에 유령으로 남았다.** `Target.targetDestroyed` 는 `Target.setDiscoverTargets`
   를 켜야 오는데 그 메서드는 정책표 밖(기본 거부)이라 우리에게 영영 오지 않는다. 그래서
   `Target.closeTarget` **응답**에서 장부를 정리하도록 고쳤다. 그 전에는 벤더 `closeTab` 이
   목록에서 사라지기를 영원히 기다렸다(`closeTab timed out waiting for target to close`).
2. **탭의 주소가 만든 시점 그대로였다.** 그래서 벤더 `openOrReuseTab` 이 이동한 탭을 못 찾아
   매번 새 탭을 열었고, 페이지가 스스로 닫은 탭도 목록에 남았다. `listTabs` 가 줄 때마다
   `Target.getTargets` 로 주소·생존을 맞추도록 했다(짧은 상한 2초. 감독자 상한 13초까지 기다리면
   브라우저가 멈춘 동안 `listTabs` 가 통째로 막히는데, 벤더는 2초마다 이 호출을 한다).
   업스트림 `navigation helpers` 와 `workflow multi-page navigation` 이 이것으로 통과했다.
3. **활성 탭이 안 바뀌었다.** 헤드리스에는 "앞에 있는 창"이 없으므로 활성 탭의 정본은 장부인데,
   `Target.activateTarget` 이 성공해도 장부를 안 바꿨다. 그래서 `currentTab()` 이 옛 탭을 줬다.

## 계약과 달랐던 판단

1. **CDP 거부 문구 끝에 안정 코드를 넣는다.** 벤더 런타임은 CDP 오류에서 `error.message` 만 읽고
   `error.code` 는 버린다(`browser-runtime.ts:245-248`). `{error, error_code}` 로 코드가 살아
   오는 것은 `ego` 메서드 쪽뿐이다(ABI 6). 그래서 CDP 통로로 거부하면 에이전트에게 안정 코드가
   **아예 남지 않았다**. 문구 끝에 `[EGO_HOST_METHOD_DENIED]` 처럼 넣는다. `error.code` 는 그대로
   둔다(우리 클라이언트는 그쪽을 읽는다). 이 변경으로 헬퍼 행렬의 `uploadFile` 이
   `unsupported` 에서 `rejected(EGO_HOST_METHOD_DENIED)` 로 바로잡혔다 — 코드가 안 보이던 동안은
   "우리가 막았다"와 "런타임에 없다"를 구별할 수 없었다.
2. **`--sdk-path` 가 파일 경로도 받는다.** 업스트림 러너는 진입점 파일(`dist/out/index.js`)을
   그대로 넘긴다. 디렉터리만 받으면 그 러너를 벤더 무수정으로 붙일 수 없다(종료 코드 2).
3. **헬퍼 행렬은 스킬의 평면 이름과 런타임의 파사드 호출을 나란히 적는다.** 벤더 스킬 문서가
   런타임보다 낡아(ABI 9절) 스킬의 이름 대부분이 파사드로 옮겨졌다. 이름만 적으면 "지원한다"가
   무엇을 뜻하는지 알 수 없다.
4. **범위 밖 묶음을 하나 더 뒀다.** 계약은 지원/거부 둘만 적는다. 우리 정책과 무관한 이유
   (플랫폼, 브라우저 능력 차이)로 실패하는 케이스를 거부 묶음에 넣으면 "우리가 막았다"는 거짓
   서명이 되고 지원 묶음에 넣으면 게이트가 항상 빨갛다.
5. **가짜 백엔드가 `Target.getTargets`·`Target.closeTarget` 을 흉내 낸다.** 탭 대조가 생기면서
   가짜 백엔드가 자기가 만든 타깃을 기억해야 그 대조가 진짜처럼 돈다. 그리고 목록을 못 읽었을 때
   (`targetInfos` 가 배열이 아닐 때)는 **아무것도 바꾸지 않는다** — 빈 응답을 "타깃이 하나도
   없다"로 읽으면 살아 있는 탭을 장부에서 지운다.

## 링크 — 이미 잰 것

- **리눅스 후손 프로세스 fd 부재, 감독자 SIGKILL → 파이프 EOF → Chromium 소멸(약 200ms)**:
  S2b 가 실측했다. `.agents/progress/issue-582/s2b-evidence.md`, `test/launcher.test.mjs`.
- **취소와 동시 작업 무간섭**: S2e 의 `test/cancel.test.mjs` 5건이 든다(멈춘 이동 + 열린
  가로채기 취소, 미소유 requestId 거부, 같은 세션의 다른 작업 무영향, deadline, 배타 슬롯).
  `.agents/progress/issue-582/s2e-evidence.md`.

## S3 으로 넘긴 것

- ABI 문서에 `**S3a**` 로 남은 두 행: `~` 확장(`HOME`/`USERPROFILE` 절대 경로 주입)과
  작업 공간 `.env` 배치. 둘 다 어댑터가 spawn 시점 환경을 만드는 일이다.
- 벤더 헬퍼 `page.screenshot()` 을 그대로 쓰는 경로에 증거 디렉터리를 물리는 일(`options.path`).
  우리 `screenshot` RPC 는 감독자가 경로를 정하지만 벤더 헬퍼는 호출자가 정한다.
- 다운로드(FR-ENV-TOOL.2b)는 Pending 그대로다. 경로 재작성과 GUID 소유 검사는 있고, 받은 파일을
  자원으로 노출하는 일은 범위 밖이다.
- `regression PWB-10` 이 드러낸 사실 — 우리 Chromium 의 권한 능력이 업스트림 브라우저와 다르다.
  스킬 파생본(S4)에 "권한 능력은 브라우저마다 다르다"를 적을 자리다.
