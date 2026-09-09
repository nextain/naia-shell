# 머지 전 최종 검증 (HEAD e51566c6, 2026-09-10 04:33:01)

```
## npx tsc -p tsconfig.json
EXIT=0
## pnpm test (root)
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  src/test/agent-bench-execution.contract.test.ts > 문서와 하네스가 어긋나면 드러난다 > 문서가 선언한 확인 수단 파일이 전부 실제로 있다
 FAIL  src/test/app-install-root.contract.test.ts > 앱 설치·목록·삭제의 자리 > 네 갈래가 모두 같은 자리 함수를 지난다
 FAIL  src/test/app-install-root.contract.test.ts > 앱 설치·목록·삭제의 자리 > 정본 자리 함수는 옛 자리를 실제로 옮긴다
 FAIL  src/test/e2e-runtime-isolation.contract.test.ts > 전용 e2e 환경의 실행 자리도 임시 디렉터리 아래다 > radio-queue-e2e-environment.ts 의 자리가 데이터 홈 밖의 임시 디렉터리다
 FAIL  src/test/environment-wire-conformance.contract.test.ts > 짝 저장소와의 표본 드리프트 > 짝 저장소 표본을 실제로 찾았다 — 건너뛴 게이트는 게이트가 아니다
 FAIL  src/test/onboarding-reset.contract.test.ts > 온보딩을 되살리는 길 (#564) > 네 스펙이 저마다 손으로 비우지 않고 같은 헬퍼를 쓴다
 FAIL  src/test/wire-union-drift.contract.test.ts > 뇌가 보내는 것을 셸이 전부 안다 (FR-WIRE-UNION.3) > 표본이 아니라 짝 저장소의 실제 송신 코드와 대조한다
 FAIL  src/test/wire-union-drift.contract.test.ts > 짝 저장소와의 표본 드리프트 (FR-WIRE-UNION.6) > 짝 저장소 표본을 실제로 찾았다 — 건너뛴 게이트는 게이트가 아니다
 Test Files  6 failed | 99 passed | 1 skipped (106)
      Tests  8 failed | 1638 passed | 4 skipped (1650)
EXIT=1
## baseline diff (root)
0a1
>  FAIL  src/test/agent-bench-execution.contract.test.ts > 문서와 하네스가 어긋나면 드러난다 > 문서가 선언한 확인 수단 파일이 전부 실제로 있다
## packages/ego-host npm test
ℹ tests 164
ℹ pass 164
ℹ fail 0
ℹ todo 0
EXIT=0
## packages/shell pnpm test
⎯⎯⎯⎯⎯⎯ Failed Tests 48 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  7 failed | 184 passed | 2 skipped (193)
      Tests  48 failed | 1905 passed | 21 skipped (1974)
EXIT=1
## checks
file-anchors EXIT=0
traceability EXIT=0
uc-traceability EXIT=0
e2e-inventory EXIT=0
  - DIR  /var/home/luke/alpha-adk/.worktrees/naia-shell-582-ego-host/tmp
  - FILE /var/home/luke/alpha-adk/.worktrees/naia-shell-582-ego-host/tsconfig.build.json
vendor-check EXIT=0
## 잔류
marker=0 supervisord=0 cage=0
```

## 재실행 (커버리지 맵 경로 정정 뒤)
```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 7 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  5 failed | 100 passed | 1 skipped (106)
      Tests  7 failed | 1639 passed | 4 skipped (1650)
EXIT=1
ROOT_FAILS_IDENTICAL_TO_BASELINE
```
