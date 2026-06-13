# UC 이식 — 사용자 테스트 문서 (루크 검토용, 2026-06-14)

> GOAL(루크 2026-06-13) 최종 산출물. "모든 UC 가 표준 프로세스로 이식되면 UC별 사용자 테스트 문서를 만들어 그걸 기반으로 전부 검토." = **이 문서**.
>
> **이 문서가 검증하는 것**: 각 UC 의 (1) 표준 프로세스 준수(Old-Baseline→계약먼저→이식→drift-gate→2-AI open-loop 리뷰→커밋) (2) 자율-검증분(이식+리뷰+컴파일/단위테스트) **완료 상태** (3) **루크가 실 구동으로 확인할 절차**(runtime/graft/external = 머신 게이트). compile-green ≠ 작동([[feedback_handoff_verified_runnable_state]]) 이므로 runtime 은 정직하게 루크 게이트로 표기.

---

## 0. 공통 — 실행 환경 / 사전 준비

### 0.1 앱 실행
```bash
cd projects/new-naia/new-naia-os/packages/shell
pnpm install            # 최초 1회
pnpm run tauri:dev      # 데스크톱 앱 기동(Tauri + Vite)
```
⚠️ **wayland 주의**(이미 픽스됨, 참고): `tauri-with-mode.mjs` 가 `DISPLAY` 있을 때만 x11 강제, 없으면 wayland + DMABUF off (순수 Wayland/KDE 대응). 기동 안 되면 `echo $WAYLAND_DISPLAY` 확인. (근거: [[feedback_handoff_verified_runnable_state]])

### 0.2 자동 테스트(루크가 직접 돌릴 수 있는 검증)
```bash
# 순수 로직 단위 (vitest) — os
cd packages/shell && pnpm test                 # 826 passed, exit 0 (2026-06-14 확인)
# 순수 로직 단위 (vitest) — agent
cd ../../../new-naia-agent && pnpm test         # 269 passed, exit 0 (2026-06-14 확인)
# 실 UI 자동구동 (Tauri IPC mock)
cd packages/shell && pnpm test:e2e
# 실 Tauri 바이너리 (실 Rust 백엔드, 디스플레이 필요)
cd packages/shell && xvfb-run pnpm test:e2e:tauri   # 이 머신에선 cage/wdio SIGUSR1 불안정 → 루크 머신 권장
# Rust 컴파일 검증
cd packages/shell/src-tauri && cargo check      # Finished, exit 0 (2026-06-14 확인)
```
> **green = exit code 0** 으로 판정(pass 카운트 아님, [[feedback_test_exit_code_not_pass_count]]).

### 0.3 표준 프로세스 / 직교 / 검출기 (이 문서 전반의 전제)
- **gRPC transport**: os(Rust tonic client) → agent(@grpc/grpc-js server) → naia-adk/naia-settings 저장. proto SoT = `new-naia-agent/src/main/adapters/grpc/naia_agent.proto`.
- **직교**: UC(세로) × port(가로). new-core(`@nextain/naia-os-core`) 도메인은 @tauri-apps 미의존(substrate-agnostic, 안드로이드 대비) — 어댑터가 Tauri invoke/listen 주입.
- **검출기(드리프트 자동차단)**: `check-file-anchors`(미계약 파일 RED) + `check-canon-conformance`(canon out_of_scope UC RED) + `enforce-root-structure` + pre-commit compile-integrity. canon SoT = `.agents/context/canon-scope.json`(GOAL+Old-Baseline 도출).
- **리뷰 산출물**: `.agents/reviews/r-<uc>-2026-06-13.json` (open-loop 2-AI, ground truth=정본+Old-Baseline).

### 0.4 ★ 전 UC 공통 graft 상태 (정직 고지)
실 구동 셸(`packages/shell/src`)은 현재 **chat(UC1) 만** new-core gRPC 경로로 관통한다. 나머지 UC 의 new-core 이식분(F0~F3/V2/UC12/UC13 도메인·포트·어댑터)은 **작성+단위검증됐으나 셸이 아직 호출 안 함**(dormant). 각 UC 의 "graft" 절차 = 셸이 해당 `wire*Live` 를 호출하도록 연결 + 실 구동 확인. graft 는 *작동 중인 old 경로를 new 경로로 교체*라 **runtime 검증 필수 = 루크 머신 게이트**(compile-only 로 done 주장 금지).

---

## 1. Foundation tranche (F0~F3)

