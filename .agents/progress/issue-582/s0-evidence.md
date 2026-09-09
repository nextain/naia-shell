# #582 S0 실행 증거 (S0a·S0b·S0c)

작업 자리: `.worktrees/naia-shell-582-ego-host` (브랜치 `feat/582-ego-browser-host`, 시작 HEAD `d41cb6df`).
계약: `docs/progress/issue-582-ego-browser-host.md` 3·4.4·4.5·4.7·7·9절.

## 기준선

`.agents/progress/issue-582/baseline-root-test-20260909.txt` 은 실패 7건을 적어 두었다(기준 커밋 `5f979d26`).
작업 시작 시점(`d41cb6df`)에서 실제로 돌려 보니 실패는 8건이었다. 늘어난 한 건은 S-1 문서 커밋이 만든 것이다.

- `src/test/agent-bench-execution.contract.test.ts > 확인 수단이 하나도 없는 시나리오를 이름으로 안다`
  — S-1 이 UC-ENV-TOOL-SPACE 를 문서에 추가했지만 그 시나리오를 확인할 수단이 저장소에 하나도 없어서 났다.
  S0a 가 그 시나리오의 첫 확인 수단(`src/test/env-tool-workspace-resource.contract.test.ts`)을 붙이면서 자연히 초록으로 돌아왔다.
  기준선 7건은 손대지 않았다.

## S0a 도메인 스키마

명령과 종료 코드:

```
npx tsc -p tsconfig.json                 # EXIT=0
pnpm test                                # EXIT=1 (실패 7건 = 기준선 그대로, Tests 7 failed | 1578 passed | 10 todo)
node scripts/check-file-anchors.mjs      # EXIT=0 (69 파일 전부 앵커됨)
node scripts/check-traceability.mjs --enforce  # EXIT=0 (dead-link 0 · orphan 0)
```

테스트 수: 시작 시점 1555 passed → S0a 뒤 1578 passed (새 계약 테스트 23건). 새 실패 0.

바꾼 것:

- `src/main/domain/env-tool.ts` — `BrowserWorkspace`·`BrowserPage`·`WorkspaceOwnership`,
  `createHeadlessWorkspace`·`isReachableOwnership`·`applyWorkspaceHelper`(4.4 헤드리스 전이 표)·`revisionMatches`,
  `EnvFailureReason`(11개)과 `ENV_FAILURE_REASONS`·`isEnvFailureReason`,
  `EnvOperationRequest` 에 `workspaceId`·`pageId?`·`expectedRevision?`,
  `hasEvidence` 가 브라우저 증거의 `screenshotRef` 도 검사(4.5).
- `src/test/env-tool-workspace-resource.contract.test.ts` — 새 계약 테스트.
- `src/test/env-tool-browser.contract.test.ts` — 캡처 없는 완료를 서비스가 거절하는 negative 1건 추가.
- `src/test/helpers/env-tool-fixture.ts`·`src/test/env-tool-live.contract.test.ts` — `workspaceId` 필수화에 맞춤.
- `docs/requirements.md`·`docs/user-scenarios.md` — FR-ENV-TOOL.6·10 과 UC-ENV-TOOL-SPACE 의 확인 수단에 새 계약 테스트 등재.

### 계약과 달랐던 판단 (S0a)

1. **`agent` 밖 소유 상태의 오류 코드.** 4.4 표는 `agentDelegatedToUser`·`user` 칸을 "도달 불가" 라고만 적고 코드를 주지 않는다.
   순수 함수는 그런 입력을 받을 수 있으므로 조용히 성공시키지 않기 위해 같은 `EGO_HANDOFF_UNSUPPORTED_HEADLESS` 로 거부한다.
   새 오류 코드를 만들지 않은 이유는, 코드가 늘면 감독자·어댑터가 처리해야 할 분기가 계약보다 앞서 늘기 때문이다.
2. **`EnvRejectionCode` 를 지우지 않고 부분집합으로 남겼다.** `EnvRejection.code` 는 `EnvFailureReason` 으로 넓혔다.
   기존 호출부는 그대로 컴파일되고, 포트가 던진 형식 있는 사유(S0b)를 같은 자리에 기록할 수 있다.
