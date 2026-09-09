# #582 S1 벤더링 — 실행 증거

작성 2026-09-09. 실행자 Opus. 워크트리 `.worktrees/naia-shell-582-ego-host`
(브랜치 `feat/582-ego-browser-host`). 계약 문서 `docs/progress/issue-582-ego-browser-host.md`.

업스트림 원본 클론(읽기 전용) HEAD = `5ca3c36cba2240b8df2e22ba32127747029039d5`,
커밋 날짜 2026-08-24. 이 머신 Node v26.7.0, npm 11.19.0, pnpm 10.34.5.

## 1. 만든 것

`packages/ego-host/` (pnpm-workspace 의 `packages/*` 로 자동 편입, 루트 신설 없음)

| 경로 | 내용 |
|---|---|
| `package.json` | `@nextain/naia-ego-host`, private, ESM, node>=22, 의존성 0. 스크립트 `vendor:check`·`vendor:test`·`test` |
| `vendor/ego-lite/` | 업스트림 경로 그대로 미러링한 복사본 **126개 파일** (아래 2절) |
| `vendor/ego-lite/UPSTREAM.md` | 업스트림 URL·고정 커밋·허용 목록·무수정 원칙·스킬 예외·재동기화 절차 |
| `vendor/ego-lite/MANIFEST.sha256` | 파일별 sha256 (GNU `sha256sum -c` 호환). `--check` 의 근거 |
| `scripts/sync-ego-lite.mjs` | `--check`(네트워크 불필요) / `--ref <commit>`(얕은 fetch → 허용 목록만 복사 → MANIFEST·UPSTREAM.md 갱신 → 스킬 3자 diff → `git diff --stat`) |
| `docs/ego-runtime-abi.md` | 실행 ABI. 계획 4.2 의 줄 번호를 벤더 파일에서 재확인해 정정 |
| `test/vendor-install.test.mjs` | 무결성 + 변조 탐침 2건 + 임의 디렉터리 설치·빌드·단위 테스트 + bin 동작 + 학습 루트 |
| `THIRD_PARTY_NOTICES.md` | ego-lite MIT 전문·저작권. #228 표기는 S2 로 미룬다는 주석 1줄 |
| `README.md` | 목적·구조·무수정 원칙·명령·S2 예고 |
| `.gitignore` | 벤더 빌드 산출물과 이 패키지 산출물 |

벤더 파일은 복사 후 **한 글자도 편집하지 않았다.** 업스트림 클론과의 `diff -r` 이
`package/ego-browser`(dist·node_modules 제외)·`skills/ego-browser`·`LICENSE`·`AGENTS.md`·
`spec/agent-skills-spec.md`·워크플로 파일 전부에서 차이 0.

## 2. 계약 대비 정정 두 가지 (검토 필요)

### (1) 허용 목록에 파일 하나가 빠져 있었다 — 추가함

계획 6절의 허용 목록 다섯 항목만 복사하면 **벤더 런타임의 자체 단위 테스트가
299건 중 1건 실패**한다(종료 코드 1).

```
✖ publishes ego-browser to ClawHub and SkillHub from an exact SemVer tag
  AssertionError: publish workflow must exist
```

`vendor/ego-lite/package/ego-browser/test/skill-publish-workflow.test.js:6-12` 가
저장소 루트의 `.github/workflows/publish-ego-browser-skill.yml` 을 읽어 내용까지
검사하기 때문이다. 같은 계획이 "벤더 `npm test` 0" 을 S1 게이트로 요구하므로 두 조항을
동시에 만족시키는 길은 **이 파일 하나**를 허용 목록에 넣는 것뿐이다.

- `.github/` 전체가 아니라 이 파일 하나만 넣었다(허용 목록 6항목, 벤더 파일 126개).
- 위치가 `packages/ego-host/vendor/ego-lite/.github/workflows/` 라 저장소 루트의
  `.github/workflows/` 가 아니므로 우리 CI 는 이 워크플로를 실행하지 않는다.