### F0 — 부팅 / workspace init (UC12-min)
- **무엇**: naia-adk workspace 경로 주입 → 디렉터리 상태 판정(missing/empty/has_settings/has_other_files) → 부팅 액션 결정(recreate=항상 delete-then-clone, new+nonempty=사용자 결정 필요).
- **이식 슬롯**: `domain/boot.ts`(AdkDirState/adkPrepAction/AdkDirNeedsDecisionError) · `adapters/tauri/live.ts`(inspectAdkDir/setRoot/detectRoot/setAdkPath).
- **2-AI 리뷰**: R1 BLOCKER(setup-broken + PII 로깅) → R2 CLEAN. 산출물 `r-f0-2026-06-13.json`.
- **루크 테스트 절차**:
  1. 앱 기동 → 온보딩에서 빈 디렉터리를 workspace 로 지정 → `naia-settings` 생성되는지(파일시스템).
  2. 이미 `naia-settings` 있는 경로 재지정 → 기존 설정 로딩(덮어쓰기 안 함).
  3. **비어있지 않은(다른 파일 있는) 경로** 지정 → "사용자 결정 필요" 분기 노출(자동 삭제 안 함 = 데이터 보호).
- **기대(Old-Baseline parity)**: old-naia-os 의 workspace init 와 동일 분기. PII(경로) 로그 미노출.
- **graft/게이트**: 위 §0.4. 온보딩 셸이 `inspectAdkDir`/`setAdkPath` live 어댑터 호출하도록 graft 후 실 구동.

### F1 — 자기상태(InteroceptivePort) + 승인(ApprovalPort)
- **무엇**: 시스템/진단 상태 관측 + 승인 분류(tier)/영속 grant. **+ 신규계약 Diagnostics RPC**(agent version/uptime/component health → os rich payload).
- **이식 슬롯**: InteroceptivePort(systemStatus/diagnostics/devices/degradations) · PersistentGrantPort(allowedTools) · ApprovalPort.classify(agent tool-tier 매핑) · **agent `adapters/diagnostics-provider.ts` + proto `Diagnostics` RPC + os `agent_grpc.rs::diagnostics()`**.
- **2-AI 리뷰**: R1 fix + Diagnostics provider 계약(`diagnostics-rpc-contract-2026-06-13.md`, 신규계약 GOAL⑥). `r-f1-2026-06-13.json`.
- **✅ 완료(자율-검증)**: Diagnostics RPC **end-to-end 컴파일 검증** — agent handler+provider(tsc+5 단위테스트) → proto `DiagnosticsResult{version,uptime_ms,healthy,components}` → os Rust client `cargo check` green(2026-06-14).
- **루크 테스트 절차**:
  1. **DiagnosticsTab** 열기 → 진단/상태 표시(systemStatus/gateway_status).
  2. "너 지금 상태 어때?" 류 질의 → 자기상태 보고(UC11 표현 경로).
  3. 오디오 출력 장치 목록(PipeWire, Linux) 노출 확인.
- **기대**: old DiagnosticsTab 동일. component unhealthy 있으면 healthy=false 정직 보고(거짓 healthy 금지).
- **graft/게이트**: os `InteroceptivePort.diagnostics` 가 `agent_grpc.diagnostics()` rich payload 를 매핑하도록 배선 + 실 호출 = 루크.

### F2 — workspace 관측 (read-only, UC7a)
- **무엇**: 파일/디렉터리/프로세스 *상태 조회*(변경 X) + 드리프트 감지(watch). 오류를 **PermissionDenied vs ObservationFailure** 로 분류(혼동 금지).
- **이식 슬롯**: `ports/f2.ts`(ReadResult=T|PermissionDenied|ObservationFailure, isDenied/isFailure/isOk) · `adapters/tauri/f2.ts`(makeF2EnvObserve/makeF2ExpectedState/makePtyReader, classifyError) · `app/control/observe.ts`(DriftDetector).
- **2-AI 리뷰**: R1 ISSUES(BLOCKER2 error-conflation + MAJOR4) → 신규계약(§C delta) 수정 → R3 CLEAN(3R 수렴). `r-f2-2026-06-13.json`.
- **루크 테스트 절차**:
  1. workspace 내 파일/디렉터리 목록·내용·크기 조회 → old 와 동일 결과.
  2. **권한 없는 경로** 조회 → "권한 거부"로 분류(관측 실패와 구분).
  3. 파일 변경 → 드리프트 감지 이벤트(`workspace:file-changed`) 수신.
  4. pty 에이전트 상태 조회(추적 pid).
