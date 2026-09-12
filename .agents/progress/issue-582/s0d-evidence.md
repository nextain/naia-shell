# S0d 증거 — 터미널 exec 등급 바닥 (2026-09-09)

대상: `.agents/progress/issue-582/s0-review-fable.md` 의 [P1] 한 건. worktree `feat/582-ego-browser-host`.

## 무엇을 고쳤나

`EnvironmentToolService.exec` 이 호출자가 선언한 등급을 그대로 판정에 넘겼다. 관측 권한만
부여된 조립에서 `capability: "observe"` 로 선언하면 임의 명령이 통과했다. 브라우저 RPC 는 S0c 에서
표로 등급을 고정했지만 터미널은 그 표에 담을 수 없다 — 명령 하나가 무엇을 하는지 셸이 미리 알 수 없기
때문이다. 그래서 표가 아니라 **바닥**을 뒀다.

- `TERMINAL_EXEC_TIER_FLOOR = "workspace-write"`.
- `flooredTierFor(declared, floor)` 가 `ALL_TIERS` 인덱스로 둘 중 높은 쪽을 고른다. 낮추는 길은 막고
  올리는 길은 둔다(`destructive` 선언은 그대로 destructive 로 판정).
- `ALL_TIERS` 에 없는 선언은 바닥으로 되돌린다. 모르는 이름이 바닥을 뚫는 길이 되면 안 된다.
- 판정에 쓴 등급이 `run()` 과 `terminal.exec()` 양쪽에 같은 요청 객체로 내려가고
  `snapshotOf().tier` 에 남는다.

## 계약과 달랐던 판단

- 리뷰는 "바닥을 고정하고 높은 선언은 그대로"만 적었다. 순서 판정 함수를 `flooredTierFor` 로 내보내
  테스트가 여덟 등급 전부를 직접 밟게 했다. `ALL_TIERS` 는 주석이 "순서가 아니라 집합"이라고 못박고
  있으므로, 이 함수는 그 순서를 **바닥 계산에만** 쓰는 국소 규칙이며 `permits()` 의 집합 의미는
  건드리지 않는다(부여 검사는 여전히 정확 포함).
- 등급 미포함 문자열 처리(모르는 선언 → 바닥)는 리뷰에 없던 항목이다. 타입 밖에서 들어온 값이
  `indexOf` 에서 -1 이 되어 바닥보다 낮게 취급되는 길을 막았다.

## 검증 (종료 코드)

| 명령 | 결과 |
|---|---|
| `npx tsc -p tsconfig.json` | EXIT=0 |
| `npx vitest run src/test/env-tool-approval-matrix.contract.test.ts src/test/env-tool-terminal.contract.test.ts` | EXIT=0, 50 passed (approval-matrix 43 + terminal 7) |
| `pnpm test` | EXIT=1 — 실패 7건이 기준선과 **파일·테스트 이름까지 동일**(`baseline-root-test-20260909.txt` 의 FAIL 줄과 diff 0). 1622 passed / 4 skipped / 10 todo |
| `bash scripts/enforce-root-structure.sh` | EXIT=1 — 기존 위반 2건(`tmp/`, `tsconfig.build.json`)만 |

새로 추가된 테스트 5건(터미널 실행 등급 바닥):

1. 바닥은 워크스페이스 내부 변경이다
2. 관측만 부여된 조립에서 관측으로 선언한 exec 는 거부된다 — `capability-denied`, 포트 미도달
3. 관측 선언이라도 워크스페이스 권한이 있으면 바닥 등급으로 판정해 통과하고 장부에 바닥이 남는다
4. 파괴적 선언은 그대로 파괴적으로 판정된다 — 올리는 길은 열려 있다
5. 바닥 계산은 ALL_TIERS 순서를 따르고 모르는 선언은 바닥으로 되돌린다

기존 터미널 계약 테스트 7건은 전부 `workspace-write` 선언이라 영향 없음(리뷰 예측대로).
