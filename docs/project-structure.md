# 프로젝트 구조 명세

> **SoT**: `.agents/context/agents-rules.json` F12/F13
> 새 파일/폴더 생성 전 반드시 이 문서에서 등록 여부 확인.
> 등록되지 않은 리소스 → `scripts/enforce-root-structure.sh --fix`가 **삭제**.

---

## 허용된 루트 디렉토리 (F12 Registry)

| 디렉토리 | 목적 |
|---------|------|
| `.agents/` | AI 컨텍스트 SoT — rules, progress, reviews |
| `.claude/` | Claude Code 설정 |
| `.github/` | CI/CD 워크플로우 |
| `.users/` | Human-readable mirror (.agents/ 내용 반영) |
| `about-docs/` | **이 표준 repo 자체**에 대한 메타 문서 (설명·검증 ledger·실험). payload 아님 — project-create/migration 이 복제 제외 |
| `benchmark/` | 성능·정확도·자율성 벤치마크 |
| `bin/` | CLI 진입점 |
| `data-private/` | 비밀·개인정보 (키·토큰·음성·얼굴 등) — gitignored, Git 추적 제외 (RBAC T3) |
| `docs/` | 정규 설계 문서 (이 표에 등록된 것만, 하위: `progress/` 이슈별 진행 산출물) |
| `examples/` | 실행 가능한 예제 |
| `node_modules/` | 의존성 (gitignored, 자동 생성) |
| `packages/` | 소스 패키지 (pnpm-workspace.yaml 등록된 것만) |
| `quarantine/` | **보류 격리**(처분 6번째) — 방치 의심 자산 백업. 실물은 gitignore, `MANIFEST.json`/`README.md` 만 추적. `scripts/quarantine.mjs` 관리 (agents-rules `quarantine_policy`) |
| `READMES/` | 다국어 README |
| `scripts/` | 빌드·검증·운영 스크립트. **분류 레지스트리=`scripts/README.md`**(신규 스크립트 등록 필수). 물리 하위: `cron/`·`builds/`·`conform/`(참조 안전). |
| `src/` | 소스 코드 (하위: `main/` 메인 소스, `test/` 테스트) |

> 새 디렉토리 추가 시: `agents-rules.json` F12 → 이 표 → 사용자 승인 순서 필수.

---

## 허용된 루트 파일 (F13 Registry)

| 파일 | 목적 |
|------|------|
| `AGENTS.md` | AI 도구 진입점 — canonical SoT |
| `CLAUDE.md` | AGENTS.md mirror (Claude Code) |
| `GEMINI.md` | AGENTS.md mirror (Gemini CLI) |
| `OPENCODE.md` | AGENTS.md mirror (opencode) |
| `CODEX.md` | AGENTS.md mirror (Codex) |
| `.gitignore` | Git 제외 규칙 |
| `.gitmodules` | 서브모듈 설정 — _planned (현재 서브모듈 없음, 미존재. whitelist 예약)_ |
| `.env.example` | 환경변수 예시 (시크릿 없는 샘플 — `.github/workflows/oss-readiness.yml` 체크리스트 항목) |
| `LICENSE` | 라이선스 |
| `CONTEXT-LICENSE` | AI 컨텍스트 라이선스 범위와 재사용 조건 |
| `package.json` | 루트 workspace 패키지 설정 (`@nextain/naia-os-core`) |
| `pnpm-workspace.yaml` | pnpm workspace 패키지 목록 |
| `pnpm-lock.yaml` | pnpm 잠금 파일 |
| `tsconfig.json` | TypeScript 프로젝트 참조 |
| `tsconfig.base.json` | 공통 tsconfig 기본값 — _planned (현재 미존재. whitelist 예약)_ |
| `vitest.config.ts` | vitest 설정 (루트 코어/계약 테스트 include — 크로스플랫폼) |
| `README.md` | 이 repo 소개 (복제 제외) |
| `README.template.md` | 새 프로젝트가 받는 README skeleton (create/migration 이 README.md 로 사용) — _planned (현재 미존재. whitelist 예약)_ |
| `CHANGELOG.md` | 변경 이력 — _planned (현재 미존재. whitelist 예약)_ |
| `review-pass.yaml` | 크로스리뷰 리뷰어 패널 project-local override (정본 SoT = naia-settings/review.json) — _planned (현재 미존재. whitelist 예약)_ |

