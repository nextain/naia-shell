# {{PROJECT_NAME}}

{{PROJECT_DESCRIPTION}}

---

## 프로젝트 구조

```
{{PROJECT_NAME}}/
│
│  # ── 헌장 (Charter) ──────────────────────────────────────────
│  # AI 도구와 사람 모두가 읽는 프로젝트 규칙과 진입점.
│  # 이 파일들은 확정 후 AI가 단독으로 수정할 수 없다.  [Luke:크론이나 Hooks로 AI가 하나를 수정할 경우 자동 동기화 되어야 한다.]
│
├── AGENTS.md                  # 모든 AI 도구의 공통 진입점 (SoT)
├── CLAUDE.md                  # Claude Code용 mirror (자동 생성)
├── GEMINI.md                  # Gemini CLI용 mirror (자동 생성)
├── OPENCODE.md                # opencode용 mirror (자동 생성)
├── CODEX.md                   # Codex용 mirror (자동 생성)
│
│  # ── AI 컨텍스트 ────────────────────────────────────────────
│  # AI 도구가 읽는 규칙·상태·스킬·훅. 사람이 직접 편집하는 곳.
│
├── .agents/
│   ├── context/
│   │   ├── agents-rules.json  # 규칙 SoT — 구조 강제, 프로세스 게이트, 금지 행동
│   │   ├── process-status.json# 현재 진행 이슈 + SDLC 게이트 상태 (세션마다 업데이트)
│   │   └── project-index.yaml # 진입점 인덱스 + 온디맨드 로딩 목록
│   ├── skills/                # AI에게 가르칠 스킬 정의
│   ├── hooks/                 # AI 세션 이벤트 훅             [Luke:compaction 이후 맥락이나 상위 지시를 잃는 것이 가장 큰 문제로 이에 대한 고민이 필요함]
│   ├── commands/              # 커스텀 슬래시 커맨드
│   └── progress/              # 이슈별 진행 상태 파일 (AI가 작성)   [Luke:docs의 progress에 작성하도록 할 것, 사용자가 알 수 있도록 한다. 가시성이 떨어지고 compaction 이후 맥락이나 상위 지시를 잃는 것이 가장 큰 문제로 이에 대한 고민이 필요함]
│
│  # ── Human Mirror ───────────────────────────────────────────
│  # .agents/ 와 1:1 대응하는 사람이 읽기 편한 마크다운 버전.
│  # 개발자가 브라우저·에디터에서 바로 볼 수 있게.
│
├── .users/  [Luke:ko언어 삭제했음. 우선 한국어로 만들고 영문 버전을 추가로 배포하는게 나을 것 같음. 다국어 프로젝트나 오픈소스 인 경우, 아래에 {lang}을 두고 동일하게 운용 한다.]
│       ├── commands-list.md
│       ├── hooks-list.md
│       ├── skills-list.md
│       └── context/
│           └── process-status.md  # 현재 진행 상황 (한국어)
│
│  # ── 소스 코드 ──────────────────────────────────────────────
│  # 실제 구현. main과 test를 같은 src 아래 두어 함께 관리.
│
├── src/
│   ├── main/                  # 메인 소스 코드
│   └── test/                  # 테스트 코드 (main과 대응)
│
│  # ── 성능 측정 ─────────────────────────────────────────────
│  # 기능 테스트(test/)와 분리. 정확도·속도·비용을 독립적으로 측정.
│
├── benchmark/                 # 벤치마크 시나리오 + 결과   [Luke: AI로 운용하는 프로젝트들은 회귀 테스트로 품질을 체크할 수 없음. 따라서 개발별 벤치마크를 두어 모듈의 성능과 이상을 체크해야 함. 비정상적으로 느려졌다거나 끊기는 것들이 여기서 체크될수 있으며, 개선에 대한 효과를 fail/pass 가 아닌 확인이 가능하게 하기 위함임]
│
│  # ── 자동화 스크립트 ─────────────────────────────────────────
│  # 프로젝트를 유지하는 도구들. 직접 실행하거나 CI에서 사용.
│
├── scripts/
│   ├── enforce-root-structure.sh  # 미등록 파일/폴더 감지 → 삭제   [luke:hook이나 cron에서 작동, 하고 삭제 에대한 히스토리를 남겨야함. 프로젝트에 logs 디렉토리 하나 추가 필요]
│   ├── sync-harness-mirrors.sh    # AGENTS.md → 4개 mirror 자동 동기화
│   └── cron/                      # 주기적으로 실행할 배치 작업  [luke:다국어 운영의 경우, 번역을 수행하거나, 프로젝트가 깨짐. AI의 오동작(프로젝트의 방향성을 벗어난 개발을 수행)을 체크하고 조기에 Alert을 줄 수 있어야 함]
│
│  # ── 문서 ────────────────────────────────────────────────────
│  # 설계 결정과 운영 지식. 코드보다 오래 살아남는 것들.
│
└── docs/  [luke:요구사항, 시나리오등은 단일 md로 구성될 수 없음. SW공학 수준의 추적이 필요함, 요구사항은 git의 이슈와 대응될 수도 있음. 가장 고민이 많이 필요해보임, 또한 다중의 유저가 함께 수행하는 경우, 기업환경, 오픈소스 환경은 어떻게 운용 ? 개별 개발자, 개별 ai는 어느 수준으로 역할과 권한을 갖는가 ? RBAC과 SDLC는 단순히 문서의 규칙이 아니라 프로젝트의 스크립트와 하네스로 묶여야 함.]
    ├── project-structure.md   # 이 구조의 공식 명세 + 등록 절차
    ├── lessons.md             # 겪어봤던 문제와 그 해결책 (왜 이 규칙인가)
    ├── requirements.md        # 기능/비기능 요구사항
    ├── user-scenarios.md      # 누가, 무엇을, 왜 — 개발 전 반드시 작성
    ├── glossary.md            # 프로젝트 공식 용어사전
    ├── ARCHITECTURE.md        # 시스템 구조도
    └── progress/              # 이슈별 산출물 (UC, 요구사항, 테스트 결과)
```

---

## 시작하는 방법

```bash
# 1. 구조 검증
./scripts/enforce-root-structure.sh

# 2. 새 이슈 시작 전 프로세스 현황 확인
cat .agents/context/process-status.json

# 3. harness 동기화 (AGENTS.md 수정 후)
./scripts/sync-harness-mirrors.sh
```

## 개발 프로세스

코드 작성 전 반드시 이 순서를 따른다:

1. **P01** — `docs/user-scenarios.md`에 UC 작성
2. **P02** — Test Coverage Map에 테스트 시나리오 매핑
3. **P03** — `docs/requirements.md`에 요구사항 등록
4. **P04** — 통합 테스트 작성
5. **P05** — 완료 후 요구사항 상태 Done 업데이트

> 순서를 건너뛰면 코드 작성 금지. 자세한 규칙: `.agents/context/agents-rules.json`
