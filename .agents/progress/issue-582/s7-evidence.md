# S7 증거 — 구현 적대 리뷰 지적 일곱 건 (#582)

작성 2026-09-10. 대상 리뷰: `.agents/progress/issue-582/codex-impl-review-20260910.md` (P0 1, P1 5, P2 1).
계약: `docs/progress/issue-582-ego-browser-host.md` 3절 4번·4.3.1·4.3.2·4.4·4.7,
`.agents/progress/issue-582/s0-review-fable.md` 마지막 두 절.
worktree `/var/home/luke/alpha-adk/.worktrees/naia-shell-582-ego-host`, 브랜치 `feat/582-ego-browser-host`.

커밋 셋:

- `7b816baa` — `fix(shell): #582 S7 restrict webview commands to fixed-effect ops, Rust-owned grants` (P0)
- `93ea8444` — `fix(ego-host): #582 S7 ledger tombstone reuse, host attach reservation, handshake binding, resource session check, cancel attribution, context arg types` (P1 다섯 + P2)
- `9c36455a` — `fix(ego-host): #582 S7 handshake keeps empty workspaceId as a value, not a type error` (위의 P1-3 이 만든 회귀를 루트 계약 테스트가 잡아 바로 닫은 것)

## 1. 지적별 처리

### [P0] 웹뷰가 승인 장부를 거치지 않고 관리자 토큰·원시 CDP 를 쓸 수 있다

**고친 것.** 메인 웹뷰에 노출하는 Tauri 명령에서 임의 grant 토큰 발급(`ego_host_issue_token`),
아무 관리 RPC 나 부르는 문(`ego_host_rpc`), 아무 등급 연결이나 여는 문(`ego_host_session_open`)을
없앴다. 남은 것은 효과가 고정된 `ego_host_op_*` 이고, 각 명령의 등급은 **그 명령의 이름**이
정한다. Rust 상수 `OP_TIERS` 가 그 표이며 서비스의 `BROWSER_RPC_TIERS` 와 같은 값이어야 한다 —
단위 테스트가 `src/main/app/control/env-tool.ts` 를 **읽어** 칸마다 대조한다(기대값을 적으면 두
표가 갈라진 사실을 못 잡는다. 소켓 경로를 Node 모듈을 실행해 대조하는 것과 같은 이유다).
클라이언트가 실은 `grant`·`approvalRef` 는 `begin_op` 첫 줄에서 버린다. 토큰 발급과 관리 채널은
`ego_host_bridge.rs` 안에서만 쓰인다. 관측 등급 작업은 grant 없이 붙어 원시 CDP 가 Rust
(`ego_host_op_cdp` 의 등급 검사)와 감독자(grant 없는 연결의 CDP 거부) **두 곳**에서 막힌다.
`script` 는 어댑터(`EGO_HOST_SCRIPT_REFUSAL`)와 Rust(`ego_host_op_script`) 양쪽에서
`approval-missing` 으로 거부한다.

**테스트.**
- Rust `ego_host_bridge::tests::the_rust_tier_table_matches_the_service_table_cell_by_cell`
- Rust `ego_host_bridge::tests::a_client_declared_grant_never_reaches_the_tier_decision`
- Rust `ego_host_bridge::tests::script_is_refused_and_unknown_rpcs_are_refused_too`
- Rust `ego_host_bridge::tests::the_script_command_refuses_before_it_can_reach_the_supervisor`
- e2e-tauri `(c2) 웹뷰에는 토큰 발급·원시 CDP 명령이 없고, 조작한 grant 는 Rust 가 버린다`
- vitest `웹뷰는 토큰을 만들지 못한다 — 발급 명령이 아예 없다 (S7 P0)`
- vitest `연결은 RPC 이름이 고른 명령으로 서고, 등급·토큰을 싣지 않는다 (S7 P0)`
- vitest `효과가 고정되지 않은 RPC 로는 연결이 서지 않는다 — 명령이 없다`
- vitest `script 는 토큰 자리에서 먼저 끝난다 — 명령에 닿지 않는다`

