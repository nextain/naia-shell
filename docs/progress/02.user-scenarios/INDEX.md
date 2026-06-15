# 02. 사용자 시나리오 Registry (UC) — V모델 02

<!--
스키마: 이 한 파일 registry. 상태 = Draft→Approved→In-progress→Done.
추적: 모든 UC는 ≥1 REQ(01)에서 유도되고(역추적), ≥1 TEST-S(03)로 닫힌다 (orphan 0).
컬럼 = | ID | 영역 | 누가 → 무엇을 → 왜 | 유도 REQ | 상태 | TEST-S |
상세 시나리오(UC1~14 + S01~71 granular) = docs/user-scenarios.md. 이 registry = 추적 SoT + 우선순위 현황.
-->

> **이식 backfill (2026-06-15)**: 기존 `docs/user-scenarios.md`(UC1~14)를 V모델로 회귀 정리. UC-### = 신 ID, 괄호 = 구 UC 번호.
> 상태 = **유저 여정 우선순위(루크 2026-06-15) 기준 실제 현황**. ⑧메모리·⑨워크스페이스 = 현 스코프 제외.

## 사용자 시나리오 (우선순위 순)

| ID | 영역 | 누가 → 무엇을 → 왜 | 유도 REQ | 상태 | TEST-S |
|---|---|---|---|---|---|
| UC-012 | ①온보딩+계정 | 사용자가 온보딩에서 provider·나이아계정·키를 설정하고 완료 → 에이전트가 그 설정으로 동작 (구 UC12/UC12-min). **2026-06-16: 계정/creds/키 런타임 push graft(2-clean) + step2 wizard step-flow(assets·submit·게이트·auth-callback) core 경유 graft(3R 2-clean). 잔여=루크머신 실앱 e2e(newCore 플래그+OAuth)** | REQ-001, REQ-007 | In-progress | TEST-S-012 |
| UC-001 | ②채팅 | 사용자가 텍스트로 대화 → 에이전트가 gRPC(os→agent) 경유 응답(도구·thinking·멀티턴·취소) (구 UC1) | REQ-006 | Done | TEST-S-001 |
| UC-013 | ③승인 | 사용자가 위험 행위(도구실행 등)를 승인/거부 → 승인된 것만 실행 (구 UC13) | REQ-003 | Done | TEST-S-013 |
| UC-005 | ④스킬 | 에이전트가 도구/스킬(time·weather·memo·github·obsidian·mcp)을 실행 (구 UC5) | REQ-009 | In-progress | TEST-S-005 |
| UC-002 | ⑤음성 | 사용자가 음성으로 대화 → STT 입력·TTS/avatar 표현 (구 UC2) | REQ-008 | Draft | TEST-S-002 |
| UC-008 | ⑥유투브/BGM | 사용자/에이전트가 공간 분위기(youtube BGM)를 제어 (구 UC8) | REQ-011 | Draft | TEST-S-008 |
| UC-006 | ⑦브라우저 | 에이전트가 브라우저를 조작(navigate/click/fill) (구 UC6) | REQ-010 | Draft | TEST-S-006 |
| UC-011 | 자기상태 | naia 가 자기 상태(시스템/진단/장치)를 정직 보고 (구 UC11/UC14) | REQ-002 | In-progress | TEST-S-011 |
| UC-007 | ⑨워크스페이스(제외) | 에이전트가 host-system 관측·조작(승인) (구 UC7/UC7a) — **현 스코프 제외**(DriftDetector/MutationGate=old 소비자 부재, 방향 미해결) | REQ-004, REQ-005 | Draft | TEST-S-007 |

> **제외(루크 2026-06-15)**: ⑧메모리(구 UC3/UC4)=off-scope(naia-memory 다른 세션 소유, canon out_of_scope). ⑨워크스페이스(UC-007)=보류(신규발명 방향 결정 후).
> 상세 granular(S01~71 — provider/voice/skills/channels 60+)·테스트 커버리지 맵 = `docs/user-scenarios.md`.
