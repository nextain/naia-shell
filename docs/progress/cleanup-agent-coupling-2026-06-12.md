# 군더더기 정리 — naia-agent 담당 코드 제거+배선 (배선 전 정리) — 2026-06-12

> session_id: 67a0313b-2578-4da2-9a52-53c26128656f
> Luke 지시: naia-os는 verbatim 복사라 naia-agent 없이 자체동작하던 군더더기가 있다. 배선하면 그 옛 경로가 응답해 "동작한다"고 착각(false-success) → **naia-agent 담당 부분을 먼저 제거+배선한 뒤** provider 흐름 진행. "빠르게 하면 100% 실수, 변칙으로 들어간게 그게 다인줄 알지 말 것." 목표 = 단일 transport(gRPC-shaped) 경계, 인지는 agent.

## 검증된 사실 (감사 + 호출처 grep)
- **gateway.json = 셸이 쓰기만, 읽는 곳 0** (new-naia-agent에 참조 전무). #201에서 gateway(openclaw) 프로세스 제거됨 → `sync_gateway_config`/`gateway-sync`는 **아무도 안 읽는 파일에 쓰는 순수 군더더기**. 홈디렉터리 .openclaw 아래 SOUL.md 리터럴-틸드 아티팩트의 범인.
- ⚠️ **내 UC12 어댑터(src/main/adapters/tauri/uc12.ts)가 죽은 sync_gateway_config 호출** = 죽은 gateway 위 배선(false-success 실례, Luke 경고 적중).
- **이중 transport**: 새-core 경유 = sendChatMessage/cancelChat/sendApprovalResponse 3개뿐. 나머지 ~13종(creds/auth/notify/tts/directToolCall/skills/panel*/embedding/memory export·import)은 옛 safeSendToAgent(send_to_agent_command) 경로.
- **새 agent는 discord 미담당** → channel-sync(discord 채널 linking)의 gateway 경로 = 죽음. discord = 미이식 미래 UC(deferred).
- **임베디드 agent fallback**(Rust spawn_agent_core): 상대경로 ../agent/src/index.ts 등 — new-naia-agent 단일화 시 군더더기.

## 정리 계약 (per-item 결정 — 검증 후에만 제거)
### 슬라이스 1 — 죽은 gateway/openclaw 서브시스템 제거 (최우선, 검증 완료)
아무도 안 읽는 gateway.json 경로 전체 제거. 호출처 동반 정리:
- TS 삭제: src/lib/gateway-sync.ts
- TS 호출처 제거: OnboardingWizard.tsx(syncToGateway), SettingsTab.tsx(syncToGateway + reset_gateway_data), DiagnosticsTab.tsx(restart_gateway 버튼), **src/main/adapters/tauri/uc12.ts(sync_gateway_config — 내 군더더기)**
- channel-sync.ts: gateway 호출 제거 → discord 채널 linking은 deferred(새 agent discord skill 이식 시 복원). discord BFF/token 부분 보존 검토.
- Rust 삭제: sync_gateway_config, restart_gateway, reset_gateway_data, ensure_gateway_config, call_gateway_tool(0참조), gateway.json/openclaw.json 경로 로직. invoke_handler 등록 해제.
- 테스트 mock 정리: gateway-sync.test, channel-sync.test, SettingsTab.test의 gateway mock.
- ⚠️ UC12 계약 영향: GatewaySyncPort(authUpdate/sync) 재평가 — gateway 죽었으면 이 포트 자체가 군더더기. config 영속은 ConfigPort(naia-settings)가 담당. provider 흐름과 직결.

### 슬라이스 2 — 단일 transport 통합 (제거+배선)
옛 safeSendToAgent 경로 메시지(~13종)를 새-core 단일 transport로 consolidate. send_to_agent_command 산재 IPC 정리. (creds/auth가 여기 포함 → provider 흐름 naiaKey 스레딩 해소.)

### 슬라이스 3 — 임베디드 agent fallback 제거 (Rust)
spawn_agent_core의 임베디드 상대경로 제거, new-naia-agent 단일화. (BGM server=embedded bgm-server-bin.ts는 별도 판단.)

### 판단 보류 (인지 로직, 별 슬라이스)
provider registry/pricing fetch, persona/system-prompt 조립, 셸 memory facts(Rust local SQLite) — 일부 정당한 셸 책임 vs agent 이관. 후속 UC.

### KEEP (정당한 셸 책임)
realtime voice(openai-realtime, gemini-live WebKitGTK 프록시, 로컬 vllm-omni), STT 캡처, 로컬 모델 discovery, UI cost 추정, secret store.

## 방법
각 항목 = 호출처 grep 검증 → 제거 or 배선 → tsc + 셸 테스트 + 파일앵커/빌드계약 검출기 GREEN → 커밋. 한 번에 blast 금지. 슬라이스 1부터.

cf [[project_new_naia_goal_and_method_anchor]]