- 근거와 이유를 `vendor/ego-lite/UPSTREAM.md` "계획 문서 6절의 허용 목록 정정" 에 남겼다.
- 추가 후 벤더 `npm test` = **299 pass / 0 fail / 종료 코드 0**.

### (2) 설치 테스트는 런타임만 떼어 낼 수 없다

S1 지시는 "`package/ego-browser` 를 임시 디렉터리에 복사해" 라고 적었지만, 그것만
복사하면 빌드가 죽는다.

```
Error: ENOENT: no such file or directory, lstat '/tmp/skills/ego-browser'
    at .../scripts/build.mjs:89
```

`scripts/build.mjs:24-31` 이 `package/ego-browser` 의 **두 단계 위**를 저장소 루트로 보고
거기서 `skills/ego-browser` 를 찾아 `dist/out/ego-browser` 로 복사한다. 계획 12절이 이미
지적한 사실이다. 그래서 테스트는 `package/ego-browser` + `skills/ego-browser` +
워크플로 파일의 **상대 위치를 그대로 재현해** 임시 디렉터리에 스테이징한다.
"임의 디렉터리"는 위치가 자유롭다는 뜻이지 구조를 무시해도 된다는 뜻이 아니다.

## 3. 검증 — 실행한 명령과 종료 코드

| # | 명령 (cwd) | 종료 코드 | 핵심 출력 |
|---|---|---|---|
| V1 | `node scripts/sync-ego-lite.mjs --check` (`packages/ego-host`) | **0** | `126개 파일이 5ca3c36… 와 바이트 단위로 같다` |
| V2 | `npm test` → `node --test test/*.test.mjs` (`packages/ego-host`) | **0** | `tests 6 / pass 6 / fail 0`, 그중 (b) 가 `벤더 단위 테스트 통과 299건` 출력 |
| V3 | `npm ci --prefer-offline --ignore-scripts && npm test` (`packages/ego-host/vendor/ego-lite/package/ego-browser`) | **0** | `tests 299 / pass 299 / fail 0` |
| V4 | `bash scripts/enforce-root-structure.sh` (워크트리 루트) | **1 (기존 상태)** | 아래 참조 |
| V5 | `pnpm install --frozen-lockfile --prefer-offline` (워크트리 루트) | **0** | `Scope: all 4 workspace projects`, `Lockfile is up to date` |
| V6 | `pnpm test` (워크트리 루트) | **1 (기준선과 동일)** | `Test Files 5 failed \| 97 passed \| 1 skipped (103)`, `Tests 7 failed \| 1556 passed \| 4 skipped (1567)` |

### V4 — 루트 구조 게이트가 잡은 두 건은 이번 작업과 무관하다

```
[FAIL] 미등록 항목 2개 발견:
  - DIR  <워크트리>/tmp
  - FILE <워크트리>/tsconfig.build.json
```

둘 다 기존 상태다. `tsconfig.build.json` 은 HEAD 에 이미 추적 중인 파일이고(루트
`package.json` 의 `build` 스크립트가 참조한다) F13 목록에만 없다. `tmp/` 는 무관한
`naia-shell-windows-hardening` 하나를 담은 gitignore 대상 디렉터리다.
**`packages/ego-host` 는 단 한 번도 지적되지 않았다** — F12 `allowed_root_dirs` 에
`packages` 가 있고 새 패키지는 `pnpm-workspace.yaml` 의 `packages/*` 로 들어간다.
이 두 건은 헌장(F12/F13) 수정이 필요한 사안이라 범위 밖으로 남긴다.

### V6 — 기준선 대비 새 실패 0건

`.agents/progress/issue-582/baseline-root-test-20260909.txt` 의 실패 7건과
이번 실행의 실패 7건이 **이름까지 완전히 일치**한다.