**종료 코드.** `cargo test ego_host` 25 passed / EXIT=0. e2e-tauri 풀스택 5 passing / EXIT=0.
`vitest src/lib/__tests__/ego-browser-env-ipc.test.ts` 11 passed / EXIT=0.

**실기 증거.** 제거가 진짜임을 실 Tauri 앱이 말한다 — 첫 시도에서 wdio 가
`WebDriverError: Command ego_host_issue_token not found` 를 던졌다(스펙이 그 예외를 잡지 않아
빨갛게 났고, 잡도록 고친 뒤 통과). 같은 스펙에서 조작한 `{tier:"credential"}` 을 실어
`ego_host_op_snapshot` 을 열어도 등급은 관측이라 그 세션의 CDP 가 `grant-required` 로 막히고,
조작한 `{tier:"observe"}` 를 실어 `ego_host_op_click` 을 열면 CDP 가 그대로 나간다.

### [P1] 묘비 sessionId 재사용

**고친 것.** `settleAttach` 가 성공할 때 `tombstones.delete(sessionId)` 로 묘비를 지우고 같은
값을 새 소유자로 등록했다. 이제 감독자가 사는 동안 묘비 id 는 재등록 자체가 거부되고
(`{ok:false, reason:"tombstoned"}`) 그 attach 는 중계기가 곧바로 detach 한다.
`resolveAttachedEvent` 도 묘비를 맨 앞에서 보고, **알려진 세션**이라도 그 이벤트의 target 과
현재 lease 의 generation 을 검증한다.

**테스트.** ego-host `묘비 sessionId 는 lease 가 살아 있어도 재등록되지 않고 그 attach 는 감독자가 detach 한다`
(실 Chromium. gen1 세션을 탭 종료로 묻고, 새 탭에 **진짜 attach 예약을 살려 둔 채** 옛 값을
재사용하는 `Target.attachedToTarget` 을 주입한다 — Chromium 은 sessionId 를 재사용하지 않으므로
그 순간은 주입으로만 만들 수 있다. 거부 사유가 `unexpected-child` 가 아니라 `tombstoned` 여야
한다는 것이 이 검사의 판별점이다). 지연 요청 쪽은 기존
`detach 된 sessionId 는 묘비로 남아 재사용돼도 옛 세대의 요청을 거부한다` 와 새 테스트 끝의
원래 id 검사가 함께 든다.

### [P1] 호스트 attach 예약 누수

**고친 것.** `targetId -> 횟수` 하나였다. 응답이 먼저 온 순서에서는 응답 경로가 세션만 적고
횟수를 줄이지 않았고, 뒤따라 온 이벤트는 "이미 아는 감독자 세션" 검사에서 먼저 돌아가 예약을
소비하지 않았다. 타임아웃·CDP 오류·송신 실패에서도 예약이 남았다. 남은 예약은 그 타깃의
예기치 않은 자식 attach 가 주워 감독자 세션으로 승인받는 문이다. 이제 **요청 id 를
correlation 으로 삼은 예약 객체**(`hostReservations`)로 들고, 응답 경로는 `settleHostAttach`,
이벤트 경로는 `unconsumedHostReservation` 으로 정확히 한 번 소비한다. 타임아웃·오류·
`deliverCdpFatal`·send 실패 네 자리에서 `cancelHostAttach` 로 걷고, 예약을 못 찾은 늦은 응답은
`rejectChildSession` 으로 detach 한다.

**테스트.**
- ego-host `감독자 attach 예약은 응답·이벤트 두 순서에서 정확히 한 번 소비된다`
- ego-host `attach 가 실패하면 예약이 걷히고 늦게 온 자식 attach 는 그것을 소비하지 못한다`

두 순서와 실패 경로는 어느 쪽이 먼저 올지 Chromium 이 정하므로 실브라우저로는 강제할 수 없다.
이 두 건만 각본 있는 가짜 CDP 백엔드로 돌리고, 그 이유를 테스트 안에 적었다. 같은 파일의
나머지 열한 건은 전부 실 Chromium 이다.

### [P1] 핸드셰이크가 토큰 결박을 덮어씀