- **기대**: old 명령 1:1 parity(`workspace_list_dirs`/`workspace_read_file`/`workspace_file_size`/`workspace_get_sessions`/`workspace_get_pty_agents`). 권한오류≠관측오류.
- **graft/게이트**: 셸이 `wireObservationServiceLive`/`wireDriftDetectorLive` 호출 + watch/pty 런타임 확인 = 루크.

### F3 — workspace 조작 (mutating, UC7) + 승인
- **무엇**: 파일 편집·명령 실행 + **결과 관측(reafference)**. 고위험(T2). MutationGate = 승인먼저 → mutate → observe(F2) → reafference → 불확정 시 abort.
- **이식 슬롯**: `domain/mutate.ts`(actionScopeOf/isUnsafePath) · `app/control/mutate.ts`(MutationGate scope-binding 검사 + null-byte/`..` 차단) · writeFile/ptyWrite live, **execCommand = fail-closed + 신규 보안계약**.
- **2-AI 리뷰**: R1 BLOCKER2(arg-casing + arbitrary-exec 보안) → 수정. `r-f3-2026-06-13.json`.
- **루크 테스트 절차**:
  1. 파일 쓰기/편집 → 변경 후 F2 로 결과 재관측(reafference) 일치.
  2. **승인 scope 와 다른 행위** 시도 → "scope-mismatch" 차단(승인A→행위B 방지).
  3. `..`/null-byte 포함 경로 → 차단(경로 탈출 방지).
  4. 임의 명령 실행 → fail-closed(신규 보안계약 범위 밖은 거부).
- **기대**: 안전 불가분 = fail-closed. exec 는 화이트리스트/신규계약 범위만.
- **graft/게이트**: 실 write/pty/exec 왕복 + 승인 흐름(UC13) = 루크.

---

## 2. Vertical — 대화

### V1 = UC1 — 텍스트 대화 ✅ (실 셸 관통)
- **무엇**: ChatPanel 입력 → agent provider 호출 → wire 스트림 응답. **유일하게 실 셸이 gRPC 로 관통**.
- **이식 슬롯**: os `domain/chat.ts`(ChatChunk.toolResult +toolName+success; approvalRequest +args+description) · `adapters/message-router.ts`+`shell-compat.ts` · agent `app/chat-turn-handler.ts` · proto AgentEvent 11종 · os `agent_grpc.rs::agent_event_to_ui_json`.
- **2-AI 리뷰**: HIGH2(도구결과 success/toolName 유실 + 승인 args/description 유실=blind approval) → cross-repo 수정. `r-uc1-2026-06-13.json`.
- **✅ 완료(end-to-end)**: agent(emit) → proto(ToolResultEvent.success/ApprovalRequestEvent.description) → **os Rust forward(2026-06-14 드롭버그 fix)** → `chat-service.ts:443-467`(소비) → `PermissionModal.tsx:34`(description 표시). cargo green.
- **루크 테스트 절차**:
  1. ChatPanel 에 텍스트 입력 → 스트리밍 응답(▌ 멈춤 없음).
  2. 도구 사용 응답 → **도구 결과 성공/실패가 정확히 표시**(픽스 전: 항상 실패로 표시됐음).
  3. Tier>0 도구 → **승인 모달에 도구 인자/설명 표시**(픽스 전: 빈 설명 = blind approval).
- **기대**: old 대화 parity + 도구결과/승인 페이로드 무손실.
- **게이트**: chat 은 graft됨 → 루크는 실 대화로 바로 확인 가능.

### V2 = UC2 — 음성 대화 (os-local 완료, provider WS = 외부)
- **무엇**: wake → 말하기 → 음성응답 + 아바타. VoiceConnectionStatus 상태기계(cold-start 인지).
- **이식 슬롯**: `domain/voice.ts`(VoiceConnectionStatus 순수) · `ports/v2.ts`(SensoryPort/ExpressionPort/VoiceProviderPort) · `adapters/tauri/v2.ts`(makeV2Expression: play/synthesize/express; makeV2Sensory: startMicCapture[getUserMedia **lazy**]/transcribe).
- **2-AI 리뷰**: BLOCKER0(startup-block 불변 = type-only import + lazy device, 검증). `V2-baseline-contract-2026-06-13.md`.
- **⚠️ 중요(아키텍처)**: voice realtime = **os → provider WS 직결**(gemini-live/openai-realtime/naia-omni/vllm-omni), os→agent gRPC 경유 **아님**. → "gRPC Voice RPC" 는 만들지 않음(만들면 Old-Baseline 위반 드리프트).
- **루크 테스트 절차**(외부 키/서버 필요 = 루크 머신):
  1. 음성 provider(gemini-live 등) 키 설정 → WS 연결 → cold-start 상태 전이 표시.
  2. 마이크 발화 → STT → 응답 → TTS 음성 + 아바타 emote.
  3. ⚠️ **기동 시 마이크 미접촉 확인**(getUserMedia lazy — 과거 90초 stall 버그 회피, 근거 [[feedback_isolation_toggle_not_component_guessing]]).
