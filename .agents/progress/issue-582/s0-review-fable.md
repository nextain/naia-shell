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