**고친 것.** grant 만 대조하고 operation·workspace 는 클라이언트가 보낸 non-null 값을
우선했다. 이제 선언이 있으면 토큰 기록과 **정확히 같아야** 하고, 없으면(`null`·`undefined`)
기록을 쓴다. 문자열이 아닌 값은 명시 거부다.

**테스트.** ego-host `hello 의 operationId·workspaceId 는 토큰 기록과 정확히 같아야 한다`
(정상 일치·작업 불일치·공간 불일치·누락·잘못된 타입 넷·빈 문자열 일치/불일치).

### [P1] 자원의 세션 소유를 기록만 하고 검사하지 않음

**고친 것.** `map.has(id)` 만 봤다. 한 작업이 두 세션을 들면 S1 이 만든 objectId·requestId 를
S2 의 명령에 넣어도 정책층이 통과시켜 Chromium 까지 갔다. 이제 `resourceDenial` 이
`map.get(id) === sessionId` 를 요구하고, **없는 것**(`이 작업이 연 것이 아니다`)과 **남의 세션
것**(`세션 <id> 의 것이다`)을 다른 문구로 나눈다. 다운로드 GUID 와 IO 핸들도 Set 에서 세션
결박 Map 으로 바꿨다(세션이 없는 브라우저 수준 이벤트에서 온 자원은 대조할 세션이 없으므로
작업 소유만 본다 — 없는 사실을 지어내 거부하지 않는다).

**테스트.** ego-host `같은 작업의 두 세션이 서로의 objectId·requestId 를 쓰지 못한다`
(실 Chromium. 한 작업이 탭 둘에 붙고, S1 이 만든 objectId 를 S1 에서 쓰면 통과·S2 에서 쓰면
세션 불일치·없는 id 는 소유 없음).

### [P1] 취소 장벽 뒤 이벤트의 오귀속

**고친 것.** 이벤트 소유자 탐색이 running 작업만 훑어, 종결된 작업이 검색에서 빠지고 그
작업이 유발한 지연 이벤트가 한 칸 앞의 다른 작업에 붙었다. 뒤에 놓인 "owner 가 terminal 이면
버린다" 검사는 그래서 영원히 참이 되지 않았다. 이제 상태를 거르기 **전에**
`lastUserOfAny` 로 실제 마지막 소유자를 찾고, terminal 이면 그 자리에서 버린다(자원 등록도
하지 않는다). 귀속 정보(`sessionUsers`)는 `cleanupOperation` 이 끝날 때 지워지므로 CAS 와 정리
완료 사이 구간이 그대로 덮인다.

**테스트.** ego-host `취소: CAS 직후 도착한 지연 이벤트는 O2 에 귀속돼 버려지고 O1 의 것만 통과한다`
(실 Chromium. 정리 명령의 응답을 붙잡아 CAS ↔ 정리 완료 구간을 열고 그 안에서 지연 이벤트를
주입한다. `droppedAfterBarrier` 에 O2 로 적히고 O1 의 채널에는 오지 않으며, 정리가 끝나고
O1 이 세션을 다시 쓰면 같은 이벤트가 통과한다).

### [P2] 컨텍스트 인자의 잘못된 타입

**고친 것.** 문자열만 비교하고 `null`·배열·객체·숫자는 조용히 우리 컨텍스트로 덮었다. 값이
아니라 **호출자의 믿음**이 틀어지는 자리다. 이제 필드가 있으면 비지 않은 문자열이어야 하고
아니면 `EGO_CONTEXT_MISMATCH` 로 명시 거부한다.

**테스트.** ego-host `컨텍스트 인자의 null·배열·객체·숫자·빈 문자열은 조용히 덮이지 않고 거부된다`
(거부된 인자가 Chromium 까지 가지 않았음을 `sentMethods` 로 함께 확인).

## 2. 고친 것이 실제로 출력을 바꾸는가 (mutation probe)

일곱 자리를 하나씩 되돌려 새 테스트가 RED 가 되는지 확인했다. 플래그만 세우고 끝난 픽스가
아니라는 증거다.