```
src/test/app-install-root.contract.test.ts        (2건)
src/test/e2e-runtime-isolation.contract.test.ts   (1건)
src/test/environment-wire-conformance.contract.test.ts (1건)
src/test/onboarding-reset.contract.test.ts        (1건)
src/test/wire-union-drift.contract.test.ts        (2건)
```

합계도 같다 — 기준선 `7 failed | 1556 passed | 4 skipped (1567)`,
이번 `7 failed | 1556 passed | 4 skipped (1567)`. 이 7건은 범위 밖이라 손대지 않았다.

### 잠금 파일

`pnpm-lock.yaml` 에 한 줄(`packages/ego-host: {}`)이 늘었다. 새 패키지에 의존성이
없어 그것뿐이며 `--frozen-lockfile` 이 0 으로 통과했다. 커밋에 포함한다.

## 4. 동기화 스크립트를 실제로 돌린 증거

`--check` 만으로는 `--ref` 경로가 산다는 보장이 없어, 로컬 클론을 원본으로 지정해
(`--source`) 같은 커밋으로 실제 동기화를 두 번 돌렸다.

```
[sync-ego-lite] <로컬 클론> 에서 5ca3c36… 를 얕게 받는다
[sync-ego-lite] 커밋 5ca3c36cba2240b8df2e22ba32127747029039d5 (2026-08-24)
[sync-ego-lite] 벤더 파일 126개, MANIFEST.sha256 갱신
[sync-ego-lite] 파생 스킬 skill/SKILL.md 가 없어 3자 diff 를 건너뛴다 (S4 에서 생성한다)
[sync-ego-lite] git diff --stat:
  (추적 중인 파일에 변경 없음)
→ 종료 코드 0, 같은 커밋으로 다시 돌려도 결과 불변(멱등)
```

3자 diff 경로도 임시 파생 스킬(`skill/SKILL.md`)을 만들어 실제로 확인했다 —
`(1/2) 업스트림 이전판 → 신판`은 "차이 없음", `(2/2) 업스트림 신판 → 우리 파생본`은
실제 unified diff 를 출력했다. 확인 후 임시 파일은 지웠다.

### `--check` 변조 탐침 (게이트가 실제로 잡는지)

테스트 안에 넣어 상시 돈다. 플래그만 세우는 검사가 아니라는 증거다.

- 벤더 파일 끝에 주석 한 줄 추가 → `--check` 종료 코드 **1**, stderr 에
  `내용이 다르다(벤더 파일 수정 금지): package/ego-browser/src/browser-runtime.ts`. 복원 후 다시 0.
- 허용 목록 밖 파일(`vendor/ego-lite/docs/stray.md`) 생성 → `--check` 종료 코드 **1**. 정리 후 다시 0.

## 5. 정정한 ABI 줄 번호

계획 4.2 표의 근거 줄을 벤더 파일에서 하나씩 열어 확인했다. 여덟 행 중 **여섯 행이
어긋나 있었고**, 그중 넷은 아예 다른 함수를 가리켰다. 전체 표는
`packages/ego-host/docs/ego-runtime-abi.md` 10절에 있다.