- **기대**: old 음성 parity. 미설정 시 정직한 "Unsupported"(거짓 성공 금지).
- **게이트**: provider WS + STT 모델 + cloud TTS = 외부 키/서버 = 루크 머신. ExpressionPort.stop()/sttModels()/outputDevices() = 다음 슬라이스(정직 deferred).

---

## 3. Agent UCs (도구 / 스킬 — new-naia-agent)

### UC5 — 도구 실행 루프 ✅
- **무엇**: toolUse → 실행 → 결과 스레딩 → 최종 응답. enableTools/disabledSkills 소비 + per-tool timeout(60s) + composite 충돌 시 보수적 tier.
- **이식 슬롯**: agent `app/chat-turn-handler.ts` · `adapters/composite-tool-executor.ts` · 각 ToolExecutor.
- **2-AI 리뷰**: R1 BLOCKER0, MEDIUM 수정. `r-uc5-2026-06-13.json`.
- **루크 테스트 절차**: 날씨/시간/웹검색/github 류 도구 요청 → 도구 실행 → 결과 반영 응답. 비활성 스킬 제외 확인. 무한 도구 행 방지(timeout).
- **게이트**: 실 외부 도구 호출 = 루크 머신.

### UC6 — 환경 조작(브라우저) (agent-local 완료, CLI/CDP = 외부)
- **이식 슬롯**: agent `adapters/agent-browser-skills.ts`(cmd 화이트리스트 + injected CLI, github-skills 패턴, tier="ask", no-throw, mock-tested).
- **2-AI**: self-review BLOCKER0.
- **루크 테스트 절차**: "이거 찾아서 눌러줘" → browser navigate/click + 관측. ⚠️ 실 browser CLI/CDP 연결 = 신규계약 + 루크 머신.
- **게이트**: external CLI/CDP = 루크.

### UC8 — 공간 분위기(BGM) (agent-local 완료, youtubei.js = 외부)
- **이식 슬롯**: agent `adapters/youtube-bgm-skills.ts`(search/play/volume + injected).
- **2-AI**: self-review BLOCKER0. `UC8-bgm-contract-2026-06-13.md`.
- **루크 테스트 절차**: "음악 틀어줘" → BGM 검색/재생/볼륨. ⚠️ youtubei.js + 셸 player = 신규계약 + 루크 머신.
- **게이트**: external youtube WS + 셸 오디오 player = 루크.

### UC-provider-provenance ✅
- **무엇**: provider 라우팅 출처(naia-settings / wire / 키체인 overlay). naia 계정(any-llm 게이트웨이) / API-key(외부 SDK 직결, 게이트웨이 안 탐) / 로컬 판단 = **agent 기존 CLI provider 관리**.
- **이식 슬롯**: agent `domain/provider-route.ts`(nativeBaseUrl default throw — anthropic/unknown 에 silent openai 금지) · grpc-codec.
- **2-AI**: `r-provider-provenance-2026-06-13.json`. `UC-provider-provenance-contract-2026-06-12.md`.
- **루크 테스트 절차**: provider 별(anthropic/openai/gemini/ollama/glm 등) 설정 → 각 정확한 base/transport 로 라우팅(키체인 런타임 우선). naia-settings 갱신 후 ReloadSettings 멱등.
- **기대(근거)**: [[project_new_naia_os_agent_adk_architecture]] — naiaKey 기준 라우팅·키체인 정본 **아님**. agent CLI provider 관리가 판단.
- **게이트**: 실 provider 호출 = 루크.

---

## 4. Control UCs