3. **`workspaceId` 는 필수다.** 터미널 작업도 자리를 밝힌다(Herdr 워크스페이스 식별자). 자리를 선택 필드로 두면
   정리 대상이 그때그때 정해져 고아가 남는다(4.8). `env-tool-live` 계약 테스트는 자기 Herdr 워크스페이스 id 를 넣도록 맞췄다.
4. **`completeTaskSpaceClose` 는 개정을 올린다.** 표에는 개정 규칙이 없다. 닫힘도 공간의 상태 변화이므로
   낡은 참조가 닫힌 공간에 작용하지 못하도록 `revision + 1` 로 표시한다.

## S0b 동시성·deadline

명령과 종료 코드:

```
npx tsc -p tsconfig.json                       # EXIT=0
npx vitest run src/test/env-tool-cancel-timeout.contract.test.ts  # EXIT=0 (24 passed)
pnpm test                                      # EXIT=1 (실패 7건 = 기준선 그대로, Tests 7 failed | 1593 passed)
node scripts/check-file-anchors.mjs            # EXIT=0
node scripts/check-traceability.mjs --enforce  # EXIT=0
```

테스트 수: 1578 → 1593 passed (S0b 계약 테스트 15건). 새 실패 0.

바꾼 것:

- `src/main/app/control/env-tool.ts` — 작업 장부를 상태 한 칸에서 기록(`OperationRecord`)으로 바꾸고
  종결 CAS(`settle`), 진행 중 멱등 공유(`inflight`), 실제 deadline 타이머와 `AbortController`,
  포트가 실은 사유 보존, `snapshotOf` 로 상태·사유·부분 효과·늦게 온 종결 시도 노출.
- `src/main/ports/env-tool.ts` — 브라우저·터미널 포트 메서드에 `signal?: AbortSignal` 추가(신호를 포트까지 내리기 위한 최소 변경).
- `src/main/domain/env-tool.ts` — `EnvOperationFailure`(포트가 사유를 싣는 통로)와 `envFailureReasonOf`.
- `src/test/env-tool-cancel-timeout.contract.test.ts` — 경주 양방향, 동시 멱등 5건 → 포트 1회, 가짜 타이머 deadline,
  사유 보존, 취소가 포트·신호까지 도달.

### 계약과 달랐던 판단 (S0b)

1. **취소 순서.** 4.7 은 "취소 훅" 만 말한다. 구현 순서는 ① 종결 자리 CAS 선점 → ② `AbortSignal` 발화 → ③ 취소 포트 호출로 고정했다.
   신호를 먼저 끊으면 몸통이 먼저 실패로 종결해 취소가 `failed` 로 둔갑한다(실제로 그렇게 짜면 뒤집힌다).
2. **사유를 못 읽은 오류.** 계약은 형식 있는 사유 11개만 정하고 "사유 없는 예외" 를 정하지 않았다.
   지어내지 않으려면 새 코드를 만들어야 하는데, 코드가 늘면 감독자·어댑터 분기가 계약보다 앞서 늘어난다.
   그래서 `disconnected`(사유를 받지 못한 통로)로 적고 원문 메시지를 `detail` 에 남긴다. 경계 이탈(`workspace-escape`)로는 절대 뭉개지 않는다.
3. **증거 없는 완료의 사유는 `partial`** 로 바꿨다(전에는 `workspace-escape`). 일은 일어났고 증거만 없는 상태다.
4. **판정이 멱등 조회보다 앞선다.** 같은 멱등 키라도 권한이 없는 호출자는 진행 중·완료된 남의 결과를 받지 못한다.
   기존 순서(캐시 먼저)를 유지하면 키만 알면 결과를 주워 갈 수 있었다.
5. **포트에 `signal?` 을 S0b 에서 넣었다.** 계약 9절은 포트 형태를 S0c 로 잡지만, "신호를 포트까지 전달" 을 S0b 에서 증명하려면
   포트가 인자를 받아야 한다. S0c 는 그 위에서 포트를 마저 넓힌다.

## S0c 포트·등급 고정 RPC 표

명령과 종료 코드:

```
npx tsc -p tsconfig.json                                            # EXIT=0
npx vitest run src/test/env-tool-approval-matrix.contract.test.ts   # EXIT=0 (38 passed)
pnpm test                                                           # EXIT=1 (실패 7건 = 기준선 그대로, Tests 7 failed | 1617 passed)
node scripts/check-file-anchors.mjs                                 # EXIT=0 (69 파일 전부 앵커됨)
node scripts/check-traceability.mjs --enforce                       # EXIT=0
```

테스트 수: 1593 → 1617 passed (S0c 계약 테스트 24건). 새 실패 0.

바꾼 것:

- `src/main/ports/env-tool.ts` — `BrowserWorkspacePort {create, list, close}`,
  `BrowserOperationPort {open, navigate, snapshot, click, fill, evaluate, screenshot, close}`(각각 `signal?`),
  `BrowserScript`·`BrowserEvaluation`, `CancellationPort` 유지.
- `src/main/app/control/env-tool.ts` — `BROWSER_RPC_TIERS`(관측 셋·워크스페이스 변경 여덟)와 `requiredTierFor`,
  RPC 별 서비스 메서드, 증거를 만들지 않는 RPC 를 위한 `ResourceOutcome`, 판정에 쓴 등급을 장부에 남기는 `snapshotOf().tier`.
- `src/test/helpers/env-tool-fixture.ts` — 새 포트에 맞춘 대역, `fakeWorkspaces`, 포트가 받은 신호 기록.
- `src/test/env-tool-approval-matrix.contract.test.ts` — 표 자체와 "선언을 믿지 않는다" 계약.
- `src/test/env-tool-live.contract.test.ts` — 컴파일만 맞춤(브라우저는 여전히 쓰지 않는다).
- `.agents/context/module-manifest.json` — env-tool 세 항목의 `uc` 에 SPACE·RECOVER·SCRIPT 를 나눠 넣었다.
  `contract` 는 문자열 한 칸이라 병기할 자리가 없어 기존 값(`docs/progress/issue-497-universal-agent.md`)을 유지했다.
- `docs/requirements.md`·`docs/user-scenarios.md` — FR-ENV-TOOL.14 와 UC-ENV-TOOL-SCRIPT 에 확인 수단 등재.

### 계약과 달랐던 판단 (S0c)

1. **`listWorkspaces` 등급.** 계약은 관측(스냅샷·캡처)과 워크스페이스 변경(열기·이동·클릭·입력·평가·닫기·공간 생성/닫기)만 적었다.
   목록 조회는 보기만 하므로 관측으로 넣었다. 관측 등급 RPC 는 셋이 된다.
2. **등급 판정 근거를 `notes` 가 아니라 장부에 남겼다.** 선언과 표가 다를 때 결과 메모에 적으니 기본 클릭마다 메모가 붙어
   "좌표를 썼다" 같은 실제 효과 기록과 섞였다. 대신 `snapshotOf().tier` 로 판정에 쓴 등급을 노출한다.
3. **증거 없는 RPC 는 다른 결과 타입을 쓴다.** `close`·`createWorkspace`·`listWorkspaces`·`closeWorkspace` 는 스냅샷이 없다
   (닫힌 페이지에는 볼 것이 없다). 같은 생명주기·상한·취소를 쓰되 `ResourceOutcome<T>` 로 자원을 돌려준다.
   대신 이 경로에는 멱등 캐시를 두지 않았다 — "공간을 다시 만들어 달라" 와 "같은 공간을 달라" 는 다른 말이다.
4. **작업 공간 포트는 생성자 다섯 번째 선택 인자다.** 아직 어댑터가 없는 조립(S3a 이전)이 많고, 없으면 공간 RPC 가
   `method-denied` 로 끝난다. 조용히 성공하지 않는 것이 요점이다.
5. **기존 계약 테스트 셋을 새 계약대로 고쳤다.** 클릭의 요구 등급을 표가 정하므로 "선언 등급으로 거절을 만드는" 테스트는
   더 이상 성립하지 않는다. FR-ENV-TOOL.4(페이지 문장이 판정을 못 바꾼다)는 관측 권한만 준 조립에서 양쪽 다 거절되는 형태로,
   "거절된 요청은 기억하지 않는다" 는 경계 이탈로 각각 바꿨다.