| 항목 | 계획의 근거 | 정정 | 어긋난 이유 |
|---|---|---|---|
| CDP 통로 | `browser-runtime.ts 4~12, 38~76` | `:4`, `:11-12`, `:38-77`, **`:239-250`** | rawCdp 는 77행에서 끝난다. **요청 id 보존의 실제 근거인 응답 대조부(239-250)가 계획 범위 밖**이었다 |
| 세션 | `browser-runtime.ts 107~144` | `:107-144` + **`:205-216`** + `:23`,`:206`,`:211` | `Page.enable` 정의는 205-216 으로 범위 밖. 136행에는 호출만 있다 |
| 오류 통로 | `browser-runtime.ts 218~307` | **`:218-230`** | 232-307 은 `handleMessage` 라는 **다른 함수**다. 범위가 두 함수를 뭉갰다 |
| 탭 | `index.ts 175~214` | **`browser-runtime.ts:116-117`**, **`nav.ts:112-133`**, **`nav.ts:168-173`**, `index.ts:303-319` | `index.ts:175-214` 는 `installEgoSdk` 의 console.log·업데이트 알림 구간으로 **탭과 무관**하다 |
| 작업 공간 | `index.ts 303~318`, `helpers.ts 304~415` | **`helpers.ts:411-416`**, **`:418-429`**, **`:431-438`**, **`:118`·`:143-145`**, `:297-339`, **`ego-errors.ts:142-172`**, `index.ts:201-213` | `index.ts:303-318` 은 `wrapCreateTab` 으로 **탭** 코드다. 작업공간 래핑은 201-213. helpers 범위도 시작이 늦어 ownership 정의를 빠뜨렸다 |
| 스냅샷 | `driver/observe.ts`, `helpers.ts 358~374` | **`observe.ts:49-65`·`:73-79`**, **`browser-runtime.ts:309-326`**, `helpers.ts:364-374` | refs 의 `{backendNodeId, role, name}` 모양은 observe.ts 가 아니라 **browser-runtime.ts:309-326** 에 있다. `probeAgentControl` 본체는 364-374(356-363은 주석) |
| 환경·경로 | `env.ts 5~49`, `run.ts 61~87`, `helpers.ts 852~865` | `env.ts:5-49` ✔, `helpers.ts:852-865` ✔, **`run.ts:61-106`**, **`state.ts:6`** | `loadEnv()` 는 run.ts 에서 불리지 않는다 — **`state.ts:6` 의 모듈 로드 부수효과**다. 그래서 환경 변수는 프로세스 spawn 시점에 이미 있어야 한다 |
| 브라우저 버전 | `update-notice.ts` (파일만) | `:136-149`, `:70-85`, **`:50-54`**, `index.ts:192-195` | 줄을 채웠고, `CI`/`EGO_BROWSER_NO_UPDATE_NOTIFIER` 로 알림이 억제된다는 사실이 빠져 있었다 |

## 6. 코드를 읽어 새로 확정한 계약 사실

- **12개 필수 메서드**: `sendCDPMessage`, `listTabs`, `createTab`, `snapshot`,
  `listTaskSpaces`, `useTaskSpace`, `createTaskSpace`, `claimTaskSpace`, `closeTaskSpace`,
  `completeTaskSpace`, `handOffTaskSpace`, `takeOverTaskSpace`.
  선택 3개(`getBrowserVersion`, `animationHighlightMouseToPosition`,
  `setAgentTaskState`)는 없어도 조용히 degrade 한다(`?.` 호출).
  런타임이 `ego` 에 **써 넣는** 콜백 2개는 `onCDPMessage`, `onSendCDPMessageError`.
- **세션 상실 문구가 계약이다.** `browser-runtime.ts:9-10` 의 정규식
  (`Session not found` / `Session with given id not found` / `Target closed` / `No session`)에
  걸려야 자동 재접속이 돈다. 다른 문구를 쓰면 재시도가 죽는다.
- **`listTabs` 는 `{tabs}` 로 통일해야 한다.** `{targetInfos}` 폴백은 세션 확보 경로
  (`browser-runtime.ts:117`)에만 있고 헬퍼 경로(`nav.ts:117`)는 `result.tabs` 만 본다.
- **미지의 `error_code` 는 그대로 통과한다.** `ego-errors.ts:41-47` 의 주석이 명시한다.
  문구를 런타임이 덮어쓰는 코드는 `EGO_TASK_SPACE_INACTIVE` 와
  `EGO_TASK_SPACE_USER_IN_CONTROL` 둘뿐이다. 따라서 우리가 쓸
  `EGO_HANDOFF_UNSUPPORTED_HEADLESS` 는 **사람이 읽을 설명을 `error` 문자열에 담아야
  아무 안내도 안 남는 일이 없다.**
