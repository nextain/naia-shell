# 04. 기능 설계 Registry (SPEC) — V모델 04

<!--
스키마: 이 한 파일 registry. UC(02)를 구현 가능한 기능 단위(SPEC)로 분해.
추적: 모든 SPEC는 ≥1 UC를 가리키고(역추적), ≥1 TEST-F(05)로 닫힌다 (orphan 0).
컬럼 = | ID | 유도 UC | 기능 요약 | area | 상태 | TEST-F |
area = core(헥사고날 코어 @nextain/naia-os-core) / shell(packages/shell) / agent(new-naia-agent).
마크다운은 SPEC(기능 의도)까지 — 그 아래 unit/함수 = 코드(src/main/ports·app·adapters), 유닛테스트 = src/test(@spec 태그).
-->

> **이식 backfill (2026-06-15)**: 헥사고날 포트/컨트롤(`src/main/ports/*`, `src/main/app/control/*`, `adapters/`)을 SPEC 으로 정리.
> 상태 = 이식+2-AI 리뷰+컴파일 완료 여부 + **셸 graft 연결** 여부(graft=실행 셸이 new-core 경유).

## 기능 설계

| ID | 유도 UC | 기능 요약 | area | 상태 | TEST-F |
|---|---|---|---|---|---|
| SPEC-001 | UC-012 | **F0 부팅 control-plane** — decideBoot(부팅 분류) + config persist(secret strip/forAgent/키체인) + AdkPath. ports/index·app/control/boot | core | Done | TEST-F-001 |
| SPEC-002 | UC-011 | **F1 InteroceptivePort** — 자기상태·diagnostics(gRPC Diagnostics RPC end-to-end)·device·degradation. ports/f1·app/control/status | core | Done | TEST-F-002 |
| SPEC-003 | UC-013 | **F1 ApprovalPort** — 승인 게이트(classify/needsApproval/isBlocked) + 승인-세션 결속(correlation/context-digest). ports/f1·app/control/approval | core | Done | TEST-F-003 |
| SPEC-004 | UC-007 | **F2 EnvironmentPort 관측** — ObservationService(readFile/listDir) + DriftDetector(observed vs expected). ports/f2·app/control/observe | core | Done(이식, graft 보류) | TEST-F-004 |
| SPEC-005 | UC-007 | **F3 MutationGate 조작** — 승인→mutate→observe→reafference + execCommand fail-closed(신규 보안계약). ports/f3·app/control/mutate | core | Done(이식, graft 보류) | TEST-F-005 |
| SPEC-006 | UC-001 | **UC1 ChatService gRPC** — startTurn/cancel/deliverChunk + chat-bridge + shell-compat(makeShellChatService) + 도구/승인 페이로드 포워딩. ports/uc1·app/chat·adapters | core | Done(graft+e2e) | TEST-F-006 |
| SPEC-007 | UC-012 | **UC12 OnboardingController** — submit/assets/startNaiaAuth/onNaiaAuthCallback/complete/completeWith(§D 신규계약)/update. app/control/onboarding | core | In-progress(completeWith graft 완료, 나이아계정 OAuth 흐름 graft 미연결) | TEST-F-007 |
| SPEC-008 | UC-002 | **V2 음성** — SensoryPort/ExpressionPort/VoiceProviderPort + os-local 어댑터(AudioPlayer/MicCapture/STT/avatar). ports/v2·domain/voice | core | Done(os-local 이식, external WS=루크머신) | TEST-F-008 |
| SPEC-009 | UC-014, UC-015 | **Shell Discord 연결·Inbox** — native secret capture/키체인, discovery·allow-list CAS, agent token pipe, nonce 인증 graceful shutdown→bounded exit wait→force fallback, revoke/reap·lease 소유권, 다중 채널 저장소·반응형 Channels UI | shell | Done | TEST-F-009 |
| SPEC-010 | UC-016 | **Agent Discord Gateway runtime** — 허용목록 ingress, outbound reply, reconnect/rate-limit/cancel, durable dedupe, lifecycle epoch·generation 권한 | agent | Done | TEST-F-010 |
| SPEC-011 | UC-017 | **선제 발화 전달** — persisted profile 설정, session activity stream, 기존 agent_response/TTS/BGM 표현, yield/control/stop, generation 기반 stale 폐기 | shell+Rust | Partial(native acceptance 후속) | TEST-F-011 |

## 비고
- **graft 미연결(dormant)** = SPEC 은 이식+리뷰+컴파일 완료지만 실행 셸(packages/shell)이 아직 new-core 경유 안 함(old 경로 구동). graft 완료 = SPEC-006(chat)·SPEC-003(승인, chat흐름 내)·SPEC-007 일부(completeWith).
- 스킬/브라우저/유투브(UC-005/006/008)의 agent-side 기능 = `new-naia-agent`(별 repo, 자체 04.features). os-side 는 gRPC 도구호출(SPEC-006)로 경유.
- UC-007(F2/F3) graft = old 소비자 부재로 방향 미해결(passthrough vs 신규 에이전트-capability) → 보류. 상세 = `99.dev-comm/uc-migration-campaign-2026-06-13.md`.
