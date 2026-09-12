# 파생 스킬과 업스트림의 차이 (#582 S4)

`skill/SKILL.md` 는 업스트림 스킬 문서의 **파생본**이다. 무수정이 목표가 아니다(계약 1절·10절).
런타임은 한 글자도 고치지 않지만 스킬 문서는 우리 정책 — 비로그인 격리, 헤드리스 인계 불가,
측정된 지원 범위, 두 진입점의 승인 등급 — 에 맞춰 고쳐 쓴다.

- 원본: `../vendor/ego-lite/skills/ego-browser/SKILL.md`
  (업스트림 고정 커밋 `5ca3c36cba2240b8df2e22ba32127747029039d5`, 문서 버전 1.2.6 / 2026-07-20)
- 파생본: `SKILL.md` (0.1.0 / 2026-09-10)
- 지원 범위의 근거: `../docs/helper-matrix.md` (측정 생성물)

업스트림이 새 커밋으로 올라가면 `node ../scripts/sync-ego-lite.mjs --ref <커밋>` 이
**3자 diff** 를 낸다 — (1) 업스트림 이전판 → 신판, (2) 업스트림 신판 → 우리 파생본.
(2) 가 이 표와 어긋나면 파생 결정이 하나 늘었거나 사라진 것이다. 그때 이 표를 먼저 고친다.

## 바꾼 문장

아래 표의 원문·파생문은 **각 파일에 그대로 있는 문자열**이다. `test/skill.test.mjs` 가
원문이 업스트림 원본에, 파생문이 파생본에 실제로 있는지 매번 확인한다 — 표가 낡으면 테스트가 깨진다.

