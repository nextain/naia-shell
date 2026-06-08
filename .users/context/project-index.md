<!-- src-sha: 9ca11b69fa066f2f -->
<!-- 자동 번역 미러 (M13-mirror). 원본: .agents/context/project-index.yaml -->

```markdown
# naia-os 컨텍스트 인덱스

프로젝트: naia-os  
버전: 0.1.0  
업데이트: 2026-06-08  
설명: Bazzite 기반 배포형 AI 운영체제 — naia-template-project 전면 재구성 (육각형 아키텍처 이식)

---

## 세션 시작 시 반드시 읽을 파일 (순서 중요)

| 파일 | 목적 |
|------|------|
| `.agents/context/process-status.json` | 현재 이슈 및 SDLC(Software Development Life Cycle) 게이트 상태. 세션 시작 시 `last_updated` 갱신 필수 |
| `.agents/context/agents-rules.json` | 규칙 단일 정보원 (Single Source of Truth) — 전체 금지·필수 사항 |
| `docs/project-structure.md` | 루트 디렉토리·파일 허용 명세 |

---

## 진입점

| 파일 | 목적 |
|------|------|
| `AGENTS.md` | AI 도구 통합 진입점 (canonical SoT) |
| `CLAUDE.md` | AGENTS.md의 Claude Code 미러 |

---

## 필요할 때만 로드하는 섹션

### 프로세스·요구사항

- **`docs/user-scenarios.md`** — 사용 사례(UC), 사용자 시나리오, 테스트 커버리지 맵
- **`docs/requirements.md`** — 기능 요구사항(FR), 비기능 요구사항(NFR)
- **`docs/glossary.md`** — 도메인 용어사전

### 아키텍처

- **`docs/ARCHITECTURE.md`** — 시스템 아키텍처, 패키지 맵, 의존성

### 진행 상황

- **`.agents/progress/`** — 이슈, 진행 중 작업, SDLC 게이트

### 격리 자산

- **`quarantine/MANIFEST.json`** — 보류·격리된 미사용 자산 목록 (강제 추적)
  - 비어있지 않으면: 백업 자산 존재 의미
  - `pending_notice` 항목: 권한자 처분 대기 중
  - 관리: `scripts/quarantine.mjs`

---

## 컨텍스트 단일 정보원(SoT) 우선순위

1. `.agents/context/agents-rules.json`
2. `AGENTS.md`
3. `.agents/context/project-index.yaml`
```