| 되돌린 것 | 빨개진 테스트 |
|---|---|
| `settleAttach` 의 `tombstones.delete` 복원 + 이벤트 묘비 검사 제거 | 묘비 재사용 (1 fail / 13) |
| 응답 경로가 `noteHostSession` 만 부르게 복원 | 예약 한 번 소비 (1 fail / 13) |
| 오류 경로의 `cancelHostAttach` 제거 | 실패 뒤 자식 attach (1 fail / 13) |
| 핸드셰이크 결박 루프 제거 + 클라이언트 값 우선 복원 | 핸드셰이크 결박 (1 fail / 12) |
| `resourceDenial` 을 존재 검사만으로 복원 | 두 세션 교차 사용 (1 fail / 5) |
| `lastUserOfAny` 를 running 전용으로 복원 | 취소 장벽 귀속 (1 fail / 6) |
| `enforceContext` 를 문자열 비교만으로 복원 | 컨텍스트 인자 타입 (1 fail / 14) |

P0 은 실기가 대신 증명했다(`Command ego_host_issue_token not found`).

## 3. 검증 (전부 종료 코드)

```
$ cd packages/ego-host && npm test
  tests 171 / pass 171 / fail 0 / todo 0                               EXIT=0
  ↳ S6c 시점 164 + S7 신규 7

$ cd packages/shell/src-tauri && NAIA_AGENT_SCRIPT=… NAIA_AGENT_PROTO_DIR=… \
    CARGO_TARGET_DIR=target-e2e cargo test ego_host
  25 passed; 0 failed; 319 filtered out                                EXIT=0
  ↳ S6c 시점 21 + S7 신규 4

$ npx tsc -p tsconfig.json                                             EXIT=0
$ cd packages/shell && npx tsc --noEmit -p tsconfig.json               EXIT=0

$ cd packages/shell && npx vitest run
  Test Files 7 failed | 184 passed | 2 skipped (193)
  Tests 48 failed | 1907 passed | 21 skipped (1976)                    EXIT=1
  ↳ 기준선(S6c 증거)의 7파일·48건과 **같다**. 통과가 1905 → 1907.

$ cd packages/shell && npx playwright test e2e/env-tool-browser-host.spec.ts
  7 passed                                                             EXIT=0

$ cd packages/shell && pnpm run build:e2e:tauri                        EXIT=0
$ cd packages/shell && env -u DISPLAY -u WAYLAND_DISPLAY \
    WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
    cage -- pnpm exec wdio run e2e-tauri/wdio.conf.ts \
      --spec e2e-tauri/specs/env-tool-browser-host-fullstack.spec.ts
  5 passing / Spec Files: 1 passed                                     EXIT=0
$ … --spec e2e-tauri/specs/env-tool-browser-host-lifecycle.spec.ts
  4 passing / Spec Files: 1 passed                                     EXIT=0

$ pnpm test        (루트)
  Test Files 5 failed | 100 passed | 1 skipped (106)
  Tests 7 failed | 1638 passed | 4 skipped (1650)                      EXIT=1
  ↳ `baseline-root-test-20260909.txt` 의 7건과 **이름까지 같다.** 새 실패 0.

$ node scripts/check-file-anchors.mjs                                  EXIT=0
$ node scripts/check-traceability.mjs --enforce                        EXIT=0
$ node scripts/check-uc-traceability.mjs                               EXIT=0
$ node scripts/build-e2e-inventory.mjs --check                         EXIT=0

$ pgrep -af 'supervisord.mjs'   잔류 0
$ pgrep -af 'naia-ego-marker'   잔류 0
$ pgrep -af '^cage'             잔류 0
```

## 4. 계약과 달랐던 판단

