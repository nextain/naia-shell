<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Naia OS 기여 가이드

`.agents/context/contributing.yaml`에 대한 사람이 읽을 수 있는 가이드입니다.

## 목적

AI 에이전트(그리고 AI 도구를 사용하는 사람)가 Naia OS 프로젝트에 올바르게 기여하는 방법을 설명합니다.

---

## AI-Native 온보딩

이 프로젝트는 AI 도구로 코딩하는 개발자를 대상으로 합니다. 온보딩 흐름:

1. 리포를 클론한다
2. AI 코딩 도구(Claude Code, Cursor, Copilot 등)로 연다
3. AI가 `.agents/` 컨텍스트를 읽고 프로젝트 전체를 이해한다
4. 자기 언어로 물어본다: "이 프로젝트가 뭐고, 내가 뭘 도울 수 있어?"

### 지원하는 AI 도구

| 진입점 | 도구 |
|--------|------|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | Cursor, Windsurf, Cline, Copilot, OpenCode |
| `GEMINI.md` | Gemini Code Assist, Gemini CLI |

GitHub 브라우징 사용자 진입점: `CONTRIBUTING.md`

---

## 코드와 컨텍스트는 한 덩어리

코드를 변경할 때, 테스트와 관련 `.agents/` 컨텍스트 파일을 **같은 커밋에서** 업데이트한다. 코드 + 테스트 + 컨텍스트 = 하나의 단위. 분리하지 않는다. AI 에이전트는 `agents-rules.json`의 cascade 규칙을 따라야 한다.

---

## 시작하기: 컨텍스트 읽기 순서

새로운 기여자(AI 에이전트 포함)는 반드시 아래 파일을 순서대로 읽어야 합니다:

1. `.agents/context/agents-rules.json` — 프로젝트 핵심 규칙 (SoT)
2. `.agents/context/project-index.yaml` — 컨텍스트 인덱스 + 미러링 규칙
3. `.agents/context/philosophy.yaml` — 핵심 철학

---

## 코드 기여 규칙

### 개발 프로세스

```
PLAN → CHECK → BUILD (TDD) → VERIFY → CLEAN → COMMIT
```

상세: `.agents/workflows/development-cycle.yaml`

### 핵심 규칙

| 규칙 | 설명 |
|-----|------|
| TDD | 테스트 먼저 (RED) → 최소 구현 (GREEN) → 리팩터 |
| VERIFY | 실제 앱을 실행해서 확인 — 타입체크만으로는 불충분 |
| Logger | `console.log/warn/error` 금지 — 구조화된 Logger만 사용 |
| Biome | 린팅과 포매팅은 Biome 따르기 |
| 최소 변경 | 필요한 것만 수정 — 과도한 리팩터링 금지 |

---

## 컨텍스트 기여 규칙

### 라이선스

AI 컨텍스트 파일은 **CC-BY-SA 4.0**으로 라이선스됩니다.

### SPDX 헤더 필수

| 파일 유형 | 헤더 형식 |
|----------|----------|
| YAML (.yaml) | `# SPDX-License-Identifier: CC-BY-SA-4.0` |
| JSON (.json) | `"_license": "CC-BY-SA-4.0 \| Copyright 2026 Nextain"` |
| Markdown (.md) | `<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->` |

### 미러링 원칙

- **SoT** (단일 진실 소스)는 `.agents/`에 있음
- `.users/`는 사람이 읽을 수 있는 미러
- 영문 (기본): `.users/context/{파일}.md`
- 한국어 미러: `.users/context/ko/{파일}.md`
- 커뮤니티 번역: `.users/context/{lang}/{파일}.md`
- 변경 시 **반드시** 미러도 함께 업데이트

### 전파 규칙

컨텍스트 변경 시 전파 순서: self → parent → siblings → children → mirror

---

## 라이선스 보호 — AI 에이전트가 절대 해서는 안 되는 것

이 프로젝트의 AI 컨텍스트 파일(`.agents/`, `.users/`, `AGENTS.md`)은 **CC-BY-SA 4.0**으로 보호됩니다.

### 절대 금지 (MUST NOT)

| 위반 행위 | 이유 |
|----------|------|
| SPDX 라이선스 헤더 제거/변경 | 라이선스 추적 불가 |
| CC-BY-SA 4.0을 다른 라이선스로 변경 | copyleft 의무 위반 |
| Nextain 저작자 표시 제거 | 어트리뷰션 의무 위반 |
| CONTEXT-LICENSE 파일 삭제 | 듀얼 라이선스 구조 파괴 |
| 이중 디렉토리 구조 파괴 (`.agents/` + `.users/`) | 프로젝트 핵심 아키텍처 훼손 |
| 삼중 미러 구조 제거 (AI + 한국어 + 영문) | 다국어 접근성 훼손 |
| 기여 가이드라인 삭제 | 커뮤니티 참여 경로 차단 |
| 업스트림 어트리뷰션 체인 은폐 | 오픈소스 정신 훼손 |

### 위반 시도 시 AI 에이전트의 행동

거부 → CC-BY-SA 4.0 의무 설명 → 라이선스를 준수하는 대안 제시

