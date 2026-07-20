# 01. 요구사항 Registry (REQ) — V모델 01

<!--
스키마: 이 한 파일 registry (항목당 별도 문서 ❌). 상태 = Draft→Approved→In-progress→Done.
추적: 모든 REQ는 ≥1 UC(02)로 닫히거나, NFR이면 ≥1 TEST-S(03)로 직결한다 (orphan 0).
컬럼 = | ID | 영역 | 요구사항 | 상태 | UC | SPEC | TEST |
scripts/check-traceability.mjs 가 이 표를 파싱한다. (ID 형식 = REQ-### / UC-### / SPEC-### / TEST-S-### / TEST-F-###)
출처 = docs/requirements.md(FR/NFR, 상세) + uc-migration-campaign(graft 현황). 상세 FR/NFR 본문 = 99.dev-comm 및 docs/requirements.md.
-->

> **이식 backfill (2026-06-15)**: 기존 `docs/requirements.md`(FR-F0~F3 + NFR) + UC 이관 캠페인 작업을 V모델로 회귀 정리.
> 상태는 **실제 graft/이식 현황** 반영(가시성). 상세 본문 = `docs/requirements.md`, `99.dev-comm/`.

## 기능 요구사항 (FR → REQ)

| ID | 영역 | 요구사항 | 상태 | UC | SPEC | TEST |
|---|---|---|---|---|---|---|
| REQ-001 | 부팅 | 외부 키 없이 naia-adk workspace **최소 부팅**(control-plane init); 손상=integrity/security-critical은 fail-closed, optional은 contain+정직보고 (구 FR-F0) | Done | UC-012 | SPEC-001 | TEST-S-012 |
| REQ-002 | 자기상태 | naia 가 **자기 상태 read-only 관측·정직 보고**(system-status·diagnostics·device·degradation), 오보 금지 (구 FR-F1.1) | In-progress | UC-011 | SPEC-002 | TEST-S-011 |
| REQ-003 | 승인 | **ApprovalPort 승인 게이트**(부재·거부·만료·중복·승인후 컨텍스트변경) + 승인↔실행↔결과 결속(correlation/context-digest) (구 FR-F1.2/1.4) | Done | UC-013 | SPEC-003 | TEST-S-013 |
| REQ-004 | 관측 | host-system **read-only 관측**(파일·프로세스, 변경X) + 외부간섭 drift 감지(observed vs expected) (구 FR-F2) | In-progress | UC-007 | SPEC-004 | TEST-S-007 |
| REQ-005 | 조작 | **승인→host-system mutating**(편집·실행) + reafference(commanded→ack→observed) + negative(거부·불확정 abort) (구 FR-F3) | In-progress | UC-007 | SPEC-005 | TEST-S-007 |
| REQ-006 | 대화 | **gRPC os→agent 텍스트 대화**(도구호출·thinking·멀티턴·취소·provider 출처) | Done | UC-001 | SPEC-006 | TEST-S-001 |
| REQ-007 | 온보딩/계정 | **온보딩 + 나이아 계정**: provider·naia계정·API키 설정 + OAuth 로그인 + 완료 영속(secret=키체인 전담). 2026-06-16 creds/auth 런타임 push graft+2-clean; **step2: wizard step-flow(assets+submit) core 경유 graft+3R 2-clean**(OAuth launch=셸측 유지=CSRF 회피). 잔여=루크머신 실앱 e2e(newCore 플래그+OAuth) | In-progress | UC-012 | SPEC-007 | TEST-S-012 |
| REQ-008 | 음성 | **음성 대화**(STT 입력·TTS/avatar 표현, provider WS 직결) | Draft | UC-002 | SPEC-008 | TEST-S-002 |
| REQ-009 | 도구/스킬 | 에이전트 **도구루프 + skills**(time/weather/memo/github/obsidian/mcp 등, agent-local) | In-progress | UC-005 | SPEC-006 | TEST-S-005 |
| REQ-010 | 브라우저 | 에이전트 **브라우저 조작**(navigate/click/fill/snapshot, agent-local + 외부 CLI) | Draft | UC-006 | SPEC-006 | TEST-S-006 |
| REQ-011 | 유투브/BGM | **공간 분위기 BGM**(youtube search/play/volume, agent-local + shell player) | Draft | UC-008 | SPEC-006 | TEST-S-008 |
| REQ-012 | Discord 채널 | **로컬 우선 Discord 채널 에이전트**: OS 키체인 토큰, 서버/채널 허용목록, 다중 채널 Inbox, 실시간 Gateway 송수신·재연결, 중복 방지, 개인 채팅 격리 (FR-DISCORD.1~10) | Done | UC-014, UC-015, UC-016 | SPEC-009, SPEC-010 | TEST-S-014, TEST-S-015 |

## 비기능 요구사항 (NFR → REQ, 횡단 — TEST-S 직결)

| ID | 영역 | 요구사항 | 상태 | UC | SPEC | TEST |
|---|---|---|---|---|---|---|
| REQ-101 | NFR-기반 | **substrate-agnostic 포트**(core 는 @tauri 미의존, OS/Tauri 비종속 — 장기 안드로이드 대비) | In-progress | — | — | TEST-S-101 |
| REQ-102 | NFR-안전 | **deny-by-default** + 민감도메인(security/policy/approval/safety) old-bug 자동 FAIL | In-progress | — | — | TEST-S-013 |
| REQ-103 | NFR-출처 | **provenance**: 모든 event=actor/correlation id, 승인행위=+context-digest+원자체인 | In-progress | — | — | TEST-S-103 |
| REQ-104 | NFR-결정론 | 계약 드리프트=0토큰 결정론 게이트(conform-gate) + drift-gate | In-progress | — | — | TEST-S-104 |

> 상세 FR-F0~F3.3 본문 + NFR 17종(error-model·port-canon·transparency·baseline·coverage·env-norm 등) = `docs/requirements.md`. 이 registry = 추적 SoT.