- **벤더 스킬 문서가 벤더 런타임보다 낡았다.** `skills/ego-browser/SKILL.md`
  (metadata `version 1.2.6`, `date 2026-07-20`)의 퀵스타트가 아직
  `ego-browser nodejs <<'EOF'` 와 `cliLog(...)` 를 쓴다(`cliLog` 7회, `ego-browser nodejs` 2회).
  런타임(2026-08-24)에는 `nodejs` 서브커맨드가 없고(인자를 주면 USAGE + 종료 코드 2,
  `run.ts:89-92`) `cliLog` 전역도 없어졌다(`index.ts:175-186` 주석
  "There is no dedicated cliLog global anymore").
  **S1 지시문의 `nodejs`/`cliLog('x')` 표현은 이 낡은 스킬 문서에서 온 것으로 보인다.**
  설치 테스트 (c) 는 실제 계약대로 인자 없이 stdin 에
  `console.log(await browser.listTabs())` 를 넣어 실행했고, 임의 cwd 에서
  `Error: browser runtime is not available` 이 stderr 에 나오며 **종료 코드 1** 로 끝났다.
  S4 의 파생 스킬은 이 두 표현도 함께 고쳐야 한다.
- `dist/out/index.js` 는 rollup 번들 하나이고 학습 루트 기본값은 `dist/out/ego-browser`,
  `EGO_BROWSER_AGENT_WORKSPACE` 를 주면 `<그 경로>/learnings` 로 바뀐다
  (테스트 (d) 가 빌드 산출물의 `learningsRoot` 를 직접 import 해 확인).

## 7. 남은 문제

- **허용 목록 정정 (2절-①) 은 사람 확인이 필요하다.** 계획 6절의 목록을 한 항목
  늘렸다. 반려되면 벤더 `npm test` 게이트를 299 → 298 로 낮추거나 그 한 테스트를
  제외해야 하는데, 둘 다 게이트를 약하게 만든다.
- 워크트리 루트 구조 게이트(V4)는 기존 위반 2건 때문에 계속 1 로 끝난다. 헌장
  (F12/F13) 수정 사안이라 이번 범위 밖이다.
- 루트 `pnpm test` 의 기존 실패 7건은 그대로다(범위 밖).
- `skill/SKILL.md` 파생본과 `skill/UPSTREAM-DIFF.md` 는 **S4** 에서 만든다. 그때까지
  동기화 스크립트는 3자 diff 를 건너뛴 사실만 출력한다.
- `THIRD_PARTY_NOTICES.md` 의 #228 참조 구현 표기는 **S2** 에서 추가한다(주석으로 표시).

## 8. 커밋 직후 상태

`git show --stat HEAD` 요약 (전체 파일 목록은 커밋 자체에 있다):

```
feat(ego-host): vendor ego-lite runtime at 5ca3c36 with sync script (#582 S1)
 138 files changed, 28730 insertions(+)
```

내역: 벤더 허용 목록 126개 + `UPSTREAM.md` + `MANIFEST.sha256` + 패키지 자체 파일 7개
(`package.json`, `.gitignore`, `README.md`, `THIRD_PARTY_NOTICES.md`,
`scripts/sync-ego-lite.mjs`, `docs/ego-runtime-abi.md`, `test/vendor-install.test.mjs`)
+ `pnpm-lock.yaml` + 진행 기록 2개.

`git status --short` — 이번 작업에서 남긴 미커밋 변경은 **0건**이다. 남아 있는 9줄은
전부 세션 시작 시점의 스냅샷에 이미 있던 것들이다.

```
 M benchmark/.attest/*.json                     (7건, 세션 시작 시부터 수정 상태)
?? .agents/session-contracts/.recovery/leases/…json  (하네스가 만든 세션 리스)
?? docs/progress/issue-582-ego-browser-host.md  (계약 문서, 다른 세션 산출물)
```

커밋 후 `node scripts/sync-ego-lite.mjs --check` 를 다시 돌려 **0** 을 확인했다 —
커밋된 트리가 곧 고정 커밋과 같다는 뜻이다.