| # | 무엇을 | 원문 (업스트림) | 파생문 (우리) | 이유 |
|---|---|---|---|---|
| 1 | 스킬 이름 | "name: ego-browser" | "name: naia-browser" | 파생본은 업스트림 스킬이 아니다. 같은 이름을 쓰면 에이전트가 업스트림 문서의 약속(로그인 상속·인계)을 우리 런타임에 적용한다. |
| 2 | 설명의 로그인 상속 | "reusing the user's login state without competing for the browser" | "signed-out task space that never touches the user's windows, focus, or login state" | 작업 공간은 비로그인 격리 공간이다(계약 3절 1번). 사용자 로그인 상속은 온프레미스·무간섭·격리와 양립하지 않는다. |
| 3 | 작업 공간의 로그인 상속 | "inherits the current user's login state" | "there is no login state to inherit, by design" | 같은 결정을 본문에서도 지운다. 설명만 고치고 본문을 두면 에이전트는 본문을 읽고 인증 사이트를 시도한다. |
| 4 | 인계 절차 | "When the task requires user intervention (e.g. login, captcha, manual confirmation)" | "When the task reaches a login form, a captcha, a one-time code, an age gate" | 헤드리스에는 넘겨줄 창이 없다. 인계 대신 **멈추고 보고**가 유일한 올바른 결말이다(계약 3절 2번). |
| 5 | 회수·claim | "to take ownership and select it" | "Calling these is not a crash — each returns a formatted refusal with a stable code" | `claimTaskSpace`·`handOffTaskSpace`·`takeOverTaskSpace` 는 원래 요청 id 를 가진 `EGO_HANDOFF_UNSUPPORTED_HEADLESS` 로 거부된다(helper-matrix 측정). 거부가 곧 답이라고 적어야 우회하지 않는다. |
| 6 | 자가 회수 금지 | "on your own to grab control back" | "Do not try to sign in, do not look for credentials" | 업스트림은 "사람에게서 뺏지 말라"를 말한다. 우리는 뺏을 사람이 없고, 대신 막히면 자격증명을 찾아 나서지 말라는 경계가 필요하다(FR-ENV-TOOL.8 은 별도 권한이다). |
| 7 | 출력 통로 | "cliLog(value)" | "console.log(value)" | 고정 커밋 런타임에 `cliLog` 전역이 없다(src/index.ts:175-186). 벤더 스킬 문서가 런타임보다 낡았다 — 문서를 런타임에 맞춘다. |
| 8 | 지원 헬퍼 목록 | "Task spaces: `listTaskSpaces`, `useOrCreateTaskSpace`, `claimTaskSpace`, `handOffTaskSpace`, `takeOverTaskSpace`, `waitForAgentControl`, `completeTaskSpace`" | "This list is **measured, not promised.**" | 지원 범위는 약속이 아니라 측정 결과다(계약 1절). 목록은 helper-matrix 의 `supported` 만 싣고, `rejected`·`unsupported` 는 "Helpers not to use" 로 내린다. |
| 9 | 파일 업로드 | "await uploadFile(" | "File upload — refused: EGO_HOST_METHOD_DENIED" | `DOM.setFileInputFiles` 는 임의 호스트 경로를 읽는다. 중계기 행렬의 거부 항목이다(계약 4.3.2). |
| 10 | 무한 스크롤 헬퍼 | "await scrollToBottomUntil(" | "Not present in the pinned runtime — write the loop yourself with scrollBy + js" | 고정 커밋 런타임에 그 이름의 헬퍼가 없다(helper-matrix `unsupported`). |
| 11 | 승인 등급 | "Use the `Bash` tool to run all browser operations via" | "## Permission tiers" | 형식 도구와 heredoc 은 등급이 다르다(계약 3절 4번). heredoc 은 터미널 실행 바닥 등급 + **건별 승인**이며, 승인 없이는 감독자 핸드셰이크가 자식 프로세스 전에 거부한다. |
| 12 | 캡처 경로 | "await captureScreenshot()" | "the capture path is chosen by the supervisor, not by you" | 캡처 경로는 사용자 인자가 아니라 감독자가 정한다(계약 4.4·4.5). 환경으로 내려오는 `EGO_HOST_EVIDENCE_DIR` 아래에 써야 증거 검사가 파일을 찾는다. |
| 13 | 브라우저 능력 차이 | "ego-browser (ego-lite) is a Chromium-based browser designed from the ground up" | "Permission-related capabilities are the clearest place this shows" | 우리는 업스트림 브라우저가 아니라 일반 Chromium 을 몬다. S2f regression PWB-10 에서 권한 능력이 실제로 달랐다. 문서의 능력을 가정하지 말라고 적는다. |
| 14 | 안정 참조의 수명 | "the same element keeps the same number across calls" | "Chromium reuses those numbers across documents" | S3a 실측: 문서가 바뀌어도 `backendNodeId` 가 재사용돼 옛 참조가 새 페이지의 엉뚱한 요소로 풀린다. 쓰기 전에 현재 스냅샷 refs 확인이 필요하다(계약 4.4). |
| 15 | 실행기 정체 | "ego-browser nodejs <<'EOF' ... EOF" | "`ego-browser` here is our launcher" | 같은 명령 모양이지만 닫힌 브라우저 앱의 실행 파일이 아니라 우리 런처다. 에이전트가 업스트림 설치 안내를 따라가지 않게 못 박는다. |
| 16 | 설치 안내 경로 | "read `references/install.md`" | "read `../README.md`" | 벤더 `references/install.md` 는 업스트림 앱 설치 절차다. 우리 설치·기동은 호스트 패키지 README 가 정본이다. |
| 17 | 시간 상한 | "if a native browser dialog is open" | "The supervisor's ceiling is 13 seconds per CDP round trip" | 감독자 상한이 런타임의 15초보다 먼저 만료해야 취소·시간초과가 형식 있는 실패로 끝난다(계약 4.2, S2a). 업스트림 문서에 없는 항목이라 추가다. |
| 18 | 사이트 학습 위치 | "For setup, install, or connection problems" | "## Site learnings" | 학습 루트가 벤더 트리 밖(`skill/learnings/`)이며 `EGO_BROWSER_AGENT_WORKSPACE` 로 지정된다. 업스트림 문서에는 이 절이 없다 — 추가다. |

## 그대로 둔 것

원문 구조와 문장을 최대한 유지했다. 3자 diff 가 읽히려면 "우리가 바꾼 곳"만 달라야 한다.

- 절 순서와 제목(Quick start · Common helpers · Task spaces · Scroll / mouse · js · Recommended workflow · Caveats).
- 세 가지 작업 흐름(의미·시각·직접 DOM/CDP)과 리치 에디터 경고 문단 전체.
- `js()` 의 주의사항, 초 단위 시간, `snapshotText()` 의 기본 범위, 셀렉터·좌표 형식 표.
- `completeTaskSpace` 의 전용 마지막 heredoc 규칙과 `keep` 기본값 `false`.

## 그대로 두지 않은 이유가 없는 것 (양보)

- 업스트림의 `assets/`·`agents/openai.yaml`·`references/video.md` 는 파생하지 않는다. 우리 배포 표면이 아니다.
- 업스트림 `scripts/install.sh` 도 파생하지 않는다. 설치는 pnpm 워크스페이스가 한다.
