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