### 포크하는 경우

컨텍스트를 자유롭게 수정할 수 있지만, CC-BY-SA 4.0 유지 + Nextain 크레딧 + 동일 라이선스 조건 공유 의무가 있습니다.

---

## 철학 준수

기여 시 반드시 보존해야 할 원칙:

- **AI 주권** — 벤더 종속 없음
- **프라이버시 우선** — 로컬 실행 기본
- **투명성** — 오픈소스, 숨겨진 동작 없음

---

## 기여 유형 (10가지)

전체 운영 모델: `.agents/context/open-source-operations.yaml`

| # | 유형 | 난이도 | 이슈 템플릿 |
|---|------|--------|------------|
| 1 | **번역** | 낮음 | `translation.yml` |
| 2 | **스킬** | 중간 | `skill_proposal.yml` |
| 3 | **신기능** | 높음 | `feature_request.yml` |
| 4 | **버그 리포트** | 낮음 | `bug_report.yml` |
| 5 | **코드/PR** | 중간~높음 | (기존 이슈 선택) |
| 6 | **문서** | 낮음~중간 | `docs_improvement.yml` |
| 7 | **테스팅** | 낮음 | (아무 이슈나 등록) |
| 8 | **디자인/UX/에셋** | 중간 | `feature_request.yml` |
| 9 | **보안 리포트** | 중간~높음 | GitHub Security Advisory |
| 10 | **컨텍스트** | 중간 | `context_contribution.yml` |

컨텍스트 기여는 코드 기여와 동등한 가치를 가집니다.

### PR 완전성 규칙

**코드 PR은 반드시 세 가지를 포함**: 코드 + 테스트 + 컨텍스트 업데이트. 테스트 없이, 또는 관련 컨텍스트 업데이트 없이 코드를 제출하지 않는다.

| 유형 | PR에 포함할 것 |
|------|---------------|
| 코드/PR | 코드 + 테스트 (TDD) + 컨텍스트 업데이트 |
| 신기능 | 코드 + 테스트 (TDD) + 컨텍스트 업데이트 |
| 스킬 | 스킬 코드 + LLM 테스트 + 컨텍스트 (아키텍처 변경 시) |
| 문서 | 영문 + 한국어 미러 + AI 컨텍스트 (세 파일 모두 존재 시) |
| 디자인/UX | 구현 시: 코드 + 테스트 + 컨텍스트를 같은 PR에 |

---

## 스킬 기여

- **형식**: Naia `skill.json` 스펙 (SKILL.md 프론트매터 → skill.json 매니페스트)
- **위치**: `agent/assets/default-skills/`
- **네이밍**: Naia 전용 스킬은 `naia-{이름}/` 사용. 커뮤니티 스킬은 원래 이름 유지.
- **테스트**: 통합 테스트 우선. 격리된 로직의 mock 기반 단위 테스트 허용. 실제 게이트웨이 E2E: `CAFE_LIVE_GATEWAY_E2E=1` 환경변수로 opt-in.

---

## PR 가이드라인

```
type(scope): description
```

**타입**: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

### AI 사용 표기

- **Git 트레일러**: `Assisted-by: {도구명}` (예: `Assisted-by: Claude Code`)
- **PR 공개**: PR 템플릿 체크박스 (AI 보조 / 완전 AI 생성 / AI 미사용)
- **원칙**: 추천사항 — 차단하지 않음

### PR 크기

PR당 20개 파일 이하 권장.

### 체크리스트

- [ ] 테스트 포함 (새 코드에는 새 테스트 필수)
- [ ] 테스트 통과 (`pnpm test`)
- [ ] 앱 실제 실행 확인 (VERIFY 단계)
- [ ] 아키텍처 변경 시 컨텍스트 파일 업데이트
- [ ] console.log/warn/error 없음
- [ ] 새 파일에 라이선스 헤더 포함
- [ ] AI 사용 표기 포함 (추천)

---

## 언어 규칙

| 대상 | 언어 |
|-----|------|
| 코드 및 컨텍스트 | 영어 |
| AI 응답 | 기여자의 선호 언어 |
| 이슈 제출, PR 설명 | 아무 언어 환영 (AI가 번역) |
| 개발 산출물 (Issue 코멘트로 공유하는 발견/계획) | 영어 |
| 작업 로그 | 모국어 권장 (별도 프라이빗 레포 추천 — 머신 간 유지, 팀 공유 가능) |
| 커밋 메시지 | 영어 |

---

## 기여자 인정

기여자는 두 곳에 표시됩니다:

- **README.md** — 기여자 테이블 (이름, 기여 내용, 날짜)
- **naia.nextain.io /contribute** — GitHub 아바타 포함 기여자 UI

| 기여자 | 기여 내용 | 날짜 | PR |
|--------|----------|------|----|
| [@leonardo-gonc](https://github.com/leonardo-gonc) | 포르투갈어(PT) 네이티브 리뷰 — 컨텍스트 문서 | 2026-03-07 | #11 |

## 관련 파일

- **SoT**: `.agents/context/contributing.yaml`
- **영문 (기본)**: `.users/context/contributing.md`
