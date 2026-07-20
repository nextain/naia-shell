# 03. 시나리오 테스트 Registry (TEST-S) — V모델 03

<!--
스키마: 이 한 파일 registry. UC(02)·NFR(01)을 검증하는 시스템/인수 테스트.
추적: 모든 UC는 ≥1 TEST-S로 닫힌다. TEST-S는 ≥1 UC 또는 NFR-REQ를 가리킨다(역추적, orphan 0).
컬럼 = | ID | 검증대상(UC/REQ) | 시나리오 요약 | 형태 | test_ref | 상태 |
형태 = e2e(Playwright 실 UI) / seam통합 / 통합스모크. 유닛/계약 테스트는 05(TEST-F).
-->

> **이식 backfill (2026-06-15)**: e2e `packages/shell/e2e/*.spec.ts` + seam 통합테스트를 V모델로 정리.
> 상태 = **2026-06-15 이 세션이 직접 실행한 e2e 결과**(`pnpm test:e2e` 62p/24f, graft scope 전부 Pass).

## 시나리오 테스트

| ID | 검증대상(UC/REQ) | 시나리오 요약 | 형태 | test_ref | 상태 |
|---|---|---|---|---|---|
| TEST-S-001 | UC-001 | 채팅 new-core 경유 응답 + 도구/thinking/멀티턴/취소 변종 | e2e | `packages/shell/e2e/uc1-new-core.spec.ts`, `uc1-new-core-variants.spec.ts` | Pass |
| TEST-S-013 | UC-013, REQ-102 | 승인 게이트(approval_request→사용자 결정→실행) e2e — deny-by-default 포함 | e2e | `packages/shell/e2e/uc13-approval.spec.ts` | Pass |
| TEST-S-012 | UC-012 | 온보딩 완료 → new core `completeWith` 영속(write_naia_config agent-only secret strip + 키체인) | seam통합 | `packages/shell/src/lib/__tests__/onboarding-core.test.ts` | Pass |
| TEST-S-005 | UC-005 | 도구루프(도구 tool_use→tool_result) new-core 경유 | e2e(부분) | `packages/shell/e2e/uc1-new-core-variants.spec.ts` (도구 변종) | Partial |
| TEST-S-002 | UC-002 | 음성 대화(STT→LLM→TTS/avatar) | e2e | — | Planned |
| TEST-S-006 | UC-006 | 브라우저 조작 | e2e | `packages/shell/e2e/197-browser-login.spec.ts`(old-path) | Planned |
| TEST-S-007 | UC-007 | workspace 관측/조작 | e2e | `packages/shell/e2e/91-workspace-panel.spec.ts`(old-path) | Planned |
| TEST-S-008 | UC-008 | youtube BGM 검색/재생 | e2e | — | Planned |
| TEST-S-011 | UC-011 | 자기상태/진단 보고(Diagnostics RPC) | e2e | — | Planned |
| TEST-S-016 | UC-017 | 계약: activity 표시/TTS·yield/control/stop·stale 폐기. 실제 Tauri: profile 저장·복원, DJ 실제 BGM·첫 결과·stop, 전시 greeting·stop | 계약+부분 native | `packages/shell/src/lib/__tests__/speech-profile-commands.test.ts`, `packages/shell/e2e-tauri/specs/71-proactive-speech-profiles.spec.ts` | Partial |
| TEST-S-101 | REQ-101 | substrate-agnostic: core 가 @tauri-apps 미의존(import 검사) | 정적 | (compile-integrity + import 검사) | Planned |
| TEST-S-103 | REQ-103 | provenance: provider 출처 추적(actor/correlation) | e2e | `packages/shell/e2e/uc-provider-provenance-live.spec.ts` | Pass |
| TEST-S-104 | REQ-104 | 계약 드리프트 0토큰 결정론 게이트 | 게이트 | `scripts/conform/` (conform-gate) | Planned |
| TEST-S-014 | UC-014, UC-015 | Discord 연결 설정·접근 가능 채널 저장(CAS) + Inbox/개인 채팅 격리 + 좁은 화면 목록↔대화 이동 | e2e(Playwright 실 UI) | `packages/shell/e2e/discord-channel-agent.spec.ts` | Pass (3/3, 2026-07-21) |
| TEST-S-015 | UC-016 | 허용목록 ingress, Gateway 송수신·재연결, 두 채널 동시성, durable dedupe, 수명주기 epoch/revoke를 결정론적 fake Gateway와 쌍방 wire로 검증. 실제 bot 2채널 송수신·재연결·403·rotate/revoke는 운영자 인수 대기 | seam통합 + live | `naia-agent:src/test/discord-runtime.integration.test.ts`, `discord-live.integration.test.ts`; `src/test/uc-wire-v1-paired-proto.contract.test.ts` | Partial |

## 비고
- Pass = 이 세션 직접 실행 확정(2026-06-15). Partial = 인접 변종으로 부분 검증, 전용 TEST-S 미작성. Planned = 시나리오 정의·코드 부재(or old-path).
- **24 e2e 실패(2026-06-15)는 전부 본 graft scope 밖**: onboarding-fresh 3=pre-existing stale 테스트(wizard 첫스텝=welcome인데 바로 agentName 기대), 취소 1=flake(격리 pass), memory-settings 12=off-scope(naia-memory), voice/pty/send/cli 8=old-path/external. 상세 = `99.dev-comm/uc-migration-campaign-2026-06-13.md` 2026-06-15 체크포인트.
- 유닛/계약 테스트(src/test)는 05(TEST-F). `@spec SPEC-###` 태그로 코드 추적.
- TEST-S-014는 최종 Shell 스냅샷에서 격리 포트로 Playwright 3건을 재실행했다. 실제 Discord bot/OS 키체인 확인은 자격증명이 필요한 운영자 인수 항목이며, 자동화 Pass로 오표기하지 않는다.
