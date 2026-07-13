<!-- src-sha: ca7340883704add4 -->
<!-- 자동 번역 미러 (M13-mirror). 원본: .agents/context/process-status.json -->

# 프로세스 현황 (SoT — Single Source of Truth)

**버전**: 1.0

**컨텍스트 마지막 갱신**: 2026-07-13 10:05 UTC

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
| **이슈 코드** | `naia-shell-transplant` |
| **제목** | naia-shell 헥사고날 이식 — 기초 단계(F0~F3): 제어평면·자기상태·관측·조작 [repo=naia-shell; naia-os=배포판 계층 별개] |
| **이슈 문서** | `docs/progress/` (F0-baseline, F0-contract, F{1,2,3}-baseline-contract, F0-graft) + 00-PHASES.md |
| **GitHub 이슈** | 없음 |
| **시작일** | 2026-06-08 |
| **마지막 갱신** | 2026-07-10 00:00 UTC |
| **상태** | 진행 중 |
| **참고** | 2026-07-10 검증·경화(8G 아바타 근본수정 확인): opencode GLM 5.2 이식분 리뷰+실측. 아바타 스폰=gpu.tier(EXCLUSIVE_8G_TIERS)+localFocus 구동(wm: avatar=provider 무형) → buildSlotsManifest 가 localGpuTier auto→해석된 tier id 로 기록해야 wm 이 avatar_ditto_trt 스폰(미해소=미표시). adk-store=vram 자동감지. Rust kill_stale_cascade(8910 고아 EADDRINUSE 방지). GLM 잔여 TSC break 수정 + vite.config test.exclude src-tauri/** 추가(스테이징 agent 620테스트 오염 제거). tsc0·셸 vitest 1096 GREEN·cargo0·Playwright 전 스펙 격리 GREEN(full 병렬 40실패=8G 부하 flakiness, 회귀 아님). \| 2026-06-30 Round2(로컬 cascade 임베딩, 멀티레포, FR-CASCADE.1~4): R2.1=windows-manager loader launch 슈퍼바이저+plan --json(wm 1756f4b). R2.2=naia-shell slots-manifest write + Rust start/stop/cascade_status + CascadeProcess + 설정 토글 UI. 원격금지 로컬 사이드카. cargo0·tsc0·SettingsTab+slots66. 8GB 음성단독 적합(RTF=R2.3 DEFER). \| Round1: 프로파일 UX 일관화 + VRAM 슬롯 추천 + 로컬 음성 정직화(FR-VRAM.4·FR-PROF.1·FR-VOICE, naia-shell 13cef2c5, 적대리뷰 PASS, vitest 1008). ⚠️ 본 미러는 자동생성(M13)이며 이전 K2/K3 drift 존재 — 자동 동기화 필요. \| (이전) F0~F3 계약 + 스캐폴드, 통합 67/67. |

---

## 대기 중인 작업: RTX 3090 NVA talking-head 결정 실험

| 항목 | 내용 |
|------|------|
| **상태** | 핸드오프 준비 완료 (`handoff_ready`) |
| **실행 호스트** | RTX 3090 24GB PC |
| **공개 진행 이슈** | [naia-shell #376](https://github.com/nextain/naia-shell/issues/376) |
| **비공개 실행 이슈** | [Cascade private handoff #24](https://github.com/nextain/naia-omni-cascade/issues/24) — maintainer access 필요 |
| **비공개 backend preflight** | [Cascade #25](https://github.com/nextain/naia-omni-cascade/issues/25) — 재현 기준선·자산·container smoke 선행 |
| **상위 이슈** | [naia-shell #366](https://github.com/nextain/naia-shell/issues/366) |
| **실행 순서** | private #25 preflight → Cascade #12 RED → #11 GREEN → #19 RED → #18 GREEN → 사용자 protocol 승인 → #13 실험 |
| **NVA 편집기 기준선** | `nextain/naia-video-avatar` `feat/nva-editor-baseline` @ `3a3c9aa7103b8da0bc3a667b720ecd9d57fbbe87` |
| **비공개 backend** | 기준선·자산·실행 명령·증거 위치는 private handoff에서 검증하며 공개 컨텍스트에 복제하지 않음 |
| **계획 검토** | 독립 적대 리뷰 2회 연속 CLEAN |
| **중단 지점** | #13 증거·판정표 생성 후 production 계약을 확정하지 않고 사용자 결정 요청 |
| **보류 범위** | 발음별 clip, N² 전이, interpolation, production loader/합성 확정, Vertex/Gemini/credit/export, Shell #367~#374 |

이 작업은 기존 `naia-shell-transplant` 현재 작업을 대체하지 않는다. 3090 PC의 별도 세션이 공개 #376에서 상태를 확인하고 private #24를 실행하며, Shell 통합은 NVA/Cascade/naia.land 계약이 승인된 뒤 마지막에 진행한다.

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
