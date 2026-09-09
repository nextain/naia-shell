# S4 증거 — 파생 스킬·UPSTREAM-DIFF·naia.land 학습 (#582)

작성 2026-09-10. 담당 Opus(구현). 계약: `docs/progress/issue-582-ego-browser-host.md` 6절·9절 S4.
worktree `/var/home/luke/alpha-adk/.worktrees/naia-shell-582-ego-host`, 브랜치 `feat/582-ego-browser-host`.

## 1. 무엇을 만들었나

| 파일 | 무엇 |
|---|---|
| `packages/ego-host/skill/SKILL.md` | 업스트림 스킬(1.2.6, 고정 커밋 `5ca3c36c…`)의 파생본. 이름 `naia-browser` |
| `packages/ego-host/skill/UPSTREAM-DIFF.md` | 바꾼 문장 18건의 원문·파생문·이유 표 + 그대로 둔 것 + 양보 |
| `packages/ego-host/skill/learnings/naia-land/` | `manifest.json` · `notes/overview.md` · `tools/public-page.js` · `browser-tools/login-form.js` |
| `packages/ego-host/test/skill.test.mjs` | 파생 결정을 지키는 검사 7건 |
| `packages/ego-host/README.md` | S4 절 추가(파생 결정 넷과 실행 명령) |

## 2. 파생 결정 (계약 6절이 요구한 것과 1:1)

1. **이름·프런트매터** — `name: ego-browser` → `name: naia-browser`. `derivedFrom` 에 업스트림 커밋을 적어 두었다.
2. **로그인 상속 삭제** — 설명과 본문 두 곳 모두. "각 작업 공간은 자기 탭을 갖지만 **사용자의 로그인 상태를 상속한다**"가
   "비로그인으로 시작하며 상속할 로그인 상태가 애초에 없다(계약 3절 1번)"로 바뀌었다.
3. **인계·회수·claim** — 업스트림의 `Control handoff` 절을 통째로 `Login, captcha, and anything that needs a person` 으로
   갈았다. 세 헬퍼는 `EGO_HANDOFF_UNSUPPORTED_HEADLESS` 로 거부되며, 사람이 필요하면 **멈추고 보고**한다.
   자격증명을 찾거나 다른 경로로 같은 보호 자원에 접근하지 말라는 문장을 명시했다(FR-ENV-TOOL.8 은 별도 권한이다).
4. **`cliLog` → `console.log`** — 지원 목록·주의사항·작업 흐름 전부. `cliLog` 는 "쓰지 말 것" 절에만 남는다(§4 판단 1).
5. **지원 헬퍼 목록 = helper-matrix 의 `supported` 만** — 35개. `rejected`(claim·handOff·takeOver·uploadFile)과
   `unsupported`(scrollToBottomUntil·cliLog)는 `## Helpers not to use` 에 **코드와 함께** 코드 블록으로 내렸다.
6. **승인 등급 절 신설** — `## Permission tiers`. 형식 도구는 서비스가 등급을 고정하고, heredoc(`env_browser_script`)은
   터미널 바닥 등급 + **건별 승인**이며 승인 없으면 감독자 핸드셰이크가 자식 프로세스 전에 거부한다.
7. **캡처 경로는 감독자가 정한다** — `EGO_HOST_EVIDENCE_DIR` 아래에 쓰라고 코드 예시까지 적었다.
   S3a 가 "환경 변수만 있고 강제는 없다"고 넘긴 항목이며, 문서가 그 강제의 자리다.
8. **브라우저 능력 차이 주의** — `### Browser capabilities differ from the upstream browser`.
   S2f regression PWB-10 이 근거다. "문서의 능력을 가정하지 말고 작은 호출로 한 번 재라".
9. **`ego-browser nodejs` 는 우리 런처** — 업스트림 닫힌 앱의 실행 파일이 아니라 `bin/ego-browser.mjs` 임을 명시.
   설치 안내도 `references/install.md` 대신 `../README.md` 로 돌렸다.

원문 구조·절 순서·문장은 최대한 유지했다. 3자 diff 가 읽히려면 우리가 바꾼 곳만 달라야 하기 때문이다.
그대로 둔 것은 UPSTREAM-DIFF 의 "그대로 둔 것" 절에 적었다.

## 3. 3자 diff 가 파생본을 읽는가 (계약 6절)

`scripts/sync-ego-lite.mjs` 는 이미 구현돼 있었고, `DERIVED_SKILL = <pkg>/skill/SKILL.md` 를 읽어
`--ref` 실행 시 (1) 업스트림 이전판→신판 (2) 업스트림 신판→우리 파생본 두 diff 를 출력한다
(`printSkillThreeWayDiff`, 311~338행). S1 시점에는 파생본이 없어 "S4 에서 생성한다"를 출력하고
건너뛰었다. 이제 파일이 생겼으므로 그 분기가 사라진다 — 코드 변경 없이 성립한다.

## 4. 계약과 달랐던 판단

