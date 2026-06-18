# naia-os

Bazzite 기반 배포형 AI OS — naia-template-project clean rebuild (헥사고날 이식)

---

## ⚠️ Multi-tool Harness

이 파일은 **canonical SoT** (Single Source of Truth). 아래 4개 파일은 자동 동기화 mirror:

- `CLAUDE.md` (Claude Code)
- `GEMINI.md` (Gemini CLI)
- `OPENCODE.md` (opencode)
- `CODEX.md` (Codex)

**편집 규칙**: 이 `AGENTS.md`만 편집. `scripts/sync-harness-mirrors.sh` 또는 pre-commit hook이 4개 mirror 자동 갱신.

표준: [agents.md](https://agents.md/) (AAIF — Agentic AI Foundation, Linux Foundation, 2025-12 출범).

---

## Mandatory Reads (every session start)

코드를 만지기 전 순서대로 읽는다:

1. **프로세스 현황**: `.agents/context/process-status.json` — 현재 이슈와 P01~P05 게이트 상태. 세션 시작 시 읽고, `last_updated` 갱신. 세션 종료 시 완료 게이트 업데이트.
2. **규칙 SoT**: `.agents/context/agents-rules.json` — 모든 금지/필수 규칙.
3. **구조 명세**: `docs/project-structure.md` — 허용된 루트 디렉토리/파일 목록.

### ★ 작업 재시작/재부팅 시 — UC/기능 코딩보다 먼저 (MANDATORY)
드리프트는 구조가 안 단단하다는 신호. 코드 한 줄 전에 **구조 건전성 점검**부터:
```bash
bash scripts/enforce-root-structure.sh          # 루트 구조 위반
node scripts/check-assembly-coverage.mjs        # S/UC 완전성 (미분류 0)
npx tsc -p tsconfig.json && (cd packages/shell && pnpm test)  # 깨어짐
```
그리고 **드리프트 검출 갭** 확인: 파일단위 미계약 코드를 검출기가 잡나? `.agents/hooks/conform-gate.js` 가 가동 중인가(manifest regions 있나)? 안 잡으면/inert면 — 그 갭 닫기(라이브 자동차단)가 **UC 작업보다 최우선**. 잘못된 작업은 거짓 앵커 → 고치지 말고 삭제(수정은 실패한다 = 이식 원칙).

---

## 구조 규칙 (F12/F13 — permanent)

**새 디렉토리/파일 생성 전 반드시 확인**:
- 루트 디렉토리 → `agents-rules.json` F12 `allowed_root_dirs` 확인
- 루트 파일 → `agents-rules.json` F13 `allowed_root_files` 확인
- 패키지 → `pnpm-workspace.yaml` 확인

미등록 생성 시: `scripts/enforce-root-structure.sh --fix`가 **삭제**.

```bash
# 구조 검증 (dry-run)
./scripts/enforce-root-structure.sh

# 미등록 항목 삭제 (--fix)
./scripts/enforce-root-structure.sh --fix
```

---

## SDLC 프로세스 게이트 (P01~P05 — permanent)

모든 신규 기능/수정 작업은 이 순서를 반드시 따른다:

| 게이트 | 이름 | 산출물(deliverable) | 게이트 조건 |
|--------|------|---------------------|------------|
| P01 | 사용자 시나리오 | `docs/user-scenarios.md` UC 항목 | UC 없으면 다음 단계 금지 |
| P02 | 테스트 시나리오 | Test Coverage Map 매핑 | 테스트 매핑 없으면 다음 단계 금지 |
| P03 | 요구사항 | `docs/requirements.md` FR/NFR 항목 | 요구사항 없으면 코드 작성 금지 |
| P04 | 통합 테스트 | 테스트 파일(vitest + Playwright e2e + 해당 시 e2e-tauri) | 테스트 없으면 PR 머지 금지 — UI/Rust 변경은 실 UI(Playwright) 또는 실 백엔드(e2e-tauri) 검증 포함. 계획(P01~P03)에 Rust+UI 테스트 명시 포함 |
| P05 | 완료 | requirements.md 상태 → Done | 커밋 전 업데이트 필수 |

**세션 규칙**:
- 시작: `process-status.json` 읽기 → `last_updated` 갱신
- 종료/커밋 전: 완료 게이트 상태 + deliverable 업데이트

---

## 헌장 불변 원칙 (Charter Immutability)

확정된 헌장 파일은 **AI가 절대 단독 수정 불가**. 수정 시 사용자 명시 승인 필수.

헌장 파일:
- `AGENTS.md` + mirrors (`CLAUDE.md`, `GEMINI.md`, `OPENCODE.md`, `CODEX.md`)
- `.agents/context/agents-rules.json`
- `.agents/context/process-status.json`
- `docs/project-structure.md`

---

## 정규 디자인 문서

| 파일 | 역할 |
|------|------|
| `docs/project-structure.md` | 구조 명세 + 리소스 레지스트리 (헌장①) |
| `docs/requirements.md` | 기능/비기능 요구사항 |
| `docs/user-scenarios.md` | 사용자 시나리오 + 테스트 커버리지 맵 |
| `docs/glossary.md` | 도메인 용어사전 |
| `docs/ARCHITECTURE.md` | 시스템 아키텍처 |
| `docs/brain-body-environment.md` | 뇌·몸·환경 레이어 표준 (환경=독립 사이드카 기준) |

> 추가 시: 위 표에 먼저 등록 → `docs/project-structure.md` Doc Registry 업데이트.

---

## 작업 규칙

### 코드 변경 전 체크 4건

1. `AGENTS.md` + `process-status.json` 읽었는가?
2. P01~P03 게이트 완료됐는가?
3. 새 파일/폴더가 F12/F13에 등록됐는가?
4. 헌장 파일 수정이 아닌가? (수정 시 사용자 승인 필수)

### Commit 규칙

- **Conventional Commits**: `type(scope): summary`
- `process-status.json`이 변경됐으면 커밋에 포함
- 커밋 메시지에 관련 이슈 번호 + gate ID 명시

---

## 빌드 / 테스트

```bash
pnpm install    # 의존성 설치
pnpm build      # tsc --build
pnpm test       # 순수 로직 단위 — vitest run

# 검증 수단 (P04 — '검증 불가'로 punt 금지, GUI/Rust 도 헤드리스로 가능):
cd packages/shell
pnpm test                    # vitest (순수 로직)
pnpm test:e2e                # 실 UI 자동구동 Playwright e2e/ (Tauri IPC mock)
xvfb-run pnpm test:e2e:tauri # 실 Tauri 바이너리 e2e-tauri/ (wdio+tauri-driver, 실 Rust 백엔드 — UI→IPC→Rust→config/agent 풀스택). README=packages/shell/e2e-tauri/README.md, 헬퍼=configureSettings

# 구조 검증
./scripts/enforce-root-structure.sh

# harness 동기화 (AGENTS.md 편집 후)
./scripts/sync-harness-mirrors.sh
```

---

## 컨텍스트 SoT 우선순위

```
.agents/context/agents-rules.json  >  AGENTS.md (이 파일)  >  기타
```
