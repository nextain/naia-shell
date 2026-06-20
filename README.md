# naia-os

Bazzite 기반 배포형 AI OS — naia-template-project clean rebuild (헥사고날 이식)

---

## 프로젝트 구조

```
naia-os/
│
│  # ── 헌장 (Charter) ──────────────────────────────────────────
│  # AI 도구와 사람 모두가 읽는 프로젝트 규칙과 진입점.
│  # 이 파일들은 확정 후 AI가 단독으로 수정할 수 없다.
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
│   ├── hooks/                 # AI 세션 이벤트 훅
│   └── reviews/               # 리뷰 기록
│
│  # ── Human Mirror ───────────────────────────────────────────
│  # .agents/ 와 1:1 대응하는 사람이 읽기 편한 마크다운 버전.
│  # 개발자가 브라우저·에디터에서 바로 볼 수 있게.
│
├── .users/
│       ├── commands-list.md
│       ├── hooks-list.md
│       ├── skills-list.md
│       ├── workflows-list.md
│       └── context/
│           ├── process-status.md  # 현재 진행 상황
│           └── project-index.md
│
│  # ── 소스 코드 ──────────────────────────────────────────────
│  # 코어(src/)와 워크스페이스 패키지(packages/)로 나뉜다.
│
├── src/
│   ├── main/                  # 코어 소스 (헥사고날: domain/app/ports/adapters)
│   └── test/                  # 테스트 코드 (main과 대응)
├── packages/
│   ├── shell/                 # Tauri 데스크톱 셸 (UI·아바타·음성 I/O)
│   └── bgm-sidecar/           # 환경 사이드카 (BGM)
│
│  # ── 자동화 스크립트 ─────────────────────────────────────────
│  # 프로젝트를 유지하는 도구들. 직접 실행하거나 CI에서 사용.
│
├── scripts/
│   ├── enforce-root-structure.sh  # 미등록 파일/폴더 감지 → 삭제
│   ├── sync-harness-mirrors.sh    # AGENTS.md → 4개 mirror 자동 동기화
│   ├── builds/                    # 빌드·probe 스크립트
│   └── conform/                   # 계약 적합성 검사
│
│  # ── 문서 ────────────────────────────────────────────────────
│  # 설계 결정과 운영 지식. 코드보다 오래 살아남는 것들.
│
└── docs/
    ├── project-structure.md   # 이 구조의 공식 명세 + 등록 절차
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