### UC12 — 온보딩 / 설정
- **이식 슬롯**: os `app/control/onboarding.ts`(complete() 가드: provider/naia 필수; update() providerChanged 시 old envKey 클리어) · `adapters/tauri/config-map.ts`(누락 6 UI_ONLY 키 추가).
- **2-AI 리뷰**: R1 BLOCKER(stale credential — provider 교체 시 옛 키 잔존) → 수정. `r-uc12-2026-06-13.json`.
- **루크 테스트 절차**:
  1. 온보딩 wizard → provider/모델 + naia 계정/api key 설정 → 저장(naia-settings).
  2. **provider 교체** → 옛 provider 의 envKey 가 클리어되는지(stale 키 누출 방지).
  3. 필수 미입력 시 complete 차단.
- **게이트**: ⚠️ 실 셸 온보딩이 아직 new-core 미graft(live=old) → graft 후 실 구동 = 루크.

### UC13 — 승인 게이트
- **이식 슬롯**: os `app/control/approval.ts`(sameScope) + MutationGate scope-binding(F3). 위험 행위 전 사용자 승인.
- **2-AI 리뷰**: R1 BLOCKER(승인A→행위B = scope 불일치 실행) → 수정. `r-uc13-2026-06-13.json`.
- **루크 테스트 절차**:
  1. 위험 도구 → 승인 모달(인자/설명 표시 = UC1 페이로드 fix 와 연동).
  2. 승인한 행위와 **다른 scope** 실행 시도 → 차단.
  3. 거부 → 행위 미실행.
- **게이트**: 라이브 승인 흐름 = gRPC chat-approval(agent approval_request emit → 셸 응답) + 루크 머신.

### UC11 — 자기상태 인지 → §F1 참조(InteroceptivePort + Diagnostics RPC).

---

## 5. Off-scope (이 캠페인 범위 밖 — 정직 고지)

- **UC3 기억하는 대화 / UC4 능동 회상 / UC-memory**: 장기기억(naia-memory) 연결 = **다른 세션 소유**. canon `out_of_scope_uc`. 여기서 만들면 드리프트(근거 [[feedback_closed_loop_review_canon_conformance]]). 검출기가 6파일 RED 로 정직하게 계속 표기(gRPC=memory-side 선행).
- **S-row 잔여**(sessions/skill-manager/config/device/channels/naia-discord/voicewake/welcome): openclaw gateway(#201) 제거로 **DEPRECATED**(이식=죽은코드 드리프트). panel=os-side. `skill-placement-decision-2026-06-13.md` 참조.

---

## 6. 루크 검토 체크리스트 (요약)

| UC | 자율-검증(이식+리뷰+컴파일/단위) | 루크 runtime 게이트 |
|----|:--:|---|
| F0 부팅 | ✅ R1→R2 CLEAN | 온보딩 graft + 디렉터리 분기 실구동 |
| F1 자기상태+Diagnostics RPC | ✅ end-to-end cargo green | DiagnosticsTab + rich payload 매핑 |
| F2 관측 | ✅ 3R CLEAN | wire*Live graft + watch/pty 런타임 |
| F3 조작+승인 | ✅ R1 BLOCKER2 수정 | write/pty/exec 왕복 + 승인 |
| V1/UC1 텍스트 | ✅ **end-to-end(셸 graft됨)** | **실 대화로 바로 확인 가능** |
| V2/UC2 음성 | ✅ os-local BLOCKER0 | provider WS 키/서버(외부) |
| UC5 도구루프 | ✅ R1 BLOCKER0 | 실 외부 도구 |
| UC6 브라우저 | ✅ self-review | external CLI/CDP |
| UC8 BGM | ✅ self-review | external youtube + player |
| provider-provenance | ✅ 2-AI | 실 provider 호출 |
| UC12 온보딩 | ✅ R1 BLOCKER 수정 | graft + 실 온보딩 |
| UC13 승인 | ✅ R1 BLOCKER 수정 | gRPC chat-approval 흐름 |
| UC3/UC4 기억 | — off-scope(다른 세션) | — |

**검토 방법 제안**: ① `pnpm test`(os/agent) + `cargo check` 로 자율-검증분 exit0 재확인 → ② `pnpm run tauri:dev` 로 UC1 실 대화(graft됨) 먼저 확인 → ③ 나머지 UC 는 graft 우선순위 정해 하나씩 셸 배선 후 실 구동(각 §의 루크 절차). graft 는 작동 경로 교체라 UC 하나씩 검증하며 진행 권장(blind 일괄 graft 금지).