1. **"`cliLog` 문자열 0" 을 "가르치는 자리에 0" 으로 읽었다.** 브리프는 파생본에 `cliLog` 문자열이
   0 이어야 한다고 했지만, 같은 브리프가 "rejected·unsupported 는 '쓰지 말 것' 절에 **코드와 함께**"
   적으라고도 했다. `cliLog` 는 helper-matrix 의 `unsupported` 다. 둘을 동시에 만족시킬 수 없어
   **자리로** 읽었다 — 지원 목록·주의사항·작업 흐름 어디에도 없고 `## Helpers not to use` 안에만 있다.
   테스트가 그 자리를 강제한다(`낡은 출력 통로 cliLog 는 가르치지 않는다`). 완전 삭제를 택하면
   업스트림 문서를 읽고 온 에이전트가 `cliLog` 를 그대로 쓰고 이유를 못 찾는다.
2. **`switchTaskSpace` 는 목록에 없다.** 계약 4.4 의 전이 표에는 `useOrCreateTaskSpace / switchTaskSpace` 가
   나란히 있지만 업스트림 `Common helpers` 목록에도 helper-matrix 에도 그 이름이 없다(파사드로 옮겨졌다).
   측정에 없는 이름을 목록에 넣지 않았다. 소유권 표는 helper-matrix 가 잰 이름들로만 채웠다.
3. **naia.land 학습은 "미확인"이라고 노트 첫 줄에 적었다.** 브리프대로 실제 사이트에 접속하지 않고
   `projects/naia.land` 소스에서만 읽었다. 소스에 `data-testid` 가 거의 없어(로그인 카드에는 없다)
   **주소 기반 셀렉터**(`header a[href$="/login"]`)를 골랐다 — Tailwind 유틸리티 클래스는 디자인이
   바뀔 때마다 사라지므로 안정 셀렉터가 아니다. 이 판단을 노트에 이유와 함께 적었다.
4. **학습에 로그인 절차를 적지 않았다.** naia.land 로그인은 입력란 없이 Google OAuth 로 나간다
   (`src/app/[lang]/(auth)/login/login-card.tsx`, Discord 단추는 소스에서 주석 처리). 헤드리스 비로그인
   공간에서 넘어갈 수 없는 구간이므로 "누르지 말고 멈추고 보고" 로 적었다. 테스트가 그 문장을 확인한다.
5. **`drainEvents` 는 지원 목록에 남겼다.** helper-matrix 가 `supported` 로 쟀기 때문이다. 다만 그것이
   FR-ENV-TOOL.2b(다운로드·이벤트 스트림)를 Done 으로 만들지 않는다는 문장을 바로 아래 붙였다 —
   헬퍼는 돌지만 받은 것을 자원으로 내놓는 통로가 없다.

## 5. 검증 (전부 종료 코드)

```
$ cd packages/ego-host && node --test test/skill.test.mjs
  tests 7 / pass 7 / fail 0                                        EXIT=0

$ cd vendor/ego-lite/package/ego-browser \
    && EGO_BROWSER_AGENT_WORKSPACE=<repo>/packages/ego-host/skill \
       node dist/scripts/validate-site-skills.js
  site skills ok: <repo>/packages/ego-host/skill/learnings           EXIT=0

$ cd packages/ego-host && node scripts/sync-ego-lite.mjs --check
  --check 통과: 126개 파일이 5ca3c36cba2240b8df2e22ba32127747029039d5 와 바이트 단위로 같다
                                                                    EXIT=0

$ cd packages/ego-host && npm test
  tests 155 / pass 155 / fail 0 / todo 0    (S3b 까지 148 + S4 7)     EXIT=0

$ node scripts/check-file-anchors.mjs        70 파일 전부 계약 앵커됨   EXIT=0
$ node scripts/check-traceability.mjs --enforce                       EXIT=0
$ node scripts/check-uc-traceability.mjs                              EXIT=0
$ bash scripts/enforce-root-structure.sh   기존 위반 2건(tmp, tsconfig.build.json)만  EXIT=1(기준선)

$ pgrep -f 'naia-ego-[m]arker'    출력 없음                            EXIT=1(=잔류 0)
```

## 6. 공유 파일에 넣은 hunk

없다. S4 는 `packages/ego-host/` 안에서만 만들고 고쳤다. 벤더 트리(`vendor/ego-lite/`)는
한 바이트도 건드리지 않았다 — `--check` 0 이 그것을 증명한다.

## 7. S6 으로 넘긴 것

- 파생 SKILL 이 말하는 `env_browser_*` 도구를 **실제로 등록**하는 일은 S6a 다. 이 슬라이스는 문서만 만들었다.
- 캡처 경로 강제는 여전히 문서 수준이다. heredoc 본문이 `EGO_HOST_EVIDENCE_DIR` 을 쓰지 않아도
  감독자가 막지는 않는다(관측 RPC 의 캡처 경로만 감독자가 정한다). 강제를 원하면 벤더 헬퍼 경로에
  중계기 규칙이 하나 더 필요하고, 그것은 이번 범위가 아니다.
- 학습을 ADK 안 작업 공간으로 복사·갱신하는 배선(어댑터가 `EGO_BROWSER_AGENT_WORKSPACE` 를 ADK 아래로
  주는 것은 이미 있다)에서 저장소 원본을 언제 어떻게 씨앗으로 넣을지는 정하지 않았다.