> 새 파일 추가 시: `agents-rules.json` F13 → 이 표 → 사용자 승인 순서 필수.
> _planned_ = whitelist(F13)에는 예약돼 있으나 이 repo 에 아직 실파일이 없는 항목 (template/standard 용 forward-looking 예약 — `enforce-root-structure.sh` 는 존재 강제 없음, 없어도 통과).

---

## 등록된 패키지 (Package Registry)

`packages/` 아래 패키지는 `pnpm-workspace.yaml`에 등록된 것만 생성 가능.

새 패키지 추가 절차:
1. `pnpm-workspace.yaml` 먼저 수정
2. `agents-rules.json` 패키지 목록 업데이트
3. 이 표에 추가
4. 사용자 승인 후 실제 폴더/파일 생성

| 패키지 디렉토리 | npm name | 계층 | 설명 |
|--------------|----------|------|------|
| `packages/shell` | `naia-shell` | 몸(셸 UI) | Tauri 데스크톱 셸 — React 프론트엔드·아바타·음성 I/O·e2e. 코어(`@nextain/naia-os-core`)를 `chat-service` 로 결선 |
| `packages/bgm-sidecar` | `@naia/bgm-sidecar` | 환경(사이드카) | YouTube BGM HTTP 서버(포트 18791). 뇌와 분리된 독립 서비스 (SoT: `docs/brain-body-environment.md`) |

> 루트 패키지(`packages/` 밖)는 `@nextain/naia-os-core` (코어 = `src/main/`, F12 `src/` 등록). `packages/` 등록 대상 아님.

---

## 정규 문서 (Doc Registry)

`docs/` 아래 문서는 `AGENTS.md` 정규 디자인 문서 표에 등록된 것만.

새 문서 추가 절차:
1. `AGENTS.md` 정규 디자인 문서 표에 먼저 추가
2. 이 표에 추가
3. 사용자 승인 후 실제 파일 생성

**정규 디자인 문서 (`AGENTS.md` 표 등록 — 헌장/설계 SoT):**

| 파일 | 역할 |
|------|------|
| `project-structure.md` | 이 파일 — 구조 명세 |
| `requirements.md` | 기능/비기능 요구사항 |
| `user-scenarios.md` | 사용자 시나리오 + 테스트 커버리지 맵 |
| `glossary.md` | 도메인 용어사전 |
| `ARCHITECTURE.md` | 시스템 아키텍처 |
| `brain-body-environment.md` | 뇌·몸·환경 레이어 표준 (환경=독립 사이드카 기준) |

**보조 문서 (`docs/` 실재 — 색인=`docs/README.md`, 링크 무결성=`scripts/check-doc-graph.mjs`):**

| 파일 | 역할 |
|------|------|
| `README.md` | docs 색인(목차) — 모든 문서로 가는 진입점 |
| `STRUCTURE.md` | 이식 구조(1단계 뼈대) — template→헥사고날 이식 정본 |
| `00-PHASES.md` | 페이즈 인덱스 — 진행 순서 SoT(발표용) |
| `PRESENTATION.md` | 발표 자료 골자(`##` = 슬라이드 1장) |
| `acceptance-criteria.md` | 합격 기준 — 검증이 게이트를 대체 |
| `llm-roles.md` | LLM 역할 분담(작은 모델 ↔ 큰 모델) 표준 |
| `logging.md` | 로깅 규약(shell + Rust) |
| `threat-model.md` | 위협 모델·한계(하네스가 막는 것/못 막는 것) |

> `progress/` 하위(이슈별 진행 산출물·dev-comm)는 시간순 ledger 라 이 레지스트리 대상이 아니다(`check-doc-graph --exempt progress`).

---

## 강제 실행

```bash
./scripts/enforce-root-structure.sh         # dry-run — 위반 목록 출력
./scripts/enforce-root-structure.sh --fix   # 미등록 항목 삭제
```
