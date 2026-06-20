<!-- src-sha: e56009c568ab9da4 -->
<!-- 자동 번역 미러 (M13-mirror). 원본: .agents/context/process-status.json -->

# 프로세스 현황 (SoT — Single Source of Truth)

**버전**: 1.0

**목적**: 프로세스 현황 기록의 정본(SoT). 세션 시작·종료 시 반드시 업데이트하고, 구조 명세·이슈·리소스를 유기적으로 연결.

---

## 참조 파일

| 항목 | 경로 |
|------|------|
| 프로젝트 구조 | `docs/project-structure.md` |
| 규칙 SoT | `.agents/context/agents-rules.json` |
| 이슈 문서 폴더 | `docs/progress/` |
| 스크립트 레지스트리 | `scripts/README.md` |

---

## 현재 작업

| 항목 | 내용 |
|------|------|
| **이슈 코드** | `naia-os-transplant` |
| **제목** | naia-os 헥사고날 이식 — 기초 단계(F0~F3): 제어평면·자기상태·관측·조작 |
| **이슈 문서** | `docs/progress/` (F0-baseline, F0-contract, F{1,2,3}-baseline-contract, F0-graft) + 00-PHASES.md |
| **GitHub 이슈** | 없음 |
| **시작일** | 2026-06-08 |
| **마지막 갱신** | 2026-06-10 00:12 UTC |
| **상태** | 진행 중 |
| **참고** | F0~F3 계약서 (Codex/Gemini/GLM 교차검토 수렴) + 코드 스캐폴드(비동기, src/main). 계약 및 통합 테스트 67/67 통과. 실제 부팅(grafting) = Luke 머신 대기 중 |

---

## SDLC 게이트 (단계별 진행 상황)

### P01: 사용자 시나리오

| 항목 | 내용 |
|------|------|
| **상태** | 완료 |
| **이름** | 사용자 시나리오 |
| **산출물** | `docs/user-scenarios.md` (UC 1-14, S01~S71) |
| **기록** | 완전성 검증 13회 × 3연속 이상 없음(NONE) |

### P02: 테스트 시나리오

| 항목 | 내용 |
|------|------|
| **상태** | 완료 |
| **이름** | 테스트 시나리오 |
| **산출물** | `docs/user-scenarios.md` 테스트 커버리지 맵 + `src/test/*.contract.test.ts` (계약 67/67 통과) |
| **기록** | 13회 |

### P03: 요구사항

| 항목 | 내용 |
|------|------|
| **상태** | 완료 |
| **이름** | 요구사항 |
| **산출물** | `docs/requirements.md` (기능 요구사항 FR-F0~F3, 비기능 요구사항 NFR) |
| **기록** | 8회 |

### P04: 통합 테스트

| 항목 | 내용 |
|------|------|
| **상태** | 진행 중 |
| **이름** | 통합 테스트 |
| **산출물** | `src/test/integration-reafference.test.ts` (인지 흐름 관통+음수 테스트+오염 검증) + `scripts/builds/f0-graft-smoke.sh` (기존 기준선 표류 감지 장치/harness) |
| **기록** | 통합 67/67 통과 완료; 라이브 추적(Luke 머신 grafting) 대기 중 |

### P05: 요구사항 완료

| 항목 | 내용 |
|------|------|
| **상태** | 보류 |
| **이름** | 요구사항 완료 |
| **산출물** | — |
| **기록** | 라이브 추적 등가성 확인 + 후속 슬라이스 완료 후 |

---

## 리소스 레지스트리

| 항목 | 내용 |
|------|------|
| **마지막 강제 검증 실행** | 2026-06-10 00:06 UTC |
| **규칙 위반 사항** | 없음 |

---

## 사용 가이드

### 세션 시작 시

1. 이 파일을 읽는다
2. `current_work` 섹션에서 현재 상황을 확인한다
3. `last_updated`를 현재 시각으로 갱신한다
4. `sdlc_gates` 각 단계의 상태를 확인한 후 작업을 시작한다

### 세션 종료 또는 커밋 전

1. 완료된 게이트의 상태를 `done`으로 표시한다
2. 산출물(`deliverable`) 경로를 기재한다
3. `last_updated`를 갱신한다
4. `.users/context/process-status.md`와 동기화한다
5. 이 파일을 커밋에 포함한다

### 새로운 이슈 시작 시

1. `current_work` 필드를 업데이트한다
2. `docs/progress/issue-{번호}-{이름}.md` 신규 문서를 생성한다
3. `sdlc_gates` 모든 단계의 상태를 `pending`으로 리셋한다
4. `resource_registry.violations` 배열을 초기화한다
