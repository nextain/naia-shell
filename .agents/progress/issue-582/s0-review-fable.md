# S0 리뷰 (Fable, 2026-09-09)

대상: ca9d3458(S0a), 5e8a02be(S0b), da7b2872(S0c). 방법: 세 커밋의 diff 정독, 서비스·도메인 코드와 테스트 대조, 계약(4.4·4.7·9절) 대조.

## 판정

계약대로다. 종결 CAS 는 양방향 경주를 테스트가 강제하고, 진행 중 멱등 공유는 동시 5건에 포트 호출 1회를 확인하며, deadline 은 가짜 타이머로 실제 만료를 밟는다. 취소 순서(CAS 선점 → 신호 → 포트)의 근거 설명이 맞다. 자원 RPC 를 증거 RPC 와 분리한 판단도 맞다.

## 고쳐야 할 것 (S0d)

1. **[P1] 터미널 exec 가 호출자 선언 등급을 그대로 믿는다.** `EnvironmentToolService.exec` 는 `admitEnvOperation(request…)` 에 요청의 `capability` 를 그대로 넘긴다. 관측 권한만 있는 조립에서 `capability: "observe"` 로 선언하면 명령이 통과한다(브라우저 RPC 만 표로 고정했다). 수정: 터미널 실행의 바닥 등급을 `workspace-write` 로 고정하고, 호출자가 더 높은 등급(destructive 등)을 선언하면 그 높은 쪽을 쓴다(낮추는 길은 막고 올리는 길은 둔다). 판정에 쓴 등급을 장부(`snapshotOf().tier`)에 남긴다. 테스트: 관측만 부여된 조립에서 `observe` 선언 exec 가 `capability-denied` 로 거부된다. 기존 터미널 테스트는 `workspace-write` 선언이라 영향 없다.

## 다음 슬라이스로 넘기는 것 (수정 아님, 기록)

2. **[P2] 자원 RPC 에 멱등 캐시가 없다.** `createWorkspace` 를 같은 멱등 키로 재전송하면(어댑터 재연결 뒤 흔한 일) 공간이 둘 생긴다. S3a 어댑터에서 감독자 쪽이 `idempotencyKey → workspaceId` 를 기억해 같은 공간을 돌려주도록 한다. FR-ENV-TOOL.9 의 "멱등 재전송" 을 자원 RPC 에도 적용하는 문장으로 요구사항을 보강한다.
3. **[P2] `cancel(unknownId)` 가 `cancelled` 로 답한다.** 모르는 작업의 취소는 "그런 작업 없음" 이 정직하다. S3a 에서 `Termination` 에 `unknown` 을 허용하거나 별도 결과로 바꾼다.
4. **[P2] 타임아웃 뒤 실제 중단은 어댑터 몫이다.** 서비스는 신호만 끊는다. S3a 계약 테스트 "deadline 만료 → 취소 부작용 정지" 가 이를 실제 Chromium 에서 확인해야 한다(이미 계획에 있음).

## 기준선 메모

S-1 문서 커밋이 UC-ENV-TOOL-SPACE 를 추가한 시점에 그 시나리오의 확인 수단이 없어 실패 1건이 생겼고(고아 시나리오 검사), S0a 가 첫 확인 수단을 붙여 사라졌다. 기준선 7건은 그대로다.

# S0d·S2a 리뷰 (Fable, 2026-09-09)

대상: c8d2adca(S0d), 1c69a09f(S2a). 재검증: `packages/ego-host npm test` 68건(63 pass, 5 todo, 0 fail) 종료 0, `--check` 0, `--provenance` 0 을 제가 직접 다시 돌렸다.

- S0d 는 리뷰 지적대로다. 모르는 등급 이름을 바닥으로 되돌린 판단이 맞다.
- S2a 핵심 불변 확인: 토큰은 감독자가 승인에 결박해 발급하고(`issueToken`), 핸드셰이크의 grant 가 발급 승인과 다르면 거부하며 연결의 grant 는 서버 기록을 쓴다. preload 는 벤더 모듈을 정적 import 하지 않고 `isMainThread` 가 아니면 아무것도 하지 않는다. 런처 stdio 는 `inherit` 세 칸 명시 목록, `shell:false`. sessionId 는 재작성하지 않고 중첩 `params.sessionId` 는 attach/detach 두 이벤트에서만 세션으로 읽는다.
- 계약과 달랐던 판단(useTaskSpace 관측 분류, 13초 상한, 짧은 deadline 우선, 미소유 이벤트 폐기·기록)은 전부 수용한다. 계획 4.2·4.4 에 반영할 문구: "공간 선택은 관측 등급", "감독자 상한 13초", "핸드셰이크 deadline 은 짧은 쪽".
- 남는 위험: 승인 없는 연결은 원시 CDP 를 전혀 보낼 수 없다(316행). 관측 도구(스냅샷·캡처)는 RPC 로 감독자가 대신 실행하므로 문제없지만, S2e 에서 스냅샷·캡처를 원시 CDP 로 구현하면 관측 연결이 막힌다. S2e 는 감독자 내부 CDP 연결로 실행해야 한다.

# S2b 리뷰 (Fable, 2026-09-09)

대상: b5d49257. 재검증: `npm test` 102건(98 pass, 4 todo, 0 fail) 종료 0, 테스트 뒤 marker 프로세스 잔류 0 을 직접 확인.

- 계약 4.8 의 추측이 실측으로 확정됐다: 감독자 SIGKILL 뒤 Chromium 은 파이프 EOF 로 약 200ms 안에 소멸(정리 코드 0줄). 후손 fd 탐침은 socketpair(`socket:[N]`)를 보도록 고쳐졌고, 일부러 넘긴 파이프를 잡아내는 것으로 탐침 자체를 검증했다.
- 계약과 달랐던 판단 넷(Chromium 이 cmdline 을 공백으로 재작성, libuv stdio 는 socketpair, Playwright 배치는 `chrome-linux64`, win32 조정은 회수하지 않고 `unverified`)은 전부 수용한다. 특히 win32 미확인 프로세스를 죽이지 않기로 한 것이 맞다. 계획 4.9 의 프로세스 확인 행을 이 사실로 고친다.
- 파이프 스트림을 종료 시 명시적으로 파괴하지 않으면 node 가 매달린다는 발견은 감독자 데몬 정상 종료의 조건이므로 4.8 에 적는다.
- 미실측 목록(win32 HANDLE 비상속·named pipe 기동·marker 확인, darwin 기동·회수)은 OS 별 게이트 항목으로 그대로 둔다.