**(1) 원시 CDP 를 웹뷰에서 완전히 없애지 못했다 — 이름이 아니라 등급으로 가뒀다.**
브리프는 남길 명령을 `ego_host_op_<rpc>` 열둘로 못 박았다. 그대로 하려면 열기·이동·클릭·입력·
평가의 **몸통**이 웹뷰 아래에 있어야 하는데, 그 몸통은 코어 어댑터
(`src/main/adapters/ego-browser-env.ts`)가 원시 CDP 로 구현하고 있고 감독자에는
`open`·`navigate`·`click`·`fill`·`evaluate` RPC 가 없다. 감독자로 옮기면 같은 뜻의 구현이 둘이
되고, 실 Chromium 으로 도는 S3a 계약 테스트가 웹뷰 동작을 더는 증명하지 못한다(S6c 리뷰가
그러지 말라고 적은 자리다). 그래서 세션을 이어 쓰는 세 문
(`ego_host_op_rpc`·`ego_host_op_cdp`·`ego_host_op_end`)을 남기되, **그 세션은 `ego_host_op_*`
만 열 수 있고 등급은 Rust 가 이름으로 정한다.** 결과로 웹뷰가 도달할 수 있는 최대 등급은
`workspace-write` 이고, 관측 작업의 CDP 는 Rust 와 감독자 두 곳에서 막히며, `credential`
이상이나 승인 없는 heredoc 은 어떤 인자로도 만들 수 없다. 원시 CDP 를 문자 그대로 없애는 것은
감독자 쪽 고수준 RPC 를 새로 만드는 별도 슬라이스다(리뷰어 판단 필요).

**(2) 관리 RPC 를 지우는 대신 메서드가 고정된 좁은 명령으로 쪼갰다.**
어댑터는 `reconcileLease`·`ensureDirs`·`writeEnvFiles`·`waitForPidExit`·작업 취소·작업 종결을
관리 통로로 부른다. 이름 하나로 아무 메서드나 부르는 문(`ego_host_rpc`)을 없애되 그 여섯 개
쓰임을 각각 `ego_host_reconcile_lease`·`ego_host_ensure_dirs`·`ego_host_write_env_files`·
`ego_host_wait_pid_exit`·`ego_host_op_cancel`·`ego_host_op_complete` 로 나눴다. 메서드 이름은
Rust 안에 고정이고 웹뷰가 고르지 않는다. `runScript` 는 명령을 만들지 않고 어댑터에서 거부한다.
`ego_host_switch_adk` 는 TS 호출자가 없어 등록에서 뺐다.

**(3) 세션 이어 쓰기 명령의 `method` 는 자유롭게 두었다.**
`ego_host_op_rpc(session, method, params)` 의 method 는 고정이 아니다. 대신 감독자가 그 연결을
작업 연결로 보고 관리 RPC(`issueToken`·`stop`·`switchAdk`…)를 **거부**하며, grant 없는 연결에는
관측 RPC 만 허용한다. 등급을 넘는 길은 감독자가 닫는다.

**(4) 빈 문자열은 타입 오류가 아니다.**
P1-3 을 처음 구현할 때 `workspaceId: ""` 를 "비지 않은 문자열" 규칙으로 막았다. 그런데 `""` 는
"작업 공간 없음"의 정당한 값이고 어댑터의 `listWorkspaces` 가 그렇게 부른다. 루트 `pnpm test` 의
S3a 계약 테스트가 그 회귀를 잡았다(ego-host 자기 묶음 171건은 전부 초록이었다 — 패키지 안에서만
재면 못 보는 자리다). 판정을 모양이 아니라 **기록과의 일치**로 되돌리고 `9c36455a` 로 닫았다.

**(5) `Browser.downloadWillBegin` 의 GUID 는 세션 대조를 받지 않는다.**
브라우저 수준 이벤트라 세션이 없다. 세션 없이 적힌 자원에 세션 대조를 걸면 취소 훅의
`Browser.cancelDownload` 가 자기 다운로드를 못 끊는다. 없는 사실을 지어내 거부하는 대신 작업
소유만 본다는 것을 코드 주석과 이 문서에 적는다.

## 5. 남은 것

- FR-ENV-TOOL.14b(승인 UI)가 열리기 전까지 웹뷰에서 `env_browser_script` 는 도달 불가다.
  Playwright·e2e-tauri 의 `script` 케이스는 "거부된다"만 재고 있으며, 승인된 실행 경로는
  후속 이슈다(계약 4.4 옆의 Pending 문단과 일치).
- 위 (1) 의 판단은 리뷰어가 다시 봐야 한다. 원시 CDP 를 문자 그대로 없애려면 감독자에
  고수준 RPC 를 놓고 코어 어댑터의 몸통을 그리로 옮기는 슬라이스가 필요하다.
