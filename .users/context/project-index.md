<!-- src-sha: 16836779e832565f -->
<!-- 자동 번역 미러 (M13-mirror). 원본: .agents/context/project-index.yaml -->

```markdown
# {{PROJECT_NAME}} 프로젝트 인덱스

**버전:** 0.1.0  
**최종 업데이트:** {{DATE}}

## 개요

{{PROJECT_DESCRIPTION}}

---

## 세션 시작 시 반드시 읽는 파일 (순서 중요)

### 1. `.agents/context/process-status.json`
**목적:** 현재 이슈 + 소프트웨어 개발 생명주기(SDLC) 게이트 상태 확인  
**주의:** last_updated 항목 갱신 필수

### 2. `.agents/context/agents-rules.json`
**목적:** 규칙의 진실의 원천(SoT) — 금지·필수 항목 전체 포함

### 3. `docs/project-structure.md`
**목적:** 허용된 루트 폴더 구조 명세

---

## 진입점

### `AGENTS.md`
AI 도구 하네스의 정식 진입점 (진실의 원천)

### `CLAUDE.md`
AGENTS.md의 Claude Code 미러

---

## 필요한 섹션만 로드 (온디맨드 로딩)

### 프로세스 및 요구사항
- **`docs/user-scenarios.md`** — 사용 사례(UC), 사용자 시나리오, 테스트 커버리지
- **`docs/requirements.md`** — 기능 요구사항(FR), 비기능 요구사항(NFR)
- **`docs/glossary.md`** — 용어, 명칭

### 아키텍처
- **`docs/ARCHITECTURE.md`** — 아키텍처, 패키지 맵, 의존성

### 활발한 이슈 & 진행 상황
- **`.agents/progress/`** — 이슈, 진행 중인 작업, SDLC 상태

### 보류 격리 자산
- **`quarantine/MANIFEST.json`** — 보류된 자산 및 방치 의심 파일 목록 (강제 추적)
  - 비어있지 않으면 백업 자산이 존재
  - `pending_notice` 항목은 권한 있는 사용자의 처분 대기
  - 관리 스크립트: `scripts/quarantine.mjs`

---

## 컨텍스트 우선순위

1. `.agents/context/agents-rules.json`
2. `AGENTS.md`
3. `.agents/context/project-index.yaml`
```
