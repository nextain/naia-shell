# 05. 기능 테스트 Registry (TEST-F) — V모델 05

<!--
스키마: 이 한 파일 registry. SPEC(04)을 검증하는 통합/계약/유닛 테스트.
추적: 모든 SPEC는 ≥1 TEST-F로 닫힌다. TEST-F는 ≥1 SPEC을 가리킨다(역추적, orphan 0).
컬럼 = | ID | 검증 SPEC | 테스트 요약 | test_ref | 상태 |
실제 테스트 코드 = src/test(vitest). 이 registry = 의도·추적. 코드 유닛테스트는 @spec SPEC-### 태그로 결속.
-->

> **이식 backfill (2026-06-15)**: `src/test/*.{contract,test}.ts`(core 계약·단위·통합 테스트)를 SPEC 별로 정리.
> 상태 = repo-root `npx vitest run src/test` 실행 기준(191 cases pass, 2026-06-15 확인).

## 기능 테스트

| ID | 검증 SPEC | 테스트 요약 | test_ref | 상태 |
|---|---|---|---|---|
| TEST-F-001 | SPEC-001 | F0 control-plane 계약(decideBoot 분류·persist secret strip) + graft smoke | `src/test/f0-control-plane.contract.test.ts`, `f0-graft-smoke.test.ts` | Pass |
| TEST-F-002 | SPEC-002 | F1 자기상태/진단 계약 + live-adapter(old 명령 parity) | `src/test/f1-self-status-approval.contract.test.ts`, `f1-live-adapter.test.ts` | Pass |
| TEST-F-003 | SPEC-003 | 승인 게이트 계약(부재·거부·만료·중복·승인후변경, 소유주 대조) | `src/test/f1-self-status-approval.contract.test.ts` | Pass |
| TEST-F-004 | SPEC-004 | F2 관측 계약(PermissionDenied contain·drift) + live-adapter(old 명령 parity) | `src/test/f2-observe.contract.test.ts`, `f2-live-adapter.test.ts` | Pass |
| TEST-F-005 | SPEC-005 | F3 조작 계약(arg-casing·exec 보안) + live-adapter + reafference 통합 | `src/test/f3-mutate.contract.test.ts`, `f3-live-adapter.test.ts`, `integration-reafference.test.ts` | Pass |
| TEST-F-006 | SPEC-006 | UC1 chat/bridge/shell-compat/chunk-fields/child-stdio/trace 계약·통합 | `src/test/uc1-chat.contract.test.ts`, `uc1-bridge.contract.test.ts`, `uc1-shell-compat.contract.test.ts`, `uc1-chunk-fields.test.ts`, `uc1-child-stdio.contract.test.ts`, `uc1-trace.integration.test.ts` | Pass |
| TEST-F-007 | SPEC-007 | UC12 OnboardingController 계약(stale키 strip·completeWith·complete 가드) | `src/test/uc12-onboarding-controller.contract.test.ts`, `uc12-onboarding.contract.test.ts` | Pass |
| TEST-F-008 | SPEC-008 | V2 voice 도메인(startup-lazy) + live-adapter(parity) | `src/test/v2-voice-domain.test.ts`, `v2-live-adapter.test.ts` | Pass |
| TEST-F-009 | SPEC-009 | 연결/채널 UI 상태·격리, CSP/IPC, native 자격증명·manifest generation/CAS·authority/revoke/child reap, Agent 쌍방 wire 계약 | `packages/shell/src/components/__tests__/ConnectionsSettingsTab.test.tsx`, `ChannelsTab.test.tsx`; `packages/shell/src/lib/__tests__/discord-api.test.ts`, `csp-no-discord.test.ts`; `packages/shell/src-tauri/src/lib.rs`; `src/test/uc-wire-v1-paired-proto.contract.test.ts` | Pass |
| TEST-F-010 | SPEC-010 | Gateway·entry wiring·ingress policy·trusted state·messages·inbox·durable dedupe·runtime lifecycle 계약/통합 | `naia-agent:src/test/discord-gateway.contract.test.ts`, `discord-entry-wiring.contract.test.ts`, `discord-ingress-policy.contract.test.ts`, `discord-trusted-state.contract.test.ts`, `discord-messages.contract.test.ts`, `discord-inbox-store.contract.test.ts`, `discord-dedupe.contract.test.ts`, `discord-runtime.integration.test.ts` | Pass |

## 비고
- Pass = `npx vitest run src/test` 191 cases pass(2026-06-15). `.mjs` 가드 파일 17개는 vitest `process.exit` 아티팩트로 파일레벨 RED 처럼 보이나 케이스 전부 통과(`feedback_test_exit_code_not_pass_count`).
- 셸 소비자 테스트(packages/shell/src/**/__tests__)는 셸 스위트(`pnpm test` 827 pass)에서 별도 — graft seam 통합(onboarding-core.test.ts)은 03(TEST-S-012)에 등재.
- Discord 기능은 최종 고정 스냅샷에서 Shell UI 1304 pass/13 skip, Rust 136/136, Agent 1225 pass/9 skip, paired wire 9/9로 재검증했다(2026-07-21).
- 유닛테스트 깊이: 마크다운은 TEST-F(통합/계약 의도)까지. 그 아래 개별 유닛은 코드(`src/test`), `@spec SPEC-###` 태그로 추적(후속: 태그 backfill).
