# 요구사항 (P03 — FR/NFR) — 2단계 산출물

> **현재 Windows 로컬 표현 기준 (2026-08-06):** 별도 GPU 프로파일은 없다. NVA는 GPU·로그인과 무관한 사전 생성 web-player다. 감지 VRAM 6GB 이상이면 Voice 설정에서만 `voxCPM 2 local voice`를 명시적으로 켜고 끌 수 있으며 로그인은 필요하지 않다. 자세한 활성 계약은 이 문서의 `2026-08-06 active Windows NVA/Voice/Media contract`와 [`windows-6gb-voice.md`](windows-6gb-voice.md)를 따른다. [`windows-8gb-nva.md`](windows-8gb-nva.md) 및 FR-CASCADE.1~22의 Ditto/TRT/Cascade 프로파일 조항은 비규범 이력이다.

`[Phase 05 (P03 요구사항)]`

> 추적: P01 `user-scenarios.md` + P02 Test Coverage Map → P03. **범위 = foundation tranche(F0~F3)** 우선(나머지 tranche 는 착수 시 확장). **상태: 초안 — 2회 클린 리뷰 대기.**
> 원칙: FR=foundation 시나리오에서 도출, NFR=1단계 구조 불변식 + fault-isolation. 각 요구사항 = P04 통합 테스트 대상.

## 기능 요구사항 (FR) — foundation tranche

| ID | 요구사항 | 출처 시나리오 | 검증(P02) |
|---|---|---|---|
| **FR-F0** | 외부 키 없이 naia-adk workspace **최소 부팅**(control-plane init) — **손상 분류**: integrity/security-critical(신원·정책·무결성 config) = **block/fail-closed**; optional/cosmetic = **contain + 정직 보고**(비차단) | UC12-min·S01·S02 | 부팅 trace + negative(손상 설정) |
| **FR-F1.1** | naia 가 **자기 상태 read-only 관측·정직 보고**(system-status·diagnostics·device·설정/연결 degradation) — 오보 금지 | UC11·S09·S10·S11·S44·S12a | InteroceptivePort 계약 + 정직성 |
| **FR-F1.2** | **ApprovalPort 최소계약 선잠금**(승인부재·거부·만료·중복·승인후 컨텍스트변경) — F3 전 확정 | UC13·S12 | ApprovalPort 계약 + 상태전이 trace |
| **FR-F1.3** | 자기상태/승인 실패가 **planning·route·skill 선택을 오염시키지 않음**(downstream contamination 차단) | (횡단) | 통합 contamination 테스트 |
| **FR-F1.4** | **승인-세션 최소 결속** — *필수*: `correlation id`(승인↔실행↔결과 동일) + 승인-실행 *동일 session·context*; *불변식*: 다른 session/context 의 승인으로 실행 불가. **+ 행위 스코프 결속**: 승인은 *구체 행위(target·op·body·env)* 에 묶임. **실행 *전* 불일치(pre-exec drift) = block/재승인**(side-effect 없음). (실행 개시 후 drift = FR-F3.3 abort+미확정.) body·env·target·op = 실행 게이트. **context identity canon** = 결정적 **digest**{session id + workspace root(**canonical: symlink/mount/대소문자 정규화 또는 안정 workspace id** — raw path drift 방지) + active surface/app(*headless/비-앱=null 허용, host-neutral*) + 승인시점 config 버전 + client id} (병렬 세션 구분; substrate별 값 부재 허용 = NFR-substrate-agnostic 정합) — 이 집합 불일치 = post-approval drift = 재승인 필요. (lease 전체=DEFER, 이 subset 만 지금) | UC13·UC10a(min) | binding 계약 |
| **FR-F2** | host-system **read-only 관측**(파일·프로세스 상태 조회, 변경 X) — 권한 밖 경로 거부·미지원 환경 정직 보고. **외부 간섭 drift 감지**(observed vs expected; **expected 권위 우선순위** = 선언적 목표상태 > 마지막 승인 의도 > 직전 관측 스냅샷(상위 존재 시 그것 적용 — 결정적)) | UC7a·S33/S34(read) | EnvironmentPort observe + negative + drift |
| **FR-F3.1** | **승인 → host-system mutating**(파일 편집·명령 실행) — 승인 경로 *먼저*, 그 위에 변경 | UC13→UC7·S07·S12 | ApprovalPort+EnvironmentPort mutate |
| **FR-F3.2** | mutating 결과 **reafference**(`commanded→acknowledged→observed→mismatch`) — 의도/실행/실제 분리 | UC7(reafference) | 통합 reafference 테스트 |
| **FR-F3.3** | negative(exit-block): 승인거부·권한부족→차단; **mutation 불확정 상태 전체 처리** — timeout·interrupt/cancel·partial(side-effect unknown)·**실행 개시 후** post-approval drift·acknowledged-but-not-observed → abort + 결과 미확정 정직 보고 + disposition(↓). (실행 전 drift = FR-F1.4 block/재승인) | UC7 negative | negative + uncertain-state |

## 기능 요구사항 (FR) — 대화 transcript 영속 (S05, V1-track 선행 — 2026-06-18)

> 범위: foundation tranche **밖**, 사용자 우선순위로 선행(text Phase1). 음성·멀티모달 = Phase2+(DEFER). NFR = 횡단 NFR(특히 isolation·substrate-agnostic·provenance·error-model) 적용.

| ID | 요구사항 | 출처 | 검증(P02) |
|---|---|---|---|
| **FR-CONV.1** | agent(전두엽)가 각 text 대화 turn(user+assistant, 가용 시 tool/thinking/cost)을 turn 종료 시 `{adkPath}/conversations/{sessionId}.jsonl` append(`ConversationLogPort`). 실패=격리(턴 안 깨짐; naia-memory.save 형제 위치) | S05a·UC1 | conversation-log 계약(append·격리·no-throw) |
| **FR-CONV.2** | sessionId(대화별)가 shell→proto→domain→handler 배선 → 세션별 파일 분리. 누락=단일 fallback 세션(크래시 금지) | S05a | sessionId 배선 계약 |
| **FR-CONV.3** | shell 이 Rust IPC 로 `{adkPath}/conversations` list/read/delete(**writer 없음**) — **agent 부재/죽음에도 동작(E1)**. adkPath 경계 밖 거부 | S05b·UC12 | conversation-store 계약 + e2e-tauri 경계 |
| **FR-CONV.4** | HistoryTab 소스 = 죽은 directToolCall → Rust IPC. 재시작 후 과거 대화 목록·복원 | S05b | 통합(대화→재시작→복원 golden) |
| **FR-CONV.5** | transcript 메시지 스키마 = **modality-확장 가능**(`{role,content,timestamp, modality?, audioRef?…}`) — Phase1 text만, 음향 필드 예약(naia-memory 잠재기억 forward-compat; 음성 경로 비밀봉) | S05c | 스키마 계약 |

## 기능 요구사항 (FR) — 워크스페이스 전환 설정 복원 (S72, 셸 feature — 2026-06-24)

| FR | 요구사항 | UC/시나리오 | 검증 |
|----|---------|-----------|------|
| **FR-WS.1** | 워크스페이스(ADK path) 전환(SettingsTab 폴더선택·Apply) 시 그 워크스페이스 config.json(persona·userName·agentName·honorific·speechStyle·locale)을 `readNaiaConfig` 로 읽어 localStorage `naia-config` 로 복원 후 reload — 초기 설정(AdkSetupScreen)과 동형(비대칭 해소) | S72a·UC12 | 복원 병합 계약(`applyWorkspaceConfigToLocal`) |
| **FR-WS.2** | UI 정체성 설정(vrmModel·backgroundImage·backgroundVideo·bgmTrack·customVrms·customBgs)을 워크스페이스별 `{adkPath}/naia-settings/ui-config.json` 에 저장(write)·복원(read). agent config.json 은 `stripForAgent` 유지 — UI키는 ui-config.json 으로만(env 오염 방지) | S72b | ui-config 분리 계약 |
| **FR-WS.3** | 전환 후 avatar store(VRM/배경)·테마·persona 가 복원값 재적용(reload 경유). 누락 키 = 번들 기본 폴백(크래시 금지) | S72a | 복원 폴백 계약 |

## 기능 요구사항 (FR) — localStorage SoT: adkPath 뿐, 설정 SoT = naia-settings/ (UC-CONFIG-SOT, 2026-07-15 루크 원칙)

**원칙**: localStorage 는 오직 `naia-adk-path`(부트스트랩 포인터)만 **권위**로 갖는다. 사용자 설정
(persona·이름·말투·locale·모델·VRM·배경)의 SoT 는 `naia-settings/config.json`·`ui-config.json`.
localStorage `naia-config` 는 파일에서 하이드레이트되는 **순수 렌더 캐시**(107곳 동기 `loadConfig()` 리더용, 권위 없음).

| ID | 요구사항 | UC | 검증 |
|----|----------|-----|------|
| **FR-CONFIG-SOT.1** | 부팅 시 `naia-config` 는 **파일에서 하이드레이트**된다 — 병합에서 `...local` base 제거 → `{ ...(fileConfig ?? {}), ...(uiConfig ?? {}) }`(파일 절대 우선, `applyWorkspaceConfigToLocal` 와 동형). 부트스트랩 키(`workspaceRoot`/adkPath·`onboardingComplete`)만 명시 보존. `if(!fileConfig && !uiConfig)` = 캐시 wipe 방지. 순수함수 `mergeBootConfig` 로 추출(테스트 가능) | S-CONFIG-SOT-1 | 부팅 병합 계약(스테일 persona 를 파일이 덮는가) |
| **FR-CONFIG-SOT.2** | `syncConfigToFile()`(localStorage→config.json 되쓰기)은 **하이드레이션 완료 후에만** 실행. 하이드레이션 전 스테일 localStorage 를 파일에 되쓰지 않는다(800ms 디바운스 레이스 차단). stale-URL 대비 sync 는 하이드레이트 후 재실행 | S-CONFIG-SOT-2 | 되쓰기 게이트 계약(하이드레이션 전 write 없음) |
| **FR-CONFIG-SOT.3** | 무회귀 — `stripForAgent`·키체인·107곳 동기 `loadConfig()` 리더 **무변경**. 캐시의 권위만 박탈 | S-CONFIG-SOT-3 | 기존 adk-store/config 테스트 무회귀 |
| **FR-CONFIG-SOT.4** | **UI 설정 SoT 완성** — `extractUiConfig`(ui-config.json write) 가 `UI_IDENTITY_KEYS`(9개) 대신 **`UI_ONLY_CONFIG_KEYS` 전체**를 뽑는다. "config.json 에서 strip 하는 UI 키 = ui-config.json 에 쓰는 키" 가 일치해야, 파일 SoT 없는 키(vllmTtsHost·theme·appPosition·bgmVolume·ttsProvider·liveProvider 등)가 부팅 시 리셋되지 않는다. read/병합은 이미 통짜(`{...file, ...ui}`)라 대칭 자동. ⚠️ FR-CONFIG-SOT.1 도입 시 드러난 회귀(로컬 보이스 호스트 `vllmTtsHost` 미저장)의 근본 수정 | S-CONFIG-SOT-4 | ui-config 왕복 계약(UI_ONLY 전체 write→read 라운드트립) |
| **FR-CONFIG-SOT.5** | **AdkSetup 화면 중 되쓰기 게이트 유지** — `showAdkSetup` 분기에서 `configHydratedRef=true` 로 선마킹하지 않는다(하이드레이션 없이 게이트가 열려 mount-time `syncConfigToFile` 이 스테일 캐시를 파일에 되쓴 2026-07-16 시연장 클로버의 한 축). 설정 완료 → `showAdkSetup=false` → 하이드레이션 effect 재실행 후에만 게이트 개방 | S-CONFIG-SOT-2 | `e2e/config-sot-boot.spec.ts`(실 UI 부팅 3계약: 하이드레이션·무클로버·읽기지연 경쟁) |
| **FR-CONFIG-SOT.6** | `write_naia_config`는 입력이 JSON 객체인지 먼저 검증하고, UTF-8 임시 파일 전체 기록·디스크 동기화 후 같은 디렉터리에서 원자 교체한다. 중단·잘못된 입력·쓰기 실패 시 기존 `config.json`을 손상시키지 않는다 | S-CONFIG-SOT-5 | Rust 원자 저장 계약(한국어 왕복·덮어쓰기·invalid 입력 보존) |

### NFR
- **동기 렌더 제약**: localStorage 캐시는 유지한다(rip-out 불가 — 107곳 sync 리더가 React 렌더/이벤트/store init 에서 await 불가). 캐시는 read-through, 권위는 파일.
- **비대칭 해소**: 부팅 병합과 워크스페이스 전환(`applyWorkspaceConfigToLocal`)이 **동일 패턴**(파일만 base)이어야 한다. 부팅만 `...local` 을 쓰던 것이 유일 버그원.
- **레이스 안전**: 하이드레이션(IPC 2회 await)과 디바운스 sync(800ms) 간 순서를 플래그로 강제 — "먼저 끝난 쪽이 이긴다"에 의존 금지.

> NFR: NFR-isolation(복원 실패가 전환 자체 안 깸) · NFR-deny-default(ui-config.json 도 adkPath 경계 가드 = 기존 Rust read/write_naia_config 패턴 재사용).

## 기능 요구사항 (FR) — 파이프라인 TTS 셸 직접 (#363, 셸 feature — 2026-06-25)

> 범위: foundation tranche 밖, 사용자 우선순위. new-core agent 엔 TTS 합성이 없어 `tts_request` IPC 가 Rust dispatcher 에서 drop → 무음(#363). A안 = 셸 직접 합성(realtime 음성 경로와 동형, agent 우회). 트랙: alpha-adk `naia-os-tts-shell-direct-2026-06-24.md`.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-TTS.1** | 파이프라인·프리뷰 TTS 를 셸이 직접 합성(`lib/tts/synthesize.ts`) — agent 우회. browser(isClientSide)는 기존 speechSynthesis 유지 | S-TTS·UC2 | `synthesize.test.ts`(provider 분기) · 셸 vitest |
| **FR-TTS.2** | provider 분기: nextain(gateway `POST /v1/audio/speech`, `X-AnyLLM-Key: Bearer`)·google·openai·elevenlabs(bytes)·vllm(OpenAI-compat)·edge(MS WS). **nextain creds(naiaKey/gatewayUrl)를 pipelineVoiceConfig 두 구성 지점에 탑재** = 무음 직접원인 해소 | S-TTS | `synthesize.test.ts` |
| **FR-TTS.3** | edge WS 실패 시 browser speechSynthesis 폴백(`onstart/onend/onerror`로 avatar speaking 상태 누수 방지) → 기본값 무음 금지. 합성 실패 = `audioQueue.skipOrdered(seq)` 로 ordered 슬롯 해제(후속 오디오 stall 방지) | S-TTS | `edge-tts.test.ts` · audio-queue |

> NFR: NFR-isolation(합성 실패가 턴 안 깸·슬롯 누수 0) · NFR-efferent-async(audioQueue 순서·interrupt 정합). ⚠️ 라이브 네트워크/edge-WS 왕복 = 실 앱(naiaKey) 검증 천장.

## 기능 요구사항 (FR) — capability-driven 모델 설정 (#365, 크로스레포 — 2026-06-25)

> 범위: gateway(project-any-llm) + 셸. omni 모델(STT+LLM+TTS 통합)을 독립 슬롯 가정과 충돌 없이 수용. 사용자 결정: gateway capability manifest + **AppConfig 평면 유지**(UI 슬롯 도출, 중첩 마이그레이션 없음). 트랙: `naia-capability-driven-settings-365-2026-06-25.md`.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-CAP.1** | gateway 가 capability SoT — `GET /v1/models`(`model_catalog.py`, no-auth) 카탈로그. 클라 `fetchNaiaModelCapabilities` 가 override(실패 시 static fallback) | S-CAP·UC12 | `test_models.py`(gw) · `capability-fetch.test.ts` |
| **FR-CAP.2** | `deriveSettingsSlots(caps)` 로 설정 슬롯 동적 전개 — omni→음성 in/out 커버(외부 STT/TTS 숨김), 텍스트→외부 둘 다 노출. binary `isSelectedOmni` 불리언 대체. config 평면 유지 | S-CAP | `slots.test.ts` · 셸 vitest |
| **FR-CAP.3** | `ModelCapability` = llm/omni/asr/stt/tts/vlm/image/video/avatar/world — gateway `CAPABILITIES` vocab 와 동기 | S-CAP | types · model_catalog |

> NFR: NFR-isolation(gateway 미가용 시 static fallback·무회귀) · NFR-port-canon(/v1/models 스키마). 동작 보존 = 적대 리뷰로 `showVoiceSection ≡ !isSelectedOmni`(전 모델) 확인.

### Naia account Azure text models (#396, 2026-07-30)

| ID | Requirement | Verification |
|---|---|---|
| **FR-NAIA-AZURE.1** | Naia provider는 `grok-4.3`, `deepseek-v4-pro`, `gpt-5.6-sol`, `gpt-5.6-luna`, `claude-opus-5`를 정적 fallback과 gateway catalog에서 노출한다. Opus는 quota가 열릴 때까지 준비중으로 표시한다. | registry/catalog unit |
| **FR-NAIA-AZURE.2** | 선택은 기존 `naia-settings/config.json` SoT에 저장되고 재시작 후 복원된다. | config roundtrip + Settings FE |
| **FR-NAIA-AZURE.3** | 일반 chat은 기존 Shell→Agent provider pipeline과 Naia key를 사용해 정확한 model ID를 보낸다. DeepSeek 요청은 tools/tool_choice를 보내지 않고 Grok은 기존 tool policy를 유지한다. 별도 Azure/direct-provider transport를 만들지 않는다. | request-body capture + controlled integration |
| **FR-NAIA-AZURE.4** | gateway의 `supports_tools`와 `upstream_provider=azure`를 반영하며, gateway 실패 시 다른 provider/model로 silent fallback하지 않는다. | positive/negative catalog tests |
| **FR-NAIA-AZURE.5** | Gateway 가격은 이미 원가의 1.1배인 최종 고객가이며 Shell은 추가 가산 없이 그대로 표시한다. | exact pricing unit |
| **FR-NAIA-AZURE.6** | OpenAI-compatible 모델과 Anthropic Messages 모델의 protocol/운영 상태를 구분하며 quota가 없는 Opus를 선택 가능하다고 오표시하지 않는다. | metadata + disabled apply unit |

**Deferred**: Coding Workers, Pi lifecycle, Workspace coding UX and role eligibility are not part of #396.

## 기능 요구사항 (FR) — VRAM tier 로컬 프로파일 (#2, 셸측 슬라이스 — 2026-06-25)

> 범위: private deployment draft 의 **naia-shell UI측만**. 로더(fetch/launch)·auto-download = device RTF hardware gate=DEFER. 정본 tier manifest = private tier manifest (outside this repo). **hard rule F1: 측정 RTF 없이 realtime 단정 금지.** 트랙: `naia-vram-tier-capability-bridge-2026-06-25.md`.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-VRAM.1** | GPU VRAM 감지(Rust `detect_gpu_vram`, nvidia-smi) → 설정 UI 가 tier(6/12/24G+) 표시·수동 override. 감지 실패=null→수동 선택 | S-VRAM·UC12 | gpu 파싱 단위 · `vram-tiers.test.ts` |
| **FR-VRAM.2** | `selectVramTier(vramGb)`+`tierProvidedCapabilities` → **opt-in 시** effectiveCapabilities 에 fold(deriveSettingsSlots 반영, 로컬 tier 가 커버하는 외부 슬롯 숨김). **기본 off=무변경**(안전 기본값) | S-VRAM | `vram-tiers.test.ts` |
| **FR-VRAM.3** | footprint = private footprint measurement(avatar + TTS models). 각 tier `realtime: measurement-gated`(F1) — RTF 단정 0. 로컬 serving/auto-download = DEFER(loader 게이트) | — | F1 가드 테스트 / DEFER |
| **FR-VRAM.4** | **VRAM 예산 내 슬롯별 로컬 추천(숨김 아님)**. `tierRecommendedSlots(tier)`(tier capability llm/tts/avatar → 슬롯 main/tts/avatar 로컬 추천값) → ① 설정 두뇌 탭 GPU 프로파일 아래 추천 요약 ② 각 슬롯 셀렉터(main/tts/avatar) 추천 옵션 배지 ③ 프로파일 탭 슬롯 개요 배지 ④ 온보딩 provider step 추천 표시. **외부 슬롯 숨김 안 함(FR-VRAM.2 fold 채택 안 함)** — F1: 런타임 매니저 readiness 보고 전 숨김 금지. tier=null(off/미달)=추천 0(클라우드 유지) | S-VRAM·UC12 | `tier-slots.test.ts`(6/6: 8G→tts만, 12G→tts+avatar, 24G→+main, null→0) |

> NFR: NFR-isolation(VRAM 미감지·tier off 시 무회귀) · F1(measurement-gated, RTF 단정 금지). FR-VRAM.4 는 추천(표시)만 — 슬롯 자동변경·숨김 없음(사용자 선택·확인 보존).

## 기능 요구사항 (FR) — S-SLOT 게이트+6슬롯 설정 모델 (#gate-slots, 셸 feature — 2026-06-28)

> 범위: naia-shell 설정/온보딩 **클라우드 슬롯**측. 구 engine/ai/models/memory 분산을 게이트+6슬롯으로 통합("설정 헷갈림" 해소). **Naia는 provider가 아니라 접근 유형(게이트)** — 이전 naia/byo/local 3프로파일 전제 오류 폐기. 트랙: `.agents/progress/naia-model-slots-architecture-2026-06-28.md`(2-clean 수렴). 로컬 런타임(cascade·통합 VRAM)은 **DEFER**(wm 언블록 후 · Phase 1.2b/1.4).
>
> **상태: Done (P04→P05, 2026-06-29)** — 클라우드 슬롯측 구현 완료. 검증: `settings-slots.contract.test.ts`(23/23 GREEN), `SettingsTab.test.tsx`(S-SLOT 2건), `e2e/settings-slots.spec.ts`(Playwright 3/3 — 게이트·3그룹·Gemini 기본값 적용 실 UI). 구현: 1.1 슬롯 모델(`lib/slots/model.ts`)·1.2a 게이트+3그룹 UI(3-profile 잔재 제거 R1-7)·1.3 Gemini 기본값(`applyNaiaSlotDefaults`, §9 #5 해결 gemini-3.5-flash/3.1-flash-lite)·1.5 온보딩 게이트→슬롯 순서. DEFER: 1.2b(로컬 설정 영역)·1.4(통합 VRAM)·Phase 6(STT 완전통합) — wm/별도 슬라이스.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-SLOT.1** | **naia 계정 게이트**(binary, naiaKey 파생)가 최상위 분기. 계정=크레딧 접근 권한. **GPU·로컬 옵션은 게이트 무관**(R1-3 — `detectGpuVramGb>0` 또는 host 입력으로 계정·비계정 모두 로컬 엔드포인트 노출) | S-SLOT·UC12 | `settings-slots.contract.test.ts`(게이트 파생·로컬 무관) |
| **FR-SLOT.2** | 6 슬롯 **각각 독립 설정**: LLM main · LLM sub(범용·기억전용 아님) · embedding · STT · TTS · video avatar. 3 그룹(Brain·Voice·Avatar) UI | S-SLOT | `settings-slots.contract.test.ts`·`settings-tab.test.ts` |
| **FR-SLOT.3** | naia 계정 시 **Naia 기본값 자동 적용**(현재 main=gemini-flash·sub=gemini-flash-lite·embed=cpu offline·tts=Gemini TTS·stt=free). UI는 특정 공급자 이름이 아닌 Naia 관리 기본값으로 표기하며 사용자 개별 override를 허용한다. | S-SLOT | `settings-tab.test.ts`(기본값 적용) |
| **FR-SLOT.4** | 설정 탭·온보딩 모두 **게이트→슬롯 순서**. 구 engine/ai/models/memory 탭 중복 통합·재배열(회귀 无) | S-SLOT·UC12 | `onboarding-fresh.spec.ts` + Playwright E2E(게이트→클라우드 슬롯 흐름) |
| **FR-SLOT.5** | sub-LLM은 `memoryLlmProvider` 필드명 유지(R1-1), **역할 범용화**(기억+압축+adk 배치용). rename→`subLlm*`은 Slice C dual-write | S-SLOT | `settings-slots.contract.test.ts`(필드명·역할) |
| **FR-SLOT.6** (2026-07-15) | embedding 슬롯 offline(CPU) 모델에 **다국어(한국어) 2종** 노출 — `multilingual-e5-large`(1024d, 고정확) · `paraphrase-multilingual-MiniLM-L12-v2`(384d, 경량·빠름). all-MiniLM/all-mpnet 은 **영어 전용**이라 한국어 회상 품질 낮음(실측 2/5). **UI 라벨에 언어 명시**(`[영어 전용]`/`[한국어·다국어]`)로 유저가 구분 가능(핵심 요구). 배선 3-repo: naia-memory OfflineEmbeddingProvider(모델 allowlist·e5 q8 dtype·프리픽스) + naia-agent(검증 allowlist·dims 계약) + shell(union·드롭다운·i18n). 각 경계·SDLC 준수. 기본값(NAIA_SLOT_DEFAULTS) 무변경 | S-EMBKO·S-SLOT | `settings-slots.contract.test.ts`(offline union·다국어 2종 roundtrip) + naia-memory `embeddings.test.ts`(dims) + naia-agent `memory-adapter-embedding.contract.test.ts`(dims·allowlist) |

> NFR: NFR-isolation(슬롯 변경이 타 슬롯·부팅 안 깸) · NFR-deny-default(게이트 미설정 시 안전 기본값). ⚠️ 로컬 설정 영역(1.2b)·통합 VRAM(1.4)·STT 완전통합(Phase 6) = wm/별도 슬라이스 DEFER.

## 기능 요구사항 (FR) — 프로파일 UX 일관화 + 로컬 음성 정직화 (실사용 피드백, 셸 feature — 2026-06-30)

> 범위: naia-shell 설정 **프로파일 탭 디자인 일관화** + **naia-local-voice(로컬 음성) 정직화** (Round 1, naia-shell 단독). 실제 로컬 cascade 기동(lifecycle 임베딩) = **DEFER(Round 2 — naia-omni-windows-manager 정식 로더 #1 M5 의존)**. 트랙: `.agents/progress/naia-os-profile-design-gpu-voice-flow-2026-06-30.md`.

> **#397 supersession:** FR-CASCADE.9~14와 [`windows-8gb-nva.md`](windows-8gb-nva.md)가 Windows 8GB 정책의 정본이다. FR-VOICE.5와 과거 FR-VRAM.5의 CPU/NPU/local-Ollama 두뇌 조항은 폐기됐다. 활성 Windows 프로파일은 LLM을 외부에 유지하고 VoxCPM2 W8A16 + TensorRT LocDiT와 TensorRT-native Ditto만 로컬에서 실행한다. VoxCPM2의 나머지 모듈과 생성 제어는 PyTorch에 남으므로 전체 모델 TensorRT로 표기하지 않는다.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-PROF.1** | 프로파일 탭 **타이포/카드 일관화**. 클래스 없는 `<strong>`(밝은 `--cream` bold 튐) 제거 → 공통 토큰(`.settings-card`/`.settings-card-title`/`.settings-summary-{grid,row,key,value}`). 인라인 style 카드 박스 → 공통 클래스 | S-PROF | `SettingsTab.test.tsx`(35/35 무회귀) · 시각(HMR) |
| **FR-VOICE.1** | naia-local-voice 합성이 **로컬 음성 호스트(`vllmTtsHost`)** 사용 — LLM용 `vllmHost`(localhost:8000) 오용 버그 수정. `SynthesizeOpts.vllmTtsHost` 신설 + ChatApp 2개 빌드부 + 합성 호출 배선 | S-VOICE | `SettingsTab.test.tsx` · tsc |
| **FR-VOICE.2** | **silent free 폴백 제거(정직화)**. naia-local-voice/vllm 합성 실패 시 브라우저 무료 TTS로 위장 금지 → 1회 명확 알림(`chat.localVoiceUnavailable`) + 무음. 클라우드 provider 는 기존 free 폴백 유지 | S-VOICE | `ChatApp` 경로 · tsc |
| **FR-VOICE.3** | naia-local-voice **voice picker 채움**(registry voices=기본 음색 1) — 선택 시 stale 클라우드 voice id 잔존 방지. 설정 힌트=로컬 cascade 실행 필요(`settings.localVoiceEngineHint`) + public façade 포트(8910) placeholder | S-VOICE | registry · tsc |
| **FR-VOICE.4** | naia-local-voice `/tts` 합성이 **웹뷰 CORS 로 차단되지 않도록** Tauri 런타임에선 Rust 프록시(`local_voice_synthesize`, reqwest, CORS 면제)로 우회. VoxCPM2(stdlib http, ACAO 없음) 대상 웹뷰 `fetch(POST application/json)`가 preflight 501+ACAO 부재로 실패하던 버그 수정(2026-07-15 실측). 비-Tauri(브라우저/vitest)는 직접 fetch 유지 → 계약 무회귀. 대응 서버측 근본수정 = cascade `voxcpm2_service.py` CORS 헤더(별도, kiosk-4070 배포). ⚠️ **stale(2026-07-15 표면 전환)**: naia-local-voice 가 raw `/tts` → OpenAI `/v1/audio/speech`(3자 합의 정본 표면)로 이동, omni 서버는 CORS 허용(`ACAO:*` 실측) → Rust 프록시 코드 제거됨. 이 행은 이력 보존용 | S-VOICE | (대체: FR-VOICE.5) |
| **FR-VOICE.5** | **Windows 8GB half-duplex 로컬 음성 + Ditto 립싱크 배선**. ① LLM은 Naia 계정·원격 Ollama·외부 API 경로를 그대로 유지하며 Shell/manager가 로컬 Ollama나 NPU를 선택·설치·기동하지 않는다. ② `naia-local-voice`는 public cascade façade를 통해 VoxCPM2 W8A16 host + FP16 TensorRT LocDiT 음성을 합성한다. ③ Shell은 재생하는 동일 WAV를 Ditto TensorRT-native `/stream`에 직렬 전달한다. ④ 초기화 실패 시 NVA idle 화면을 유지하고 FR-VOICE.2의 명확한 알림+무음 원칙을 따른다. ⑤ 엔진·모델 revision·SM·TensorRT major 불일치나 warm-up 실패는 준비 완료로 위장하지 않고 기동을 실패시킨다. | S-VOICE-AVATAR·UC-WIN-NVA-8G | `synthesize.test.ts` + `cascade-renderer.test.ts` + 실제 façade `/v1/audio/speech`·Ditto `/stream` + Tauri 94 + windows-manager manifest/profile tests |
| **FR-VOICE.8** | **TTS 진행 상태 표시와 텍스트 독립성** (2026-09-07 #571 로 개정). TTS가 켜진 일반 채팅은 14개 지원 언어로 `thinking → tts → render`를 표시한다. **답 텍스트는 음성 상태와 무관하게 도착하는 대로 렌더한다** — 화면을 재생 시작까지 가리지 않는다. 개정 전에는 canonical 을 보존한 채 화면만 가렸는데, 음성이 느린 기계에서 워밍업 홀드가 그 마스크를 계속 다시 걸어 본문이 무기한 인질이 됐다(win-rtx4060 실기: 비용 배지만 찍히고 60초 공백). 음성은 별도의 진행 표시로만 나타나고, 그 표시는 재생이 끝나거나 홀드가 풀리면 사라진다. 이전 세대의 늦은 공개와 중단 뒤 상태 부활은 계속 허용하지 않는다. | S-VOICE-AVATAR·UC-WIN-NVA-8G | `ChatArea.test.tsx` 느린 합성(대기 중 본문+비용 배지 노출)·CJK 무공백·재생 콜백 유실·ESC 계약 + `i18n-output-stage.test.ts` 14 locale + `reveal-guard.test.ts` 진행 표시 해제 판정 |
| **FR-VOICE.9** | **GPU 작업의 bounded 수명주기**. VoxCPM2와 Ditto는 각각 한 요청만 수행하며 겹친 요청은 `429 Retry-After`로 즉시 거부한다. TTS 입력은 64KiB/1,000자, Ditto 오디오는 16MiB/60초와 허용 sample-rate로 제한한다. 성공·오류·연결 중단 모두 Ditto SDK 세션을 닫고, Shell MSE와 HTTP bridge 큐도 상한을 둔다. | UC-WIN-NVA-LATENCY | naia-labs `test_render_admission.py` 22개 범위 + cascade bounded bridge 4개 + 실제 8901/8902 동시 요청 200/429 + Ditto 반복 10회 |
| **FR-VOICE.10** | 로컬 VoxCPM2 음색 프리셋은 내부 WAV 파일명을 노출하지 않고 성별·순번·기본 여부를 사용자의 언어로 표시한다. 저장·합성 계약에는 원래 파일 식별자를 유지한다. | UC-WIN-VOICE-6G | `ref-audio-api.test.ts` 식별자/메타데이터 보존 + `RefAudioSection.test.tsx` 표시명 계약 + 실제 façade `/ref/voices` |
| **FR-VOICE.11** | 6GB VoxCPM2 음성 경로는 스트리밍 답변을 문장 단위로 나누되 합성은 단일-flight로 직렬화하고 재생은 독립 오디오 큐로 이어간다. 첫 WAV의 생성 시간/재생 길이로 RTF를 측정해 RTF>1이면 다음 문장까지 선행 버퍼링하고, RTF≤1 또는 한 문장 답변이면 즉시 재생한다. 중단·실패는 대기 합성을 폐기하고 다음 문장의 순서를 막지 않는다. | UC-WIN-VOICE-6G | `ChatArea.test.tsx` 6GB 직렬 합성·적응형 버퍼·중단 + `audio-queue.test.ts` pause/resume·WAV duration + 실제 8901 429 무발생 연속 발화 |
| **FR-VOICE.12** | 사용자가 음성 입력이나 새 채팅으로 앞 발화를 중단했지만 VoxCPM2 서버의 기존 GPU 작업이 아직 정리 중이면, façade는 upstream 429와 `Retry-After`를 보존하고 Shell은 그 429만 제한 시간 동안 순차 재시도한다. 구 façade의 정확한 urllib 429→502 본문만 임시 호환한다. 재시도 중 다시 중단하면 즉시 취소하며 validation·OOM·일반 5xx·연결 오류는 재시도하지 않는다. | UC-WIN-VOICE-CONTINUOUS | `synthesize.test.ts` busy→성공·중단·비-busy 오류 + cascade `test_openai_speech.py` 429 전달 + Windows façade 겹침 실측 |
| **FR-VOICE.13** | **마이그레이션 침묵 비활성 금지** (#419). 안전 마이그레이션이 로컬 음성 권한을 끌 때(폐기 `localGpuTier` = 스테일 권한) ① 사유를 config `localVoiceMigrationNotice` 필드로 기록하고 ② Voice 설정 카드에 로컬라이즈된 사유와 복구 액션(재활성 버튼)을 표시하며 ③ 마이그레이션 판정 1줄을 Logger 로 남긴다. 사용자가 로컬 음성을 다시 켜면 notice 를 해제한다. 사유 기록 없는 기능 비활성 경로는 금지. | S-VOICE-MIGRATION | `config.test.ts` notice 기록/해제 + `SettingsTab.test.tsx` 사유 표시+복구 버튼 + Playwright 폐기 필드 시드 실 UI |
| **FR-VOICE.14** | **로컬 음성 준비 신호 단일화 + 미실행 상태 명시** (#418). ① 준비 판정은 façade `GET /health` 의 TTS 필드를 파싱하는 단일 헬퍼 `fetchLocalVoiceHealth` 로 수렴한다 — 포트 응답이나 저장된 URL 존재는 준비가 아니다. ② RefAudioSection 은 로컬 provider 에서 로드 실패 시 일반 오류로 뭉개지 않고 health 로 구분해 "엔진 실행 필요"(제자리 시작 액션 포함) 또는 "엔진 준비 중(TTS 미가용)" 을 명시한다. ③ 기존 CASCADE_READY 구독과 합성 warm-up 재시도(FR-VOICE.12)는 유지하고 준비 '판정'만 이 헬퍼를 쓴다. | S-VOICE-READY | `local-runtime.test.ts` health 계약 + `RefAudioSection.test.tsx` 미실행/준비중 상태 + Tauri 94 실측 `/health` |
| **FR-VOICE.15** | **e2e/하니스 시드 SoT** (#418). 하니스가 만드는 셸 config 시드는 `config-seed.ts` 의 `buildSeedShellConfig`(타입 = AppConfig 에서 폐기 키 제외, 초과 속성 컴파일 차단)로만 생성한다. 빌더는 폐기 키(`RETIRED_CONFIG_KEYS`)를 런타임에도 거부하고, 계약 테스트가 폐기 키 목록과 안전 마이그레이션(normalize)의 실제 제거 동작 일치를 고정한다. | S-VOICE-READY | `config-seed.test.ts`(거부·일치 계약) + tsc |
| **FR-VOICE.16** | **TTS 파이프라인 소유권 경계** (#420, 단계 진행). 일반 채팅의 모든 합성 발화는 단일 Shell TTS 파이프라인을 통과하며, 렌더러·스킬이 이를 우회하는 코드 경로는 금지(저작 NVA 클립 재생만 예외 — 자체 녹음 음성의 정확한 알려진 문구). 오케스트레이션은 `lib/tts/` 로 단계적 이전한다: **Phase 2a 완료** = 6GB half-duplex 직렬화+적응형 프리버퍼+세대 fencing 을 `lib/tts/local-voice-scheduler.ts` 로 추출. **Phase 2b 완료** = 문장 오케스트레이션 본체(요청 수명주기·저작클립/브라우저/셸합성 라우팅·로컬 무폴백/클라우드 폴백 실패 정책·1회성 미가용 알림·에코필터 링버퍼)를 `lib/tts/sentence-pipeline.ts` 로 추출 — ChatArea 는 환경 콜백만 배선하는 어댑터(`sendSentenceToTts` = 위임 1줄), 소유권 계약(media-runtime-routing)은 새 소유자를 읽고 "ChatArea 무합성 위임" 단언 추가. 두 Phase 모두 ChatArea 계약 테스트 무수정 통과가 리팩터 판정. **Phase 3 완료** = 소비자 감사(라디오DJ/NVA/프리셋 = 이미 파이프라인 경유 확인) + 브라우저 발화 취소를 파이프라인 interrupt 소유로 이동 + **컴포넌트 전수 소비자 계약**(components/** 에서 synthesizeTts/speechSynthesis.speak/.playAuthoredClip 호출 금지 — 허용 예외는 음성 미리듣기 2곳: SettingsTab 프로바이더 미리듣기·OnboardingWizard 시스템보이스 미리듣기(FR-VOICE-ONBOARD.1), 미리듣기는 대화 발화가 아님). | UC-WIN-VOICE-6G·UC-WIN-VOICE-CONTINUOUS·UC-WIN-NVA-TTS-SYNC (기존 UC 보존이 시나리오) | `local-voice-scheduler.test.ts` 10건 + `sentence-pipeline.test.ts` 8건(라우팅·실패정책·중단·취소·링버퍼) + `media-runtime-routing.contract.test.ts` 5건(신소유자+무합성 위임+전수 소비자) + `ChatArea.test.tsx` 기존 계약군 무수정 GREEN + Tauri 94 |
| **FR-VOICE.17** | **로컬 음성 다운로드·설치 진행 UX** (#453). 로그인한 Naia 회원이 로컬 VoxCPM2 음성을 선택하면 Shell은 정리된 번들(≈4.2 GiB: torch + 컴파일된 Nextain `.pyd`, TensorRT/CUDA·모델은 미포함)을 다운로드하고 설치를 완료한다. ① 다운로드 단계는 Rust `download_voxcpm2_archive`가 250 ms마다 `voxcpm2_install_progress {phase:"download", downloaded, total}`를 방출한다. ② 설치 단계는 `prepare-voxcpm2-model.ps1`이 `VOXCPM2_PROGRESS {phase:"install", step, label, percent}`를 방출하고 Rust `install_voxcpm2_runtime`이 child stdout를 줄단위로 읽어 같은 `voxcpm2_install_progress` 이벤트로 전달한다(TensorRT/CUDA 설치 → 모델 다운로드 → 엔진 빌드). ③ SettingsTab이 이 이벤트를 구독해 로컬라이즈된 라벨과 `<progress>` 바(`data-testid="voxcpm2-install-progress"`)로 렌더하며, 정지된 "설치 중" 문구를 대체한다. 설치 완료 시 진행률을 해제한다. 게이트: **로그인 회원 전용** — `install_voxcpm2_runtime`은 `read_secure_naia_credential` 부재 시 `voxcpm2_naia_member_login_required`로 fail-closed, UI는 `naiaKey` 부재 시 선택을 막고, 런타임 서빙은 `activation.activate()`가 모델 로딩 전에 BASIC/PRO 엔타이틀먼트를 검증한다. VRAM<6 GiB 또는 SM<7.5는 다운로드 전(nvidia-smi)·모델 로딩 전(inspect_cuda) 이중 fail-closed. | UC-WIN-VOICE-6G·UC-WIN-VOICE-INSTALL | `SettingsTab.test.tsx` 진행 이벤트→바 렌더+완료 해제 + Rust `install_voxcpm2_runtime` 로그인 게이트 + voxcpm2-tensorrt `tests/test_thin_artifact.py` 얇은/번들 계약 + 실 `pnpm run tauri:dev` 다운로드·설치 진행 표시 |
| **FR-VOICE.18** | **VoxCPM2 activation 401 복구** (#470). 독립 런타임은 readiness 전에 비밀 없는 `VOXCPM2_ERROR {"code":...}`를 내보내며, Shell은 stdout 종료보다 이 envelope를 먼저 소비한다. 401/403 `entitlement_rejected`만 `voxcpm2_naia_member_login_required`로 매핑해 저장된 잘못된 credential을 지우고 로그인 UI로 복구한다. FREE/inactive와 transport/timeout/5xx는 각각 membership-required/unavailable로 남고 credential을 지우지 않는다. 어떤 오류에도 credential·계정·응답 본문을 로그나 IPC 오류에 포함하지 않는다. | UC-V017-VOXCPM2-ENTITLEMENT-RECOVERY | runtime activation pytest + Rust startup-line parser/mapping tests + Settings component recovery tests |
| **FR-VOICE.19** | **워밍업 언더런 근본 차단** (#519). ① RTF 측정은 첫 문장 한정이 아니라 모든 로컬 문장에서 수행한다. ② RTF>1 관측 시 warming hold: 재생 시작을 보류하고 `naia:voice-model-preparing` 이벤트로 "음성 모델 준비 중…"을 표시한다. 폴백 없음(FR-VOICE.2 유지 — 루크 결정 2026-08-31). ③ 해제는 (a) 어떤 문장이 RTF<1로 완성(엔진 웜), (b) 스트림 종료 + 대기 문장 전부 합성 완료(complete-then-play — 갭 원리적 0), (c) 문장 실패(교착 방지) 세 조건뿐이며 임의 시간 캡으로 굶주린 큐를 강제 재생하지 않는다(기존 5초 캡 대체). ④ interrupt 는 hold 와 preparing 표시를 함께 해제한다. | UC-WIN-VOICE-WARMUP | `local-voice-scheduler.test.ts` hold 진입·3해제조건·interrupt + `sentence-pipeline.test.ts` 전 문장 측정·preparing dispatch |
| **FR-SHELL-ISO.1** | **개발 인스턴스 격리 + 단일 GPU 런타임 공유** (#425). ① 개발 실행(tauri:dev/tauri:prod)은 별도 앱 정체성(`Naia Dev`/`com.naia.shell.dev`, tauri.conf.dev.json 오버레이 — WebView2 데이터·localStorage 분리)과 별도 데이터 홈(`NAIA_HOME`, 기본 `~/.naia-dev` — adk-path 캐시·lease·logs·run·skills)을 쓴다. 설치본(stage-runtime)은 base config·`~/.naia` 유지. native E2E 격리(e2e_runtime_dir)가 항상 상위. ② cascade(VoxCPM2, :8910)는 **두 인스턴스가 공유**: 부팅·시작 시 `/health`가 TTS enabled 면 죽이지 않고 **입양**(ADOPTED_CASCADE_READY — 스폰과 동일 계약), 바인드됐지만 비건강일 때만 고아 정리. 정지는 공유 엔진 정지. ③ 포트 분리(2026-08-06 dual-instance 설계 수확): dev 인스턴스는 BGM 사이드카 :18891, OAuth 콜백 :18892 를 쓴다(`dev-instance.mjs` env + Rust `development_instance_enabled()` — debug 빌드 AND NAIA_DEV_INSTANCE=1 이중 게이트, e2e 센티널 무접촉). dev 인스턴스는 updater 도 비활성. 게이트웨이 :18789 는 spawn_gateway 가 제거된 스텁(레거시)이라 분리 불요 판정. ④ agent 기억 격리 = naia-agent#108 완료(NAIA_HOME 존중, 페어 94a7b1d). | S-SHELL-ISO | Rust `isolated_dev_home_overrides_the_default_naia_dir`·`adopted_cascade_ready_matches_the_spawn_contract_shape` + `local-runtime.test.ts` ADOPTED 계약 핀 + Tauri 94 무회귀 |
| **FR-RUNTIME.1** | 일반 `tauri:dev`/제품 실행은 native E2E 임시 workspace를 상속하거나 사용자 `~/.naia/adk-path`에 기록하지 않는다. E2E override는 명시적인 mode sentinel과 격리 runtime을 함께 요구한다. | UC-WIN-VOICE-6G | launch-env 단위 + Rust mode/cache 단위 + 일반 Tauri 로그 `SetWorkspace loaded=true` + E2E 전후 path-cache 불변 |
| **FR-SETTINGS.1** | 아직 사용자 흐름이 확정되지 않은 Connections 설정은 탭과 전체 내용을 비활성화하고 저장·연결 동작에 진입하지 못하게 한다. | 설정 연결 | SettingsTab 단위 + Playwright 설정 탭 |

> NFR: NFR-honesty(미가용을 free 음성으로 위장 금지) · F1(measurement-gated). Windows cascade lifecycle 임베딩과 `windows_trt_8g` manager 기동은 구현·실측됐다. 지원 하한은 VRAM 8GB이며 8GB 미만 또는 감지 실패에서는 NVA를 fail-closed로 비활성화한다. 실시간은 지원 조건이 아니고 속도는 [`windows-8gb-nva.md`](windows-8gb-nva.md)의 문장별 실측값으로만 표현한다.

## 기능 요구사항 (FR) — 16GB 로컬 프로파일 자동설정 + 음색/에코 배선 (2026-07-15, 코스포 시연 로컬 장면)

> 배경: 루크 지시로 "GPU 프로파일 선택 하나로 두뇌·음성·아바타가 자동 설정"되는 시연 로컬 장면
> (9B 로컬 LLM + VoxCPM2 int8 로컬 음성 + VRM). FR-VRAM.4("추천만, 자동변경·숨김 없음")를
> **본 FR 이 개정**한다 — 루크가 명시적으로 자동 적용을 요구했으므로 추천→자동적용으로 전환.

| ID | 요구사항 | UC/시나리오 | 검증(P02) |
|----|----------|-----------|------|
| **FR-VRAM-LEGACY.1** (비규범 이력) | 과거 4060 CPU/NPU Ollama 자동설정 설계. #397에서 폐기됐다. 현재 8GB Windows 프로파일은 `windows_trt_8g`로 정규화하고 LLM 설정을 보존하며 VoxCPM2 W8A16 + TensorRT LocDiT와 Ditto TensorRT-native만 로컬에 둔다. 16GB 로컬 LLM 실험 프로파일은 Windows 8GB 지원 계약과 별도다. | 역사 기록 | 현재 요구사항은 FR-CASCADE.9~14 참조 |
| **FR-VOICE.6** | **로컬 음성 정본 호스트 = :8910 façade**. `DEFAULT_LOCAL_VOICE_HOST` = `http://localhost:8910`이며 public 표면은 `POST /tts`다. :8901 VoxCPM2와 구 :22600 raw 서비스는 Shell이 직접 호출하지 않는다. 프로파일 자동설정은 **빈 값·localhost/127.0.0.1 변형만** 이 기본으로 교체(원격 GPU Tailscale 호스트는 보존)한다. | S-VOICE-AUTO | `synthesize.test.ts`(:8910 `/tts` 기본 호스트) · `SettingsTab` 자동설정(원격 호스트 보존) |
| **FR-VOICE.7** | **프리셋 음색 façade 팔레트 id 전달**. naia-local-voice 의 `voice` = 사용자 음성 참조(`voiceRefUrl`)의 basename(쿼리/프래그먼트 제거 후 `.wav` 파일명 → façade `/ref/voices` 팔레트 id). 팔레트 밖 값(녹음/업로드·비-wav)은 `naia-default` 폴백(서버가 모르는 id 를 200+랜덤 음색으로 받으므로). **vllm provider 는 제외** — 범용 OpenAI 서버라 팔레트 id 를 모름, `"default"` 유지. 두 합성 경로(파이프라인·Live)가 단일 `resolveTtsVoiceId(config)` 공유 → 분기 드리프트 방지 | S-VOICE-PRESET | `ChatArea` 음색 해석(프리셋→id·쿼리스트링·vllm 분리) |
| **FR-ECHO.1** | **자기발화(에코) 방어 2단**. ① 재생 중 마이크(STT 세션) 정지 + 종료 0.8초 후 재개 — 재개 대기 타이머는 다음 문장 재생 시작 시 취소(문장 간 큐 드레인으로 마이크가 발화 중 재개통되던 누수 차단). ② 최근 TTS 문장과 유사도(문자 bigram Dice ≥ 0.6 또는 ≥8자 부분일치)면 STT 결과 스킵 — **짧은 정상 답변("좋아/네/그래")은 절대 스킵 금지**(bigram 폴백 정확일치, 부분일치 길이-게이트) | S-ECHO | `echo-text-filter.test.ts`(동일·부분·짧은답변·정상질문 8건) |

> NFR: FR-VRAM-LEGACY.1의 <16GB 트레이드오프는 프리릴리스 이력으로만 남긴다. FR-ECHO.1 은 web-speech 지연배달 특성 대응(1차 마이크정지가 주 방어, 2차 텍스트필터는 누수 폴백). ⚠️ **후속(비블로킹)**: 부팅 병합(mergeBootConfig)이 localStorage-only 키(naiaKey 시크릿·discord 커서·세션 플래그)를 보존하지 않는 회귀 — 데모 실사용 정상 확인이나 재로그인/중복응답 가능성, 부팅 흐름 변경은 별도 안전작업으로 분리.

## 기능 요구사항 (FR) — BGM 스킬 배선 (2026-07-16, 시연 크리티컬 — 루크 demo freeze 해제 승인)

> 배경: 스킬 회귀 조사(naia-agent FR-PROV-6, ollama tools)에서 발견된 별개 이식 갭 — BGM 위젯(BgmPlayer)·
> 검색 사이드카(:18791, #335)·에이전트 UC8 어댑터는 전부 존재하나 **도구 등록 배선이 0** 이라 나이아가
> BGM 을 모름(구 monolith 는 agent 내장 스킬이 `bgm_youtube_*` 이벤트를 발사했음). 설계 = 앱(환경) 도구
> 경로(agent compose 주석 E1 "브라우저/BGM=셸 소유 환경") — **naia-agent 무변경**.

| ID | 요구사항 | UC/시나리오 | 검증(P02) |
|----|----------|-----------|------|
| **FR-BGM.1** | **skill_youtube_bgm 앱 도구 배선** (셸 단독, agent 무변경). ① `lib/bgm-skill.ts`: 도구 descriptor(액션 play/stop/pause/resume/next/prev/volume, tier 0 — App.tsx 가 이미 auto-allow) + `executeBgmSkill(args, deps)`(deps 주입: search=사이드카 `GET :18791/yt/search`, emitBgm=Tauri `emit("agent_response", …)` — **위젯이 이미 듣는 `bgm_youtube_*` 타입으로 발사**, BgmPlayer 무변경). play=videoId 직접 또는 query 검색 첫 결과(UC8 어댑터 동형), volume=0..1 clamp. ② 부팅 등록: App.tsx keepAlive 등록 effect 에서 `sendAppSkills("bgm-widget", [SKILL_YOUTUBE_BGM])` — 위젯은 앱이 아니라 descriptor.tools 경로 부재. ③ 실행: ChatArea `dispatchAppToolCall` 에 BGM 분기(appRegistry 소유자 탐색 앞) → `executeBgmSkill` → `sendAppToolResult`. 음성 경로(onAppToolCall)도 같은 dispatch 공유라 자동 커버. ⚠️ 음성/립싱크(FR-VOICE.5) 경로 무접촉 | S-BGM-SKILL·UC8 | `bgm-skill.test.ts`(단위 — 액션·검색·clamp·payload·오류) + **`e2e/bgm-skill.spec.ts`(실 UI 배선 회귀 가드 — 부팅 등록 + 채팅 턴 dispatch→위젯 재생, P04 실 UI 게이트 충족)** · tsc · 실 재생=부스 리허설(수동) |

## 기능 요구사항 (FR) — Shell 기본 라디오 DJ·행사 소개 스킬 (#362, 계획)

> **2026-07-30 라디오 MVP 재검증:** `skill_youtube_bgm`은 재생 요청 접수와 실제
> 관측 상태를 구분하고 `status`로 `requested/loading/playing/paused/ended/error/timeout`
> 스냅샷을 반환한다. naia-agent는 요청 결과만으로 곡을 소개하지 않고, 같은
> `playbackId`의 관측된 `playing`을 확인한 뒤에만 DJ 발화를 시작한다. `ended`·오류·시간초과는
> 대체곡/재평가 경로로 보낸다. 결정론적 iframe fixture와 실제 Tauri 큐 검증을 기본으로 하며,
> 외부 YouTube 성공은 CI 합격 조건으로 두지 않는다. 사용자의 최종 STT는 DJ TTS를 중단하고
> 일반 대화를 우선하며, 응답 뒤 라디오 활동을 재개한다.
>
> 아직 완료로 보지 않는 항목은 재생 위치/길이(`currentTime/duration`), sequence와 freshness를
> 묶어 TTS 직전에 원자적으로 소비하는 단일 사용 `speakPermit`, 물리적 TTS 종료 ACK, 날씨
> 동의/캐시 정책이다. #405에서는 외부 LLM + Windows TRT의 A→B 전환, 자동 TTS·Ditto,
> 렌더 중 끼어들기를 실제 Tauri 경로로 결합했다. 따라서 현재 상태는 **라디오 기능 MVP 경로 완료**이며 FR-RADIO-DJ.1~8
> 전체 완료를 뜻하지 않는다.

> 범위: 이 절은 구현 계획의 정본이다. 반복 발화의 일정·침묵·사용자 우선순위는 naia-agent가 소유하고, Shell은 실제 재생과 환경 관측 사실을 제공한다. `skill_youtube_bgm`은 저수준 제어로 유지하며 `skill_radio_dj`가 이를 조합하는 기본 스킬이다.

| ID | 요구사항 | 수용 기준 |
|---|---|---|
| **FR-RADIO-DJ.1** | Shell은 YouTube 재생 요청과 관측 결과를 구분해 `playbackId`, `commandId`, 단조 증가 `sequence`, `updatedAt`, `freshUntil`을 포함한 재생 스냅샷을 제공한다. 상태는 `requested/loading/playing/paused/ended/error/timeout`으로 분류한다. DJ 소개·대체·진행 위치 판단용 관측값의 최대 경과시간은 **5초**이며, 만료 뒤에는 재관측한다. | 이전 곡 A의 지연 오류가 새 곡 B의 상태를 덮어쓰지 않는다. 같은 `playbackId`의 더 낮은 sequence 이벤트는 무시된다. `freshUntil`이 지난 스냅샷으로는 멘트를 만들지 않고, 새 `playbackId/sequence` 관측 전에는 TTS를 시작하지 않는다. |
| **FR-RADIO-DJ.2** | `BgmPlayer`의 YouTube iframe 어댑터는 준비·상태 전이·오류·재생 위치/길이 이벤트를 수신하고, 로딩 제한시간과 오류 분류를 적용한다. | 앱 이벤트 발행이나 iframe URL 설정만으로 `playing`을 보고하지 않는다. 실제 iframe의 재생 확인 뒤에만 `playing`을 보고하며, `infoDelivery`의 `currentTime/duration`으로 긴 재생의 신선도를 갱신한다. 종료·오류·15초 로딩 시간초과는 해당 iframe URL의 `playbackId`에 결속하고 준비된 다음 후보를 한 번만 전환한다. 같은 곡의 중복·지연 이벤트는 다음 곡을 건너뛰지 않는다. |
| **FR-RADIO-DJ.3** | `skill_radio_dj`와 확장된 `skill_youtube_bgm`는 앱 스킬 등록, 허용 정책, `dispatchAppToolCall`, `app_tool_result`, 재등록/해제 수명주기에 모두 연결된다. | 대화·연속 발화·라디오 DJ·행사 소개 경로에서 동일한 도구 결과 계약을 받고, 창 재연결 뒤 중복 등록이나 유실이 없다. |
| **FR-RADIO-DJ.4** | 자율 발화 전 agent는 Shell 관측 컨텍스트를 요청·반영하고, 발화 문장 생성 전에 적격성을 판정한다. agent가 쿨다운, 곡 중복, 침묵, 사용자/마이크 우선순위 및 다음 재평가 시점을 소유한다. | Shell은 별도 스케줄러 없이 관측·표현 경계로서, agent의 허용 요청에 현재 `observationSequence`·`playbackId`를 묶은 **단일 사용 `speakPermit`**을 발급한다. TTS 직전 Shell은 permit·사용자 음성/채팅·현재 TTS·재생 sequence·`freshUntil`을 원자적으로 재검증한다. 하나라도 달라지면 permit을 폐기하고 TTS를 시작하지 않으며 agent는 다음 재평가를 예약한다. |
| **FR-RADIO-DJ.5** | DJ 멘트는 해당 `playbackId`의 관측된 `playing` 뒤에만 곡명·아티스트·길이·진행 위치를 소개한다. 오류·시간초과면 사실을 숨기지 않고 한 번만 알리거나 침묵하며, opt-in 자동재생일 때만 1회 대체곡을 시도한다. | `ok: true`(명령 접수)만으로 곡 소개를 하지 않는다. 실패 곡의 제목이나 길이를 현재 재생 중인 것처럼 말하지 않는다. |
| **FR-RADIO-DJ.6** | 시간·날씨 컨텍스트는 유효한 IANA 시간대와 명시적 날씨 동의에 한정한다. 설정·복원·profile 갱신에서 시간대를 검증하고, 유효하지 않으면 명시적 기본 시간대로 정규화하거나 시간 언급을 비활성화한다. Shell은 agent/LLM에 원 좌표 대신 관측 시각·날씨 결과·정밀도를 낮춘 위치 범위만 전달한다. 동의 철회 시 좌표·날씨 캐시를 즉시 폐기하고 프로필 갱신을 보낸다. | 구현 전에 날씨 캐시 TTL과 위치 정밀도(도시/권역)를 설정값으로 확정한다. 동의가 없거나 관측값이 오래되면 날씨 언급을 생략하며, 시간대 정규화/비활성 결과를 관측 가능하게 한다. |
| **FR-RADIO-DJ.7** | 검증은 결정론적 로컬 iframe 이벤트 fixture와 실제 Tauri 경로를 기본으로 한다. 외부 YouTube는 선택적 수동 smoke로 분리한다. | CI에서 ready/playing/error/ended, A→B→늦은 A 오류, 만료 스냅샷 재관측, 예약 뒤 사용자 인터럽트, 유효/무효 IANA 시간대와 DST 경계, 도구 결과와 activity 발화 조건을 재현한다. 외부 YouTube 재생 성공을 CI 합격 조건으로 두지 않는다. |
| **FR-RADIO-DJ.8** | activity가 실행한 BGM `play`는 현재 곡과 대기열을 교체하지만 일반 채팅 요청은 기존 대기열 의미를 유지한다. 장기 speech activity의 producer `finish`는 TTS 종료가 아니며, 음성·영상 재생 완료 전 activity를 폐기하지 않는다. Shell은 자동 발화 문장을 실제 TTS/아바타 재생 시작 전까지 숨기고, 즉시 도착한 `finish` 뒤에도 이미 승인된 TTS를 끝까지 전달한다. agent control RPC는 app 왕복을 기다리기 전에 activity/action 유효성을 검사하고 ACK해야 한다. | 실제 Tauri에서 곡 A `playing` → 자동 `/v1/audio/speech` → 같은 오디오 `/stream` → 곡 B 교체·`playing` → 새 DJ 발화가 성공한다. 렌더 중 Enter는 250ms 안에 렌더를 취소하며 BGM은 계속된다. Shell `94-avatar-4060-facade.spec.ts`와 paired naia-agent #103 계약 테스트로 검증한다. |
| **FR-RADIO-DJ.9** | 설정의 사용자용 스킬 이름은 다른 스킬과 같은 영어 표기 `Youtube Radio DJ`로 표시하고 내부 `skill_youtube_bgm` 식별자를 접힌 카드에서 노출하지 않는다. 카드는 시스템 스킬 순서를 유지한 채 `skill_memo` 바로 앞의 기존 2열 목록에 배치하며, 버튼을 펼쳤을 때만 상세 설정을 표시한다. 미설정 값은 Windows 런타임과 같은 대기 120초·멘트 간격 15분·BGM 자동재생 꺼짐을 사용하고 프로필 자체는 opt-in을 위해 비활성으로 유지한다. | Settings RTL 이름/순서/기본값/접힘/펼침 + Playwright 2열 카드·상세 설정 검증 |
| **FR-RADIO-DJ.10** | 일반 곡·재생목록·BGM 요청은 `player`, 지속적인 자율 선곡과 DJ 멘트를 원하는 요청은 `radio_dj`로 LLM이 의미에 따라 선택한다. Shell은 특정 언어의 키워드나 exact-match 문구를 검사하지 않으며 구조화된 스킬 인자만 실행한다. `radio_dj` 재생이 승인되면 능동 발화 프로필과 권한을 함께 활성화한다. | 스킬 schema 다국어·유사 표현 설명 + 구조화 호출 계약 테스트 |
| **FR-RADIO-DJ.11** | 라디오 DJ는 현재 곡의 실제 진행 위치와 길이를 근거로 종료 전에 다음 후보를 미리 검색하고, 실제 `ended` 뒤 짧은 멘트와 함께 전환한다. | 검색은 미리 할 수 있지만 재생 전환은 현재 곡 종료에 결속한다. 새 곡은 실제 `playing` 뒤에만 소개하며 종료→다음 `playing` 무음 시간을 측정한다. |
| **FR-RADIO-DJ.12** | 사용자 대화·곡 교체·정지 명령은 자동 멘트·검색·대기열보다 우선한다. 일반 대화는 현재 음악을 보존하고 “다른 곡”은 현재 곡과 준비 후보를 교체하며 정지는 모든 자동 활동을 회수한다. | 사용자 발화와 곡 종료가 겹쳐도 TTS 중복·곡 건너뜀 없이 사용자 응답을 우선한다. 정지 뒤 추가 검색·재생·TTS는 0회다. |
| **FR-RADIO-DJ.13** | 장기 음악 취향은 사용자가 명시한 좋아요·싫어요만 저장한다. 단순 청취 시간·완주·한 번의 건너뛰기·일반 대화로 영구 취향을 추론하지 않으며 사용자는 취향을 조회·수정·삭제할 수 있다. | 재시작 뒤 명시 취향만 재호출되고 삭제 뒤 복원되지 않는다. 메모리 장애 시 거짓 개인화 없이 세션 최근곡만 사용하며 계정 간 취향이 격리된다. |
| **FR-RADIO-DJ.14** | 자동 선곡은 최근 `videoId`뿐 아니라 제목+아티스트로 정규화한 동일 곡의 다른 영상도 제외하고, 장르·분위기 등 요청 근거를 유지한 새 곡을 고른다. | 같은 곡은 최근 20곡 또는 현재 6시간 세션 중 더 넓은 범위에서 반복하지 않는다. 같은 아티스트는 연속 추천하지 않고 자동 10곡 중 기본 2곡 이하로 제한한다. 명시적 동일 곡 요청과 후보 고갈은 근거를 기록한 예외다. |
| **FR-RADIO-DJ.15** | 사용자는 현재 곡을 음성·텍스트로 즐겨찾기에 중복 없이 추가·삭제하고 즐겨찾기만 재생할 수 있다. | 재시작 뒤 저장 상태가 유지되고 한 바퀴 전 동일 곡을 반복하지 않는다. 빈 목록은 꾸며내지 않으며 재생 불가 항목은 자동 삭제하지 않고 이번 순회에서 건너뛴다. |
| **FR-RADIO-DJ.16** | YouTube의 재생 불가·삭제·임베드·지역·연령 제한·iframe 오류를 `playing`으로 보고하지 않는다. 자동 DJ는 실패 후보와 동일 음원을 이번 세션에서 제외하고 제한된 다른 후보를 찾는다. | 실패 곡을 소개하지 않고 후보별 최대 한 번만 시도한다. 연속 실패 뒤 무한 검색·TTS 없이 짧게 알리거나 사용자 선택을 기다린다. |
| **FR-RADIO-DJ.17** | 이미지 입력 capability가 확인된 모델에만 현재 음악 표면의 캡처를 이미지 도구 결과로 전달하고, 모델은 실제 관찰한 내용과 불확실성을 짧게 언급할 수 있다. | 캡처 범위는 YouTube 배경/플레이어로 제한하며 채팅·설정·알림을 제외한다. 이미지 전송을 지원하지 않는 provider/model에서는 캡처와 시각 언급을 모두 생략한다. 문자열 data URL만 반환하는 상태를 “모델이 봄”으로 간주하지 않는다. |

### 구현 순서 및 인계 항목

1. **프로토콜 설계:** agent↔Shell 관측 요청/응답, `playbackId`·`commandId`·sequence, 거절·시간초과·재평가 규칙을 문서화한다.
2. **재생 관측:** iframe 어댑터와 BGM 상태 모델을 구현하고, 기존의 낙관적 `setPlaying(true)` 경로를 관측 기반 상태로 교체한다.
3. **도구 연결:** 기본 `skill_radio_dj`와 BGM 저수준 도구를 앱 등록부터 결과 반환까지 일관되게 배선한다.
4. **자율 정책:** agent의 개인 라디오/행사 소개 스케줄러에 적격성 게이트와 근거 있는 멘트 규칙을 넣는다. Shell에는 중복 스케줄러를 만들지 않는다.
5. **환경·프라이버시:** 시간대·날씨 동의·캐시 폐기·위치 정밀도를 구현하고 노출 최소화 테스트를 추가한다.
6. **검증:** 로컬 fixture E2E, 순서 역전·오류·침묵·사용자 인터럽트 테스트 후 선택적 외부 smoke를 수행한다.
7. **개인화·선곡:** 명시 취향 메모리, 최근곡 정규화, 즐겨찾기 도구, bounded 대체 검색을 구현하고 [`radio-dj-practical-test-scenarios.md`](radio-dj-practical-test-scenarios.md)의 L1~L4 증거를 수집한다.
## 기능 요구사항 (FR) — 크로스플랫폼 설치 파일: 매트릭스 SoT + 재현 빌드 (#377, 셸 feature — 2026-07-17)

> 상태: 진행 중 (2026-07-17)
>
> 배경: Windows 설치 파일 검증 요청에서 출발한 조사 결과, **설치 파일이 한 번도 만들어진 적 없고 clean
> checkout 재현이 불가**함이 확인됨 — `node.exe`·MSVC 재배포 3종은 conf 가 요구하나 그 실물을 놓는 코드가
> 저장소 어디에도 없고(선언만 있고 생성 주체 부재 — vosk zip 실물은 dll 4개뿐), Windows 빌드 명령이
> `stage-cascade-loader` 를 빠뜨린 채 base conf 딥머지로 리소스만 요구(스테이징 잔재로 우연 통과 중).
> 근본원인 = 플랫폼 차이가 conf 6개 + build.rs + package.json + "주인 없음"에 산재. 해법(루크 확정) =
> **차이를 코드가 아닌 데이터로**: 매트릭스 1곳 → 스크립트 1개가 프로비저닝+conf 생성. **WSL 불요
> 불변**(현재도 wsl.exe spawn 0건 — 이를 요구사항으로 승격해 재도입 차단).

| ID | 요구사항 | UC/시나리오 | 검증(P02) |
|----|----------|-----------|------|
| **FR-INSTALL.1** | **플랫폼 매트릭스 = 유일 SoT** (`src-tauri/platform-matrix.json`). OS(win32/linux/darwin) → { **전체 번들 지원 아키텍처 `bundleArchs`**(win/linux=x64, darwin=x64+arm64 — win/linux Vosk 0.3.45 산출물과 import lib가 x64 고정이므로 arm64는 다운로드 전에 명확 중단; Node arm64 아카이브 메타데이터는 미래 지원을 위해 유지), bundle targets, node 런타임(버전 핀 + **아키텍처(x64/arm64)별 다운로드 URL + SHA256 맵** — 스크립트가 `process.arch` 로 선택, 미지원 arch=명확 에러. SHA 는 동일성만 증명하므로 arch 오선택은 맵 구조로 차단), vosk 리소스(**nullable — darwin=null**, STT 는 mac 에서 stub 이고 vosk crate 자체가 linux/windows 타깃 한정. **win = dll 4종 전부**: `libvosk.dll` + **MinGW 런타임 `libgcc_s_seh-1`·`libstdc++-6`·`libwinpthread-1`** — libvosk 가 load-time 의존하므로 누락 시 STT 저하가 아니라 **기동 실패**; linux = `libvosk.so`), 추가 런타임(win=MSVC 재배포 3종 — **원본 = env `VCToolsRedistDir` 우선, 없으면 vswhere 로 VS 설치 경로 조회 후 redist 디렉토리 규약 탐색. 미발견 시 탐색 경로를 나열한 명확한 에러**), 스테이징 단계(agent 필수 · cascade-loader **optional**), **아이콘**(mac 행에 `icon.icns` — 파일 실존하나 conf 미등록이던 갭 해소): `bundle.icon` 은 **배열**이라 머지가 병합이 아니라 **통째 대체**다(**R5 개정** — `--config` 머지 = JSON Merge Patch 계열이고 `json-patch` `merge()` 는 비객체 patch 를 대체로 처리. **정밀화(P1-R1 실소스)**: tauri CLI 의 머지는 순정 RFC 7386 이 아니라 **null-보존 변형 `merge_patches`** — null 로 base 키 삭제 불가. tauri-build 의 `TAURI_CONFIG` 재머지는 순정 `json_patch::merge` 라 두 소비자의 null 시맨틱이 다름 → 오버레이에 "삭제 의도의 null" 금지(배열 통째 대체는 양쪽 동일). 따라서 mac 행에 `["icons/icon.icns"]` 만 실으면 base 5원소가 남는 게 아니라 **사라진다**). mac 행은 델타 1개가 아니라 **최종 배열 전체**(base 5원소 + `icons/icon.icns`)를 emit 하며, 이는 **"겹침 금지" 의 명시적 예외 — 배열 키는 부분 델타가 원리적으로 불가능**하다. win/linux 행은 icon 키를 싣지 않아 base 배열이 그대로 산다. 공통 아이콘(png/ico)은 base 유지 — **분담 규칙(R4 개정): 커밋-실존 자산=base, 스테이징 산출물·OS 델타·조건부=매트릭스→생성 conf, 겹침 금지(배열 키 = 위 예외)** — tauri-build 의 `copy_resources` 는 `tauri dev`·`cargo check` 포함 모든 cargo 빌드에서 리소스 실존을 강제하므로 base 에는 커밋된 파일만 둘 수 있다 → dev 모드 아이콘 회귀 없음. **매트릭스 초기값 출처(명시)**: 삭제 전 conf 스냅샷(windows.json 의 MSVC dll 3종 실명·설치자 설정) + S-INSTALL(darwin targets=app/dmg); node 정확 버전(22.x.y)·다운로드 URL 템플릿은 P1 착수 시 nodejs.org dist 규약으로 핀, **설치자 설정(win: publisher·webviewInstallMode=offlineInstaller·digestAlgorithm·nsis.installMode=currentUser·nsis.languages — 삭제되는 conf 들의 사실을 매트릭스로 이주**), linux 패키지 depends(**base 쪽 채택 — pipewire-alsa·libasound2 포함**: cpal 오디오 실의존. base↔linux.json 상충의 해소 방향 명시), **updater: createUpdaterArtifacts=false 3 OS 전부**(서명키 부재 시 빌드 실패 차단 — 현행 *-local conf 가 하던 일의 승계, `.sig`/키는 범위 밖), **기대 산출물 `artifacts: [{ glob, minBytes }]`(R6 신설 — FR-INSTALL.6 이 "OS 분기=매트릭스" 로 참조하는 실체. 이 필드가 없으면 검증 스크립트가 무엇을 확인할지 매트릭스에서 유도할 수 없다)**: `glob` = `src-tauri/target/release/bundle/` 기준 상대 글롭(win `nsis/*-setup.exe`·`msi/*.msi`, linux `deb/*.deb`·`rpm/*.rpm`·`appimage/*.AppImage`, mac `macos/*.app/Contents/MacOS/*`·`dmg/*.dmg`). **모든 glob 은 단일 파일을 가리켜야 한다(R7 — 디렉토리 매치 금지)**: `.app` 은 파일이 아니라 **번들 디렉토리**라 `macos/*.app` 를 그대로 쓰면 크기가 디렉토리 아이노드(수십~수백 바이트)로 잡히고, `minBytes` 초기값이 "첫 성공 산출물의 50%" 로 핀되는 방식이라 그 임계마저 수십 바이트로 굳어 **내용물이 비어도 통과**한다 — mac 은 실기기 실측이 없어 이 검증이 유일한 축인데 그 축이 무력해진다. 그래서 mac 은 **번들 안의 실행 파일**을 가리킨다(빈 `.app` = 매치 0 = red) — **글롭을 쓰는 이유 = 파일명의 버전은 `src-tauri/Cargo.toml` 의 `package.version` 에서 오고(base conf 에 `version` 키 부재 → tauri 가 Cargo.toml 로 폴백. `package.json` 의 버전과는 별개 출처라 리터럴 파일명은 두 출처를 얽는다), 버전을 매트릭스에 또 적으면 "한 사실 두 곳" 위반. `minBytes` = **P3(win 실측)·P4(CI)의 첫 성공 산출물 크기의 50% 로 핀**하고 그때까지 **null**(검증 스크립트는 null 을 만나면 **명확한 에러로 중단** — 임계 미정을 조용한 통과로 바꾸지 않는다. 근거 없는 숫자를 먼저 적는 것도 금지) }. 같은 사실이 2곳에 적히지 않는다(conf 는 매트릭스에서 **생성**되므로 구조적으로 어긋날 수 없음) | S-INSTALL | `scripts/__tests__/platform-matrix.test.ts`(스키마: 3 OS 키 전수·필수 필드·`bundleArchs` 지원 계약과 미지원 명확 에러·node arch 맵(x64/arm64)·SHA 형식·darwin vosk=null 허용·win vosk dll 4종·win 설치자 설정 실존·`createUpdaterArtifacts=false` 3 OS·**mac 행 icon = 전체 배열**(base 5원소 + icns — 부분 델타 금지)·**3 OS 행마다 `artifacts` 실존 + glob 형식 + `minBytes` = 양수 또는 null**) [단위] |
| **FR-INSTALL.2** | **단일 스크립트 `scripts/stage-runtime.mjs`** (Node, OS 분기 = `process.platform`/`process.arch` 로 매트릭스 행 선택뿐 — bash/ps1 분리 금지). ① 리소스 프로비저닝: node 런타임 다운로드+SHA256 검증 후 **3 OS 모두 OS 기본 `tar` 로 추출**(**R5 개정** — 추출 도구를 아카이브 포맷과 분리해 명시: Windows 10 **1803+** 는 시스템 디렉토리에 `tar.exe`(bsdtar)를 기본 탑재하고 bsdtar 는 **zip 도 판독**한다. PowerShell `Expand-Archive` 등 대체 도구 금지 — FR-INSTALL.4 의 허용 외부 도구 목록(OS 기본 curl·tar)과 일치시켜 구현자 분기 차단). 아카이브 = win: zip 내 `node.exe` / linux·mac: tar.gz·xz. +`resources/` 배치(unix 실행권한 0o755), win MSVC 재배포 복사(FR-INSTALL.1 의 원본 규칙, 미발견 시 중단 — 조용한 생략 금지), **vosk 는 프로비저닝·검사 대상 아님(순서상 안전)** — 생성 주체는 현행대로 `tauri-plugin-stt/build.rs` 의 `setup_vosk`(버전 0.3.45 핀)이며, clean checkout 에서도 선행 조건이 자동 충족된다 — **다만 그 근거는 "번들러의 리소스 수집 전" 이 아니다(R5 교정)**: vosk 리소스의 **최초 소비자는 번들러가 아니라 셸 크레이트 자신의 `build.rs` 안에서 도는 tauri-build `copy_resources`** 이고(부재 시 `ResourcePathNotFound` → build script 실패), 순서를 실제로 보증하는 것은 **`plugins/tauri-plugin-stt/Cargo.toml` 의 `links` 키**(`links = "tauri-plugin-stt"`)다 — cargo 는 `links` 를 가진 직속 의존의 build script 를 dependent 의 build script **앞에** 실행하도록 강제한다(tauri 자신도 같은 메커니즘에 의존: `tauri` 크레이트의 `links = "Tauri"` → `DEP_TAURI_DEV`). **이 불변식을 게이트로 승격**: `links` 키 실존을 단언한다 — 업스트림이 `links` 를 떼면 순서 보증이 사라져 clean checkout 첫 빌드가 간헐 `ResourcePathNotFound` 로 깨지는데, 아무것도 이를 지키지 않기 때문. (stage-runtime 이 vosk 하드 에러를 내면 오히려 clean checkout 첫 빌드를 깨뜨림 — 금지.) 부재의 최종 검증 = FR-INSTALL.6 산출물 검증(번들 후). build.rs 다운로드 SHA 무검증은 후속 이슈. `stage-agent.mjs` 호출 + **cascade-loader 는 stage-runtime 이 sibling 존재를 직접 확인 후에만 `stage-cascade-loader.mjs` 호출**(부재 시 skip+명시 로그 — 해당 스크립트 자체는 하드 exit(1) 유지, optional 판단은 stage-runtime 소유). ② **`tauri.conf.generated.json` 생성**(`.gitignore` 등재, **`build` 키 자체 부재** — `check-build-contract.mjs` 는 conf 의 build 훅을 수집하며 **빈 문자열 훅도 수집**하므로(flatpak 선례) 키 부재로만 스캔 비대상 성립. **conf 생성 로직은 순수 함수로 분리**(다운로드 부작용과 격리 — vitest golden 이 네트워크 없이 실행 가능해야). **테스트 경로 확정(R5 — 실측 근거)**: 단위 테스트는 `scripts/__tests__/` 아래 둔다. 매트릭스 JSON 옆 코로케이션(`src-tauri/platform-matrix.test.ts`)은 **영구 미수집**이다 — `vite.config.ts` 의 `test.exclude` 가 `src-tauri/**` 를 통째 배제하기 때문(프로브 실측: `scripts/__tests__/` = 수집됨 / `src-tauri/` = 미수집). 경로를 비워 두면 FR-INSTALL.1·2 의 유일한 단위 축이 0건 실행된 채 `pnpm test` 는 GREEN 을 유지하는데, 이는 FR-INSTALL.6 이 금지한 "항상 통과" 와 같은 실패 양식): base 중립 conf 위에 매트릭스 행을 전개, cascade-loader 부재 시 그 리소스 항목 자체를 생략(현행 딥머지 잔재-의존 제거). **`tauri build` 는 stage-runtime 이 마지막 단계에서 직접 spawn**(`--config` 경로를 package.json 커맨드 문자열에 넣지 않는다 — `check-build-contract.mjs` 가 `--config X` 를 경로로 수집·실존 강제하는데 생성물은 gitignore 라 clean checkout 에서 dangling RED 가 되므로. 진입점 커맨드 = `node scripts/stage-runtime.mjs` 뿐). ③ 구 경로 정리: base conf 중립화 — targets·linux 블록·`resources.cascade-loader`·**`createUpdaterArtifacts`**(매트릭스가 유일 소유 — base 잔존 시 "한 사실 두 곳" 위반+미경유 빌드 실패) 제거, **`beforeBuildCommand` = `pnpm build` 로 축소**(스테이징 제거 — `--config` 는 base 를 **머지**하므로 base 훅이 살아남는다: 스테이징이 남으면 stage-agent 이중 실행 + `stage-cascade-loader` 하드 exit(1) 로 sibling 없는 CI 전멸. 스테이징은 package.json 진입점에서 stage-runtime 이 선행), updater endpoint/pubkey·공통 icon·beforeDevCommand 는 base 유지. **agent 리소스 매핑 4종(`agent/dist`·`agent/scripts`·`agent/package.json`·`agent/node_modules`)은 매트릭스의 "3 OS 공통" 그룹 → 생성 conf 소유**(R4 반증으로 base 이주 금지 — tauri-build `copy_resources` 는 `tauri dev`·`cargo check` 포함 **모든 cargo 빌드에서 무조건** 실행되고 리소스 부재 = `ResourcePathNotFound` 빌드 실패인데, `src-tauri/agent/` 는 gitignored **스테이징 산출물**이라 base 등재 시 스테이징 없는 dev·e2e-tauri 가 즉사. 현 소유자 = 삭제 예정 conf 들뿐이라 방치 시 생성 conf 에 agent 미탑재 — 매트릭스 공통 그룹 1곳이 승계, "한 사실 두 곳 금지" 그대로 성립). base = 커밋-실존 정적 자산만, 생성 conf = 스테이징 산출(agent) + OS 델타 + 조건부(cascade-loader). `tauri.conf.{local,windows,windows-local,linux}.json` 삭제(**linux.json 은 삭제 전 외부 소비자 확인** — 배포판 계층(titanoboa 등)이 참조하면 이관 명시 후 삭제, 조용한 파손 금지) + **고아가 되는 `nsis-hooks.nsh` 삭제**(참조 실체 = `tauri.conf.local.json` 의 installerHooks 뿐 — windows.json 빌드 경로는 원래 미참조. 그 기능(agent DLL 을 `$INSTDIR` 로 이동)은 resources 직접 매핑이 대체). **flatpak conf 처리(R5 개정 — 이관하지 않는다)**: 구설계는 base 에서 제거되는 `targets` 를 `tauri.conf.flatpak.json` 에 "보완 이관" 하려 했으나, 그러면 매트릭스 linux 행과 **같은 사실이 2곳**이 되고 그 사본은 **생성물이 아닌 수기 파일**이라 FR-INSTALL.1 의 "생성되므로 구조적으로 어긋날 수 없음" 면제를 못 받는다 — 어떤 검증 축에도 안 걸려, #377 §3 이 근본원인으로 지목한 드리프트(base↔linux.json `depends` 상충)를 새로 하나 만드는 셈. 게다가 **repo 내 소비자 0 건(실측**: flatpak 매니페스트·package.json 스크립트·워크플로우 어디서도 미참조. 유일 언급인 `build-tooling-manifest.json` 엔트리는 `check-build-contract.mjs` 가 `tauri.conf*.json` 을 자동 발견해 등록을 강제한 결과일 뿐 빌드 경로가 아님**)** 이라 이관이 보전하는 것도 없다. → **`linux.json` 과 동일 규율로 외부 소비자 확인**(배포판 계층이 이 conf 를 참조하는지) 후, 소비자가 있으면 이관을 명시하고, 없으면 **무변경**(flatpak 은 NFR 범위 밖 — 부활 시 매트릭스에 flatpak 행을 추가하는 것이 이 설계의 결). 조용한 파손 금지 규율을 두 파일에 대칭 적용한다. package.json 은 `tauri:build:bundle` 1개로 통합, **`build-tooling-manifest.json` 정리 = 신규 진입점 등록(base `beforeBuildCommand=pnpm build` 포함) + 삭제되는 conf/스크립트의 기존 엔트리 제거**(stale note 포함) | S-INSTALL | `scripts/__tests__/platform-matrix.test.ts`(conf 생성 golden: 3 OS 각각 targets/resources/설치자 설정 기대형상·cascade-loader 유/무 분기·**생성물에 `build` 키 부재**·base 에 createUpdaterArtifacts 부재·**base resources 에 스테이징 산출 경로 0**·**생성 conf 의 mac icon = 배열 전체 형상**(배열 대체 시맨틱스 고정)·**`tauri-plugin-stt` `Cargo.toml` 의 `links` 키 실존**(vosk 빌드 순서 불변식)) [단위] · `check-build-contract.mjs` PASS [계약] · tsc |
| **FR-INSTALL.3** | **번들 node 런타임 탐색 크로스플랫폼화** (Rust). 현행 `lib.rs` 의 agent·BGM spawn 이 `#[cfg(windows)]` 인라인으로만 resource_dir 의 `node.exe` 를 찾음 → 3 OS 공통 "resource_dir 번들 node 우선, 시스템 폴백" 으로 통일(platform 모듈 경유, 죽은 `find_bundled_node`(호출자 0) 정리 포함). 기존 폴백 체인(PATH→nvm/fnm→OS별 well-known)·`NAIA_AGENT_PATH` 최우선은 보존. **확정된 node 경로를 `log_both` 로 기록**(`[Naia] node = <절대경로>` — `log_both` 는 `debug_assertions` 게이트가 없어 release 에서도 파일에 남는다). 이 줄이 FR-INSTALL.4·5 스모크의 판정 근거다(**R5** — "떴는가" 가 아니라 **"무엇으로 떴는가"** 를 관측해야 번들 분기가 증명된다). **파일 줄 형식(R8 — 판정 술어의 전제. 실측)**: `log_both` 는 stderr 에는 원문을 내지만 **파일에는 `log_to_file` 이 유닉스 초 접두를 붙여** `[<unix_secs>] [Naia] node = <경로>` 로 남긴다. 따라서 판정은 **`^\[[0-9]+\] \[Naia\] node = ` 정규식**(또는 `[Naia] node = ` **포함** 매칭)으로 한다 — `[Naia]` 를 줄 **앵커(`^`)** 로 잡으면 매치가 **0건**이 되어 아래 전칭 판정이 **공허참으로 항상 green** 이 된다(실측: 앵커 0건 vs 포함 67건). 같은 이유로 세션 구분자도 "`[Naia] === Session started ===` **를 포함하는** 마지막 줄" 로 읽는다. **줄 수·값의 정의(R6 개정)**: node 를 해석하는 스폰 지점은 **둘**이고(`spawn_agent_core` + BGM 서버) `NAIA_MINIMAL` 미설정 기본 부팅에서 **둘 다 무조건 실행**되므로 **부팅당 2줄**이 나온다 — **스폰마다 1줄**, 값은 **env 오버라이드(`NAIA_AGENT_PATH` 등)를 포함한 최종 확정 경로**(폴백 체인의 산출물이 아니라 실제로 spawn 에 쓰인 값. env 가 설정된 실행에서 줄이 누락되지 않도록 로그 지점은 폴백 클로저 **바깥**). **검증 한계 명시(정직)**: e2e-tauri 는 debug 바이너리라 resource_dir 에 번들 node 가 없어 **폴백 경로 무회귀만** 증명 — 신설 번들 분기의 실행 증명은 FR-INSTALL.4(win 설치본)·FR-INSTALL.5(linux 설치본)가 담당 | S-INSTALL | cargo build · 번들 node 해석 순서 단위(경로 해석 함수 분리로 테스트 가능하게) · e2e-tauri(실 Rust: agent 핸드셰이크 — 폴백 무회귀) · **번들 분기 실행 증명 = FR-INSTALL.4/5 로 위임(명시)** |
| **FR-INSTALL.4** | **Windows 설치 실측** — clean 상태에서 `tauri:build:bundle` → NSIS+MSI 산출 → **NSIS** 무인 설치(`/S`, currentUser, 관리자 불요) → **설치본 실행 파일로 기동 + 에이전트 핸드셰이크 확인**(e2e-tauri `TAURI_BINARY` env 오버라이드 신설 — 현행 debug 경로 하드코딩 해소). **판정은 FR-INSTALL.5 와 동형의 2조건(R6 개정)**: 핸드셰이크만으로는 *어느* node 로 떴는지 증명하지 못하는데, 하필 이 실측 머신은 정의상 빌드 머신이라 시스템 node 가 반드시 있어(빌드 전제조건) PATH 폴백이 성공하면 그대로 green 이 된다 — `node.exe` 동봉이 #377 의 출발점인데 Windows 번들 분기만 검증축 밖에 남는 셈. 따라서 ① 핸드셰이크 **AND** ② 설치본 로그(사용자 홈 아래 `.naia/logs/naia.log`)에서 `[Naia] node = ` 를 **포함하는 줄이 최소 2줄 AND 그 줄들이 전부** 설치본 resource_dir(= NSIS `$INSTDIR`) 하위일 것(**R8 — 개수 하한 필수**: 전칭은 0줄이면 공허참이라 그대로 두면 이 게이트가 조용히 green 이 되는데, Linux 와 달리 Windows 에는 그 공허참을 잡아 줄 mutation probe 가 없어 **여기가 Windows 번들 분기의 유일한 축**이다) — **FR-INSTALL.5 와 동일한 세션 스코프를 적용한다(R7 필수)**: 이 로그는 누적 파일이고 이 머신은 정의상 빌드 머신이라 `tauri dev`·e2e-tauri 가 남긴 시스템 node 줄이 이미 들어 있다 → 스코프 없이는 정상 설치본도 red. **마지막 `[Naia] === Session started ===` 이후 줄만** 판정한다. MSI 는 산출·실존 확인까지(WiX MSI = perMachine/관리자 승격이 표준 — per-user 무인 실측은 NSIS 담당). **순수 Windows(WSL 불요) 불변**: 빌드·설치·런타임 전 구간에 WSL/POSIX 셸 의존 금지 — 허용 외부 도구 = OS 기본 제공(curl·tar), tauri CLI 가 스스로 관리하는 번들러 도구(NSIS/WiX 자동 다운로드), **VS 부속 도구(vswhere — VS C++ 빌드도구가 이미 빌드 전제조건이라 신규 의존 아님)**까지 | S-INSTALL | 실 빌드 산출물(.exe/.msi 실존+크기) · NSIS 무인 설치 후 설치본 기동 스모크 = **기동+핸드셰이크 AND `[Naia] node = ` 포함 줄이 최소 2줄 AND 전부 `$INSTDIR` 하위**(R6/R8 — Windows 번들 분기 실행 증명. 판정 범위 = 마지막 `=== Session started ===` 포함 줄 이후. 그 외 dev 환경 가정 오염 금지) |
| **FR-INSTALL.5** | **CI 3 OS 빌드+설치 증명** — `.github/workflows/build-installers.yml`: windows/ubuntu/macos-latest 매트릭스, **push/수동 트리거만**(fork PR 제외 — 보안), naia-agent(공개) sibling clone, cascade-loader 는 optional 경로(private repo — 시크릿 없이 skip+로그), 산출물 artifact 업로드. **ubuntu job 은 빌드에 더해 deb 설치 → xvfb 기동 스모크**(번들 node 실사용 증명 — linux 미실측 공백 해소). **스모크 성공 판정(R5 개정 — 2조건 AND)**: 설치본 바이너리를 xvfb 아래 기동 → **120초 내** 셸 로그(사용자 홈 아래 `.naia/logs/naia.log`)에 ① 마커 `[Naia] agent-core gRPC @` 출현(gRPC 준비 핸드셰이크 — 자식 stdout 의 `GRPC_LISTENING` 을 실제 수신한 **뒤에만** 방출되므로 node 스폰 실패 시 나올 수 없음) **AND** ② `[Naia] node = ` 를 **포함하는 줄이 최소 2줄**(FR-INSTALL.3 의 부팅당 2줄 — agent·BGM) **AND** 그 줄들의 경로가 **전부 설치본 resource_dir 하위** = green. **개수 하한이 AND 로 붙는 이유(R8)**: 전칭("전부 … 하위")은 대상이 0줄이면 **참**이라, 로그 접두사 드리프트나 폴백 클로저 안쪽 기록 같은 이유로 줄이 사라지면 ② 가 공허참으로 green 이 되고 ①(핸드셰이크)만 남는데 그건 R6 가 폐기한 상태 그대로다 — 하한을 못 박으면 공허참이 원리적으로 불가능해진다. **"정확히" 가 아니라 "최소" 인 이유(R8 자체 교정)**: `restart_agent` 가 `spawn_agent_core` 를 재호출하면 node 를 다시 해석해 **3번째 줄**이 나온다(실측) — 상한을 박으면 재시작이 일어난 실행에서 정상 설치본이 거짓 red 가 된다. 하한 + 전칭이면 공허참도 부분 누출도 잡으면서 오탐이 없다. 하나라도 불충족·프로세스 조기 종료 = red(**R6**: "하나라도 하위" 가 아니라 **전부** — 그래야 BGM 만 시스템 node 로 새어도 red 가 된다). **판정 범위 = 이번 부팅의 줄만(R7 필수 — 세션 스코프)**: `naia.log` 는 `append` 전용 **머신 단위 누적 파일**이라(절단·회전 코드 0건) 이전 부팅들의 시스템 node 줄이 그대로 남아 있다 — 스코프가 없으면 ② 는 **정상 설치본에서도 영구히 red** 이고, 같은 job 안에서 도는 mutation probe 가 스모크보다 먼저 실행되면 그 줄이 섞여 **실행 순서에 판정이 좌우**된다. 따라서 **파일의 마지막 `[Naia] === Session started ===` 이후 줄만** 대상으로 한다(이 구분자는 setup 최상단에서 방출되어 두 spawn 보다 항상 선행 — 실측). 로그 파일 삭제로 대신하지 않는다(빌드 머신의 사용자 로그를 파괴하므로). 창 생존만으론 번들 node 를 증명하지 못하므로(에이전트 스폰 실패해도 창은 뜸) 로그 관측 기준이며, `NAIA_MINIMAL` 미설정 기본 부팅에서 스폰이 무조건 일어나는 것이 전제(CI job env 에 해당 변수 부재). **"PATH 에서 node 제거" 에 의존하지 않는다(R5 — 구설계 폐기)**: unix 폴백은 PATH 와 무관하게 사용자 홈 아래 `.nvm/versions/node` 를 **직접 디렉토리 스캔**하므로 PATH 만 끊는 것은 폴백을 차단하지 못한다. 현 GitHub 러너 이미지는 그 디렉토리가 비어 있어(`nvm alias default system`) 우연히 통과하지만, 그러면 **판정력이 외부 러너 이미지에 위탁**되어 이미지가 바뀌는 날 조용히 무력화된다. 더구나 FR-INSTALL.3 이 번들 node 를 **최우선**으로 두므로 PATH 제거는 정상 경로에 애초에 아무 영향이 없다 — 그래서 관측 대상을 ②(실제 사용된 경로)로 바꾼다. **자기 검증(mutation probe)**: 번들 node 를 일부러 제거한 실행 1회가 **red 가 되는지** CI 에서 확인 — 폴백이 하나 늘어도 게이트가 조용히 통과하지 않음을 증명(FR-INSTALL.6 의 부정 케이스 정신과 동일). **mac = arm64 전용·미서명·미공증 정직 표기**(`macos-latest` = arm64 러너 → `process.arch`=arm64 → darwin-arm64 node + arm64 호스트 타깃 = **Apple Silicon 전용 산출물, Intel Mac 몫 없음**. Intel 은 `macos-*-intel` 라벨 추가가 필요하며 후속. 우클릭 열기 필요) — 서명/updater `.sig` 는 범위 밖(별도 결정) | S-INSTALL | CI 3 job 전부 green + artifact 실존 · ubuntu 설치+기동 스모크 green(마커 **AND** node 줄 최소 2줄 **AND** 그 경로가 전부 resource_dir 하위 — 세션 스코프 적용) + mutation probe red 확인 (mac 완료선 = **arm64** 빌드 성공, 실기기 설치는 미보유 정직 표기) |
| **FR-INSTALL.6** | **산출물 검증 스크립트 1개** `scripts/verify-artifacts.mjs`(3 OS 공통, OS 분기=매트릭스 — **R5: 경로·파일명 확정**, 미지정 시 구현자 분기): 매트릭스 OS 행의 **`artifacts`(FR-INSTALL.1 — glob + minBytes)** 를 읽어 ① 각 glob 이 **정확히 1개 이상** 매치 ② 매치된 파일이 `minBytes` 이상 ③ SHA256 을 **stdout + `artifacts.sha256` 파일**로 기록(CI 는 이 파일을 artifact 로 함께 업로드 — 현 범위의 소비자는 사람의 사후 대조이며, 자동 비교는 하지 않음을 명시). `minBytes` 가 null 이면 **명확한 에러로 중단**(임계 미정 = red, 조용한 통과 금지). CI 각 job 말미 + 빌드 머신에서 동일 실행. **판정 로직은 주입 가능한 순수 함수로 분리(R8 — FR-INSTALL.2 의 conf 생성기와 같은 제약)**: `verifyArtifacts({ bundleDir, artifacts })` 로 번들 루트와 매트릭스 행을 **인자로 받고**, CLI 진입점은 이를 호출만 한다. 이 저장소의 동류 스크립트는 경로를 `import.meta.url` 기준으로 자기 고정하는 관례라(`check-build-contract.mjs` 선례), 그대로 두면 부정 케이스 테스트가 실 번들을 건드리거나 **판정 로직을 재구현**하는 수밖에 없다 — 재구현하면 실제 스크립트가 glob 0 매치를 건너뛰거나 크기 비교 부호를 뒤집어도 테스트는 **영원히 green** 이라 이 FR 의 목적("항상 통과 스크립트" 차단)이 정확히 무력화된다. 부정 테스트는 **이 함수를 import** 해 임시 디렉토리 픽스처(빈 디렉토리 / minBytes 미만 파일)로 구동한다 — 재구현 금지. **자기 검증 포함**: 부정(negative) 케이스 단위 테스트(산출물 부재/과소 크기 → red)로 "항상 통과 스크립트" 차단 | S-INSTALL | 검증 스크립트 실행(Windows 빌드 머신 + CI 3 OS) + **부정 케이스 단위 테스트** `scripts/__tests__/verify-artifacts.test.ts`(부재·과소 크기→red. 경로 근거 = FR-INSTALL.2 의 `src-tauri/**` vitest 미수집 실측) |
| **FR-CLI.1** | 설치 표면의 `naia` 명령은 기존 `naia-shell` 실행 파일을 가리키는 얇은 alias여야 하며 실행 파일·업데이터 식별자는 개명하지 않는다. gateway 모니터 명령은 별도 이름으로 이관한다. | UC-CLI-OPEN | 3 OS 설치 산출물 alias/PATH 검사와 gateway 참조 전수 검사 |
| **FR-CLI.2** | `naia <file>`은 호출 cwd 기준 상대 경로와 절대 경로를 정규화하고, 실존하는 일반 파일만 `workspace-open-file-request`로 전달한다. 실행 중인 셸은 포커스 후 열고, 콜드 스타트는 UI 준비 뒤 연다. | UC-CLI-OPEN | Rust 단위 + 네이티브 실행 중/콜드 스타트 인수 테스트 |
| **FR-CLI.3** | CLI 파일 열기는 기존 workspace `openFile` API를 재사용하며 파일 내용이나 경로를 로그·URL에 복제하지 않는다. 잘못된 인자는 셸 기동을 막지 않는다. | UC-CLI-OPEN | 프론트 이벤트 결선 테스트 + 오류/디렉터리/미존재 경로 부정 테스트 |

| **FR-INSTALL.7** | **macOS Universal Binary 배포** — 동일 커밋을 GitHub Actions `macos-15-intel`(`x86_64`)과 `macos-15`(`arm64`)에서 정규 `tauri:build:bundle`로 각각 빌드한다. 공통 경로의 일반 파일은 SHA256이 같아야 하고, 공통 경로의 아키텍처별 Mach-O(최상위 Tauri 실행 파일, 번들 Node, 네이티브 `.node`/동적 라이브러리 포함)는 `lipo -create`로 병합한다. `darwin-x64`/`darwin-arm64`처럼 경로 자체가 런타임 선택 아키텍처를 명시하는 네이티브 payload만 해당 slice의 thin Mach-O와 한쪽 번들 전용 파일을 허용해 양쪽을 함께 보존한다. 그 외 한쪽 전용 파일·thin Mach-O·경로와 slice가 불일치하는 파일은 산출을 중단한다. 기존 아키텍처별 app/dmg 산출물은 보존한다. Intel 실기기에서는 x86_64 앱의 agent-core/BGM 핸드셰이크와 번들 Node 실제 사용을 검증하며, Apple Silicon 실기기 실행은 별도 출시 증거 없이는 완료로 주장하지 않는다. | S-MAC-UNIVERSAL | `assemble-macos-universal.test.ts` 부정 계약 + Intel 설치본 스모크 + CI 두 아키텍처 빌드·재귀 병합·전체 Mach-O `lipo -archs` 검증 |

> NFR: **NFR-noWSL(불변)** — 빌드·설치·런타임 어느 구간에도 WSL 요구 금지(현행 0건을 요구사항으로 고정). · NFR-honesty — 미실측(mac 실기기)·미서명을 문서와 산출물 설명에 그대로 표기, "지원" 위장 금지. · 재현성 = "사람 기억에 의존하는 수동 단계 0". ⚠️ 범위 밖(별도 이슈로 후속): 코드 서명(win 인증서·mac 공증), updater `.sig` 생성/키, **updater endpoint stale**(base conf 가 폐기된 `nextain/naia-os` releases 를 가리킴 — 설치본 첫 실행 시 죽은 endpoint 조회, 후속 이슈로 교정), flatpak 경로, `WslSetupScreen` 죽은 레거시 삭제(기존 DEFER 유지).

> **FR-INSTALL.2 P3 실측 보강(2026-07-18)**: 필수 스테이징은 agent뿐 아니라 셸 소유 BGM
> sidecar도 포함한다. `stage-bgm-sidecar.mjs`가 prod-hoisted `dist`·`package.json`·`node_modules`를
> 생성하고 매트릭스 공통 리소스로 동봉한다. `stage-agent.mjs`는 TypeScript가 복사하지 않는
> `naia_agent.proto`를 compiled gRPC module 옆에 복사하고 실존을 게이트한다. 두 항목 모두 설치본
> 핸드셰이크 실측에서 발견된 배포 계약이며 dev 상대경로 폴백으로 대체하지 않는다.
>
> **FR-INSTALL.2 #411·#412 보강(2026-08-02):** `stage-agent.mjs`와 `tauri-with-mode.mjs`는
> 공통 `package-manager.mjs`를 사용해 각 대상 프로젝트의
> `package.json#packageManager`를 읽어 선언된 pnpm 버전을 Corepack으로 고정 실행한다.
> 선언이 없는 기존 로컬 의존 프로젝트는 현재 pnpm을 사용하고, pnpm 외 값이나 유효하지 않은
> 버전은 명확히 중단한다. install/build/deploy는 `CI=true` 비대화식 모드로 실행해 서로 다른
> pnpm major의 `node_modules` 교체가 TTY 질문으로 정지하지 않아야 하며, dev 시작도 같은 resolver를
> 거쳐 paired Agent의 stale/missing `dist`를 빌드한 뒤에만 Tauri를 실행한다.
>
> **clean-runner 보강(2026-07-18)**: `naia-agent`의 production 의존성인 공개
> `naia-kb-compiler`·`naia-memory`도 정규 alpha-adk 레이아웃에 clone한 뒤 agent보다 먼저
> install/build하고 산출물을 확인한다. 셸 TypeScript 빌드 전에 루트
> `@nextain/naia-os-core`도 stage-runtime이 직접 빌드한다. 따라서 로컬에 우연히 남은 세 저장소의
> `dist/`가 없어도 단일 `tauri:build:bundle` 명령이 같은 순서로 재현된다.

## 기능 요구사항 (FR) — 로컬 cascade 임베딩 (Round 2, 멀티레포 — 2026-06-30)

> 범위: naia-shell 이 windows-manager loader를 **로컬 사이드카로 기동/감독/종료**(원격 금지). 계약: naia-shell 이 slots-manifest.json write → loader가 read + VRAM 예산 판정 → 서비스(VoxCPM2 등) spawn·supervise → stdout `CASCADE_READY {json}`. 트랙: `.agents/progress/naia-os-local-cascade-embedding-round2-2026-06-30.md`. R2.1=windows-manager(1756f4b), R2.2=naia-shell(본 커밋).

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-CASCADE.1** | windows-manager loader `launch` = plan→실제 서비스 spawn + 블로킹 슈퍼바이저(readiness 후 stdout `CASCADE_READY {json}`, 자식 사망/kill 시 teardown) + `plan --json`(naia-shell 소비) | S-CASCADE | windows-manager `tests/test_launcher.py`(9건) |
| **FR-CASCADE.2** | naia-shell 이 설정 저장 시 `{adk}/naia-settings/slots-manifest.json` write(`buildSlotsManifest`, 비밀 0). Rust `write_slots_manifest` + adk-store `writeSlotsManifest`(writeNaiaConfig 동기) | S-CASCADE | `slots/manifest` 단위 · tsc |
| **FR-CASCADE.3** | naia-shell Rust가 loader supervisor를 사이드카로 관리: `start_cascade`(detect VRAM total→`--gpu`, manifest 경유 launch, `CASCADE_READY` 핸드셰이크)·`stop_cascade`·`cascade_status`. CascadeProcess(Drop kill)+WindowEvent cleanup+PID. agent/BGM 패턴 복제 | S-CASCADE·UC12 | cargo check · 설정 토글 UI(`cascade-toggle`) |
| **FR-CASCADE.4** | 설정 음성 탭에 로컬 음성 엔진 시작/중지 토글(naia-local-voice 선택 시). 기동 직전 manifest 동기화 | S-CASCADE | `SettingsTab` · tsc |

> NFR: F1(RTF measurement-gated — VRAM 적합≠실시간 보장). 과거 “8GB 음성 단독” DEFER는 #397로 폐기됐다. 현재 8GB 경로는 VoxCPM2 W8A16 + TensorRT LocDiT와 Ditto를 half-duplex로 실행한다. Windows 강제종료 고아 하드닝(job object/PID stale-kill)은 후속이다.

## 기능 요구사항 (FR) — 과거 8G 로컬 GPU 재티어링 기록 + 원격 cascade 연결 (2026-07-08, Windows 정책은 #397로 대체)

> **역사적 기록:** 이 절의 8GB 배타 3모드와 “음성은 항상 클라우드” 전제는 Windows `windows_trt_8g`에 적용하지 않는다. 현재 Windows 계약은 FR-CASCADE.9~14와 [`windows-8gb-nva.md`](windows-8gb-nva.md)다. 원격 cascade URL(T3) 계약과 일반 capability 게이트에 관한 항목만 별도 기능으로 유효하다.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-VRAM-LEGACY.2** (비규범 이력, 구 spec FR-5) | 과거 `local-llm-avatar-8g`의 llm/avatar/both 3모드와 8GB 음성 클라우드 전용 설계. Windows `windows_trt_8g`에는 적용하지 않으며 UI 마이그레이션 입력으로만 남는다. | 역사 기록 | 현재 요구사항은 FR-CASCADE.9~14 참조 |
| **FR-VRAM.6** | **VRAM 프리플라이트 폴백** — `fitLocalCapabilitiesToVram(caps, freeVramGb, margin)` 이 free VRAM 부족 시 로컬 LLM→클라우드 강등(`llmFallbackToCloud`) + UI 정직 경고(`local-llm-vram-fallback`). 프라이버시 위장 금지(강등을 로컬로 표기 안 함) | S-VRAM8G | `vram-tiers.test.ts`(fit 폴백)·`capability-settings.spec.ts`(fallback 배지) |
| **FR-CASCADE.5** (spec FR-6) | 비디오 아바타 립싱크 노트 — 아바타 탭에서 naia-video-avatar 선택 + TTS off 시 경고(`nva-lipsync-note`, 립싱크엔 TTS 필요). 과거 8GB 음성-cloud 전용 안내는 `windows_trt_8g`에 적용하지 않는다. | S-AVATAR8G | `capability-settings.spec.ts`(FR-6) |
| **FR-CASCADE.6** (spec FR-7) | 비디오 아바타는 **cascade capability(명시적 로컬 avatar profile or 로그인) 게이트** — 로컬 프로파일이 avatar 미제공(저티어/off/legacy `auto`)이고 로그인도 없으면 video-avatar 옵션 비활성 + 안내(`avatar-cascade-required`). 로그아웃이어도 명시된 로컬 avatar-capable profile은 로컬 NVA 선택 가능하며, 원격 Host URL은 FR-CASCADE.7에 따라 로그인 전용이다. | S-AVATAR8G·UC12 | `capability-settings.spec.ts`(FR-7 게이트·로그아웃 교차·로컬 avatar profile·legacy auto 잠금) |
| **FR-CASCADE.7** (spec FR-8) | **NVA BYO 원격 cascade 소스(T3)** — 로그인 사용자가 직접 운영하거나 별도로 제공받은 `cascadeRuntimeUrl`을 지정한다. 이는 향후 Nextain cloud cascade 서비스와 별개이며 현재 cloud entitlement·endpoint·자동 폴백을 뜻하지 않는다. 명시한 Host가 로컬 façade보다 우선하고 원격 장애로 로컬 Ditto를 암묵 기동하지 않는다. | S-CASCADE-T3·UC12 | `config.test.ts` · `capability-settings.spec.ts` · `nva-remote-idle.live.spec.ts` |
| **FR-CASCADE.8** | **원격 NVA 결합 발화·투명성 계약** — 명시한 원격 NVA Host는 `/stream_text`에서 서버가 합성한 음성과 아바타 영상을 함께 반환하며, Shell은 별도 로컬 TTS를 중복 재생하지 않는다. 로컬 음성 + 아바타 분리 경로는 기존대로 로컬 음성을 재생하고 원격 `/stream` 영상은 음소거한다. 투명 배경은 cascade가 VP9 `yuva420p` 알파 영상을 제공할 때만 성립하며, 불투명 H.264를 클라이언트에서 투명하다고 위장하지 않는다. | S-CASCADE-T3·UC-AV | `cascade-renderer.test.ts`(muxed/unmuted·split/muted 렌더)·`nva-remote-idle.live.spec.ts`(실 원격 idle/stream) |
| **FR-CASCADE.9** (#397, supersedes the Windows 8GB parts of FR-VRAM.5 and the 8GB focus assumptions above) | Windows local profile `laptop-4060-8g` is compatibility UI identity only. Its canonical loader profile name is `windows_trt_8g`, and its only local capabilities are VoxCPM2 W8A16 + FP16 TensorRT LocDiT TTS and TensorRT-native Ditto avatar (planned footprint 6.30GB). It never selects, installs, or launches a local LLM, Ollama, or NPU runtime. Real-time performance is not a support gate. VoxCPM2 전체 모델 TensorRT는 범위 밖이며 LocDiT 경계만 구현된 것으로 표기한다. | UC-WIN-NVA-8G | `vram-tiers.test.ts`, slots manifest contract, windows-manager profile/manifest tests |
| **FR-CASCADE.10** | Selecting or restoring the Windows 8GB profile preserves the complete external main-LLM route: provider, model, API/Naia account route, and a user-configured remote Ollama host. Only TTS, TTS façade host when local/empty, avatar provider, and NVA bundle may be staged locally. | UC-WIN-NVA-8G | `SettingsTab.test.tsx` provider/model/remote-host preservation and config migration tests |
| **FR-CASCADE.11** | NVA local avatar requires a detected, supported NVIDIA GPU with **VRAM 8GB or more**. A detected value below 8GB or an unknown value disables the NVA option. Legacy 6GB tiers and manual overrides must not bypass that result. The Shell prevents manifest loader-profile emission and `start_cascade`, and renders VRM instead of a stale NVA config. | UC-WIN-NVA-8G | `vram-tiers.test.ts`, `nva-gate.test.ts`, `capability-settings.spec.ts`, Rust start guard/Tauri test |
| **FR-CASCADE.12** | NVA Player rendering is independent from VoxCPM2/Ditto readiness. It loads the selected local `.nva` bundle manifest and default idle clip first. `initializing`, `ready`, `failed`, and `retrying` cascade states are accessible status overlays; they do not replace or blank an already available idle avatar. Retry is explicit and idempotent. | UC-WIN-NVA-8G | `VideoAvatarCanvas.test.tsx`, `nva-player-initialization.spec.ts`, Tauri idle→cascade observation |
| **FR-CASCADE.13** | Profile and Avatar menus display the capability-level requirement: “NVA local avatar requires a supported NVIDIA GPU with at least 8GB VRAM.” Product labels do not expose CUDA, INT8, TensorRT, VoxCPM2, or Ditto implementation names. This is a minimum gate, not a guarantee for every NVIDIA model; current release verification remains RTX 30/40-series hardware. | UC-WIN-NVA-8G | i18n key coverage, SettingsTab unit + Playwright text assertions |

> **FR-CASCADE #413 secure-auth restore (2026-08-02):** `naiaKey` is intentionally absent from public config. NVA rendering, local profile gating, and slots-manifest derivation must restore membership from the secure store. A normal config/UI sync must not overwrite an authenticated `gate.naiaAccount=true` manifest with a public-config false negative. Native `start_cascade` still verifies both manifest membership and the stored credential.
| **FR-CASCADE.14** | The Shell states that a cloud cascade service will be provided separately in the future. It is an informational coming-later notice only: no cloud endpoint, availability, fallback, or current entitlement may be inferred or started from this release. | UC-WIN-NVA-8G | SettingsTab/Onboarding text assertions and no-network negative test |
| **FR-CASCADE.15** ([alpha-adk #14](https://github.com/nextain/alpha-adk/issues/14), REQ-NVA-LAT-001) | Windows TRT 지연은 같은 텍스트·음성지문·NVA·warm 상태에서 요청 수신→첫 오디오 바이트, 첫 미디어 바이트, 첫 Shell 발화 프레임, 전체 음성·영상 완료, A/V 종료 시각 차이, 취소→하위 작업 회수 시간을 각각 기록한다. 측정값 없이 실시간 또는 개선을 주장하지 않는다. | UC-WIN-NVA-LATENCY | 서비스 계측 로그 + Tauri 94 전후 결과 |
| **FR-CASCADE.16** (REQ-NVA-LAT-002) | Ditto TRT는 렌더를 한 건만 허용한다. 렌더 중 들어온 `/stream`, `/stream_pcm`, `/stream_pcm_raw` 요청은 GPU lock 뒤에서 대기하지 않고 즉시 HTTP `429`와 양의 `Retry-After`를 반환한다. 현재 요청이 끝나거나 소비자가 연결을 끊으면 슬롯을 반드시 회수한다. | UC-WIN-NVA-LATENCY | labs admission 단위/HTTP 테스트 + 연속 요청 회수 테스트 |
| **FR-CASCADE.17** (REQ-NVA-LAT-003) | `windows_trt_8g` manager 프로파일은 Ditto의 검증 대상 최대 렌더 크기를 명시적으로 주입한다. Shell이 화면 크기에 맞춰 확대·합성하며, 렌더 크기 변경은 같은 조건의 실제 RTF·첫 프레임 측정으로 효과와 화질을 확인하기 전 전체 RTX 지원 사실로 일반화하지 않는다. | UC-WIN-NVA-LATENCY | manager `test_service_plan.py` + 실제 NVA 화면 비교 |
| **FR-CASCADE.18** (REQ-NVA-LAT-004) | `video/mp4` 응답은 MSE가 전체 HTTP 응답 완료 전에 첫 재생 가능한 프래그먼트를 append하고 재생할 수 있을 때만 조기 재생 최적화로 인정한다. ffmpeg가 오디오 EOF까지 출력을 보류하면 기존 완결 경로를 유지하고 개선으로 기록하지 않는다. | UC-WIN-NVA-LATENCY | Shell MSE 단위/FE + 서비스 첫 `moof` 시각 계측 |
| **FR-CASCADE.19** (REQ-NVA-LAT-005~006) | Shell의 발화 중단·새 발화·renderer 종료는 진행 중 fetch body reader를 취소하는 것에 그치지 않고 요청 AbortSignal로 연결을 닫는다. cascade/Ditto는 연결 종료를 렌더 중단으로 처리해 ffmpeg와 GPU 슬롯을 회수하며, Shell은 NVA idle과 정직한 상태 표시를 유지한다. | UC-WIN-NVA-LATENCY | `cascade-renderer` Abort 테스트, cascade adapter 취소 테스트, labs 슬롯 회수 테스트, Tauri 94 |
| **FR-CASCADE.20** (#406) | Windows `windows-voice-6g` tier는 물리 VRAM 6GB 이상에서 canonical loader profile `windows_trt_6g`를 사용한다. 외부 LLM route를 보존하고 로컬에는 VoxCPM2 W8A16 + TensorRT LocDiT TTS와 음성 전용 façade만 둔다. Ditto/NVA/로컬 LLM/Ollama/NPU/STT는 실행하지 않고 Shell 3D VRM을 사용한다. 실시간은 지원 조건이 아니며 실제 6GB cold boot는 실측 게이트다. | UC-WIN-VOICE-6G | tier/manifest/manager plan tests, actual cold-start probe |
| **FR-CASCADE.21** (#406) | 모든 하드웨어 프로파일은 등록된 Naia 회원 로그인 후에만 선택·복원·기동할 수 있다. 로그아웃은 cascade를 중지하고 manifest의 tier/loaderProfile을 제거한다. Rust `start_cascade`도 `gate.naiaAccount=true`가 아니면 cached-ready 상태를 포함해 fail-closed로 거부한다. | UC-WIN-VOICE-6G·UC-WIN-NVA-8G | Settings/manifest/NVA gate/Rust account tests |
| **FR-CASCADE.22** (#406) | 6GB TTS는 CPU에서 W8A16 양자화를 완료한 뒤 CUDA로 이동하고 plain-attribute KV cache를 대상 device에 다시 만든다. 이는 full-BF16 CUDA 선적재 peak를 제거하기 위한 cold-start 계약이며, warm peak·첫 발화·반복 발화·오류 누적은 실제 Shell 통합 테스트로 기록한다. | UC-WIN-VOICE-6G | `test_voxcpm2_int8.py`, manager service env, Shell Tauri integration |

> NFR: **NFR-voiceprint(불변)** — Naia가 VoxCPM2를 쓸 때 **음성지문(ref voiceprint)은 필수**이며 무지문 합성을 허용하지 않는다. 이 원칙은 Windows 8GB 로컬 VoxCPM2 W8A16 + TensorRT LocDiT에도 적용된다. · NFR-honesty(백엔드·VRAM 강등 위장 금지) · F1(measurement-gated, 측정 없이 실시간·개선 단정 금지) · NFR-no-conversation-cache(대화형 Shell/cascade의 완성 A/V 응답 캐시 금지; 반복 콘텐츠 TalkingKiosk와 분리). ⚠️ in-shell WSL cascade 부트스트랩은 구 gateway-in-WSL 아키텍처의 레거시다.

## 기능 요구사항 (FR) — 지식 근거→원문 칩 + 그래프 뷰어 (kb-compiler 통합 K2·K3, 셸 feature — 2026-06-30)

> 범위: naia-agent 지식 풀 도구(`skill_knowledge_ask`/`search`) tool-result(JSON)를 셸이 **답변 + 출처 칩**으로 렌더하고, 칩 클릭 시 **근거→원문**(URL=브라우저 앱 navigate / 파일=워크스페이스 openFile)으로 연다. 통합 설계 SoT = alpha-adk `.agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md`(K2). 백엔드(에이전트↔kb-compiler 배선·계약) = naia-agent UC-KNOWLEDGE(별 레포, live).
>
> **상태: Done (P04, 2026-06-30)** — 검증: `knowledge-result.test.ts`(파싱·출처분류·**그래프 파싱** 단위)·`knowledge-tool-result.test.tsx`(RTL 렌더+칩 dispatch)·`e2e/chat-tools.spec.ts` "지식 도구(K2)"·"**지식 그래프(K3)**"(Playwright 실 UI — 답변+칩+칩클릭→브라우저 앱 / 그래프 캔버스 렌더+2D/3D 토글). tsc0·셸 컴포넌트(src/main 밖→file-anchor 무대상).

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-KB-OS.1** | 지식 도구 tool-result(JSON) 파싱 — `ask`={abstained,answer,sources[{title,sourceUris}]}·`search`={hits[...]}. 형태불일치/비지식도구 = 기본 ToolActivity 렌더 폴백(무회귀) | UC-KNOWLEDGE(agent) | `knowledge-result.test.ts` |
| **FR-KB-OS.2** | 답변 + 출처 칩 렌더 — `ToolActivity` 가 지식 도구 분기 → `KnowledgeToolResult`(answer + sourceUris 칩). 기권 시 답변만(칩 0). 출처 sourceUris 보존(근거→원문 키) | UC-KNOWLEDGE | `knowledge-tool-result.test.tsx` |
| **FR-KB-OS.3** | 근거→원문 — 칩 클릭: URL=브라우저 앱 `navigate`+activate / 파일=워크스페이스 `openFile`(file:// 제거)+앱 전환. 기존 app api 재사용(신규 앱 불요) | UC-KNOWLEDGE | `knowledge-tool-result.test.tsx`·`e2e/chat-tools.spec.ts`(지식 도구 K2) |
| **FR-KB-OS.4** (K3) | 지식 그래프 2D/3D 시각화 — `ToolActivity` 가 `skill_knowledge_graph` tool-result(nodes/edges+deg+군집) 분기 → `KnowledgeGraphView`(캔버스 force, 군집색·degree 크기, **2D↔3D 토글**, 원근+자동회전). 의존성 0(엔진 examples/cms 포팅). 파싱 실패=폴백 | UC-KNOWLEDGE(graph) | `knowledge-result.test.ts`(parseKnowledgeGraph)·`e2e/chat-tools.spec.ts`(지식 그래프 K3 — 캔버스 렌더+2D/3D 토글 실 UI) |

> NFR: NFR-isolation(지식 렌더 분기가 기존 도구 렌더 무회귀 — 파싱 실패 시 폴백)·NFR-reuse(브라우저/워크스페이스 앱 api 재사용·그래프 의존성 0 캔버스). 전용 그래프 앱(on-demand fetch) = post-MVP. 설정 지식 탭(관리 compile/소스) = 아래 K4.

## 기능 요구사항 (FR) — 지식 소스 관리 설정 탭 (kb-compiler 통합 K4, 셸 — 2026-06-30)

> 범위: 설정>지식 탭이 **"준비 중" placeholder 를 대체**해, 사용자가 **지식 소스(다중 폴더)·스코프**를 관리하고 **컴파일**을 트리거하는 관리면. 설정 정본 = `naia-settings/knowledge.json`(**셸만 쓰기, AI 에이전트 읽기전용** — config-write 도구 없음 = 신뢰경계 자가확장 차단). 컴파일 실행(폴더→kb.json)·답변(읽기)은 **naia-agent**(별 레포 — `CompileKnowledge` RPC·`openWorkspaceKnowledge`). 통합 설계 SoT = alpha-adk `.agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md`(K4).
>
> **상태: 진행 중 (P03→P04, 2026-06-30)** — 검증: `knowledge-config.test.ts`(config CRUD·kb 통계 파싱 단위)·`KnowledgeSettingsTab.test.tsx`(RTL 폴더 add/remove·상태 렌더)·`e2e/settings-knowledge.spec.ts`(Playwright 실 UI: 설정 지식 탭 폴더 추가/제거/상태). 컴파일 트리거(FR-KB-OS.8)는 에이전트 `CompileKnowledge` 배선에 의존.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-KB-OS.5** | 소스 폴더 레지스트리 — 다중 폴더 추가(폴더 선택 다이얼로그)/제거/목록. 정규화 dedup. `naia-settings/knowledge.json`(`{version,scope,sources[{path,label}]}`) 영속 — `read/write_naia_knowledge_config` Rust 커맨드(**셸 전용 write**) | UC-KB-MANAGE | `knowledge-config.test.ts`·`KnowledgeSettingsTab.test.tsx` |
| **FR-KB-OS.6** | 지식 스코프 표시 — 현 스코프(프로젝트, 기본 `default`) 표기. kb 정본 = `naia-settings/knowledge/<scope>/kb.json`(naia-adk). Shell은 이 경로를 읽어 상태만 표시하고 컴파일·저장 위치 결정은 Agent가 소유한다. | UC-KB-MANAGE | `knowledge-config.test.ts` |
| **FR-KB-OS.7** | 컴파일 상태 — `read_naia_knowledge_kb({adkPath,scope})` 로 kb.json envelope(`{version,kb}`) 통계(카드·엔티티·관계·accepted) 표시, 부재 = "미컴파일" | UC-KB-MANAGE | `knowledge-config.test.ts`(parseKbStats)·RTL |
| **FR-KB-OS.8** | 컴파일 트리거 — "지금 컴파일" → `compile_knowledge({adkPath})` → 에이전트 `CompileKnowledge`(sources→compile→kb.json) → 완료 후 상태 재조회. 실패 = 정직 표기(throw 차단·UI 무붕괴) | UC-KB-MANAGE | `KnowledgeSettingsTab.test.tsx`·`e2e/settings-knowledge.spec.ts` |
| **FR-KB-OS.9**(보안) | 설정 불가침 — `knowledge.json` 은 **셸 UI 만 기록**. 에이전트엔 config-write 도구 없음·파일 도구도 `naia-settings/` 쓰기 거부(별 레포 K-SEC). UI 입력은 AI 미경유(직접 `invoke`) | UC-KB-MANAGE | (계약: config-write 도구 부재) |
| **FR-KB-OS.10**(저장 경계) | Shell→Agent 경계는 선택된 `adkPath`와 사용자 설정만 전달한다. Shell은 memory store/project/knowledge output 경로를 생성하거나 환경변수로 주입하지 않는다. Agent가 `<adkPath>/naia-settings` 아래 제품 저장 경계를 강제하고 Shell은 compiled KB를 그 고정 경로에서 읽기만 한다. | UC-KB-MANAGE | Rust `read_naia_knowledge_kb` 테스트 + paired Agent integration |

> NFR: NFR-config-ownership(설정=사람/셸 소유, 에이전트 읽기전용 — FR-KB-OS.9)·NFR-isolation(컴파일 실패가 관리 UI 무붕괴)·NFR-reuse(`naia-settings` asset 커맨드·폴더 다이얼로그 기존 패턴 재사용).

## 기능 요구사항 (FR) — UI 재구성: 홈 몰입대화 + 워크스페이스 4단 관제탑 (#ui-reorg, 셸 feature — 2026-06-29)

> 범위: naia-shell 셸 UI(`App.tsx`·`ChatApp.tsx`·`WorkspaceCenterArea.tsx`·`Terminal.tsx`·`global.css` + 신규 `DocTabBar.tsx`). 사용자 실사용 피드백: "naia와 대화가 집중 안 됨 / 코딩 쓰기엔 좁음 / 터미널 여럿 + 문서 대량인데 작업문서 찾기 어려움". 트랙: alpha-adk `.agents/progress/naia-os-workspace-chat-reorg-2026-06-29.md`. 워크트리 `feat/ui-workspace-chat-reorg`.
>
> **상태: P04 GREEN (P05 대기 — process-status.json 갱신은 헌장이라 사용자 승인 후)** — tsc 0 · vitest 961 pass(1 fail=SettingsTab "Naia Voice" 선재, 무관) · e2e 91+120 18/18(무회귀) · e2e 119 신규 T6-T10 pass. 베이스 선재 플래키(T4/T5 터미널-생성 레이스)는 본 변경 무관(베이스 동일 실패 확인).

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-UI.1** | UI 모드는 **단일 신호**(`useAppStore.activeApp` 파생 `data-ui-mode`). `null`과 일반 앱은 왼쪽 소형 `app`, `workspace`는 왼쪽 채움 `workspace`를 사용한다. 중앙 `home` 선택은 제공하지 않고 저장된 `home`은 `app`으로 마이그레이션한다. | UC-ONBOARDING-APPEARANCE-VOICE·S-WS4 | `119` data-ui-mode + 레이아웃 버튼 |
| **FR-UI.2** | ChatApp은 **단일 인스턴스를 CSS로 재배치**(variant=rail/floating). 모드 전환·레일 접기에도 **언마운트 금지**(voice/STT/TTS 세션 연속성). 마운트 조건은 activeApp과 분리 | UC-ONBOARDING-APPEARANCE-VOICE·S-WS4 | `119` 레일 접기 시 `.chat-app` attached 유지 |
| **FR-UI.3** | 워크스페이스 왼쪽 통합 레일은 `[File Tree, Spaces, Agents]` 순서이며, Space 선택 시 오른쪽 전체 영역은 실제 Herdr terminal/tab/pane 작업면이다. Herdr의 중복 sidebar 표현만 Shell 전용 설정으로 숨긴다. | S-WS4 | 통합 rail/render 단위 + native visual/Tauri |
| **FR-UI.4** | Herdr의 파일 경로를 선택하면 File Tree가 활성화되어 경로를 펼치고 reveal/select하며 viewer가 line/column을 연다. viewer Back/닫기는 직전 Herdr pane과 terminal focus를 복원하고 File Tree root는 활성 Space worktree/CWD를 따른다. Quick Open과 문서 탭도 유지한다. | S-DOC | parser/root/FileTree/Editor 회귀 + alternate-screen native E2E |
| **FR-UI.5** | Agent 선택은 공개 API로 소유 workspace/tab/pane/terminal을 focus하고, Herdr 내부 workspace/tab/pane focus는 단일-flight snapshot polling으로 Spaces/Agents 선택 상태에 역동기화한다. 문서 탭 ✦ AI 질의는 유지한다. | S-WS4·S-ASK | snapshot poll reducer + focus command + multi-agent native E2E |
| **FR-UI.6** | 대화 레일 접힘 상태 **localStorage 영속**(`naia-ws-rail-collapsed`) | S-WS4 | `119` T8(토글 왕복) |
| **FR-HERDR.1** | Shell은 검증된 Workspace root에서 Herdr를 전용 PTY로 시작하며, Shell-owned `HERDR_CONFIG_PATH`는 사용자의 전역 설정을 바꾸지 않고 embedded client의 sidebar를 hidden collapsed 상태로 시작한다. 실행 인자·환경은 구조화되어 명령 문자열로 조합하지 않는다. | S-WS4 | Rust launch/env 계약 + frontend 단일 생성 + native Tauri |
| **FR-HERDR.2** | Herdr가 없거나 시작에 실패하거나 종료되면 성공/실행 중으로 가장하지 않고 원인을 노출하며 같은 화면에서 재시도할 수 있다. 재시도와 root 변경은 이전 PTY를 정리하고 중복 프로세스를 만들지 않는다. | S-WS4 | 준비·실패·종료·재시도·unmount/root-change 컴포넌트 테스트 |
| **FR-HERDR.3** | 기존 PTY·viewer·worktree·session 회귀 자산은 보존한다. Shell의 중복 session/agent UI와 lifecycle tools는 Herdr 공개 API의 동등 경로와 통합 증거가 생긴 뒤에만 active render/registration에서 단계적으로 retire한다. 테스트 삭제나 축소된 suite를 완료 증거로 삼지 않는다. | S-WS4·S-DOC | baseline preservation probe + full retained suite + descriptor/render negative |
| **FR-HERDR.4** | P1은 Herdr 0.8.0 public snapshot polling과 workspace/agent focus를 연결한다. Viewer 동안 실제 Herdr xterm을 계속 mount해 pane focus를 보존하고, P2는 path/FileTree/viewer 왕복을 제공한다. P3는 정책을 통과한 Naia observation/control/context bridge, P4는 L3→L2→L1 orchestration을 제공한다. raw PTY stdin이나 private TUI socket을 제어 API로 위장하지 않는다. | S-DOC·S-ASK | typed bridge 계약, 권한 negative, Shell↔Agent↔Herdr 통합 E2E |
| **NFR-HERDR-SOT** | L3 Naia/naia-agent는 사용자 의도와 이슈 포트폴리오를 조율하고, Herdr는 L2 이슈 리더와 L1 작업자의 터미널/pane/session 실행 정본이다. 같은 생명주기를 Shell 또는 Coding Workers가 중복 소유하지 않는다. | #417 + naia-agent #107 | 정적 중복 surface/tool 검사 + 통합 아키텍처 리뷰 |

> NFR: NFR-isolation(레이아웃 변경이 음성/세션·기존 워크스페이스 기능 안 깸 — 91+120 18/18 입증) · 토큰-only(테마 9종 호환, 하드코딩 색 금지) · 디자인 일관(`.ws-pane`/글래스 chrome). ⚠️ 미감(VN 톤·색감)=사용자 인지 몫(실 앱 확인).

## 기능 요구사항 — 자유·연속 발화 session stream (UC17, naia-agent #82)

> 상태: 기술 MVP Implemented(P03), #84 제품 수용 FR-CONT-SHELL.8~9 진행 중. 반복 활동 상태 기계는
> naia-agent가 소유하고 셸은 gRPC 전달·표현·정지만 담당한다.

| FR | 요구사항 | 검증(P02) | 상태 |
|---|---|---|:---:|
| **FR-CONT-SHELL.1** | agent 연결 뒤 persisted proactive profile을 `ConfigureSpeechProfile`로 전달하고, 비어 있지 않은 현재 session별 `SubscribeSpeechActivities` 장기 stream을 최대 하나 구독해 self-init `AgentEvent.request_id`, `activity_id`를 보존한다. | Rust contract + live gRPC | Implemented |
| **FR-CONT-SHELL.2** | activity `AgentEvent`를 기존 `agent_event_to_ui_json`→`agent_response` 경로로 보내 텍스트·usage·finish/error의 기존 표현 소비자를 재사용한다. 별도 event union·반복 상태 기계는 만들지 않는다. | Rust transcode + 기존 chat event 회귀 | Implemented |
| **FR-CONT-SHELL.3** | 자유 발화 cancel은 관측한 requestId+activityId를 agent `Cancel`에 돌려주고, activityId 관측 전 또는 session 명시 정지는 thin `StopSpeechActivity` command/RPC로 위임한다. requestGeneration은 requested Chat에만 사용하며 ordinary Chat cancel과 self-init activity cancel을 혼합하지 않는다. | Rust unary contract; native Tauri는 stop만 | Implemented |
| **FR-CONT-SHELL.7** | unsolicited activity는 ordinary Chat의 currentRequestId 필터와 별도 activity ref로 수용한다. 새 사용자 입력은 queue보다 먼저 `interruptTts → YieldSpeechActivity → activityResume 토큰을 실은 Chat` 순서로 처리하고, 이전 activityId/profileGeneration의 늦은 text/TTS를 폐기한다. quiet/stop은 Yield 대신 Stop을 사용한다. | ChatArea contract; native ordering은 미검증 | Implemented |
| **FR-CONT-SHELL.4** | subscriber disconnect/dispatcher 종료/agent 재시작에서 stream task와 client 자원을 정리한다. server가 해당 session active를 cancelled로 끝낼 수 있도록 stream을 실제 drop한다. | disconnect live test + watchdog | Implemented |
| **FR-CONT-SHELL.5** | 같은 session 중복 구독 0, 서로 다른 session은 독립 구독, 요청 기반 기존 Chat stream과 일반 cancel/event correlation 무회귀를 보장한다. | duplicate/session isolation + existing Chat tests | Implemented |
| **FR-CONT-SHELL.8** | 일반 설정에서 proactive profile·idle·멘트 간격·timezone·BGM opt-in·날씨 동의·위도·경도·전시 knowledgeScope를 편집해 file-backed UI config에 저장한다. timezone/좌표/scope를 검증하고 날씨 미동의·철회면 좌표를 저장하거나 agent로 보내지 않는다. | unit/RTL + native `71`: 파일 원문 확인→renderer cache 제거→WebView reload→파일 복원·wire capture | Implemented |
| **FR-CONT-SHELL.9** | proactive text는 browser/synthesized TTS 소비선을 각각 호출한다. music-only/talk-less/talk-more/change-vibe/next/stop 및 ordinary chat 끼어들기에서 250ms 안에 TTS를 먼저 취소한다. Configure ACK와 subscription epoch로 이전 stream을 폐기하고, ordinary yield/resume의 같은 activity는 유지한다. | Playwright `121` 7/7 + native `71` file-backed 설정 1/1 | Done |
| **FR-CONT-SHELL.6** | transcript read/delete의 session basename은 agent writer와 동일하다. canonical `[A-Za-z0-9_-]+` 최대 128자는 그대로, 나머지는 UTF-8 SHA-256 전체 hex를 쓰고 양쪽 공통 벡터를 검증한다. | Rust `safe_session_base` + agent shared-vector contract | Pending (후속 hardening) |

| **FR-PROACTIVE-CONTROL.1** | Shell은 AI·TTS 제어 바에 능동 발화 런타임 제어를 제공한다. 상태는 `off`, `ready`, `active`, `blocked`로 구분하고, profile·AI 경로·TTS 경로와 실제 차단 이유를 함께 표시한다. | AiControlBar RTL + native Tauri 상태 전이 | Pending |
| **FR-PROACTIVE-CONTROL.2** | persisted profile 정책과 `proactiveSpeechPermitted` 런타임 허가를 분리한다. 허가가 false이면 Shell은 agent에 disabled profile을 전송하고 진행 중 activity를 stop한다. 허가를 켜도 유효한 profile과 실행 가능 조건이 없으면 `ready`나 `active`로 가장하지 않는다. | config normalization + ChatArea wire contract + Tauri negative path | Pending |
| **FR-PROACTIVE-CONTROL.3** | 능동 발화 시작/제안은 Shell의 허가·TTS·audio/avatar capability·현재 session을 통과해야 한다. LLM 또는 agent의 요청은 이 조건을 우회할 수 없고, 사용자의 버튼 중단은 다음 activity보다 우선한다. | agent/Shell contract + real Tauri start/stop | Pending |
| **NFR-PROACTIVE-CONTROL-cost** | UI는 현재 선택된 AI/TTS 제공 경로와 BGM 자동재생 여부를 보이되, 측정하지 않은 금액·토큰·절감률을 표시하지 않는다. 로컬 엔진 미준비·서비스 오류는 성공/실행 중 상태로 표현하지 않는다. | visual/ARIA review + Tauri blocked-state test | Pending |

NFR: agent-owned(반복·deadline·memory를 셸에 복제 금지), bounded(session 구독 registry는 dispatcher 수명과
현재 session 집합에 한정), wire-compatible(기존 AgentEvent union 재사용), observable(debug 로그에
session subscribe/start/terminal/disconnect와 requestId, 시크릿 없음).

검증 경계: PR #381의 실제 Tauri 테스트는 profile 저장·복원, DJ 실제 YouTube BGM·첫 결과·stop,
전시 greeting·stop을 검증한다. 이 테스트는 `ttsEnabled: false`이므로 audible proactive TTS,
DJ 멘트2, 질문 barge-in→답변→resume, 모든 제어, stale audio 폐기를 native로 증명하지 않는다.
그 흐름은 현재 Rust/프론트/agent 계약·통합 테스트 증거이며, 제품 live acceptance는 agent #84 후속이다.

## 비기능 요구사항 (NFR) — 횡단(전 tranche)

| ID | 요구사항 | 근거(1단계 구조) |
|---|---|---|
| **NFR-isolation** | 각 기능이 자기 slice/port 경계에 들어가 **고장이 격리**(깨진 기능이 타 영역 비전파) | fault isolation(루크) |
| **NFR-deny-default** | 권한/승인 명시 없으면 **거부**; 민감-도메인(security/policy/approval/safety) old-bug = 자동 FAIL+exit 차단 | deny-by-default·거버넌스 |
| **NFR-determinism** | 계약 드리프트 = **0토큰 결정론 게이트**(conform-gate) + drift-gate. **trivial 정의(정규화 제외)** = timestamp·PID·랜덤·임시경로·실행순서 비결정성; 그 외 의미 상태/출력 차 = FAIL | conform-scan |
| **NFR-substrate-agnostic** | 포트는 **embodiment/dimension/host-neutral**(뇌는 substrate 모름) — 의도/관측만 | brain/body/OS |
| **NFR-efferent-async** | 출력 3축(Express/Action/Environment) = **async + interruption + reafference**, 동기 가정 하드코딩 금지 | efferent 계약 원칙 |
| **NFR-provenance** | **단일 계층 규칙**: ①*모든 event* = `actor/client id + correlation id`(기본). ②*승인된 행위 event* = ① + `귀속 body·env + target·op`(승인 스코프 전체) + **context-identity digest(FR-F1.4)** + 원자 체인(승인↔실행↔결과↔보고) + `commanded→ack→observed` + reafferent backlink. **조기 종료 허용**: 승인후 abort·drift·실행전 중단 = `ack/observed 없음`을 *terminal 상태로 기록*(정상). FAIL = *실행된 단계 내* 링크 누락·context digest 불일치. ③*read-only/bootstrap* = ①만. (필수 집합 단일, 충돌 없음) | provenance 불변식 |
| **NFR-error-model** | **canonical error model**: 2직교축(오류-유형×민감-도메인) + blocking/non-blocking + uncertainty + retryability + contamination projection — 포트 공통. **error surface 는 disposition(contain/degrade/block/abort) 필드 노출 필수**(P04 출력 계약 검증 가능) | 오류 분류·disposition |
| **NFR-port-canon** | 포트별 **canonical shape + versioning + backward-compat + error-surface stability**(P04 계약검증 가능하게) | port canon |
| **NFR-transparency** | 상태 보고에 **timestamp + latency(신선도)** — async efferent 와 맞물려 데이터 신선도 확인 | observability |
| **NFR-baseline** | golden trace 행동 등가; **측정불가/깨짐 ≠ baseline → 격리/면제 목록**(자격: old 본래 부재 시만; 작동상실=regression) | P02 검증 |
| **NFR-coverage** | capability-class 대표+변이축 예외 **샘플 manifest 고정**(coverage drift 방지) | P02 샘플링 |
| **NFR-env-norm** | 측정 시 외부 키/엔드포인트 stub 강제(루크 env 부작용 분리); 측정 간 workspace/pty/cache/session 리셋 | P02 환경 정규화 |

## 제품 NFR vs 검증 NFR 분리 (R1 codex)

- **제품(런타임) NFR**: isolation · deny-default · substrate-agnostic · efferent-async · provenance · error-model · port-canon · transparency.
- **검증 NFR = P04 measurement contract**(구현 요구 아님, 측정 규약): determinism(0토큰 게이트) · baseline(golden trace·격리목록) · coverage(샘플 manifest) · env-norm(stub·리셋).

## Fault disposition matrix (R1 — failsafe 결정 규칙)

실패 감지 시 "정직 보고"만으론 부족 → fault class 별 **disposition 결정**:

| fault class | disposition | 비고 |
|---|---|---|
| 민감-도메인 ∩ (거부·권한·정책 위반) | **block / abort** | deny-by-default, exit 차단 |
| mutation 불확정(timeout·partial·post-approval drift·ack-not-observed) | **abort + 결과 미확정 정직 보고**(rollback 가능 시만) | 항상 rollback 가정 금지 |
| 자기상태/관측 실패(F1/F2) | **contain + 정직 보고**(상위 오염 차단), 부팅 차단 X | downstream contamination 방지 |
| 손상 설정(F0) | 손상 유형별 **contain(정직보고) 또는 block(fail-closed)** | 유형별 계약 |
| 외부 의존 degradation(후속) | **degrade**(최소 기능) — *full fallback impl=DEFER, disposition 규칙만 지금* | |

> `contain / degrade / block / abort` 중 하나로 매핑 안 된 실패 = 미정의 = FAIL.

## Foundation 추적 완결 (R1 codex — completeness)

모든 foundation 시나리오/검증항목은 **FR / NFR / DEFER / out-of-scope 중 하나로 폐쇄 매핑**(미매핑 0):
- F0=FR-F0 / F1=FR-F1.1~1.4 / F2=FR-F2 / F3=FR-F3.1~3.3 + 횡단 NFR 전체.
- 격리 항목(미배선 memory/cron·깨짐 Discord)=DEFER/격리목록. 분포(ISO/USB)=out-of-scope.
- (추적표 갱신 = tranche 착수 시.)

## DEFER (후속 tranche / step-3+)
- V1/V2(텍스트·음성)·도구·환경-앱·채널 FR = 해당 tranche 착수 시 도출(외부 의존 Old-Baseline 후).
- OS-core(SafetyPort e-stop·ClientSessionPort lease) FR = F3 후.
- 기억(naia-memory) FR = 미배선 → 통합 트랙.
- 대화 transcript: 음성 turn→agent 경유 기록(Phase2) · 멀티모달 잠재기억/파이프라인 tap(naia-memory) = DEFER(text Phase1 선행).
- botmadang(S65) = keep/reject 결정 후.

> 각 FR/NFR = P04(통합 테스트) 검증 대상. FR-F0~F3 착수 = Old-Baseline 측정(로컬·외부키X) 후 계약·테스트 구체화.

## 기능 요구사항 — UC-WIRE-V1 공통 채팅 계약 (#384 / naia-agent #89)

> 상태: Implemented. 계약 정본은 paired naia-agent의
> `docs/progress/99.dev-comm/UC-WIRE-V1-contract-2026-07-19.md`이며,
> Agent commit `364278f`와 이 Shell commit의 paired 검증 결과를 루트
> `[CONTRACT FROZEN v1]` 표식에 기록한다.

| ID | 셸 요구사항 | 검증 | 상태 |
|---|---|---|:---:|
| **FR-WIRE-SHELL-01** | 기존 텍스트 요청 형상을 유지하면서 attachment, channel, grounding, provider session, processing profile을 선택적으로 Agent 호출 경계까지 전달한다. | `src/test/uc-wire-v1.contract.test.ts`, `packages/shell/src/lib/__tests__/chat-service.test.ts` | Implemented |
| **FR-WIRE-SHELL-02** | grounding, image artifact, provider-session lifecycle, processing disclosure와 안정 오류 code를 손실 없이 UI 소비 형상으로 변환한다. | `src/test/uc-wire-v1.contract.test.ts`, Rust `wire_v1_*` tests | Implemented |
| **FR-WIRE-SHELL-03** | 표시 문구는 wire가 아니라 셸 i18n이 소유하며, 안정 오류 code 24종은 누락 없이 안전한 사용자 문구로 매핑한다. | `packages/shell/src/lib/__tests__/wire-errors.test.ts`, `chat-service.test.ts` | Implemented |
| **FR-WIRE-SHELL-05** | **답을 만들지 못한 턴은 답변이 아니라 복구 가능한 알림이다** (2026-09-07 #572). 안정 code 로 매핑되지 않는 legacy provider 오류(`provider error: invalid tool_call index`, `provider returned reasoning without a final answer`)를 답변 버블에 원문 그대로 쓰지 않는다. 그 자리는 사용자 말로 된 한 줄, 같은 입력을 다시 보내는 재시도 조작, 접힌 원문 상세로 그린다. 알림은 `role="alert"` 로 표시해 복구 표지 게이트가 그 자리를 셀 수 있게 한다. | `ChatArea.test.tsx` 원시 문자열 부재·재시도 재전송 계약 + `scripts/check-recovery-affordance.mjs` (재시도 조작을 지우면 붉어진다) | Implemented |
| **FR-WIRE-SHELL-04** | Rust proto 소비는 명시한 paired Agent proto만 사용하고, 경로 누락·unknown/UNSPECIFIED enum·오래된 proto를 fail-closed한다. paired commit, proto SHA-256, dirty 상태를 빌드 증거에 남긴다. | `src/test/uc-wire-v1-paired-proto.contract.test.ts`, Rust `wire_v1_*` tests | Implemented |

NFR: additive backward compatibility, secret/raw endpoint/raw evidence zero-transit,
bounded input/output, paired-proto reproducibility, unknown enum fail-closed,
stable-code-only wire, localized presentation.

## Discord setup/preflight policy (#388)

> Status: the isolated Windows Tauri WebDriver verifies both the visible native
> credential **cancellation** path and a live private-token authentication/discovery
> path. The latter reads an explicitly supplied E2E dotenv file only in the debug
> acceptance runtime; it does not create a DPAPI key or WebView token form. Binding
> save, Agent authority, Gateway receive/reconnect, and same-channel reply remain
> separate live acceptance gates.

| ID | Requirement | UC/Scenario | Verification | Status |
|---|---|---|---|:---:|
| **FR-DISCORD-SETUP-01** | Discord install URL policy uses only a canonical snowflake client id, `bot` scope, and minimum permissions/intents. A raw bot token must not cross WebView string IPC, UI persistence, or diagnostics. `discord_capture_bot_token` opens a native OS password prompt and returns only configured/error metadata. | UC-DISCORD-1A | Rust credential tests; `ConnectionsSettingsTab` no-argument contract; `e2e-tauri/specs/92-discord-secure-cancel.spec.ts` isolated native cancellation; `94-discord-live-auth.spec.ts` private-token live authentication/discovery with no DPAPI/WebView persistence | Native boundary and live authentication/discovery verified; binding/authority acceptance pending |
| **FR-DISCORD-SETUP-04** | The Connections page is a user-facing setup flow, not a runtime diagnostics console: it visibly explains **create/invite bot → native secure token input → test connection → choose allowed channels** before exposing channel bindings. It must state that the `Discord 연결` action opens the operating-system password window and never renders an inline token field. Runtime generations, stale bindings, and discovery uncertainty remain fail-closed but are shown only as troubleshooting detail. | UC-DISCORD-1 / 1A | component setup-flow contract; isolated native Tauri cancellation test; `94-discord-live-auth.spec.ts` live discovery | Native flow and live authentication/discovery verified; channel permission/authority acceptance pending |
| **FR-DISCORD-SETUP-05** | Connections and the globe inbox are one user journey. After a successful allow-list save, Connections offers a direct inbox handoff. The inbox classifies `not configured`, `configured but no allowed channels`, `allowed channels with no messages`, and retrieval failure without exposing raw runtime errors. It shows only records for saved bindings and never copies Discord content into private chat. | UC-DISCORD-1B / 2 | Connections/Channels component contracts; `93-discord-inbox-handoff` real Tauri E2E; provisioned-bot acceptance | Native setup/handoff verified; live bot acceptance pending |
| **FR-DISCORD-SETUP-02** | The visible Settings flow must classify native credential cancellation, token/storage failure, current runtime authority, message-content intent, incomplete discovery, and generation conflict using stable native facts. Unknown or incomplete discovery fails closed: it cannot save an allow-list or claim `연결됨`. | UC-DISCORD-1A | Rust status/discovery contracts; component, Playwright, and Tauri WebDriver Settings tests; `94-discord-live-auth.spec.ts` | Partial: native cancellation and live discovery verified; authority pending |
| **FR-DISCORD-SETUP-03** | `연결됨` is shown only when token presence, binding generation, runtime `ready`, and Agent authority agree. A stored token without that authority is `설정됨`; a reported runtime failure is an error, not a successful configuration. | UC-DISCORD-1A | `ConnectionsSettingsTab` status tests and native Tauri status-view test | Implementing E2E recovery |

## Steam Windows launch-readiness requirements (#314)

> **FR-INSTALL.1 산출물 정정(규범적, 2026-07-19):** Linux AppImage와 macOS app은
> 각각 raw `appimage/*.AppImage`, `macos/*.app` 산출물이 정확히 1개인지 archive 전에 검증한다.
> 업로드·무결성 검증 대상은 실행 권한과 app bundle 구조를 보존하는
> `appimage/*.AppImage.tar.gz`, `macos/*.app.tar.gz`이며, 기존 장문 행의 raw glob 표기보다
> 이 계약이 우선한다. NSIS/MSI/deb/rpm/DMG 계약은 기존 표기를 유지한다.

> **FR-INSTALL.2 정정(규범적, 2026-07-19):** 기존 장문 행 안의
> “`build.rs` 다운로드 SHA 무검증은 후속 이슈” 문장은 폐기한다. Vosk Windows/Linux 아카이브의
> 파일명·SHA256은 `platform-matrix.json`이 소유하며, `build.rs`는 압축 해제 전에 이를 검증한다.
> 캐시된 아카이브도 매번 기대 SHA로 다시 검증하고, 추출 디렉터리는 매 build-script 실행마다
> 삭제 후 검증된 아카이브에서 다시 만들며, 매트릭스가 선언한 런타임 파일만 번들에 복사한다.
> 검증은 `platform-matrix.test.ts` 계약과
> 3 OS clean-run installer CI가 담당한다.

| ID | Requirement | Scenario | Verification |
|---|---|---|---|
| **FR-STEAM.1** | `platform-matrix.json`의 `steamDepot`이 진입 파일, 필수/제외 파일, 디포 경로, SHA256 manifest 이름의 유일한 계약이다. | S-STEAM | `platform-matrix.test.ts` |
| **FR-STEAM.2** | Steam 디포는 NSIS 설치 위치가 없는 상태에서 실제 `naia-shell.exe`를 기동하고 agent handshake와 번들 Node 사용을 증명해야 한다. | S-STEAM | `build-installers.yml` Windows smoke |
| **FR-STEAM.3** | 디포 업로드물은 `uninstall.exe`를 포함하지 않고 모든 포함 파일의 SHA256 상대경로 manifest를 포함해야 한다. | S-STEAM | workflow contract test + uploaded artifact |

Steamworks 포털 설정·SteamPipe 자격증명·스토어 심사 제출은 #314 운영 범위이며, 이 저장소의 비밀값으로 하드코딩하지 않는다.

## Discord 채널 에이전트 요구사항 (신규 기능, 2026-07-20)

### 제품 목적

나이아는 사용자가 Discord에서 만든 봇을 사용자의 서버에 초대한 뒤, 허용한 채널에서 다른 참여자와 대화할 수 있어야 한다. 이는 Shell 안의 Discord DM 열람 기능이 아니라, 여러 Discord 채널에서 나이아가 활동하는 채널 에이전트 기능이다.

현재 `ChannelsTab`과 `discord-relay`는 단일 DM 채널을 전제로 하며 REST 폴링에 의존한다. 이 구현은 본 요구의 기준 구현이 아니며, 아래 요구를 만족할 때까지 미완성으로 취급한다.

### 사용자 흐름

1. 사용자가 나이아에게 Discord 연결 방법을 물으면, 나이아는 Discord Developer Portal에서 봇을 만들고 서버에 초대하는 과정을 이해하기 쉬운 말로 설명한다.
2. 사용자는 설정의 **연결 → Discord**에서 봇 연결 상태를 확인하고, 필요한 보안 정보는 채팅이 아닌 전용 보안 입력 흐름으로 제공한다.
3. 사용자가 봇을 초대한 서버의 채널 중 활동을 허용할 채널을 선택한다. 허용하지 않은 채널에서는 나이아가 읽거나 응답하지 않는다.
4. 지구본 버튼은 연결된 채널의 대화함을 연다. 특별히 채널을 선택하지 않았으면 가장 최근에 활동한 채널을 연다.
5. 나이아는 선택·허용된 채널에서 다른 참여자의 메시지를 실시간으로 받고, 채널별 맥락을 지켜 대화한다.

### 기능 요구사항

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| **FR-DISCORD.1** | 설정 탭에 `프로파일 · 두뇌 · 음성 · 아바타 · 페르소나 · 기억 · 지식 · 스킬 · 연결 · 일반` 순서의 **연결** 항목을 제공한다. 연결 항목은 Discord 연결 상태, 연결된 봇, 서버·채널 권한 상태, 문제 해결 진입점을 보여 준다. | 설정 탭 UI 테스트에서 연결 항목의 위치와 상태 표시를 확인한다. |
| **FR-DISCORD.2** | 사용자가 채팅에서 Discord 연결 의도를 표현하면 나이아는 봇 생성, 서버 초대, 채널 권한 부여의 목적과 순서를 설명하고 연결 화면으로 안내한다. 비밀 값이나 봇 토큰을 대화 본문으로 요청하거나 표시하지 않는다. | 채팅 의도 처리 테스트에서 안내와 연결 화면 진입을 확인하고, 메시지·프롬프트·로그에 토큰이 없음을 확인한다. |
| **FR-DISCORD.3** | Discord 봇 자격 증명은 운영체제 보안 저장소 또는 동등한 비밀 저장소에만 보관한다. 일반 설정 파일, agent 요청, 대화 기록, 진단 로그, UI 상태에는 원문을 저장하거나 전달하지 않는다. | 비밀 저장·재시작·로그 검사와 agent 요청 직렬화 검사로 확인한다. |
| **FR-DISCORD.4** | 연결 후 나이아는 봇이 실제로 접근 가능한 서버와 채널만 발견해 표시한다. 사용자가 명시적으로 허용한 서버·채널만 활동 대상으로 저장하며, 권한 부족·초대 취소·채널 삭제 상태를 정직하게 표시한다. | 서버·채널 발견, 허용 목록 저장, 권한 상실·삭제 오류 시나리오를 검증한다. |
| **FR-DISCORD.5** | 나이아는 허용 채널의 새 메시지를 Discord Gateway 기반의 지속 연결로 수신한다. 주기적 REST 폴링은 실시간 수신의 주 경로로 사용하지 않는다. 연결 끊김 뒤에는 중복 처리 없이 재접속하고, Shell 재시작은 인증된 정상 종료 요청으로 이미 수락한 메시지를 bounded drain한 뒤 실제 자식 종료를 확인한다. timeout 때만 강제 종료하며 Agent는 미완료 예약을 durable partial로 남긴다. 복구 불가 상태는 사용자에게 보인다. | Gateway 이벤트 수신, 재접속, 중복 이벤트, 권한·네트워크 오류, 정상 종료→실제 exit→강제 종료 fallback 순서 계약 테스트와 실제 Discord E2E로 확인한다. |
| **FR-DISCORD.6** | 나이아의 응답은 원래 메시지가 속한 같은 Discord 채널로 전송한다. 채널별 대화 맥락·마지막 읽은 메시지·응답 상태는 서로 섞이지 않는다. | 두 채널의 메시지를 교차 입력해도 각 응답과 맥락이 해당 채널에만 남는지 검증한다. |
| **FR-DISCORD.7** | 나이아는 허용 채널에서 다른 참여자와 대화할 수 있다. 언제 응답할지는 연결 설정에서 정한 참여 규칙(예: 호출에만 응답, 모든 메시지에 응답, 일시 중지)을 따르며, 규칙이 없거나 채널이 허용되지 않았으면 응답하지 않는다. | 참여 규칙별 메시지 처리·무응답·일시 중지·재개 시나리오를 검증한다. |
| **FR-DISCORD.8** | 지구본 버튼의 대화함은 연결된 Discord 채널 목록과 선택된 채널의 대화를 제공한다. 좁은 Shell에서는 한 번에 목록 또는 대화 중 하나만 보여 주고, 대화 헤더의 뒤로 가기로 목록으로 돌아간다. 데스크톱 폭에서는 목록과 대화를 함께 보여 줄 수 있다. | 좁은 폭과 넓은 폭 UI E2E에서 목록·선택·뒤로 가기·레이아웃 전환을 검증한다. |
| **FR-DISCORD.9** | 채널을 명시적으로 선택하지 않았을 때 지구본 대화함은 가장 최근 활동한 허용 채널을 연다. 최근 채널이 없으면 채널 목록과 연결 안내를 보여 준다. 사용자가 마지막으로 열었던 채널은 다음 Shell 시작 때도 우선한다. | 최근 활동 채널, 마지막 열람 채널, 비어 있는 목록·재시작 시나리오를 검증한다. |
| **FR-DISCORD.10** | 채널 목록은 채널 이름, 서버 구분, 최근 메시지 미리보기, 마지막 활동 시각, 읽지 않은 메시지 수를 좁은 화면에서도 읽기 쉽게 보여 준다. 카카오톡과 같은 익숙한 대화함 원칙을 따르되, 특정 서비스의 화면을 복제하지 않는다. | 긴 이름, 많은 채널, 읽지 않음, 최근 메시지 없음, 키보드·스크린리더 탐색을 UI 테스트로 검증한다. |

### 비기능 요구사항과 경계

- **권한 우선:** 서버·채널 허용 목록과 Discord 권한이 모두 충족될 때만 메시지를 수신·응답한다. 기본값은 활동하지 않음이다.
- **실시간성:** 수신 지연·재시도·연결 상태를 관측할 수 있어야 하며, 폴링 주기에 의존해 정상 동작을 주장하지 않는다.
- **신뢰성:** Gateway 재연결, Discord rate limit, 중복 이벤트, 순서가 바뀐 이벤트, 나이아 재시작을 처리해 같은 메시지에 중복 응답하지 않는다.
- **프라이버시:** 한 Discord 채널의 메시지·대화 맥락·메타데이터를 다른 Discord 채널, Shell 개인 대화, 다른 서비스로 섞어 보내지 않는다.
- **범위 제외:** 이 요구사항은 Discord 봇의 생성·연결·수신·응답·대화함 UX를 정의한다. 다른 메신저 지원, Discord 서버 관리 자동화, 사용자 동의 없는 채널 접근은 포함하지 않는다.

### 수락 시나리오

- 가족 채널처럼 이미 봇이 초대된 서버에서, 사용자가 해당 채널을 허용하면 나이아가 새 메시지를 실시간 수신하고 같은 채널에 한 번만 응답한다.
- 같은 봇이 여러 채널에 초대된 경우, 지구본을 열면 최근 채널이 먼저 보이고 목록에서 다른 채널을 고르면 그 채널의 대화만 보인다.
- 좁은 창에서 채널을 고르면 목록은 대화 화면으로 전환되고, 뒤로 가기를 누르면 원래 목록으로 돌아온다.
- 봇 토큰이 없거나 만료됐을 때는 연결 화면에서 복구 방법을 설명하고, 채널 메시지·로그·agent 요청 어디에도 토큰 원문이 나타나지 않는다.

## Codex·LLM 역할 분리 요구사항 (2026-07-21)

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| **FR-LLM-ROLE.1** | 설정에서 Codex를 API key 없는 local-login provider로 선택할 수 있다. | provider option과 keyless chat config 계약 |
| **FR-LLM-ROLE.2** | main/sub/memory 역할의 provider·model·credentialRef를 독립 저장하고 복원한다. sub와 memory는 기본 main 상속을 제공하고, 역할에서 지원하지 않는 provider의 직접 선택을 막는다. | role config roundtrip + SettingsTab + native Tauri 설정 E2E |
| **FR-LLM-ROLE.3** | dev/stage/Tauri build는 동일한 정확한 Agent commit과 proto SHA를 강제하며 임의 sibling checkout을 사용하지 않는다. | paired contract와 dirty/wrong-commit negative test |

- **NFR-LLM-ROLE-secret**: Codex 로그인 파일이나 토큰을 Shell 설정·wire·로그로 복사하지 않는다.
- **NFR-LLM-ROLE-pairing**: Agent 기능 변경 뒤 Shell pin을 새 정확한 commit으로 갱신하기 전에는 빌드가 실패해야 한다.

## 전주대 강의 Codex 준비 상태 요구사항 (2026-07-21)

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| **FR-COURSE-CODEX.1** | 사용자가 설정의 두뇌에서 Codex를 main provider로 선택했을 때, Shell은 `Codex 연결 확인`으로 해당 PC의 Codex CLI 설치와 로그인 상태를 확인하고 `준비됨`·`설치 필요`·`로그인 필요`·`확인 실패`을 구분해 표시한다. | Rust 명령 계약 테스트에서 Windows와 비-Windows 실행 경로·상태 분류를 확인하고, Settings 단위 테스트에서 상태 표시와 재시도를 확인한다. 로그인된 실제 Shell은 `e2e-tauri/specs/96-codex-readiness.spec.ts`에서 `준비됨`까지 검증한다. |
| **FR-COURSE-CODEX.2** | Codex 준비 확인은 인증 토큰·계정 식별자·CLI 출력 원문을 UI·설정·agent 요청·로그에 저장하거나 표시하지 않으며, provider·모델·워크스페이스 설정을 변경하지 않는다. | 실패 상태 단위 테스트와 IPC 결과 직렬화 검사에서 안전한 상태 코드만 노출되는지 확인한다. |
| **FR-COURSE-CODEX.3** | Codex가 아닌 provider를 선택하면 Codex 준비 확인 UI를 노출하지 않는다. Codex 선택으로 돌아오면 사용자가 명시적으로 다시 확인할 수 있다. | Settings FE 테스트에서 provider 전환과 재시도 동작을 확인한다. |

## Grok 구독 CLI provider (2026-09-02, #529)

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| **FR-GROK.1** | 설정에서 Grok를 API key 없는 local-login provider로 선택할 수 있다. 기본 모델은 `grok-4.6`이다. 기존 `xai` API-key provider는 유지한다. | registry·Settings 단위 테스트 |
| **FR-GROK.2** | 사용자가 두뇌에서 Grok를 선택하면 Shell은 설치와 로그인만 확인하고 `준비됨`·`설치 필요`·`로그인 필요`·`확인 실패`를 구분해 표시한다. | Rust 분류 테스트, Settings 단위 테스트, Playwright `e2e/grok-readiness.spec.ts`. 로그인된 실제 Shell은 `e2e-tauri/specs/96-grok-readiness.spec.ts` |
| **FR-GROK.3** | Grok 준비 확인은 인증 토큰·계정 식별자·CLI 출력 원문을 UI·설정·agent 요청·로그에 저장하거나 표시하지 않는다. | Settings IPC 결과 직렬화 검사 |
| **FR-GROK.4** | 게이트웨이 카탈로그 prefix `grok:`는 계속 `xai`(API)로 묶고, 로컬 구독 provider id `grok`와 섞지 않는다. | Settings 카탈로그 alias 유지 |

## Codex 코딩 작업자 요구사항 (2026-07-22)

| ID | Requirement | Verification |
|---|---|---|
| **FR-CODEX-WORKER.6** | Jeonju course mode is explicit and leaves the default isolated worktree behavior unchanged. The form changes its workspace-root label and explains the direct-course boundary when that mode is selected. Shell preflights the selected Git root, clean working tree, and remote before asking Agent for selected-workspace execution. | Shell UI/adapter contract and native preflight contract; normal workers remain `ISOLATED_WORKTREE`. |
| **FR-CODEX-WORKER.7** | The course file boundary is fixed in Rust IPC to `index.html` and `hero.svg`. WebView, LLM, Discord, and task text cannot provide or modify allowed files. Shell displays Agent's verification summary. | typed Tauri invoke contract, selected-workspace Agent contract, and Tauri E2E with an isolated course fixture. |
| **FR-CODEX-WORKER.8** | On course preflight or verification failure Shell creates no success state, gives a safe folder-readiness message, and preserves student changes for review. | rejection unit/adapter test and paired Agent failure contract. |
| **FR-CODEX-WORKER.9** | Shell distinguishes the Naia ADK control root from Codex's execution-target Git root. The visible default is the current ADK root; project work selects a Git root below it, while direct ADK-root work remains an explicit target choice. Agent accepts selected-workspace course execution only at that root or a descendant, and starts Codex in the selected target rather than broadening write authority to the control root. | Shell component + native Tauri guidance E2E; Agent selected-workspace containment contract; course E2E fixture under `workspace/projects/`. |
| **FR-CODEX-WORKER.10** | In course mode the selected brain is a read-only proposal producer. It returns a versioned complete-file proposal only; Naia validates, applies, and verifies it. The authority contract is provider-neutral, so a Naia-account model or another compatible provider can replace Codex without obtaining direct workspace-write authority. | Agent proposal parser/apply/verify contracts; Shell course-mode explanation and native Tauri acceptance. |
| **FR-CODEX-WORKER.11** | Before Agent startup, Shell can persist one trusted Jeonju Discord course target at the active ADK control root. The dedicated `naia-settings/jeonju-discord-course.json` document is schema-versioned and contains a canonical clean Git root plus exactly `index.html` and `hero.svg`. Rust, not WebView input, fixes the file list and rejects a target outside the control root. | Shell target parser/UI contract, Rust schema and containment contracts, and native Jeonju course fixture. |
| **FR-CODEX-WORKER.12** | Discord message text, task text, and model output cannot create, replace, or widen a trusted course target. Only the explicit Shell action may write it; a failed update leaves the last valid target unchanged. | invoke contract rejects caller-supplied file lists and invalid paths; negative UI and Rust tests. |
| **FR-CODEX-WORKER.13** | A Jeonju course worker may start only after the visible saved course target exactly matches the entered execution-target Git root. Shell repeats that target-to-workspace comparison at its native start boundary; WebView state alone is not authority. Every selected-workspace card shows a user-facing Naia course report: queued/running/cancelling status, verified result or explicit lack of verification, preserved-failure/cancellation guidance, and the student's next action. Its `수업 파일 열기` action opens the first fixed course file in the Shell editor so the report leads directly to student inspection. Shell must not imply that an unverified or cancelled job succeeded. | `CodingWorkersApp` component contracts for blank/mismatched target gating, state reports, and file-open action; native target-match unit contract; `97-course-worker-guidance` native Shell E2E for the blocked start; `91-jeonju-course-worker` native Shell E2E for the completed report, editor handoff, and verified two-file result. |

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| **FR-CODEX-WORKER.1** | Shell은 Coding Workers 앱에서 `codex` provider, 절대 worktree 경로, 비어 있지 않은 작업 설명을 받아 worker adapter에 생성 요청할 수 있다. adapter가 없거나 실패하면 성공 상태를 만들지 않는다. | adapter fake 계약과 UI 테스트에서 생성 성공은 반환된 worker에만 한정되고 unavailable adapter는 오류·빈 목록으로 남는지 확인한다. |
| **FR-CODEX-WORKER.2** | worker는 안정적 ID, provider, worktree, task, 상태, 마지막 갱신 시각, 선택적 checkpoint ID를 가진다. 상태는 `queued`, `running`, `cancelling`, `cancelled`, `completed`, `failed`만 허용한다. | 도메인 검증 및 상태 렌더링 테스트. |
| **FR-CODEX-WORKER.3** | `queued`·`running`·`cancelling` worker가 점유한 worktree에는 새 worker를 요청하지 않고 충돌 이유를 표시한다. 병렬 작업은 서로 다른 격리 worktree에서만 시작한다. | same-worktree negative UI 테스트. |
| **FR-CODEX-WORKER.4** | 취소와 재개는 각각 worker adapter의 대상 ID 요청으로만 수행한다. 재개는 checkpoint ID가 있는 `cancelled` 또는 `failed` worker에만 가능하며, PTY kill 또는 새 shell 생성은 재개가 아니다. | cancel/resume adapter 호출 및 checkpoint negative 테스트. |
| **FR-CODEX-WORKER.5** | Shell은 원본 adapter 오류, Codex 로그인 토큰, 계정 식별자, CLI 출력 원문을 worker UI·로그·persistent config에 노출하지 않는다. | unavailable/error sanitization 테스트. |
| **FR-CODEX-WORKER.6** | Coding Workers는 제어 루트·실행 대상·고정된 수업 파일 경계와 수업 대상의 저장/적용 시점을 구분해 표시한다. 수업 대상 저장 후에는 다음 Agent 시작 시 적용됨을 명시하며, 현재 Agent가 즉시 다시 읽었다고 표시하지 않는다. | 컴포넌트·Playwright·native Tauri 테스트에서 저장 전/후 상태와 `다음 Agent 시작` 안내를 검증한다. |
| **FR-CODEX-WORKER.7** | Coding Workers는 빈 목록, 요청 중, 성공, 실패, 취소 가능, 재개 가능 상태를 사용자 행동 중심으로 표시한다. 원시 상태값·원문 adapter 오류·원문 ISO 시각만으로 상태를 전달하지 않으며, mutation 요청은 진행 중 중복 전송하지 않는다. | 상태 배지/시간/빈 상태/중복 차단/안전한 오류 맥락에 대한 컴포넌트 및 UI E2E 테스트. |
| **NFR-VISUAL-UX-GATE.1** | Shell의 기능 UI 변경은 P02에서 기본·빈 목록·진행·성공·오류·좁은 폭 상태를 명시하고, P04에서 컴포넌트·Playwright와 해당 시 native Tauri Shell로 시각·접근성·복구 행동을 검증해야 한다. 기능 계약만으로 P05 완료를 선언할 수 없다. | `verify-visual-ux` 결과와 변경 기능의 UI E2E 증거가 모두 PASS여야 한다. |

- **NFR-CODEX-WORKER-contract**: Agent gRPC schema가 확정되기 전에는 Shell adapter가 worker lifecycle의 성공을 반환하거나 PTY를 worker로 위장하지 않는다.

## Cascade standalone install-plan requirements (2026-07-22)

| ID | Requirement | Verification |
|---|---|---|
| **FR-CASCADE.2** | Shell owns the 4060 cascade installation-plan status. Each of `loader`, `python-runtime`, `cascade-service-bundle`, `ditto-engine`, `voxcpm2-model`, and `reference-voices` supplies `complete|waiting|blocked`, 0–100 progress, `install|download|verify`, retryability, and a failure reason. | Rust pure-plan contract tests and SettingsTab IPC rendering test. |
| **FR-CASCADE.3** | `ready=true` only when all install steps are complete and the Shell-owned :8910 façade reports every requested TTS/avatar service healthy. Prerequisites without a started service are `ready-to-start`, not ready. | Rust live-status classification tests. |
| **FR-CASCADE.4** | Querying install status is read-only: no model download, service spawn, or user-file mutation. A profile warm with `canStart=false` must not call `start_cascade`. Missing package metadata must be reported as unavailable, never as an active download. | SettingsTab negative invocation test plus command contract review. |

## Three-tier LLM profiles (Pi-only execution)

| ID | Requirement | Verification |
|---|---|---|
| **FR-LLM-ROLE.4** | Shell persists `expert`, `main`, and `sub` profile selections independently; each can explicitly select a compatible Codex or Claude model or inherit another role. | role roundtrip and role-editor tests |
| **FR-LLM-ROLE.5** | Memory remains orthogonal to the three development tiers and may inherit one without becoming a development tier. | resolver contract |
| **FR-LLM-ROLE.6** | Shell-to-Agent development delegation uses only Agent-managed Pi. OpenCode is not exposed, called, installed, or a fallback in this route. | Agent Pi role factory and negative OpenCode assertions |

## Naia model comparison requirements (#407, 2026-08-02)

| ID | Requirement | Verification |
|---|---|---|
| **FR-NAIA-AZURE.7** | The Naia model picker defaults to price order and does not expose a registry/default-order option. Price order uses the documented general-chat estimate `3 * uncached input price + output price`; unknown prices sort last and ties remain stable. | registry unit + Settings component + Playwright |
| **FR-NAIA-AZURE.8** | Models marked `comingSoon`, omitted from a successfully loaded catalog, or otherwise non-live are absent from the selectable model list. A stale saved unavailable model is replaced and persisted as a usable route; later sort changes do not silently change a valid selection. | metadata/filter unit + Settings component |
| **FR-NAIA-AZURE.9** | Performance order uses a dated, source-documented general-chat recommendation based on official Azure Foundry and model-provider evidence. It must not present incomparable vendor benchmarks as a single measured score. | recommendation-order unit + source comments |
| **FR-NAIA-AZURE.10** | Cache prices do not affect the default sort because model support and the user's hit rate vary. The UI continues to show separate input/output customer prices; cache-aware billing claims require verified any-llm usage and charging evidence. | pricing contract + any-llm audit |

### Pricing and cache evidence (2026-08-02)

- Naia production routes GPT-5.6 Luna through Azure. The live customer prices
  are input `$1.10`, output `$6.60`, cache read `$0.11`, and cache write
  `$1.375` per million tokens. These are Azure prices plus the existing 10%
  service margin.
- OpenAI's direct API separately lists Luna at input `$0.20`, output `$1.20`,
  and cached input `$0.02`. That 80% reduction must not be substituted for the
  Azure-backed Naia route until Azure billing or the Naia upstream route changes.
- any-llm commit `6abb91d` preserves GPT-5.6 Sol/Luna cache keys, trailing
  streaming usage, cache-read and cache-write token partitions, DB usage, credit
  charging, and `/v1/pricing` cache fields. Grok, DeepSeek, Gemini, and Claude do
  not yet share that full end-to-end prompt-cache contract.
- DeepSeek V4 Flash exists in DeepSeek and Azure Foundry catalogs, but the Naia
  production `/v1/models` and `/v1/pricing` endpoints do not expose a live route
  or customer price. Shell therefore does not offer a non-working option.

## Radio DJ durability and settings ownership (#414, 2026-08-02)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| **FR-BGM.8** | Shell refreshes the semantic `skill_youtube_bgm` descriptor before each chat turn. Delivery failure is observable and never logged as successful registration. | Done | `chat-service` unit and BGM Playwright outbound ordering |
| **FR-BGM.9** | YouTube playback in the Tauri WebView supplies an origin referrer, creates a fresh iframe attempt even for the same video ID, and exposes success only after an observed `playing` event. | Done | component/Playwright request and playback-state tests plus native Radio E2E |
| **FR-BGM.10** | Radio-owned search avoids the currently selected video when another result exists. An exited owned BGM sidecar restarts on demand, while auxiliary-window destruction does not stop the main runtime. | Done | BGM unit tests, Rust lifecycle tests, native health/playback acceptance |
| **FR-BGM.11** | Radio-owned `status` returns bounded Shell-owned recent/favorite context, and every Agent activity play carries semantic `mode=radio_dj`. On observed `ended`, Agent speaks a short transition before a fresh dynamic search; Shell filters current/recent normalized duplicates and success remains gated by correlated observed `playing`. | Done | Shell BGM unit/Playwright plus paired Agent DJ-GRPC/DJ-08 contracts |
| **FR-BGM.12** | 재생 중인 YouTube BGM의 재생 버튼은 bridge listening handshake 뒤 `pauseVideo`를 보내고, iframe 상태 이벤트가 늦거나 누락돼도 UI를 즉시 paused로 전환한다. | Pending verification | BgmPlayer 컴포넌트 + Playwright |

## BGM orphan port recovery (#517, 2026-08-31)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| **FR-BGM.13** | Spawn 직전 셸은 대상 BGM 포트의 점유자를 확인한다. 점유자 command line에 `bgm-server-bin.js`가 있으면 종료 후 포트 해제를 확인하고 spawn한다. 없으면 종료하지 않고 점유 사실을 로그에 남긴다. 판정은 포트 소유자 기준(전역 cmdline 매칭 금지 — dev 격리 인스턴스 오살 방지). | Done | Rust reclaim 단위(주입 프로브 3분기) + Windows 실프로세스 통합 테스트 |
| **FR-BGM.14** | sidecar는 `EADDRINUSE`에서 재시도 없이 즉시 exit(1)한다. 실패한 채 살아남아 낡은 nonce로 포트를 승계하는 좀비를 만들지 않는다. | Done | vitest: 점유 포트에서 `startYoutubeServer()` → exit(1) 호출·재시도 타이머 부재 |
| **FR-BGM.15** | 셸 teardown은 `state.bgm_server`가 비어 있어도 PID 파일에 살아 있는 sidecar가 있으면 component 검증 후 종료하고 나서 파일을 제거한다. 기록만 삭제해 고아를 추적 불가로 만들지 않는다. | Done | Rust teardown 헬퍼 단위 + FR-BGM.13 백스톱이 최종 방어선 |

## Onboarding appearance and voice ownership (2026-08-06)

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| **FR-ONBOARD.1** | 사용자 이름 입력은 특정 개인 이름을 placeholder로 노출하지 않는다. | OnboardingWizard 컴포넌트 |
| **FR-ONBOARD.2** | 외모 선택은 설치된 VRM과 NVA를 함께 제공하며 NVA는 GPU/VRAM 프로파일과 독립적으로 저장한다. | 컴포넌트 저장 계약 + Playwright |
| **FR-ONBOARD.3** | 비디오 배경 카드는 실제 영상 프레임을 이미지로 캡처해 표시하고, 캡처할 수 없으면 정적인 video 프레임으로 복구한다. 재생 기호만 표시하지 않는다. | 컴포넌트 + Playwright 스크린샷 |
| **FR-ONBOARD.4** | GPU 감지는 로컬/레퍼런스 음성을 음성 설정에서 선택할 수 있다는 안내만 제공한다. 온보딩은 로컬 프로파일을 자동 저장하거나 음성 서버를 시작하지 않는다. | GPU 감지 컴포넌트 + 저장 설정 회귀 |
| **FR-SETTINGS.12** | `Settings > Skills > Youtube Radio DJ` is the sole owner of Radio DJ proactive policy. General renders no duplicate profile, weather consent, coordinates, or DJ fields. | Done | Settings component and Playwright ownership assertions |
| **FR-SETTINGS.13** | Weather-location consent and coordinates survive semantically equivalent parent rerenders and persist after Save/reload. No location is transmitted unless consent is enabled. | Done | component rerender regression and Playwright persistence test |

## VRM avatar expression compatibility (2026-08-13)

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| **FR-AVATAR.1** ([#422](https://github.com/nextain/naia-shell/issues/422), REQ-002) | TTS 재생 중 3D VRM 아바타는 VRM 1.0 `aa/ih/ou/ee/oh`와 VRM 0.0 `a/i/u/e/o`를 모두 인식해 다섯 입모양을 순환한다. 연속형 표정은 부드럽게 전환하고, 텍스처 전환형 `isBinary` 표정은 한 번에 하나만 활성화하며, 발화 종료·중단 시 모든 입모양을 즉시 0으로 복귀시킨다. 이는 발화 상태 기반 시뮬레이션이며 실제 오디오 음소 분석으로 위장하지 않는다. 모델이 커스텀 `think` 표정을 제공하면 이를 우선 사용하고, 없는 모델만 neutral로 대체한다. | `mouth.test.ts` binary/continuous/VRM 0.0 5모음·one-hot·정지 회귀, `expression.test.ts` custom think·neutral fallback |
| **FR-AVATAR.2** ([#423](https://github.com/nextain/naia-shell/issues/423), REQ-002) | 일반 채팅과 실시간 음성 요청은 응답 대기 중 `think` 표정을 사용한다. 구조화된 emotion tag 또는 voice server `emotion.updated`가 도착하면 해당 감정이 우선하며, agent 응답 스트림이 먼저 끝나더라도 합성·큐·브라우저/NVA 음성 재생이 끝날 때까지 유지한다. 마지막 재생 종료, 취소, interrupt, 오류에서는 neutral로 복귀한다. 아바타가 상태 변경 뒤 로드되어도 현재 표정과 발화 상태를 즉시 동기화한다. 납품 VRM에 내장 전신 clip이 없으므로 별도 VRMA가 없는 감정 동작을 임의 참조하지 않는다. | `ChatArea.test.tsx` think→emotion→playback-end/interrupt lifecycle, `pipeline-voice.spec.ts` 실제 음성 경로, `AvatarCanvas.tsx` load-time state sync |

## Settings persistence and runtime reload (#415, 2026-08-03)

| ID | Requirement | Status | Verification |
|---|---|---|---|
| **FR-CONFIG-SOT.7** | `config.json` and `ui-config.json` are the workspace sources of truth. Derived agent environment aliases are regenerated only at the write boundary and never hydrate into AppConfig/localStorage. | Implemented | config merge/write unit plus cache-clear restart E2E |
| **FR-LLM-ROLE.7** | `subLlm*` belongs only to the sub role and `memoryLlm*` only to the memory role. Structured `llmRoles` is authoritative; legacy mirrors are deterministic and cannot assign one provider to two roles. | Implemented | role/slot/manifest contract tests |
| **FR-SETTINGS.14** | Every credential removed from workspace JSON is stored in the OS-backed secure store, restored after restart, and omitted from config, UI config, logs, and agent messages except the dedicated credential channel. | Implemented | secure-store unit and native restart test |
| **FR-SETTINGS.15** | A visible successful save means config, UI config, derived manifest, and synchronous Agent reload acknowledgement have completed in order. With no running Agent, the next `SetWorkspace` applies the persisted files; a running Agent's memory reload failure is returned to the settings UI instead of being swallowed. | Implemented | ordered write unit, Rust RPC compile, Agent #106 reload integration |
| **FR-MEMORY.5** | Changing memory role, embedding, adapter, or workspace rebuilds the effective runtime for the next turn without restarting the Shell. Failed rebuild preserves the last healthy runtime and reports the failure. | Implemented (Agent #106) | Agent reload integration, paired Shell compile, real restart log |

## 2026-08-06 active Windows NVA/Voice/Media contract

This section supersedes the active product meaning of FR-VRAM.1~6,
FR-VOICE.3~12 and FR-CASCADE.1~22 where they describe a selectable local GPU
profile, a Ditto/TRT/Cascade-rendered avatar, account-gated local voice, or
automatic media/proactive activation. Those older rows remain non-normative
implementation history only. `windows-8gb-nva.md` is archived evidence.

| ID | Normative requirement | Verification |
|---|---|---|
| **FR-NVA-WEB.1** | NVA is the pre-authored, GPU-free web player from `projects/naia-video-avatar`, not Ditto/TRT/Cascade. Shell plays idle, speaking, gesture and new utterance assets and persists the selected asset identity. | player state/component tests, focused Playwright, captured frame |
| **FR-NVA-WEB.2** | `naia-adk` supplies the default NVA bundle containing the new utterance assets. Missing/stale paths fail visibly; no static thumbnail or silent fallback counts as playback. | asset contract/hash and clean-state E2E |
| **FR-LOCAL-VOICE.1** | No local GPU profile UI exists. With detected VRAM >= 6GB, Voice settings expose one explicit `voxCPM 2 local voice` ON/OFF control. Detection never starts or enables it. | 5.9/6.0/unknown boundary tests and no-start negative |
| **FR-LOCAL-VOICE.2** | Local voice works without Naia login and independently of LLM and VRM/NVA. ON starts the Windows child and reports ready only after `http://localhost:8910` health succeeds; OFF reaps its children. | Rust lifecycle, ready/timeout/stop, no-login native E2E |
| **FR-LOCAL-VOICE.3** | Reference voice selection, recording and file upload belong to Voice settings and round-trip independently across restart. | component/API/config migration tests |
| **FR-MEDIA-CONSENT.1** | Cold boot, restored song/profile and Proactive state never start BGM or Radio DJ. Radio DJ starts only from explicit user play or structured LLM `skill_youtube_bgm` with `action=play, mode=radio_dj`. Automatic next-track behavior is scoped to that active session. | authority reducer and cold/migration Playwright negatives |
| **FR-MEDIA-CONSENT.2** | The active BGM play control toggles pause. Proactive is independent, defaults OFF and is a compact SVG icon next to AI/TTS with localized hover/focus tooltip and aria-label. | component accessibility and playback tests |
| **FR-SHELL-UX.1** | Onboarding offers VRM and NVA, uses no personal example name, and captures an actual video frame for the NVA/background thumbnail. | clean onboarding Playwright and screenshot |
| **FR-SHELL-UX.2** | Chat layout offers left-small and left-fill only; legacy center/home state migrates to left-small. | config migration and layout E2E |
| **FR-WIN-DISCORD.1** | Windows Discord Gateway connect/reconnect/shutdown is bounded and leaves no orphan child. Tests stay isolated from the four live Linux agents. | isolated Windows integration tests |

### 2026-08-08 field-review addendum (B8)

A live-field review found six defects that survived the rows above despite earlier "done" build evidence covering lifecycle/toggle plumbing but not the actual speech-ownership and render path. These rows are additive, not replacements.

| ID | Normative requirement | Verification |
|---|---|---|
| **FR-NVA-WEB.3** | Shell's selected TTS provider (any of them, including `browser`) is the sole synthesizer and player of speech audio for a turn. An NVA renderer never synthesizes speech itself; it only reacts to Shell's actual playback start/end to switch its idle/talking visual, except an exact authored-phrase clip that carries its own pre-recorded voice, which is played instead of synthesis for that one phrase only. | `sendSentenceToTts` routing contract test, focused ChatArea component tests (renderer never receives `speak(text, undefined)`) |
| **FR-NVA-WEB.4** | A speech clip that cannot carry a real alpha channel (any non-webm container) is composited against `manifest.chroma_key` or `background.color` on a canvas, so idle/talking playback never exposes an opaque recorded backdrop over the app background. | `prebaked-renderer` unit tests (contain-rect math, alpha-capability detection); pixel-level correctness on real hardware not yet verified in this session |
| **FR-SHELL-UX.3** | Settings' own avatar/NVA detail view re-hydrates `avatarProvider`/`nvaModel` on `naia-config-changed` (login, remote hydration, other tabs), matching the main view instead of only reading them once at mount. | SettingsTab focused hydration regression test |
| **FR-SHELL-UX.4** | The Channels/Discord app tab renders the live connection/binding/channel state component, not a static "coming soon" placeholder. | NaiaMetaArea + ChannelsTab component tests |
| **FR-MEDIA-CONSENT.3** | A playback-not-yet-confirmed watchdog is diagnostic only and must never skip a track by itself; a fixed elapsed-time guess is not evidence of failure, since the *message* proving playback (not the playback itself) can be lost. Independent progress evidence (iframe `infoDelivery` reporting real elapsed time on the active playback id) also confirms playback when the primary state message is lost. Only the iframe's own `onError` event (or explicit user action) is treated as real failure evidence. | `components/__tests__/BgmPlayer.test.tsx` (no-skip-on-timeout, infoDelivery cross-signal); `e2e/bgm-skill.spec.ts` real-browser regression test rewritten for this contract |
| **FR-MEDIA-CONSENT.4** | On a genuine track end (`onStateChange` ended, not a timer), Shell actively notifies the agent the same way a new track start already does (`music_changed`), instead of only updating passive context the agent might notice on some later, unrelated turn. | `components/__tests__/BgmPlayer.test.tsx`; the agent-side decision to comment vs. continue is out of this repo's scope |
| **FR-VOICE-ONBOARD.1** | Onboarding, after login, offers a voice step: Web TTS on/off with a system-voice picker and preview, and — when detected VRAM >= 6GB — an actual local-voice control that performs the real `start_cascade`/`stop_cascade` lifecycle (not only a preference flag pointing at Settings). | OnboardingWizard focused component tests (voice step navigation, real `start_cascade` invocation, persisted config fields); `e2e/onboarding-fresh.spec.ts` real-browser run (3/3) |

Verified this session with a real Chromium + dev server: `e2e/onboarding-fresh.spec.ts` (3/3) and `e2e/bgm-skill.spec.ts` (12/12, after rewriting one test that had asserted the old force-skip-on-timeout behavior FR-MEDIA-CONSENT.3 deliberately removed). Remaining gaps: no `e2e-tauri` (native Tauri/WebDriver) run this session; FR-NVA-WEB.4's chroma-key correctness has not been visually confirmed on real Windows hardware (headless chromium doesn't exercise the WebView2-specific path this fix targets).

## 2026-08-08 Naia default model change

| ID | Normative requirement | Verification |
|---|---|---|
| **FR-LLM-DEFAULT.1** | The `nextain` (Naia) provider's model catalog includes `deepseek-v4-flash` (DeepSeek V4 Flash, GA 0731 release) alongside `deepseek-v4-pro`. The gateway (`project-any-llm`) already routes and prices this model (`docker/config.naia.yml`, `model_catalog.py`) with its own passing test suite (78 tests) — this row only makes it selectable in the shell. | `lib/llm/__tests__/registry.test.ts`, `registry-gateway-models.test.ts` (model lineup, labels, sort order) |
| **FR-LLM-DEFAULT.2** | The Naia provider's default model (`registry.ts` `defaultModel`) and the login/onboarding auto-fill default (`NAIA_SLOT_DEFAULTS.main.model`) are both `deepseek-v4-flash`, replacing the prior `gemini-3.1-flash-lite`/`gemini-3.5-flash` split defaults. | `registry.test.ts`, `registry-gateway-models.test.ts`, `slots/__tests__/settings-slots.contract.test.ts` |
| **FR-LLM-DEFAULT.3** | `deepseek-v4-flash` is tiered in `NAIA_GENERAL_CHAT_RECOMMENDATION` (product model-sort priority) at the same tier as `deepseek-v4-pro`, sourced from its official Azure Foundry model card and Artificial Analysis Intelligence Index (52, #3/101 open-weight models) rather than a fabricated score — see the citation comment above the table in `registry.ts`. | `registry.test.ts` sort-order test |
| **FR-LLM-DEFAULT.4** | Every selectable Naia chat model supports Shell skill/tool calling. The offline registry and live gateway metadata must not downgrade a verified tool-capable model, and a model that cannot call tools is unavailable rather than selectable. | full selectable-model capability invariant + DeepSeek live-metadata/offline-fallback tests + Agent request-body contract |

Verification: Shell `tsc --noEmit` clean; full Shell Vitest suite green (1463 tests, 0 failed). any-llm gateway: `pytest tests/gateway/test_naia_azure_models.py tests/unit/test_naia_pricing.py` — 78 passed (3 unrelated tests in `test_models.py` need a local Docker daemon for a Postgres testcontainer, not available this session — not specific to this model). No `e2e`/`e2e-tauri` coverage for this change (model selection has no dedicated Playwright spec); not run this session.

## v0.1.7 launch QA (#447, 2026-08-14)

| ID | Normative requirement | Verification |
|---|---|---|
| **FR-V017.1** | Writing the first ADK path on a clean install is an awaited operation. If the native cache changes, Shell restarts Agent against the new workspace before setup completion; an unchanged path does not restart it. Native E2E isolation never writes the user cache. | Rust cache/restart contract + `adk-store` unit + fresh-profile Playwright; final NSIS clean-VM smoke |
| **FR-V017.2** | Startup auth, notification configuration, and every LLM/TTS credential are cached and sent after ADK setup and onboarding complete, including a clean install whose first mount had no config. Failure is observable and the request is not reported as successful. | App component contract + fresh-profile Playwright + Agent log inspection |
| **FR-V017.3** | Workspace owns one bundled Herdr PTY. Snapshot polling starts only after PTY creation and retries bounded startup races until the API becomes ready; process exit and timeout remain explicit retryable errors. | Herdr hook tests + Workspace Playwright + installed Windows process inspection |
| **FR-V017.4** | Chat layout is a persisted user preference independent of the active app. Missing/legacy center values migrate to `app` (left-small); opening Workspace never forces left-fill and no center-large chat mode is rendered. | App layout test + Playwright |
| **FR-V017.5** | Onboarding appearance selection is one grid of installed VRM/NVA cards with face-centered thumbnails and visible type badges. The default selected appearance is bundled Naia NVA and completion persists `avatarProvider=naia-video-avatar`, `nvaModel=naia`. | Onboarding unit + fresh-profile Playwright screenshot/DOM |
| **FR-V017.6** | The Windows bundle places `msvcp140.dll`, `vcruntime140.dll`, and `vcruntime140_1.dll` beside `resources/herdr/herdr.exe`, sourcing the exact staged redistributables and failing the build if any file is unavailable. A clean machine must not require a separately installed Visual C++ Redistributable for bundled Herdr startup. | stage-Herdr adjacency contract + NSIS/MSI payload inspection + clean-profile Workspace smoke |
| **FR-V017.7** | Every release build clones and stages the exact Agent commit declared by `packages/shell/agent-pairing.json`; the Rust build gate, staging scripts, and installer workflow cannot point at different revisions. The paired Agent preserves first-start config/LLM fallback diagnostics required by UC-V017-WINDOWS-FIRST-CHAT. | pairing-manifest contract test + Windows bundle build + installed first/second-turn log and usage inspection |
| **FR-V017.8** | A release candidate is not publishable until the generated Windows NSIS and MSI pass artifact-size/structure checks, bundled runtime inspection, silent install, installed smoke, silent uninstall, and clean-profile Herdr/chat/avatar acceptance. Build and verification do not authorize publication. | `verify-artifacts.mjs`, Windows installer workflow, clean-profile acceptance record |
| **FR-V017.9** | Workspace must not depend on a bare Herdr client's implicit server spawn. Before attaching the embedded PTY, Shell probes the default API socket, starts `herdr server` exactly once when absent, retains server stdout/stderr in the Naia log directory, and waits a bounded interval for snapshot readiness. Concurrent opens reuse the same ready server; an exited or timed-out server returns its exit/log evidence as a retryable error. | Rust lifecycle classification/locking tests + isolated `%APPDATA%` bundled-Herdr cold-start probe + clean Windows Workspace smoke |
| **FR-V017.10** | Onboarding completion awaits every config/key persistence operation, then sends `reload_settings` to the live Agent and replays the Naia credential before leaving the wizard. Completion is single-flight with visible progress; persistence or reload failure keeps the wizard open with an accessible error and retry action. The first chat after a clean login must not require an app restart. | onboarding completion ordering/error tests + chat-service reload IPC test + clean-install first-turn acceptance |
| **FR-V017.11** | Passing the GPU/VRAM gate does not imply that VoxCPM2 is installed. When `cascade_installation_status.canStart=false`, every local-voice selector/start/restore action is disabled and the UI reports `installation required` plus missing steps instead of `starting`. A stale selection or failed start restores a non-local TTS provider and writes the same rollback to `config.json`, Agent config, and `slots-manifest.json`. Automatic runtime restore requires both `localVoiceEnabled=true` and `ttsEnabled=true`. | Rust status classification + Settings/onboarding blocked-state, auto-restore, start-failure rollback tests + real-UI desktop/narrow acceptance |
| **FR-V017.12** | The Windows installer contains a version-pinned standalone VoxCPM2 TensorRT service runtime, including Python/CUDA/PyTorch/TensorRT dependencies and reference voices. Release staging fails when that runtime artifact is absent or differs from the pinned manifest. The user machine downloads only the pinned VoxCPM2 model content and prepares the SM-specific TensorRT engine; it never installs Python or packages. `install_voxcpm2_runtime` is single-flight, writes a durable log, atomically prepares/verifies the model engine, and returns refreshed status. The generic Cascade loader, façade, source tree, process state, and PID namespace are not prerequisites of this Windows local-voice path. | standalone runtime artifact/manifest staging tests + Rust VoxCPM2 command/process/classification tests + Settings/onboarding progress/error/retry + clean RTX Windows install/start acceptance |
| **FR-V017.13** | Both Windows installer formats remove Naia-owned roaming/local WebView and bootstrap state on uninstall while preserving user ADK content. Workspace `onboardingComplete` is never sufficient by itself to skip onboarding after local app state was removed. Same-version uninstall/reinstall must show onboarding and hold no prior credential. | NSIS hook and WiX cleanup payload tests + boot merge/security tests + silent uninstall/reinstall acceptance |
| **FR-V017.14** | The bundled live-action `naia` NVA card has an explicit crop modifier that moves the crop window lower into the tall source and zooms to its manifest face region. Desktop and narrow Playwright acceptance assert that modifier against the real Naia WebM and inspect screenshots; generic media-overflow geometry alone is not completion evidence. | component identity/modifier test + desktop/narrow Playwright bounding position and screenshot review |
| **FR-V017.15** | Onboarding completion remains incomplete on disk until config/key persistence, live Agent `reload_settings`, and strict credential replay all succeed. Credential replay errors are caller-visible on this path; killing and reopening after any failed phase must return to onboarding. | transaction ordering/failure/restart component tests + first-turn installed acceptance |
| **FR-V017.16** | Diagnostics Agent logs resolve to `~/.naia/logs/agent-stderr.log`; no visible control references the retired, unwritten `llm-debug.log`. | component and Playwright log-path tests |
| **FR-V017.17** | Staging verifies `better-sqlite3` against the exact bundled Node executable and ABI. A mismatched native module fails staging instead of shipping as a latent optional-path crash. | stage-agent ABI contract + bundled-node `require()` smoke |
| **FR-V017.18** (#449) | A successful onboarding login is committed only after the credential is persisted, the live chat core has acknowledged settings/credential activation, and the authenticated balance has been fetched with that credential. The operation is single-flight and idempotent for duplicate callbacks. Any failed phase keeps onboarding open with a retryable error; restarting the app is not an accepted recovery. | auth activation state-machine tests + onboarding component ordering/error tests + clean-profile Playwright first-balance/first-chat acceptance |
| **FR-V017.19** (#450, supersedes the disabled-selector behavior in FR-V017.11 and the generic-loader packaging clause in FR-V017.12 for Windows voice-only) | On Windows NVIDIA hardware meeting the 6 GB gate, selecting local VoxCPM2 while unprepared starts a transactional `windows_trt_6g` flow. Shell verifies the bundled TRT service runtime, downloads the pinned model, prepares and verifies the device-SM TensorRT LocDiT engine, launches the direct VoxCPM2 service, requires health to report `profile=windows_trt_6g` and `backend=tensorrt_locdit`, then atomically persists `naia-local-voice`. Failure rolls every provider/enable/slot value back and permits retry. Remote/no-local-GPU Cascade remains a separate WebSocket provider and its protocol/lifecycle must not be changed by local TRT work. | Rust direct VoxCPM2 install/launch/status tests + remote Cascade `/health` and `/ws` preservation probe + Settings/onboarding transaction tests + clean Windows native acceptance; RTX 2070 is measurement-gated |
| **FR-V017.20** (#451) | On first entry to the onboarding avatar step, the resolved default appearance is published to the live preview once its asset is available, without requiring a click. The initialization is idempotent and cannot overwrite a subsequent explicit pointer or keyboard choice. Selected-card semantics, preview, loading/error recovery, and narrow layout remain aligned and accessible. | component event-order tests + Playwright visual/keyboard/desktop/narrow acceptance |
| **FR-V017.21** (#452) | Herdr first-open readiness is an explicit phase machine covering process spawn, API/socket readiness, page navigation, and renderer readiness. Each phase has a bounded timeout and phase-specific failure evidence. Loading always resolves to ready or an accessible retryable error; a black terminal surface is forbidden. Retry preserves the active workspace and restarts only the failed layer. | Rust lifecycle/state tests + Workspace component/Playwright absent/delayed/exit/page/renderer/retry states + e2e-tauri clean-profile smoke |
| **FR-V017.22** (#451) | A fresh public `naia-adk` checkout includes both official Naia VRM assets, `naia_char_skin_head.vrm` and `naia_char_with_hair.vrm`, in `naia-settings/vrm-files`. Onboarding discovers them through the same ADK inventory path as the four existing VRMs and renders a loaded, filename-matched WebP thumbnail for every card. Existing VRMs and the default selected Naia NVA remain available and unchanged. | tracked-asset name/size/SHA-256 inspection + avatar preset tests + Playwright six-card image-load/selection/desktop/narrow acceptance |
| **FR-V017.23** (#453) | The standalone `voxcpm2-tensorrt` repository owns the Windows TensorRT implementation and release artifact. `naia-shell` owns only artifact pinning and verification, staging, installation orchestration, process lifecycle, UI, and explicit provider selection. Build and runtime must succeed with `naia-labs`, `naia-omni`, and `naia-omni-cascade` absent. Release staging reads no sibling service source and packages no private-repository path; the legacy external Cascade provider remains an independent explicit provider with no local-TRT fallback in either direction. | standalone source-boundary scan + clean artifact-staging fixture + Shell platform/build contract + remote Cascade preservation tests |
| **FR-V017.24** (#453) | The release runtime contract pins schema, Windows TRT kind, loopback transport, source provenance, Python/PyTorch/CUDA/TensorRT/VoxCPM/ONNX/safetensors versions, model repository/revision, reference-voice provenance/hash, and every artifact object's relative path, byte size, and SHA-256. Staging rejects missing, extra, size-drifted, hash-drifted, or contract-drifted files before copying them. The artifact contains the runtime and reference voice but excludes the VoxCPM2 model and generated TensorRT engine. | manifest schema/object verification unit tests + altered-artifact mutation cases + release workflow artifact contract |
| **FR-V017.25** (#453) | `VOXCPM_MODEL_DIR` is mandatory for the Shell service and must name a materialized directory containing the pinned model files. The service and TensorRT builder never call `snapshot_download` or use a Hugging Face cache fallback. The installer alone may acquire the pinned model, writes it atomically to the managed model directory, then builds and verifies the SM-specific engine from that local directory. | Python unit tests for missing/incomplete/local model + source contract scan + offline restart acceptance |
| **FR-V017.26** (#453) | Any bundled default reference voice must be an approved product asset with recorded provenance and SHA-256; an unapproved local test voice is never release-eligible. User selection/upload remains under Shell-managed state and survives service restart. A clean RTX 4060 acceptance must detect the GPU, install no packages, download only the model, build the engine, pass health with TRT identity, synthesize two Korean utterances, restart the process without re-downloading/rebuilding, and retain the selected reference voice; failure preserves actionable logs. | Python/Rust/UI tests + actual RTX 4060 install/build/health/two-speech/restart/log evidence |

## 2026-08-17 VoxCPM2 TensorRT private-runtime supersession (#453)

This section supersedes FR-LOCAL-VOICE.2 and FR-V017.23 through FR-V017.26
where they say local VoxCPM2 works without login, distributes public Nextain
source, bundles a default voice, downloads only the model, or may adopt an
unrelated direct TRT service on port 8910.

| ID | Normative requirement | Verification |
|---|---|---|
| **FR-V017.27** | `nextain/voxcpm2-tensorrt` remains a standalone private repository. Shell packages only a digest-pinned compiled artifact and rejects Nextain `.py` source, model/engine files, unapproved voices, missing SBOM/notices, and sibling-project content. OpenBMB/VoxCPM2 Apache-2.0 attribution and third-party rights remain intact. | standalone proprietary release-payload gate + Shell staging inventory tests |
| **FR-V017.28** | Install and start require a securely stored Naia login. At process start Shell sends the credential once through child stdin, never argv/environment/logs, and the compiled runtime fails closed unless the authoritative gateway reports an active BASIC/PRO entitlement. Only a separate random per-launch loopback bearer reaches the WebView. | Rust credential/pipe tests + runtime activation/auth tests + log redaction assertion + native E2E |
| **FR-V017.29** | The release contains no default reference voice until an asset has explicit authorization, provenance, digest, and release approval. A user-authorized upload is stored in Shell-managed state. `local-test-only:not-for-release` audio is test input only. | artifact negative inventory + upload/restart E2E |
| **FR-V017.30** | The Windows installer performs any pinned NVIDIA package acquisition automatically during the explicit online preparation transaction. It does not redistribute an unreviewed TensorRT developer environment. Engine build and synthesis remain offline. | package-origin receipt + artifact NVIDIA inventory audit + clean Windows install |
| **FR-V017.31** | Shell sends complete sentences to TTS as they become available from the LLM stream. It does not wait for the full answer, and the runtime never owns LLM segmentation. | streaming sentence-order/unit tests + real Shell first-audio E2E |
| **FR-V017.32** | Audio watermarking is omitted unless the standalone ON/OFF benchmark recovers the exact payload with SDR >=45 dB, p95 RTF/wall-time overhead <=10%, first-audio overhead <=250 ms, VRAM increase <=256 MiB, and the 6 GiB profile remains valid. | pinned benchmark report; omission is the default on any failed/missing gate |
| **FR-V017.33** | Direct local TRT and Cascade remain separate providers and processes. TRT install/start/stop/failure never modifies, adopts, kills, deploys, or silently calls Cascade. Cascade regression uses the observation-only `higher-injured-served-maine.trycloudflare.com` health/WS baseline. | process/route diff + external health/WS before/after evidence |
| **FR-V017.34** (#453) | VoxCPM2 release staging, completed-ZIP audit, installed-payload activation, and default reference-voice provisioning consume one tracked activation contract covering every archive-owned required file/directory, every installer-created runtime directory, the exact compiled entry module, and the approved default WAV's HTTPS URL/byte count/SHA-256. A release build fails before Tauri packaging if either the source artifact or selected completed ZIP cannot satisfy the archive-owned contract. The installer materializes declared empty runtime-state directories because ZIPs may omit them, downloads the default WAV outside the immutable artifact, validates its RIFF/WAVE header and pinned digest before atomic activation, and records it in the runtime-ready receipt. Missing or corrupt reference audio keeps `canStart=false`; runtime rejection names the failed reference-voice step instead of allowing a service that returns `no_reference_voice`. File-inventory manifests continue to exclude their own manifest file, while archive inventory counts the manifest itself; that intentional difference is not an activation failure. | activation-contract fixture mutations + selected real ZIP audit + installer default-voice contract tests + Rust missing/corrupt voice readiness tests + final release build preflight |
| **FR-V017.35** (#453) | The public VoxCPM2 archive URL has one tracked production default. Release staging performs a credential-free HTTPS HEAD and one-byte range GET, requires HTTP 200/206 and the exact pinned archive byte count, and fails before installer packaging on an inaccessible, private, redirected, or drifted object. A manually supplied URL cannot bypass this availability gate. | staging URL/probe unit tests + live R2 HEAD/range release preflight + generated download-manifest inspection |
| **FR-V017.36** | Windows updates replace complete installer-owned Agent/runtime/dependency trees instead of overlaying stale `node_modules`. A full NSIS or MSI uninstall removes the exact Naia install root plus Naia-owned roaming/local application state, while preserving `~/.naia` user memory and user workspaces. | NSIS/WiX payload contract tests + update stale-file mutation + full uninstall residue and user-state preservation smoke |
| **FR-V017.37** (#465) | An installed VoxCPM2 payload is reusable only when both its installer script and activation contract are byte-identical to the control files packaged by the running Shell. A stale but structurally valid payload is atomically restaged from the digest-verified local archive cache, without downloading the multi-gigabyte archive again. Release staging must run the default-only v0.1.7 payload to eight-voice palette upgrade regression before packaging. | Rust control-file digest and stale-payload regression + release-stage targeted test gate + cached-archive upgrade smoke |
| **FR-V017.39** (#537) | Local VoxCPM2 runs on Linux through the same standalone path as Windows: one digest-pinned `linux_trt_6g` artifact from `nextain/voxcpm2-tensorrt`, one `bash` installer (`src-tauri/linux/prepare-voxcpm2-model.sh`) that mirrors the Windows installer phase for phase (artifact verification, reference-voice palette, installer-acquired NVIDIA packages into `python-packages`, receipt-verified model, atomically swapped GPU-local engine, ready receipt), and the same compiled `http_server` spawn. The Shell picks PowerShell or bash from the operating-system layout (`voice_runtime::layout`), never from a second code path. The same rule binds the build side: whatever stages the installer script and the download manifest into a resource directory resolves both through the `VOXCPM2_PROFILES` registry rather than naming a file. A staging script that spells an installer name or ships a manifest whose `profile` does not match the host is a defect, because the Rust side then reports the installer missing and the Shell normalizes a half-finished install back to browser speech without saying so (#537 실측, 2026-09-05). On Linux the installer-acquired set includes the CUDA library wheels the PyTorch wheel loads, and archive extraction restores the ZIP entries' unix modes so the bundled interpreter is executable. Cascade is neither consulted nor started. | Rust `voice_runtime` unit tests; `bash -n` on the installer; real-machine evidence on RTX 3090 (Bazzite): installer log, `VOXCPM2_READY` announcement with `profile: linux_trt_6g`, non-silent Korean synthesis captured as WAV (#537) |
| **FR-V017.38** (#518) | 설치 payload 재사용은 제어 파일 일치에 더해, 러닝 셸이 번들한 `download-manifest.json`의 `artifactManifestSha256`이 설치 payload의 `artifact/artifact-manifest.json` 해시와 일치할 때만 허용된다. 제어 파일은 그대로 두고 런타임 아카이브만 갱신한 릴리즈(예: v0.2.2 r2의 #478 째짐 수정)가 기존 설치자에게 도달하지 못한 채 구조 유효한 구 payload 가 영구 재사용되는 것을 막는다. 핀 불일치 payload는 재사용 불가로 판정되어 기존 취득 플로우(캐시 ZIP 우선, 없으면 재다운로드)로 재스테이징된다. dev/e2e 번들 루트 분기는 이 핀 검사의 대상이 아니다. | Rust reuse-gate 단위(핀 일치/불일치/manifest 부재) + 실 payload 해시 대조 회귀 |

## v0.2.0 signed Windows updater recovery (2026-08-20)

> Status: in progress. The automated gates can prove configuration, artifact,
> signature, feed, and download-byte integrity. The final installed v0.1.9 to
> v0.2.0 install/relaunch acceptance is recorded only after the field run.

| ID | Normative requirement | Verification |
|---|---|---|
| **FR-UPDATE.1** | `packages/shell/package.json`, the Shell crate and lock entry, and `releases/v0.2.0.yaml` declare exactly `0.2.0`. The production updater endpoint is `nextain/naia-shell/releases/latest/download/latest.json`, and its tracked public key is byte-identical to the approved `data-private/key/naia-tauri.key.pub`; private key bytes and passwords never enter Git, command output, or release assets. | version/config contract test + public-key equality by digest/value comparison + tracked-secret scan |
| **FR-UPDATE.2** | Windows release staging sets `createUpdaterArtifacts=true` while Linux and macOS remain false. Both NSIS and MSI outputs have non-empty Tauri signatures generated by the approved encrypted key. A release is blocked when either signature or signing password is absent. | platform-matrix golden + signed bundle artifact gate + Tauri public-key verification |
| **FR-UPDATE.3** | Static metadata uses the default Tauri v2 target key `windows-x86_64` exactly once and points it to one canonical NSIS updater asset with that asset's exact signature. MSI and its signature remain downloadable integrity/manual-install assets; fabricated `windows-x86_64-nsis` or `windows-x86_64-msi` keys are forbidden unless the application explicitly configures a matching custom target. | updater-manifest unit/schema test + plugin-compatible target probe |
| **FR-UPDATE.4** | The canonical `nextain/naia-shell` feed and the legacy `nextain/naia-os` compatibility feed expose the same v0.2.0 metadata and canonical artifact URL while v0.1.8/v0.1.9 remain installed. Every public URL is checked unauthenticated; the downloaded bytes must match the published SHA-256 manifest. | dual-endpoint HTTP/JSON/signature/byte-hash release probe |
| **FR-UPDATE.5** | Updater transport, malformed metadata, target mismatch, download, and signature failures remain errors in the Settings surface and are never presented as up to date. Only an explicit plugin result of no update yields the latest-version state. | updater and Settings component tests |
| **FR-UPDATE.6** | Release completion requires the v0.2.0 NSIS/MSI installers, both signatures, `latest.json`, SHA-256 manifest, and release notes in one public release. An installed v0.1.9 client must discover, install, relaunch, and report v0.2.0 before the field acceptance is marked done. | GitHub release asset inventory/hash probe + installed v0.1.9 field acceptance |
| **FR-UPDATE.7** (#468) | After onboarding, an updater-enabled Shell checks for an update once per app start. A missing update, disabled updater, network failure, or invalid feed never opens the startup prompt and never blocks the rest of startup. | startup Playwright invoke count + updater failure unit tests |
| **FR-UPDATE.8** (#468) | An available update opens an accessible localized modal that identifies the current and new versions and exposes release notes. Download, install, and relaunch begin only after the member explicitly selects `Update now`; opening the prompt, toggling the checkbox, `Later`, or Escape never installs. | `UpdatePrompt` component tests + startup Playwright consent assertion |
| **FR-UPDATE.9** (#468) | `Don't show again for a month` stores the selected update version and an expiry exactly 30 days after dismissal. The same version is hidden before expiry, reappears at expiry, and a different newer version bypasses the deferral immediately. Corrupt or unavailable local storage fails open to showing the prompt instead of silently suppressing updates. | deterministic clock/storage unit tests + reload/new-version Playwright acceptance |
| **FR-UPDATE.10** (#468) | `Later` without the one-month choice closes only the startup modal and preserves the existing update banner. Deferral hides both startup prompt and banner for that version. The Settings manual update check remains independent, and install failure keeps the prompt actionable with a localized error instead of reporting success. | component and Playwright state transition tests + existing Settings update tests |

## v0.2.1 installed app storage recovery (#472)

| ID | Normative requirement | Verification |
|---|---|---|
| **FR-APP-STORAGE.1** | Install, list, restart discovery, and remove share the canonical `~/.naia/apps/{appId}` store. A valid legacy `~/.naia/apps/*` install is moved once by manifest id; canonical duplicates win without deleting legacy data. | isolated-home Rust migration/remove lifecycle tests |
| **FR-APP-STORAGE.2** | App ids are strict single path segments. Symlinks, traversal, malformed ids, duplicate ids, and canonical-path escapes cannot delete or replace data outside the canonical app store. | Rust adversarial filesystem tests |
| **FR-APP-STORAGE.3** | A disk removal failure preserves the registered app and is surfaced as an accessible UI error; the Shell never reports removal by hiding only its in-memory entry. | app-loader and AppBar component tests |

## v0.2.1 Workspace Markdown viewer (#474)

| ID | Normative requirement | Verification |
|---|---|---|
| **FR-WORKSPACE-MARKDOWN.1** | Selecting `.md` or `.markdown` in FileTree opens a GFM preview by default and retains the existing document-tab lifecycle. The user can switch between preview and source, and an oversized or unreadable document shows a bounded, retryable error instead of blocking the shell. | viewer component tests + Linux Chromium FileTree journey |
| **FR-WORKSPACE-MARKDOWN.2** | Relative links and images resolve from the current document or Workspace root. Canonical file reads remain enforced by the Rust Workspace boundary; traversal, raw HTML, script, protocol-relative content, and dangerous URL schemes cannot execute or read outside the Workspace. HTTP(S) links use the explicit system opener. | resolver/security/image tests + Rust boundary tests |
| **FR-WORKSPACE-MARKDOWN.3** | The preview exposes an article landmark, keyboard focus indication, semantic GFM tables/tasks/headings, descriptive external-link text, and honest missing-image status while preserving code, image, PDF, CSV, and log viewers. | accessibility component assertions + existing viewer regression suite |

## v0.2.2 thinking/final response separation (#479)

| ID | Normative requirement | Verification |
|---|---|---|
| **FR-CHAT-THINKING.1** | Structured thinking events and case-insensitive `<think>…</think>` text tags are accumulated only in the message `thinking` field. Tag tokens may be split at any stream boundary; neither tokens nor enclosed text may enter visible final content, the sentence chunker, or the TTS pipeline. Text following the closing tag remains complete and ordered. | incremental filter unit tests over every tag boundary + ChatArea TTS integration regression |
| **FR-CHAT-THINKING.2** | Streaming and persisted thinking use a separate semantic disclosure that is closed by default. This display rule never changes the unconditional exclusion of thinking from speech. | ChatArea component assertions for streaming/persisted closed disclosure, final answer rendering, and keyboard-accessible summary |
## v0.2.2 LLM→TTS 발화 텍스트 정규화 단일화 (#480)

- `FR-VOICE-TEXT.1`: 모든 TTS provider 경로는 `text-filter`의 공통 규칙과 locale별 확장 규칙을 거친 동일한 발화 문자열만 사용해야 한다.
- `FR-VOICE-TEXT.2`: 필터는 Markdown 표식만 제거해 본문을 보존하고, fenced code/Mermaid, URL, 제어 태그, 이모지·이모티콘과 장식 문자를 제거해야 한다.
- `FR-VOICE-TEXT.3`: inline code는 locale 레지스트리와 기본 fallback으로 처리하고, 정규화 결과가 비면 발화 요청을 생성하지 않아야 한다.
- `FR-VOICE-TEXT.4` (#540): 필터는 이모지 외 카오모지 구성 문자(IPA·발음기호 확장, 수식·결합 기호, 반각 가나, 불릿, 기타 기호 `\p{So}`·`\p{Sk}`)와 조각 자모 나열(ㅋㅋ·ㅠㅠ)을 제거하고, 제거 후 남는 빈 괄호 쌍을 정리해야 한다. 한글·영문·일문·중문 본문과 정상 문장부호·숫자는 보존한다.
- `FR-VOICE-TEXT.5` (#540): ko locale(및 본문이 한글인 fallback)은 발화 전에 숫자를 한국어 읽기로 정규화해야 한다 — 연대·연도·한자어 단위는 한자어 수사(구십 년대), 고유어 단위 1~99는 관형 고유어 수사(세 시), 소수점(삼 점 오)·천단위 콤마·%·℃·구분자 숫자열 자리읽기. 단위 분류는 데이터 테이블로 확장하며 다른 locale의 숫자 표기는 바꾸지 않는다.
### FR-CHAT-MARKDOWN.1 — 안전한 채팅 Markdown

assistant 채팅은 GFM을 렌더링하되 원시 HTML 및 스크립트를 실행하지 않아야 한다.

### FR-CHAT-MARKDOWN.2 — 코드와 Mermaid

fenced code는 언어·복사·접기·워크스페이스 전환을 제공하고, Mermaid는 워크스페이스와 공유하는 strict 렌더러를 사용하며 실패 시 원문을 보존해야 한다.

### FR-PERMISSION-SHORTCUT.1 — 권한 팝업 공통 단축키 (#477)

도구 권한 팝업은 실행 `Alt+Y`, 항상 실행 `Alt+A`, 취소 `Alt+N`을 하나의 공통 정의에서 표시·해석하고, macOS에서는 같은 Alt 키를 Option 기호로 표시한다. 팝업이 열린 동안에만 수정키가 정확히 일치하는 최초 keydown을 한 번 처리한다.

## v0.2.2 local release acceptance

| ID | Issue | Normative requirement | Verification |
|---|---:|---|---|
| **FR-BGM-PLAYBACK.1** | #430 | 늦은 YouTube 재생 확인은 실제 실패로 오인하지 않고, 임베드 차단은 침묵이나 거짓 재생 상태가 아닌 복구 가능한 오류로 표시한다. | BGM 상태 단위 테스트 + 브라우저 패널 도구 E2E |
| **FR-WORKSPACE-PATH.1** | #432 | 터미널 파일 경로는 플랫폼 기본 보조키로만 열리고 일반 클릭·드래그 선택을 보존한다. | 플랫폼 단축키 단위 테스트 + Workspace 브라우저 E2E |
| **FR-LOCALE-BOOT.1** | #437 | 저장 언어 또는 OS 언어를 첫 화면 전에 적용하며 온보딩·복구·Host 설치 상태에 백엔드 영문 원문을 노출하지 않는다. | locale hydration/온보딩 컴포넌트 + 한국어 브라우저 E2E |
| **FR-PROVIDER-BASE-URL.1** | #475 | 로컬 OpenAI 호환 provider의 Base URL을 검증·저장하고 실제 요청에 동일하게 적용한다. | URL 정규화 단위 테스트 + 설정 브라우저 E2E |
| **FR-WORKSPACE-MEDIA.1** | #482 | MP3/WAV/MP4는 텍스트로 읽지 않고 바이너리로 읽어 로컬 Blob URL을 사용하는 오디오·비디오 컨트롤로 연다. | viewer registry/component + FileTree 브라우저 E2E |
| **FR-CHAT-MARKDOWN.3** | #483 | 코드 블록은 안전한 구문 강조, 정확한 복사와 성공 피드백을 제공한다. Mermaid는 strict 렌더링하며 실패 시 원문을 보존한다. | MarkdownCodeBlock 단위 테스트 + 실제 채팅 브라우저 E2E |
| **FR-WORKSPACE-HERDR.2** | #492 | Herdr snapshot이 멈추거나 실패해도 설정된 Workspace 파일 트리는 독립적으로 표시된다. | runtime hook 단위 테스트 + stalled snapshot 브라우저 E2E |
| **FR-BGM-VIDEO.1** | #493 | YouTube iframe을 유지한 채 배경 영상만 숨겨 오디오 재생을 지속하고 선택을 저장한다. | BGM 컴포넌트 + 브라우저 패널 E2E |
| **FR-BGM-VIDEO.2** | #476 | YouTube iframe은 해당 재생이 실제로 관측(playing/진행)되기 전에는 기존 배경을 덮지 않으며, error·timeout·ended 시 기존 배경을 다시 보인다. 임베드 실패가 검은 화면으로 나타나서는 안 된다. | BgmPlayer 단위 테스트(`data-bgm-youtube-live` 게이트) + 패키지드 Windows 실기 확인 |
| **FR-BGM-FAV.1** | #476 | YouTube 즐겨찾기는 사용자 데이터로서 워크스페이스 SoT(naia-settings config `bgmYoutubeFavorites`)에 저장한다. 기존 webview localStorage 사본은 1회 마이그레이션 후 정리하며, 워크스페이스 사본이 존재하면(빈 배열 포함) 그것이 유일한 진실이다. BgmPlayer와 bgm-skill 두 읽기 경로 모두 동일 SoT를 따른다. | BgmPlayer 마이그레이션/영속 단위 테스트 + bgm-skill 기본 리더 단위 테스트 + bgm-skill E2E 즐겨찾기 흐름(워크스페이스 SoT `bgmYoutubeFavorites` 판독) |
| **FR-BGM-STATE.1** | #494 | 음표 애니메이션은 YouTube의 authoritative playing 이벤트에서만 활성화한다. | player event 단위 테스트 + 브라우저 패널 E2E |
| **FR-BGM-CONTROL.1** | #495 | 실제 재생 중에는 정지, 정지 후에는 재생 동작과 라벨을 표시한다. | player control 단위 테스트 + 브라우저 패널 E2E |
| **FR-TTS-GLOBAL-OFF.1** | local QA | 상단 TTS를 끄면 현재 재생, 대기 문장, 진행 중 합성 및 브라우저 발화를 즉시 중단하며 이후 응답을 합성하지 않는다. | AiControlBar→ChatArea 통합 테스트 + 브라우저 E2E |
| **FR-VOICE-DEV-MANIFEST.1** | local QA | Windows 개발 실행도 검증된 v0.2.2 Host 다운로드 manifest를 명시적으로 전달하며 누락된 패키지로 위장하지 않는다. | dev launcher 계약 테스트 + 동일 debug 바이너리 설치 상태 확인 |
| **FR-VOICE-SELECT.1** | #507 | 설치된 Host 음성을 설정에서 선택하면 엔진을 자동 시작하고 진행을 표시한다. 시작 실패나 차단으로 선택을 되돌릴 때는 사유와 되돌림 안내를 프로필·음성 화면 모두에 표시하며 무언 revert 를 하지 않는다. | SettingsTab 단위 테스트(자동 시작·revert 사유 표기) + settings-slots 브라우저 E2E |
| **FR-VOICE-DEV-STAGING.1** | #508 | dev(`tauri-with-mode`)와 e2e(`build-e2e-tauri`) 실행은 installer 리소스 3종(prepare-voxcpm2-model.ps1, voxcpm2-activation-contract.json, download-manifest.json)을 Rust 가 읽는 resource_dir(`<target>/debug/voxcpm2-runtime/`)에 멱등 스테이징한다. 설치 완료된 payload 가 개발 실행에서 미설치로 위장되지 않는다. | `scripts/__tests__/stage-voxcpm2-runtime.test.ts` debug 스테이징 계약 |
## 기능 요구사항 (FR) — 워크스페이스 컨텍스트 해석 (#501, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 출처 시나리오: `user-scenarios.md`의
> `UC-WORKSPACE-CONTEXT-*` 네 항목. 상태: 전부 Pending.

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-WORKSPACE-CONTEXT.1** | 워크스페이스 루트를 정규화된 절대 경로 하나로 확정하고, 그 루트의 진입점 문서와 진입점이 필수로 선언한 인덱스만 발견 대상으로 삼는다. 워크스페이스 이름·경로를 코드에 상수로 두지 않으며, 진입점이 선언하지 않은 문서는 발견 목록에 넣지 않는다. | UC-WORKSPACE-CONTEXT-DISCOVER | `src/test/workspace-context-discover.contract.test.ts` 진입점 발견·선언 밖 미로드 | Done |
| **FR-WORKSPACE-CONTEXT.2** | 발견과 로딩을 분리한다. 발견은 항상 수행하고, 실제 문서 로딩은 현재 사용자 의도가 요구하는 것만 수행한다. 로드한 문서 집합과 로드 사유(어느 선언이 그것을 요구했는지)를 컨텍스트와 함께 보관하고 조회할 수 있게 한다. 한 요청에서 로드하는 총량에 상한을 둔다. | UC-WORKSPACE-CONTEXT-DISCOVER | `src/test/workspace-context-selective-load.contract.test.ts` 의도별 선택·상한 | Done |
| **FR-WORKSPACE-CONTEXT.3** | 프로젝트 진입은 작업 디렉터리 변경이 아니라 컨텍스트 전환으로 처리한다. 진입 시 그 프로젝트의 진입점과 프로젝트 전용 필수 컨텍스트를 추가 로드하고, 같은 주제에서 프로젝트 선언이 루트 선언보다 우선한다. 진입 사실과 결과 컨텍스트는 관측 가능하다. | UC-WORKSPACE-CONTEXT-ENTER-PROJECT | `src/test/workspace-context-enter-project.contract.test.ts` 중첩 로드·우선순위 | Done |
| **FR-WORKSPACE-CONTEXT.4** | 컨텍스트는 권한을 만들지 않는다. 어떤 문서를 읽었다는 사실이 그 경로에 대한 변경 권한이 되지 않으며, 부모 워크스페이스·형제 프로젝트·직전 프로젝트의 선언에서 현재 작업의 권한을 유추하지 않는다. | UC-WORKSPACE-CONTEXT-ENTER-PROJECT | `src/test/workspace-context-enter-project.contract.test.ts` 권한 비확장 negative | Done |
| **FR-WORKSPACE-CONTEXT.5** | 프로젝트를 전환하면 이전 프로젝트의 지역 컨텍스트를 폐기하고 사용자가 명시한 의도만 유지한다. 전환 후 응답의 근거 목록에 이전 프로젝트 문서가 남지 않는다(교차 누출 0). | UC-WORKSPACE-CONTEXT-SWITCH-PROJECT | `src/test/workspace-context-switch-project.contract.test.ts` 폐기·의도 보존·누출 0 | Done |
| **FR-WORKSPACE-CONTEXT.6** | 컨텍스트에 단조 증가하는 개정 번호를 부여한다. 진입·전환·디스크상 문서 변경은 개정을 무효화하고, 무효화된 개정을 근거로 한 응답은 만들지 않는다. 현재 개정과 그 구성 문서는 조회 가능하다. | UC-WORKSPACE-CONTEXT-SWITCH-PROJECT | `src/test/workspace-context-revision.contract.test.ts` 단조 증가·갱신 반영 | Done |
| **FR-WORKSPACE-CONTEXT.7** | 진입점 부재, 형식 오류, 선언된 인덱스 부재는 추측으로 메우지 않고 실패로 처리한다. 실패 보고는 무엇을 어디서 찾았고 왜 실패했는지와 사용자가 취할 조치를 포함한다. 부분 로드 상태를 정상 컨텍스트로 승격하지 않는다. | UC-WORKSPACE-CONTEXT-BROKEN-ENTRYPOINT | `src/test/workspace-context-failure-honesty.contract.test.ts` 세 가지 실패 진단 | Done |
| **FR-WORKSPACE-CONTEXT.8** | 심볼릭 링크, 상위 경로 표기, 마운트 경계를 거쳐 확정 루트 밖을 가리키는 경로는 발견·로딩 모두에서 거부한다. 거부는 조용한 무시가 아니라 명시적 진단이다. | UC-WORKSPACE-CONTEXT-BROKEN-ENTRYPOINT | `src/test/workspace-context-path-boundary.contract.test.ts` 탈출 negative | Done |
| **FR-WORKSPACE-CONTEXT.9** | 워크스페이스를 노출하는 표면은 타입이 선언된 자원과 도구로 제공한다. 자원은 현재 워크스페이스, 컨텍스트 목록, 개별 문서, 프로젝트 목록, 스킬 목록, 거버넌스 선언을 포함하고, 도구는 발견·프로젝트 진입·컨텍스트 해석·문서 읽기·갱신·작업 결속을 포함한다. 각 표면은 스키마 버전과 현재 개정을 함께 싣는다. | UC-WORKSPACE-CONTEXT-DISCOVER·ENTER-PROJECT | `src/test/workspace-context-discover.contract.test.ts`·`src/test/workspace-context-enter-project.contract.test.ts` 스키마 계약 | Done |

## 기능 요구사항 (FR) — Herdr 제어면 (#502, 에픽 #497, #434 승계)

> 계약: `docs/progress/issue-497-universal-agent.md`. 출처 시나리오: `user-scenarios.md`의
> `UC-HERDR-CONTROL-*` 네 항목. FR-HERDR.4의 P3를 구체화한다. #434의 인수 기준을 약화 없이 승계한다.
> 상태: 전부 Pending.

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-HERDR-CONTROL.1** | space, 이슈, 세션, 작업자, pane, 터미널, 진행 중 작업, 이벤트를 타입이 선언된 자원으로 노출한다. 각 자원은 스키마 버전과 안정된 식별자를 갖는다. 화면 문자열 파싱과 private TUI socket 접근은 제어 경로에 존재하지 않는다. | UC-HERDR-CONTROL-OBSERVE | `src/test/herdr-control-resource-schema.contract.test.ts`·`src/test/herdr-control-no-screen-scrape.contract.test.ts` | Done |
| **FR-HERDR-CONTROL.2** | 버전이 붙은 스냅샷과 이벤트 구독을 함께 제공한다. 개정 번호는 단조 증가하고, 구독이 구간을 놓치면 그 사실을 소비자가 알 수 있어야 한다. 놓친 구간을 정상으로 가장하지 않는다. | UC-HERDR-CONTROL-OBSERVE | `src/test/herdr-control-resource-schema.contract.test.ts` 개정·누락 감지 | Done |
| **FR-HERDR-CONTROL.3** | 제어 조작(space·tab·pane 생성·포커스·종료, 작업자 생명주기, 중단·재개, 결과 수집)은 타입이 선언된 메서드와 구조화된 인자로 한다. ⚠️ 2026-08-26 실측 정정: pane 안에서 임의 명령을 실행하는 argv 경로가 Herdr 프로토콜 19 에 없다(`pane.run` 부재, `pane.send_text` 계열 텍스트 입력만 존재). 따라서 이 요구사항은 *제어면*에만 적용하고 명령 실행은 분리해 인용 책임을 호출자에게 명시한다. raw PTY stdin 과 private socket 을 제어 프로토콜로 쓰지 않는다는 조항은 그대로 유지한다. | UC-HERDR-CONTROL-MUTATE | `src/test/herdr-control-mutation.contract.test.ts` 구조화 인자·조립 negative | Done |
| **FR-HERDR-CONTROL.4** | 모든 변경 요청은 요청 식별자와 멱등 키를 받는다. 같은 멱등 키의 재전송은 프로세스나 명령을 중복 생성하지 않고 최초 결과를 반환한다. ⚠️ 실측: Herdr 프로토콜 19 에 멱등 키가 없고 요청 `id` 는 상관용이다. 중복 제거는 셸이 메우며 셸이 재시작하면 그 보장은 사라진다 — 이 한계를 감춘 채 "멱등하다"고 말하지 않는다. | UC-HERDR-CONTROL-MUTATE | `src/test/herdr-control-idempotency.contract.test.ts` 중복 생성 0 | Done |
| **FR-HERDR-CONTROL.5** | 모든 변경은 영향을 받은 자원 식별자와 증거 참조(출력·로그·산출물)를 반환한다. 증거 없는 성공 응답을 만들지 않는다. | UC-HERDR-CONTROL-MUTATE | `src/test/herdr-control-mutation.contract.test.ts` 증거 반환 | Done |
| **FR-HERDR-CONTROL.6** | 권한은 등급으로 분리한다. 관측, 워크스페이스 내부 변경, 자격증명 사용, 외부 발신, 파괴적·운영 변경은 각각 별도 권한을 요구하며 낮은 등급이 높은 등급을 상속하지 않는다. 승인 참조와 만료를 요청에 싣는다. | UC-HERDR-CONTROL-MUTATE | `src/test/herdr-control-capability-tier.contract.test.ts` 비상속 negative | Done |
| **FR-HERDR-CONTROL.7** | 변경 요청은 기대 개정 번호를 받는다. 현재 개정과 어긋나면 타입이 선언된 충돌을 반환하고 상태를 바꾸지 않는다. 무음 덮어쓰기는 발생하지 않는다. | UC-HERDR-CONTROL-STALE-REVISION | `src/test/herdr-control-stale-revision.contract.test.ts` 충돌·무음 덮어쓰기 0 | Done |
| **FR-HERDR-CONTROL.8** | 연결 끊김, 타임아웃, 프로세스 종료, 취소, 부분 완료를 서로 구별되는 결과 종류로 표현한다. 하나의 실패로 뭉뚱그리지 않으며, 결과 불명은 불명으로 보고한다. | UC-HERDR-CONTROL-RECONNECT | `src/test/herdr-control-outcome-taxonomy.contract.test.ts` 5종 구별 | Done |
| **FR-HERDR-CONTROL.9** | 재접속과 서버 재시작 복구에 상한을 둔다. 재접속 후에는 상태를 재확인한 뒤에만 판단하며, 상한에 닿으면 실패를 정직하게 보고한다. 재접속 자체가 완료·중단 판정의 근거가 되지 않는다. | UC-HERDR-CONTROL-RECONNECT | `src/test/herdr-control-reconnect-bounds.contract.test.ts` 상한·정직 실패 | Done |
| **FR-HERDR-CONTROL.10** | Herdr가 space, tab, pane, 터미널, 작업자 생명주기의 유일한 실행 정본으로 남는다. Shell은 경쟁하는 생명주기 소유자를 유지하지 않으며, 컨텍스트 전달에서 비밀값과 범위 밖 데이터를 제외한다. | UC-HERDR-CONTROL-OBSERVE·MUTATE (#434 승계) | 중복 surface/tool 정적 검사 + `packages/shell/e2e-tauri/specs/herdr-control.spec.ts` | Done |

> **프로토콜 19 실측 대조 (2026-08-26).** 위 요구사항은 우리가 원하는 것이고 Herdr 가 내주는 것은 별개다.
> 설치된 `herdr 0.8.0` 의 `api schema --json` 축약본이 `src/test/fixtures/herdr-protocol-19.json` 이고,
> 판정은 `src/main/domain/herdr-protocol.ts` 가 그 사실에서 계산한다(표를 손으로 적지 않는다).
> 판정 — 지원 `.1 .5 .10` / 부분 `.2 .3 .7 .8` / 미지원 `.4 .6 .9`.
> 셸이 메우는 것 `.2 .4 .6 .7 .8 .9` — 전부 셸 재시작으로 사라지는 보장이다.
> 요구사항 자체를 고쳐야 했던 것 `.3`(위 정정). Herdr 가 메서드·이벤트·필드를 바꾸면
> `src/test/herdr-protocol-conformance.contract.test.ts` 가 실패한다. 그 테스트는 이 머신에
> herdr 가 설치돼 있으면 살아 있는 바이너리와도 대조한다.

## 기능 요구사항 (FR) — 브라우저·터미널 환경 도구 (#499, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 출처 시나리오: `UC-ENV-TOOL-*` 네 항목.
> 기존 UC6·UC7·UC7a·UC13a를 확장한다. 2026-09-09 #582 가 .2·.6·.9 를 재개방하고 .10~.15 와 NFR 둘을 추가했다(계약: `docs/progress/issue-582-ego-browser-host.md`).

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-ENV-TOOL.1** | 브라우저와 터미널 작업이 하나의 공통 생명주기(접수·실행중·완료·실패·취소)를 공유한다. 각 상태 전이는 관측 가능하며 중간 상태를 완료로 승격하지 않는다. | UC-ENV-TOOL-BROWSE·CANCEL | `src/test/env-tool-browser.contract.test.ts`·`src/test/env-tool-cancel-timeout.contract.test.ts` | Done |
| **FR-ENV-TOOL.2a** | 브라우저 자원으로 작업 공간(격리 컨텍스트), 페이지, 스냅샷, 안정된 요소 참조를 노출한다. 도구는 공간 생성·열기·이동·스냅샷·클릭·입력·평가·캡처·닫기를 제공한다. (#582 에서 .2 를 분리. 실제 어댑터 기준) | UC-ENV-TOOL-BROWSE | `src/test/env-tool-browser.contract.test.ts`·`src/test/env-tool-browser-host.contract.test.ts` | In-progress |
| **FR-ENV-TOOL.2b** | 다운로드와 이벤트 스트림을 브라우저 자원으로 노출한다. (#582 범위 밖. 실제 어댑터가 제공하기 전까지 Pending) | UC-ENV-TOOL-BROWSE | — | Pending |
| **FR-ENV-TOOL.3** | 브라우저 조작은 스냅샷의 안정된 요소 참조를 우선 사용한다. 좌표 조작은 참조가 불가능한 경우로 제한하고 그 사실을 결과에 남긴다. | UC-ENV-TOOL-BROWSE | `packages/shell/e2e/env-tool-browser.spec.ts` 참조 기반 조작 | Done |
| **FR-ENV-TOOL.4** | 페이지 내용은 자료로만 취급한다. 페이지에 담긴 문장이 권한 확장, 승인 우회, 외부 발신의 근거가 되지 않는다. | UC-ENV-TOOL-BROWSE | `packages/shell/e2e/env-tool-injection.spec.ts` 주입 negative | Done |
| **FR-ENV-TOOL.5** | 터미널 자원은 Herdr의 터미널·세션·프로세스·출력 스트림을 참조하며, 생명주기 소유는 Herdr에 위임한다. 실행은 실행 파일과 인자 배열, 작업 디렉터리, 환경을 구조화해 전달하고 셸 문자열로 조립하지 않는다. | UC-ENV-TOOL-TERMINAL-EXEC | `src/test/env-tool-terminal.contract.test.ts` 위임·구조화 인자 | Done |
| **FR-ENV-TOOL.6** | 모든 작업은 증거를 반환한다. 브라우저는 구조 또는 접근성 스냅샷, 화면 캡처, 최종 주소와 개정을, 터미널은 종료 코드와 출력·로그·산출물 참조를 반환한다. | UC-ENV-TOOL-BROWSE·TERMINAL-EXEC | `src/test/env-tool-browser.contract.test.ts`·`src/test/env-tool-terminal.contract.test.ts`·`src/test/env-tool-workspace-resource.contract.test.ts`(`hasEvidence` 가 캡처 없는 완료를 거부)·`src/test/env-tool-browser-host.contract.test.ts`(캡처 파일 존재) | In-progress |
| **FR-ENV-TOOL.7** | 명령은 확정된 워크스페이스 경계를 명시적 권한 없이 벗어나지 못한다. 경계 이탈 시도는 조용히 무시하지 않고 명시적으로 거부한다. | UC-ENV-TOOL-TERMINAL-EXEC·BOUNDARY-DENY | `src/test/env-tool-workspace-escape.contract.test.ts` 이탈 negative | Done |
| **FR-ENV-TOOL.8** | 관측, 워크스페이스 내부 변경, 자격증명 사용, 외부 발신, 게시, 구매, 파괴적 명령, 운영 변경을 별도 권한으로 분리한다. 일반 편집 권한은 이들 중 어느 것도 상속하지 않는다. | UC-ENV-TOOL-BOUNDARY-DENY | `src/test/env-tool-approval-matrix.contract.test.ts` 비상속 negative | Done |
| **FR-ENV-TOOL.9** | 모든 작업은 취소 가능하고 타임아웃을 가지며 재연결과 멱등 재전송을 정의한다. 취소, 타임아웃, 부분 실행은 성공으로 승격되지 않고 각각 구별되어 기록된다. | UC-ENV-TOOL-CANCEL | `src/test/env-tool-cancel-timeout.contract.test.ts` 구별·멱등·종결 CAS·동시 멱등·실제 deadline, `packages/ego-host/test/cancel.test.mjs` 취소 훅 | In-progress |
| **FR-ENV-TOOL.10** | 브라우저 작업 공간은 작업과 수명이 다른 자원이다. 각 공간은 격리된 브라우저 컨텍스트이며 쿠키·저장소·서비스 워커·권한·다운로드 경로를 공간끼리 공유하지 않고 사용자 프로필도 물려받지 않는다. 소유권은 `agent`·`agentDelegatedToUser`·`user` 이며, 헤드리스 공간에서는 인계·회수·claim 이 형식 있는 오류로 거부되고 `agent` 외 상태에 도달하지 않는다. 이 규칙은 브라우저 자원에만 적용한다. | UC-ENV-TOOL-SPACE | `src/test/env-tool-workspace-resource.contract.test.ts` 헤드리스 전이 표·자원 형태·개정 확인, `packages/ego-host/test/isolation.test.mjs`·`mediator.test.mjs` | In-progress |
| **FR-ENV-TOOL.11** | 브라우저 호스트는 창을 만들지 않는다. 검증은 실제 프로세스 인자, 호스트 동작 전후 활성 창 동일, 감독자 프로세스 트리의 창 0 의 세 겹이며 환경 부재를 건너뛰지 않는다. | UC-ENV-TOOL-SPACE | `packages/ego-host/test/no-interference.test.mjs` | Pending |
| **FR-ENV-TOOL.12** | 사이트별 학습(도메인 manifest·페이지 구조 메모·추출 도구)을 ego-lite 학습 형식으로 저장하고 검증 스크립트로 형식을 강제한다. 학습 루트는 선택된 ADK 아래다. | UC-ENV-TOOL-BROWSE | `packages/ego-host/skill/learnings/` + `validate-site-skills` | Pending |
| **FR-ENV-TOOL.13** | 새 브라우저 호스트 도구(`env_browser_*`)는 `EnvironmentToolService` 를 통해서만 노출되고 기능 플래그로 켠다(리눅스 기본 켬, Windows 는 별도 게이트 통과 전 기본 끔). 기존 임베디드 브라우저 도구(`skill_browser_*`)의 이름·권한·동작은 바뀌지 않는다. | UC-ENV-TOOL-SCRIPT | `packages/shell/e2e/env-tool-browser-host.spec.ts` 기존 도구 불변 | Pending |
| **FR-ENV-TOOL.14** | 진입점은 둘이다. 형식 있는 도구는 효과가 고정된 RPC 만 부르며 등급은 서비스가 정한다(관측: 스냅샷·캡처, 워크스페이스 내부 변경: 이동·클릭·입력·평가). 임의 자바스크립트 묶음 실행(`env_browser_script`)은 터미널 실행과 같은 등급이며, 승인 결과가 감독자 핸드셰이크에 실려야 시작된다. 캡처 파일 경로는 감독자가 정한다. | UC-ENV-TOOL-SCRIPT | `src/test/env-tool-approval-matrix.contract.test.ts` 등급 고정 RPC 표(선언 무시)·`packages/ego-host/test/handshake.test.mjs`·Playwright 승인 없는 script 거부 | In-progress |
| **FR-ENV-TOOL.15** | 감독자는 셸이 lease(nonce·marker·started-at·경로·PID)로 소유한다. Chromium 은 감독자가 파이프로 소유해 감독자가 죽으면 함께 종료된다. 시작 조정은 marker 가 일치하는 프로세스만 회수한다. ADK 전환은 이전 감독자 종료 뒤 새 lease 조정 순서를 지킨다. | UC-ENV-TOOL-RECOVER | `packages/ego-host/test/lease.test.mjs`·`src/test/env-tool-adk-switch.contract.test.ts`·e2e-tauri lifecycle | Pending |
| **NFR-ENV-TOOL-VENDOR.1** | 벤더 런타임(`packages/ego-host/vendor/ego-lite`)은 고정 커밋과 바이트 단위로 같아야 하며 매니페스트 검사가 이를 강제한다. 벤더 파일을 편집하지 않는다. 스킬은 파생본이며 업스트림과의 차이를 `UPSTREAM-DIFF.md` 로 추적한다. | UC-ENV-TOOL-BROWSE | `packages/ego-host/test/vendor-install.test.mjs` | In-progress |
| **NFR-ENV-TOOL-ABI.1** | 벤더 런타임이 기대하는 실행 ABI 를 근거 줄과 함께 문서화하고, 실제 감독자 + 벤더 런타임 조합으로 각 행과 전송 실패 모드를 검증한다. | UC-ENV-TOOL-BROWSE | `packages/ego-host/docs/ego-runtime-abi.md`·`packages/ego-host/test/conformance.test.mjs` | In-progress |
| **NFR-ENV-TOOL-OS.1** | 감독자·런처·어댑터는 리눅스·윈도우·macOS 에서 같은 코드로 동작한다. OS 의존 코드는 브라우저 탐색·프로세스 확인(런처)과 소켓 경로 함수에만 둔다. OS 별 게이트(격리·무간섭·취소·lease·적합성 묶음을 그 OS 에서 종료 코드 0)를 통과하기 전에는 그 OS 에서 기능 플래그가 꺼진 채 배포된다. | UC-ENV-TOOL-SPACE | `packages/ego-host/test/*.test.mjs` 플랫폼 주입 단위 + OS 별 실측 게이트 | Pending |

## 기능 요구사항 (FR) — 이슈 리더와 코딩 작업자 오케스트레이션 (#500, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 출처 시나리오: `UC-ORCHESTRATION-*` 네 항목.
> FR-HERDR.4의 P4를 구체화한다. 선행: FR-WORKSPACE-CONTEXT.*, FR-HERDR-CONTROL.*. 상태: 전부 Pending.

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-ORCHESTRATION.1** | 요청을 대화로 끝낼 일과 이슈로 만들 일로 분류하고 근거를 남긴다. 사용자가 분류를 뒤집으면 그대로 따른다. 사소한 질문에 이슈와 작업자를 만들지 않는다. | UC-ORCHESTRATION-CLASSIFY | `src/test/orchestration-classify.contract.test.ts` 분류·뒤집기 | Done |
| **FR-ORCHESTRATION.2** | 이슈로 만들 일은 GitHub 이슈를 생성하거나 기존 이슈에 결속하고, 그 이슈를 Herdr space 하나에 묶는다. 같은 이슈에 space가 둘 생기지 않는다. | UC-ORCHESTRATION-CLASSIFY | `src/test/orchestration-issue-lead.contract.test.ts` 결속 단일성 | Done |
| **FR-ORCHESTRATION.3** | 이슈마다 L2 리더가 하나 선다. 리더는 계획, 소유 경로 배정, 작업자 배치, 증거 통합, 완료 판정을 맡는다. 리더가 둘 이상 존재할 수 없다. | UC-ORCHESTRATION-ISSUE-LEAD | `src/test/orchestration-issue-lead.contract.test.ts` 리더 단일성 | Done |
| **FR-ORCHESTRATION.4** | 구현자, 검증자, 리뷰어, 조사자 역할을 지원하고, 구현한 작업자가 자기 결과의 독립 검증자가 되지 않는다. 참조 이슈는 최소한 구현자와 독립 검증자로 완주한다. | UC-ORCHESTRATION-ISSUE-LEAD | `src/test/orchestration-issue-lead.contract.test.ts` 역할 분리 | Done |
| **FR-ORCHESTRATION.5** | 작업자의 소유 경로는 겹치지 않는다. 겹치는 배치는 거부하거나 명시적으로 직렬화한다. | UC-ORCHESTRATION-ISSUE-LEAD | `src/test/orchestration-ownership-conflict.contract.test.ts` 중첩 negative | Done |
| **FR-ORCHESTRATION.6** | 작업자는 자기 권한을 넓히지 못하고 이슈 완료를 선언하지 못한다. 증거는 L2가 통합하고 사용자에게 무엇을 보고할지는 L3가 정한다. | UC-ORCHESTRATION-ISSUE-LEAD | `src/test/orchestration-no-self-completion.contract.test.ts` negative | Done |
| **FR-ORCHESTRATION.7** | 워크스페이스·프로젝트 컨텍스트, 사용자 의도, 권한, 소유 경로, 예산, 성공 기준을 구조화해 작업자에게 전달한다. 대화 전문을 그대로 복사해 넘기지 않으며 비밀값을 제외한다. 위임 위험도는 워크스페이스 terminology 정의를 따르고 high는 위임하지 않는다. | UC-ORCHESTRATION-ISSUE-LEAD | `src/test/orchestration-issue-lead.contract.test.ts` 전달 계약 | Done |
| **FR-ORCHESTRATION.8** | Codex, Claude, OpenCode, 비에이전트 셸 작업 어댑터가 명령줄 도구의 차이에도 동등한 생명주기 의미(시작·관측·중단·재개·결과 수집)를 노출한다. | UC-ORCHESTRATION-WORKER-REPLACE | `src/test/orchestration-worker-adapter.contract.test.ts` 동등성 | Done |
| **FR-ORCHESTRATION.9** | 실패하거나 멈춘 작업자를 이슈 상태와 기존 산출물·증거를 잃지 않고 교체한다. 중단, 재개, 인계, 앱 재시작을 지원한다. | UC-ORCHESTRATION-WORKER-REPLACE·RESTART-RESUME | `src/test/orchestration-replace-preserve.contract.test.ts`·`packages/shell/e2e-tauri/specs/orchestration-restart.spec.ts` | Done |
| **FR-ORCHESTRATION.10** | 재시작 이후 완료·실패·중단을 증거 없이 단정하지 않는다. 이어받을 수 없는 부분은 이어받을 수 없다고 보고한다. | UC-ORCHESTRATION-RESTART-RESUME | `packages/shell/e2e-tauri/specs/orchestration-restart.spec.ts` | Done |

## 기능 요구사항 (FR) — 채널 중립 세션 (#503, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 출처 시나리오: `UC-CHANNEL-SESSION-*` 네 항목.
> 기존 UC10·UC10a를 확장한다. 상태: 전부 Pending.

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-CHANNEL-SESSION.1** | 대화, 작업, 이슈, Herdr space 식별자를 채널과 무관하게 정의한다. 같은 이슈에는 L3 대화 정체성 하나와 Herdr 실행 소유자 하나만 존재한다. | UC-CHANNEL-SESSION-HANDOFF | `src/test/channel-session-identity.contract.test.ts` 단일 소유 | Done |
| **FR-CHANNEL-SESSION.2** | 데스크톱 대화, 음성, Discord 입력이 권한이 있을 때 같은 L3 오케스트레이션 세션으로 들어간다. 채널이 달라도 대화가 갈라지지 않는다. | UC-CHANNEL-SESSION-HANDOFF | `src/test/channel-session-identity.contract.test.ts`·`packages/shell/e2e-tauri/specs/channel-continuity.spec.ts` | Done |
| **FR-CHANNEL-SESSION.3** | 대화 응답과 오래 걸리는 작업의 진행 알림을 구분해 전달한다. 진행 알림이 대화 응답을 밀어내지 않는다. | UC-CHANNEL-SESSION-RECONNECT | `src/test/channel-session-resume-refs.contract.test.ts` 경로 분리 | Done |
| **FR-CHANNEL-SESSION.4** | 재개에 필요한 참조만 보관하고 작업자 실행 상태를 복사해 두지 않는다. 실행 정본은 Herdr에 남는다. | UC-CHANNEL-SESSION-RECONNECT | `src/test/channel-session-resume-refs.contract.test.ts` 복사 negative | Done |
| **FR-CHANNEL-SESSION.5** | 채널마다 신원, 참여 자격, 공개 범위, 응답 경로 정책을 정의하고 강제한다. 워크스페이스의 기밀 컨텍스트가 더 넓은 채널로 나가지 않는다. | UC-CHANNEL-SESSION-DISCLOSURE-DENY | `src/test/channel-session-disclosure-policy.contract.test.ts` 유출 negative | Done |
| **FR-CHANNEL-SESSION.6** | 중복 전달은 이슈나 작업자를 중복 생성하지 않고 기존 처리 결과를 반환한다. 순서가 뒤바뀐 이벤트는 상태를 역전시키지 않는다. | UC-CHANNEL-SESSION-DUPLICATE-DELIVERY | `src/test/channel-session-dedupe.contract.test.ts`·`src/test/channel-session-out-of-order.contract.test.ts` | Done |
| **FR-CHANNEL-SESSION.7** | 채널 재연결과 재부팅 이후 작업이 멈췄거나 끝났다고 증거 없이 말하지 않는다. 사용자 취소는 모든 채널에서 동일하게 작동한다. | UC-CHANNEL-SESSION-RECONNECT | `packages/shell/e2e-tauri/specs/channel-reboot.spec.ts` | Done |

## 비기능 요구사항 (NFR) — 검증·벤치마크 하네스 (#498, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md`. 출처 시나리오: `UC-AGENT-BENCH-*` 세 항목.
> 형제 이슈의 완료 판정은 이 하네스가 수행한다. 상태: 전부 Pending.

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **NFR-AGENT-BENCH.1** | 네 개의 게이트를 제공한다. 프로토콜 계약, 구성요소 통합, 실제 에이전트 종단, 안전·결함 주입. 앞 게이트의 통과가 뒤 게이트를 대신하지 않는다. | UC-AGENT-BENCH-RUN | `src/test/agent-bench-runner.contract.test.ts` 게이트 분리 | Done |
| **NFR-AGENT-BENCH.2** | 중첩 진입점과 여러 프로젝트를 가진 임시 워크스페이스 픽스처, 결정론적 상태기계 검증을 위한 대역 Herdr와 대역 작업자, 그리고 실제 Herdr·명령줄 도구 프로파일을 함께 제공한다. | UC-AGENT-BENCH-RUN | `src/test/agent-bench-fixtures.contract.test.ts` 픽스처·대역 | Done |
| **NFR-AGENT-BENCH.3** | 목 데이터만으로 얻은 통과는 native Herdr, 실제 브라우저, 실제 코딩 작업자 게이트를 만족시키지 못한다. 테스트 삭제나 축소된 suite는 완료 증거가 아니다. | UC-AGENT-BENCH-FALSE-COMPLETION | `src/test/agent-bench-false-completion.contract.test.ts` 축소 suite 탐지 | Done |


> NFR-AGENT-BENCH.3 은 "목만으로 얻은 통과가 실제 게이트를 대신하지 못한다"는 *규칙*이다.
> 하네스가 그 규칙을 실제로 강제한다(mock-only 는 거절된다). 실제 코딩 모델 작업자를
> 띄운 적이 없다는 사실은 이 규칙의 위반이 아니라 그 규칙이 작동한 결과이며,
> `UC-ORCHESTRATION-CODING-PROVIDER` 로 이름을 걸어 미검증으로 남겨 두었다.
> 2026-08-27 적대리뷰가 이 둘을 혼동할 수 있다고 지적해 여기 적어 둔다.
| **NFR-AGENT-BENCH.4** | 수용 대상에서 교차 프로젝트 컨텍스트 누출 0건, 무단 외부 효과 0건, 거짓 완료 선언 0건을 요구한다. 하나라도 발생하면 수용하지 않는다. | UC-AGENT-BENCH-FALSE-COMPLETION | `src/test/agent-bench-false-completion.contract.test.ts` 세 지표 | Done |
| **NFR-AGENT-BENCH.5** | 수용된 모든 작업은 의도, 컨텍스트 개정, 수행한 작업, 산출물, 테스트, 완료 증거가 추적 가능하다. 증거 영수증을 보관하고 재현 가능하게 한다. | UC-AGENT-BENCH-RUN | `src/test/agent-bench-runner.contract.test.ts` 추적성 | Done |
| **NFR-AGENT-BENCH.6** | 컨텍스트 발견, 프로젝트 라우팅, 이슈 분류, 도구 선택, 검증된 완료, 거짓 완료, 복구, 개입 횟수, 토큰 비용, 지연, 병렬 효율, 권한 위반을 측정한다. 보고는 성공 여부만이 아니라 중앙값과 꼬리 지연, 비용을 포함한다. | UC-AGENT-BENCH-REPORT | `src/test/agent-bench-report.contract.test.ts` 지표·분포 | Done |
| **NFR-AGENT-BENCH.7** | 결정론 suite는 자격증명 없이 지속 통합에서 돌고, 실제 런타임과 자격증명이 필요한 suite는 선택 실행으로 분리한다. 기준선 보고와 회귀 임계값을 유지한다. | UC-AGENT-BENCH-REPORT | `src/test/agent-bench-report.contract.test.ts` 재현·임계 | Done |

## 기능 요구사항 (FR) — 환경 표면 계약 (#502 슬라이스 1, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md` 의 2026-08-26 계층 결정.
> 출처 시나리오: `user-scenarios.md` 의 `UC-ENV-SURFACE-*` 네 항목.
> `FR-HERDR-CONTROL.*` 과 구분한다 — 그쪽은 셸이 Herdr 를 어떻게 다루는가이고 여기는 뇌에 무엇을
> 노출하는가다. 결정은 naia-agent 가 하고 셸은 번역한다.
> ⚠️ `environment-intent.ts` 와 `herdr-environment.ts` 는 이 표보다 먼저 쓰였다(P03 게이트 위반).
> 이 표가 그것을 뒤늦게 닫는다. 번역기부터는 순서를 지킨다.
> 상태: 전부 Pending.

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-ENV-SURFACE.1** | 뇌가 보는 환경 보고는 표면 손잡이, 이름, 활동 상태, 사용자 주시 여부만 담는다. 터미널 관리자의 내부 식별자와 어휘(pane·tab·workspace·terminal)는 보고 타입에 나타나지 않는다. | UC-ENV-SURFACE-OBSERVE | `environment-intent.contract.test.ts` 선언 어휘 검사(주석 제거 + 공허 통과 방지) | Done |
| **FR-ENV-SURFACE.2** | 활동 상태는 `idle`·`working`·`waiting`·`unknown` 네 가지로 정규화한다. 환경이 모르는 상태를 내면 `unknown` 으로 남기고 `idle` 로 승격하지 않는다. | UC-ENV-SURFACE-OBSERVE | `environment-intent.contract.test.ts` 정규화 표 + `herdr-environment.contract.test.ts` 실측 3종 | Done |
| **FR-ENV-SURFACE.3** | 보고에 실을 표면 수에 상한을 두고, 상한을 넘으면 못 실은 개수를 함께 보고한다. 사용자가 보고 있는 표면을 먼저 싣는다. | UC-ENV-SURFACE-OBSERVE | `environment-intent.contract.test.ts` 상한·누락·정렬 | Done |
| **FR-ENV-SURFACE.4** | 환경이 만든 문자열은 자료로만 취급한다. 제어문자와 개행을 제거해 한 줄로 만들고 길이를 제한하며, 정상 이름은 손상하지 않는다. | UC-ENV-SURFACE-DATA | `environment-intent.contract.test.ts` 새니타이즈 + `herdr-environment.contract.test.ts` 실측 잔존 0 | Done |
| **FR-ENV-SURFACE.5** | 뇌가 내릴 수 있는 의도는 관측·포커스·중단·실행 넷뿐이다. 표면은 셸이 발행한 불투명 손잡이로만 가리키며, 셸이 발행하지 않은 손잡이는 환경에 닿지 못한다. | UC-ENV-SURFACE-ACT·DENY | `environment-intent.contract.test.ts` 의도 집합·미발행 손잡이 | Done |
| **FR-ENV-SURFACE.6** | 허용 의도 집합을 좁힐 수 있다. 관측만 허용된 상태에서 실행 의도는 거절된다. 빈 요청과 상한 초과 요청도 환경에 내려가기 전에 걸린다. 거절 사유는 전부 반환한다. | UC-ENV-SURFACE-DENY | `environment-intent.contract.test.ts` 허용 집합·빈·과길이·복수 사유 | Done |
| **FR-ENV-SURFACE.7** | 의도를 환경 호출로 번역하는 것은 셸이다. 뇌는 번역 결과를 모른다. 표면 종류에 따라 실행 경로가 갈리며(에이전트가 있는 표면과 일반 터미널), 번역할 수 없는 의도는 지어내지 않고 정직하게 거절한다. | UC-ENV-SURFACE-ACT | `environment-intent-translation.contract.test.ts` 분기·미지원 거절 | Done |
| **FR-ENV-SURFACE.8** | 실행 의도가 구조화된 인자가 아니라 터미널 입력으로 전달되는 경우, 그 사실과 인용 책임이 번역 결과에 명시된다. Herdr 프로토콜 19 에 argv 실행 경로가 없다는 실측을 감추지 않는다. | UC-ENV-SURFACE-ACT | `environment-intent-translation.contract.test.ts` 전달 방식 표기 | Done |
| **FR-ENV-SURFACE.9** | 손잡이는 관측 시점에 발행되며 그 시점의 표면에만 대응한다. 셸은 손잡이에서 환경 식별자로 가는 대응표를 자신이 보관하고 뇌에 노출하지 않는다. | UC-ENV-SURFACE-ACT·DENY | `environment-intent-translation.contract.test.ts` 대응표 격리·만료 | Done |

## 기능 요구사항 (FR) — 환경 호출 전달 (#502 슬라이스 1, 에픽 #497)

> 계약: `docs/progress/issue-497-universal-agent.md` 의 슬라이스 1 전달 경계.
> 출처 시나리오: `user-scenarios.md` 의 `UC-ENV-DISPATCH-*` 세 항목.
> 실측(2026-08-26): 번역기가 내는 환경 호출 6종 중 `session.snapshot`·`agent.focus`·`agent.prompt`
> 는 Rust 에 이미 있고, `pane.focus`·`pane.send_text`·`pane.send_keys` 가 없다. 이미 열린 셋은
> 전부 구조화 전달, 없는 셋은 전부 터미널 입력이다.
> 상태: 전부 Pending.

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-ENV-DISPATCH.1** | 전달 계층은 번역기가 실제로 내는 호출만 받는다. 그 목록 밖의 메서드는 환경에 도달할 수 없으며, 프로토콜의 나머지 메서드를 근거 없이 열지 않는다. | UC-ENV-DISPATCH-REFUSE | `environment-dispatch.contract.test.ts` 허용 메서드 목록·목록 밖 거절 | Done |
| **FR-ENV-DISPATCH.2** | 구조화 전달(`session.snapshot`·`agent.focus`·`agent.prompt`·`pane.focus`)은 워크스페이스 관측·조작 권한으로 수행한다. 요청 문자열이 명령줄로 재해석되지 않는다. | UC-ENV-DISPATCH-STRUCTURED | `environment-dispatch.contract.test.ts` 구조화 라우팅 | Done |
| **FR-ENV-DISPATCH.3** | 터미널 입력 전달(`pane.send_text`·`pane.send_keys`)은 구조화 전달과 같은 권한으로 열리지 않는다. 사용자의 터미널에 직접 타이핑하는 것과 동등하므로 별도 권한을 요구하며, 없으면 환경에 도달하지 않는다. | UC-ENV-DISPATCH-TERMINAL | `environment-dispatch.contract.test.ts` 권한 분리 negative | Done |
| **FR-ENV-DISPATCH.4** | 표면 식별자는 환경에 닿기 전에 형식을 검증한다. 형식이 어긋나면 호출을 만들지 않는다. 검증은 Rust 명령 경계에서도 중복 수행한다. | UC-ENV-DISPATCH-REFUSE | Rust 단위 테스트 + `e2e-tauri/specs/environment-dispatch.spec.ts` | Done |
| **FR-ENV-DISPATCH.5** | 요청 본문에 길이 상한을 둔다. 빈 요청은 전달하지 않는다. 상한과 공백 판정은 Rust 경계에서도 수행한다. | UC-ENV-DISPATCH-REFUSE | Rust 단위 테스트 + `environment-dispatch.contract.test.ts` | Done |
| **FR-ENV-DISPATCH.6** | 환경이 거절하면 그 사유를 그대로 올린다. 실패를 성공으로 바꾸지 않으며, 결과 불명은 불명으로 남긴다. | UC-ENV-DISPATCH-STRUCTURED | `environment-dispatch.contract.test.ts` 오류 전파 | Done |
| **FR-ENV-DISPATCH.7** | Rust 명령 계층은 식별자 형식과 길이만 검증하고 능력 게이팅은 core 의도 계층이 수행한다. 이 구조에서 웹뷰 코드가 Tauri 명령을 직접 부르면 게이팅을 건너뛴다는 사실을 문서와 요구사항에 남긴다(기존 `herdr_prompt_agent` 와 동일한 관행). Rust 계층 자체의 능력 게이팅은 후속 과제다. | UC-ENV-DISPATCH-TERMINAL | 문서 기재 + `e2e-tauri/specs/environment-dispatch.spec.ts` 명령 등록 확인 | Done |

## 기능 요구사항 (FR) — 두 저장소 wire 어휘 동기 (#497 후속)

> 출처 시나리오: `user-scenarios.md` 의 `UC-WIRE-UNION-DRIFT`.

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-WIRE-UNION.1** | 두 저장소가 같은 표본 `src/test/fixtures/wire-union.json` 을 들고, 각자 자기 쪽 어휘가 그 표본과 일치하는지 검증한다. 표본이 두 파일로 갈라지면 양쪽 테스트가 깨진다. | UC-WIRE-UNION-DRIFT | `wire-union-drift.contract.test.ts` 표본 대조 | Done |
| **FR-WIRE-UNION.2** | 어휘 목록은 각 저장소의 실행되는 코드에서 나온다. 셸은 자기 수용 상수에서, 뇌는 자기 송신 경로의 소스에서 뽑는다. 손으로 적은 표와 코드가 어긋나면 실패한다. | UC-WIRE-UNION-DRIFT | 소스 추출과 상수 대조 | Done |
| **FR-WIRE-UNION.3** | 뇌가 내보내는 chat-turn 메시지 종류는 셸이 수용하는 종류의 부분집합이어야 한다. 아니면 실패한다. | UC-WIRE-UNION-DRIFT | 부분집합 단언 | Done |
| **FR-WIRE-UNION.4** | 환경 세그먼트 kind 목록이 두 저장소에서 같아야 한다. | UC-WIRE-UNION-DRIFT | kind 집합 대조 | Done |
| **FR-WIRE-UNION.5** | 추출 결과가 비면 통과하지 않는다. 빈 집합으로 부분집합 단언이 공허하게 참이 되는 경로를 막는다. | UC-WIRE-UNION-DRIFT | 비어있지 않음 단언 | Done |
| **FR-WIRE-UNION.6** | 상대 저장소 체크아웃을 찾지 못하면 건너뛰지 않고 실패한다. | UC-WIRE-UNION-DRIFT | 상대 표본 탐색 실패 단언 | Done |

## 기능 요구사항 (FR) — #502 실배선

> 출처 시나리오: `user-scenarios.md` 의 `UC-ENV-LIVE-OBSERVE`·`UC-ENV-LIVE-ACT`·`UC-ENV-STICKY`.

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-ENV-LIVE.1** | 살아 있는 Herdr 스냅샷이 있으면 셸이 `environmentSurfaces` 세그먼트를 대화 요청에 실어 올린다. 사용자가 도구를 요청할 필요가 없다. | UC-ENV-LIVE-OBSERVE | `environment-live-wiring.contract.test.ts` | Done |
| **FR-ENV-LIVE.2** | 스냅샷이 없거나 표면이 하나도 없으면 세그먼트를 만들지 않는다. 빈 목록을 올려 "아무것도 없다"고 단언하지 않는다. | UC-ENV-LIVE-OBSERVE | 같음 | Done |
| **FR-ENV-LIVE.3** | 뇌가 표면을 조작하는 경로는 앱 도구(`skill_environment`)다. 셸이 도구를 등록하고, 호출을 받아 의도로 받아들이고, 번역해 전달한다. | UC-ENV-LIVE-ACT | `environment-skill.test.ts` | Done |
| **FR-ENV-LIVE.4** | 터미널 입력 전달은 사용자가 명시로 켠 경우에만 나간다. 기본값은 꺼짐이며, 꺼져 있으면 거절 사유가 그대로 뇌에 올라간다. | UC-ENV-LIVE-ACT | 같음 | Done |
| **FR-ENV-LIVE.5** | 환경이 거절하거나 오류를 던지면 그대로 올린다. 성공으로 바꾸거나 삼키지 않는다. | UC-ENV-LIVE-ACT | 같음 | Done |
| **FR-ENV-STICKY.1** | 손잡이는 표면 하나에 고정된다. 한 번 발행한 손잡이를 다른 표면에 재배정하지 않는다. | UC-ENV-STICKY | `environment-live-wiring.contract.test.ts` | Done |
| **FR-ENV-STICKY.2** | 표면이 사라지면 그 손잡이는 무효가 된다. 이후 그 손잡이로 온 의도는 `unknown-surface` 로 거절한다. | UC-ENV-STICKY | 같음 | Done |
| **FR-ENV-STICKY.3** | 목록 순서가 바뀌어도 손잡이는 바뀌지 않는다. 순서는 손잡이의 근거가 아니다. | UC-ENV-STICKY | 같음 | Done |
| **FR-ENV-LIVE.6** | 셸 UI 의 `EnvironmentSegment` 사본도 코어 union 과 같은 kind 를 갖는다. 세 번째 사본이 조용히 갈라지지 않는다. | UC-WIRE-UNION-DRIFT | `wire-union-drift.contract.test.ts` | Done |
| **FR-ENV-ATTENTION.1** | 나이아가 `watch` 로 지켜보기를 켜면, 그다음 대화 요청부터 표면 목록이 세그먼트에 실린다. 켜는 판단은 나이아가 한다 — 사용자가 시킬 필요가 없다. | UC-ENV-ATTENTION | `environment-live-wiring.contract.test.ts`, `environment-skill.test.ts`, `environment-skill.spec.ts` | Done |
| **FR-ENV-ATTENTION.2** | 나이아가 `unwatch` 로 끄면 그다음 요청부터 목록이 빠진다. 기본 상태는 꺼짐이며, 앱을 다시 켜면 꺼진 상태로 시작한다. | UC-ENV-ATTENTION | 같음 | Done |
| **FR-ENV-ATTENTION.3** | 지켜보지 않는 동안에는 표면 개수만 올린다. 이름도 손잡이도 올리지 않는다. 개수는 상한 때문에 못 실은 것까지 더한 값이다. | UC-ENV-ATTENTION | 같음 | Done |
| **FR-ENV-ATTENTION.5** | 대화 요청에 싣기 직전에 관측을 갱신한다. 부팅 시점 스냅샷을 계속 싣지 않는다. 꺼져 있으면 갱신하지 않는다. | UC-ENV-ATTENTION | `environment-skill.spec.ts` | Done |
| **FR-ENV-ATTENTION.6** | 관측이 실패하면 마지막 보고를 폐기하고 아무것도 모르는 상태로 되돌린다. 그때까지 발행한 손잡이도 무효가 된다. 마지막으로 본 목록을 계속 싣지 않는다. | UC-ENV-ATTENTION | `environment-live-wiring.contract.test.ts`, `environment-skill.test.ts`, `environment-skill.spec.ts` | Done |
| **FR-ENV-ATTENTION.7** | 지켜보기는 `WATCH_TURN_BUDGET` 턴이 지나면 저절로 풀린다. `always` 인 동안에는 턴을 세지 않는다 — 출력만이 아니라 상태도 예산과 무관해야, 사용자가 `auto` 로 되돌릴 때 나이아가 끈 적 없는 지켜보기가 사라지지 않는다. 나이아가 `unwatch` 를 부르지 않아도 목록이 무한히 실리지 않는다. 턴은 정상 종료·중단 어느 쪽으로 끝나든 턴이며, 실시간 음성 턴도 센다. 통화가 끊기면 지켜보기도 끝난다. 사용자가 정한 `always` 는 예산과 무관하다. | UC-ENV-ATTENTION | 같음 | Done |
| **FR-ENV-ATTENTION.11** | 도구 결과의 성공 여부는 실행기가 낸다. 호출부가 결과 문자열의 접두사로 되짚지 않는다 — 새 사유가 생길 때마다 조용히 성공으로 새어 나가기 때문이다. `무시됨`(설정이 이겨 상태가 안 바뀜)과 `관측 불가`도 실패다. | UC-ENV-ATTENTION | `environment-skill.test.ts` | Done |
| **FR-ENV-ATTENTION.12** | 경로가 대화 요청을 조립하는지는 호출부가 명시로 켠다. 기본값은 꺼짐이다 — 모르는 경로가 생기면 겸손한 쪽으로 틀려야 한다. 실시간 음성과 능동 발화는 조립하지 않는다. | UC-ENV-ATTENTION | 같음 + `env-attention-voice.spec.ts` | Done |
| **FR-ENV-ATTENTION.13** | 지켜보기에는 켠 주인의 표가 붙고, 그 표가 붙은 것만 그 주인이 끈다. 통화 시작 시점의 참·거짓으로 소유를 판정하지 않는다 — 통화 도중 다른 경로가 켠 것과 구별되지 않고, 늦게 도착한 옛 세션의 종료가 새 세션의 것을 지운다. | UC-ENV-ATTENTION | `environment-live-wiring.contract.test.ts`, `env-attention-voice.spec.ts` | Done |
| **FR-ENV-ATTENTION.19** | 전역 도구 사용이 꺼져 있으면 **개수만 보내는 안내**를 하지 않는다. 그 안내는 "필요하면 도구를 불러라"라고 말하는데 나이아가 부를 수 없는 길이다. | UC-ENV-ATTENTION | `environment-skill.spec.ts` | Done |
| **FR-ENV-ATTENTION.20** | 두 규칙이 충돌하는 조합(`always` + 전역 도구 꺼짐)에서는 **사용자 정책이 이긴다** — 목록을 그대로 보낸다. 막아야 할 것은 닫힌 길을 가리키는 안내이지 목록 자체가 아니다. 목록은 도구 없이도 쓸모가 있다(나이아가 무엇이 돌고 있는지 말해 줄 수 있다). FR-ENV-ATTENTION.4 와 .19 의 우선순위를 여기서 정한다. | UC-ENV-ATTENTION | `environment-skill.spec.ts` | Done |
| **FR-ENV-ATTENTION.17** | 설정 전환의 등록·해제 결과는 로그가 아니라 상태에 반영한다. 껐으면 등록되어 있다고 주장하지 않는다 — 다시 켤 때 낡은 참으로 첫 턴에 표면을 실어 버린다. 해제가 실패하면 뇌에 선언이 남으므로, 꺼져 있는 동안의 대화 턴에서 한 번 더 시도한다(기다리지 않으므로 대화는 지연되지 않는다). | UC-ENV-ATTENTION | `environment-skill.spec.ts` | Done |
| **FR-ENV-ATTENTION.16** | 환경 도구는 대화 턴마다 다시 등록하고, **뇌가 실제로 등록했다는 응답**(`app_skills_result`)을 기다린다. 셸→Rust 는 채널로 큐잉만 하므로 명령 성공은 "예약됨"에 불과하다 — 그것을 전달로 읽으면 도구가 없는데 있다고 판단한다. Rust 는 등록·해제를 디스패처에서 그 자리에서 수행해 뒤이은 대화 요청보다 먼저 끝나게 하고, 결과를 돌려준다. 응답이 시간 안에 오지 않으면 실패로 본다. **확인을 기다리지는 않는다** — 기다리면 확인이 없을 때 사용자의 모든 대화가 시간초과만큼 멈춘다. 대신 마지막으로 확인된 상태를 들고 그것으로 판정한다. 따라서 뇌가 방금 죽은 경우 한 턴 정도는 등록되어 있다고 믿을 수 있다. 그 한 턴은 알고 감수한 한계다. 확인되지 않은 동안에는 표면을 싣지 않되 대화는 막지 않는다. **네이티브로 검증된 것은 fail-closed 방향뿐이다** — 뇌가 없으면 확인이 오지 않거나 명령이 거절되고, 셸은 등록됐다고 주장하지 않는다(`environment-dispatch.spec.ts`). 그 테스트는 `agent_response` 를 실제로 구독하고, 합성 이벤트로 **관측 통로가 살아 있음을 스스로 증명한 뒤** 판정한다 — 통로 없이 "안 왔다"고 말하면 그것은 측정이 아니다. 성공 경로(gRPC 왕복 후 ok:true)는 e2e 픽스처가 에이전트를 막아(`agent_lease_live_blocked`) 네이티브로 잴 수 없고, 브라우저 하네스가 Tauri 를 모의해 셸 쪽 계약만 덮는다. 이 한계는 알고 남긴 것이다. | UC-ENV-ATTENTION | `environment-skill.spec.ts`, `environment-dispatch.spec.ts`(실 Rust — fail-closed 방향만) | Done |
| **FR-ENV-ATTENTION.18** | 이 기능이 요청마다 새로 얹는 고정 비용(도구 선언 약 1420바이트)도 잰다. 세그먼트만 보면 93.5% 감소지만, 도구 선언까지 넣으면 2607→1497바이트로 **42.6%** 감소다. 둘 다 사실이므로 둘 다 적는다 — 유리한 경계만 골라 말하지 않는다. 도구 선언 크기도 위아래로 묶어, 조용히 부풀거나 설명을 깎아 수치만 좋게 만드는 것을 막는다. | UC-ENV-ATTENTION | `environment-skill.test.ts` | Done |
| **FR-ENV-ATTENTION.15** | 줄어든 양을 직접 잰다. 고정 표본(표면 12개) 기준 표면 세그먼트가 요청당 1187→77바이트(93.5% 감소), 40턴 총량은 최악의 경우(켜 놓고 잊음)에도 47480→13070바이트(72.5% 감소). **이 수치는 표면 세그먼트만의 것이다** — 기능 전체 비용은 FR-ENV-ATTENTION.18 을 함께 봐야 한다. 계약 테스트가 **네 수치 모두**를 ±8% 안에서 위아래로 묶는다 — 위는 부풀기를, 아래는 세그먼트를 없애거나 예산을 줄여 수치만 좋게 만드는 것을 막는다. 감소율 자체도 따로 확인해, 두 값이 같이 움직여 비율만 유지되는 경우를 막는다. 같은 절감을 **실제로 나간 chat_request** 에서도 잰다. | UC-ENV-ATTENTION | `environment-live-wiring.contract.test.ts`, `environment-skill.spec.ts` | Done |
| **FR-ENV-ATTENTION.14** | `watch` 는 관측이 먼저다. 환경이 응답하지 않으면 지켜보기를 켜지 않는다 — 실패를 보고하면서 노출 상태만 바꿔 두지 않는다. | UC-ENV-ATTENTION | `environment-skill.test.ts` | Done |
| **FR-ENV-ATTENTION.10** | 요청마다 표면 세그먼트를 싣지 않는 경로(실시간 음성)에서는 `watch` 가 "다음 요청부터 목록이 실린다"고 답하지 않는다. 그 경로가 목록을 싣지 않는다는 사실과 `observe` 를 그때그때 부르라는 안내를 대신 올린다. 못 하는 것을 한다고 말하지 않는다. | UC-ENV-ATTENTION | `environment-skill.test.ts`, `env-attention-voice.spec.ts` | Done |
| **FR-ENV-ATTENTION.9** | 실시간 음성 턴도 지켜보기 예산을 소비한다. 다만 음성 세션은 연결 시점의 도구 목록을 쓰므로, 통화 중 `off` 로 바꾸면 선언은 그 세션에 남고 실행만 거절된다 — 선언을 걷으려면 재연결이 필요하다. 이 한계는 알고 남긴 것이다. | UC-ENV-ATTENTION | `env-attention-voice.spec.ts` | Done |
| **FR-ENV-ATTENTION.8** | 일부러 싣지 않은 목록과 상한 때문에 잘린 목록을 `listWithheld` 로 구별해 보내되 숨김일 때만 그 키를 싣고(목록을 싣는 요청에 쓸모없는 바이트를 더하지 않는다), 뇌 쪽이 서로 다른 문구로 읽는다. 숨긴 경우에는 걷는 방법을 함께 알린다. | UC-ENV-ATTENTION | 같음 (받는 쪽은 naia-agent 저장소가 소유) | Done |
| **FR-ENV-ATTENTION.4** | 사용자의 `environmentAwareness` 설정이 나이아의 선택을 이긴다. `off` 면 도구를 등록하지 않고 세그먼트도 만들지 않으며 도구 호출도 거절한다. `always` 면 나이아가 끌 수 없다. 기본값은 `auto`. | UC-ENV-ATTENTION | 같음 | Done |

## 기능 요구사항 (FR) — v0.2.3 최신 naia-memory 결선 (#534)

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-MEMORY-PAIRING.1** | pairing manifest는 agent/proto와 함께 naia-memory의 정확한 40자 commit과 package version을 선언한다. | UC-V023-MEMORY-PAIRING | `agent-pairing-drift.contract.test.ts` | Done |
| **FR-MEMORY-PAIRING.2** | production staging은 선언된 memory 저장소 root·HEAD·clean 상태·package 이름·버전을 빌드 전에 fail-closed로 검증한다. | UC-V023-MEMORY-PAIRING | `agent-pairing-drift.contract.test.ts` | Done |
| **FR-MEMORY-PAIRING.3** | installer CI가 checkout하는 memory commit은 pairing manifest와 일치한다. | UC-V023-MEMORY-PAIRING | `agent-pairing-drift.contract.test.ts`, `platform-matrix.test.ts` | Done |

## 기능 요구사항 (FR) — 초기 번들 예산 (#431)

| ID | 요구사항 | 출처 시나리오 | 검증(P02) | 상태 |
|---|---|---|---|---|
| **FR-BUNDLE.1** | Mermaid와 전이 의존성은 Mermaid 코드 블록을 렌더링할 때 동적으로 불러온다. 초기화는 모듈 로드 뒤 한 번만 수행하며 기존 strict 보안 설정과 SVG 정화를 유지한다. | UC-PERF-BUNDLE-BUDGET | `MarkdownCodeBlock.test.tsx`, production build chunk inspection | Done |
| **FR-BUNDLE.2** | 빌드 검사는 `index.html`이 참조하는 초기 진입 JS의 raw/gzip 크기와 전체 `dist` 크기를 결정론적으로 측정한다. 대상이나 설정을 찾지 못하거나 예산을 넘으면 실패한다. | UC-PERF-BUNDLE-BUDGET | `check-bundle-budget.test.mjs` | Done |
| **FR-BUNDLE.3** | 빌드는 측정값·예산·통과 여부를 JSON으로 남기고 CI는 성공/실패와 무관하게 그 보고서를 artifact로 보존한다. | UC-PERF-BUNDLE-BUDGET | `check-bundle-budget.test.mjs`, GitHub Actions workflow | Done |
| **FR-BUNDLE.4** | 항상 마운트되는 워크스페이스는 터미널 상태를 유지하되, 파일 편집기와 그 전이 의존성은 viewer에 파일이 생길 때 동적으로 불러오며, 청크 로드 실패는 셸 새로고침 없이 재시도할 수 있어야 한다. | UC-PERF-BUNDLE-BUDGET | `herdr-workspace.test.tsx`, `HerdrWorkspaceSurface.test.tsx`, production build chunk inspection | Done |
| **FR-BUNDLE.5** | 완료된 사용자의 초기 진입에서는 온보딩 wizard와 그 전이 의존성을 내려받지 않는다. 신규 사용자의 온보딩 진입 시 로딩 상태를 표시하고, 청크 로드 실패는 셸 전체를 새로고침하지 않고 해당 화면만 재시도할 수 있어야 한다. | UC-PERF-BUNDLE-BUDGET | `DeferredOnboardingWizard.test.tsx`, `205-onboarding-avatar-grid.spec.ts`, production build chunk inspection | Done |
| **FR-BUNDLE.6** | ChatArea와 전이 의존성은 초기 진입 파일에서 분리한다. 로딩 중에는 진행 상태를 표시하고, 그 사이 도착한 슬라이드 나레이션 요청은 채팅 가시성과 무관하게 마운트된 지연 표면의 eager 경량 버퍼가 보존해 React StrictMode 재마운트 뒤에도 한 번만 전달한다. 지연 표면이 해제되면 버퍼된 요청을 cancelled 결과로, Chat 청크 로드가 실패하면 failed 결과로 정산하고, 상관된 실패·취소 결과를 받은 프레젠터는 speaking에서 재개 가능한 paused 상태로 전이한다. 동일 URL의 실패한 동적 import는 브라우저 캐시상 새 요청을 보장할 수 없으므로 운영 청크 실패는 명시적인 셸 재로드로 복구한다. 빌드 검사는 대상 청크가 초기 엔트리의 동적 import 그래프에서 실제로 도달 가능한지도 확인한다. | UC-PERF-BUNDLE-BUDGET | `DeferredChatArea.test.tsx`, `slides-center-area.test.tsx`, `slide-presenter.test.ts`, `check-bundle-budget.test.mjs`, production build chunk inspection | Done |
| **FR-BUNDLE.7** | #431 기준 초기 진입 예산을 개선된 측정값에 맞춰 raw 500,000바이트, gzip 160,000바이트로 강화한다. 최종 후보 실측은 기준선 2,913,442/836,096바이트에서 raw 439,810바이트/gzip 138,469바이트로 감소했다. 빌드 시각이 엔트리에 포함되어 gzip 값은 수 바이트 변동할 수 있으며, 이 수치는 엔트리 파일 크기 감소이지 초기 총 네트워크 전송량 감소를 뜻하지 않는다. | UC-PERF-BUNDLE-BUDGET | production build + `bundle-budget-report.json` | Done |


## 기능 요구사항 (FR) — 앱 샌드박스 · BGM 라이브러리 · 슬라이드 녹화 (2026-09-05, #528 #543 #546 통합 완성)

> 리눅스 핸드오프의 bgm-wip 통합을 완성하며 누락돼 있던 신규 파일 셋과 그 계약을 명문화한다.
> 앱 샌드박스는 "앱 설치·앱 파일 경로가 한 추상화를 지나는가"의 판정 기준이다(docs/app-store-protocol.md).

| FR | 요구사항 | 근거(UC/S) | 검증 |
|----|----------|-----------|------|
| **FR-APP-SANDBOX.1** | 앱은 자기 데이터를 `<adkPath>/data-private/apps/<appId>/` 샌드박스에만 읽고 쓴다. Tauri 커맨드 6종(`app_sandbox_root`/`write_file`/`read_file`/`open_in_workspace` + `slides_recording_start`/`stop`, `app_sandbox.rs`)이 경로를 강제한다: appId 화이트리스트(ascii 영숫자·`.-_`, ≤160), 상대경로만(`Component::Normal`), canonicalize 후 `starts_with(root)` 로 탈출 차단. 프런트는 `lib/app-sandbox.ts`(6 export)가 유일 경로. | S-APP-SANDBOX | `app_sandbox.rs` 경로탈출 rust 단위 + `src/lib/__tests__/` + tsc·cargo check(PASS) |
| **FR-BGM-LIB.1** | BGM 라이브러리(즐겨찾기·재생목록·셔플·반복)의 SoT 는 앱 샌드박스 `land.naia.shell/bgm/library.json`(#528). config.json `bgmLibrary` 는 최초 1회 이관 소스이자 샌드박스 쓰기 실패 시 폴백. 재생목록 CRUD·순서 이동(`movePlaylistTrack`)·좋아요 토글·다음곡 인덱스(셔플/반복)는 순수 함수(`bgm-library.ts`). 동기 판독 캐시(`bgm-library-store.ts`)로 음성 스킬이 읽는다. | S-BGM-LIB (UC8 확장) | `bgm-library.test.ts`·`bgm-library-store.test.ts`(단위) + `BgmPlayer.test.tsx`(플레이리스트 생성·persist·다음곡, 21/21) + `e2e/bgm-skill.spec.ts` |
| **FR-APP-OPEN-GRANT.1** | 워크스페이스 밖 파일을 여는 경로(CLI 인자·단일 인스턴스·드래그드롭)는 그 파일에 세션 한정 read/write grant 를 등록한다("열림=동의", #543). `workspace.rs grant_open_file` + `lib.rs get_startup_open_file`. | S-APP-OPEN-GRANT | `workspace.rs` rust 단위 |
| **FR-SLIDES-REC.1** | 슬라이드 발표를 MP4 로 녹화한다(ffmpeg gdigrab, 산출 `<adkPath>/data-private/apps/land.naia.slides/video/`). 시작/정지 커맨드는 단일 활성 녹화만 허용(재진입 거부, poisoned-lock 방어). 프런트 라벨(`slides.recordStart/Stop`·`focusStart/Exit`·`notesShow/Hide`)은 14개 언어 i18n. | S-SLIDES-REC | `app_sandbox.rs` 녹화 상태머신 + i18n 생성 --check + 수동 실기 |
| **FR-I18N-COMPLETE.1** | 셸 src 의 모든 `t("...")` 키는 로케일 파일 열넷(`src/lib/locales/*.ts` — #559 이후 정본, 생성물 아님)에 모두 존재해야 한다. bgm-wip 이 `bgm.tabPlaylists`·`bgm.newPlaylist`·shuffle/repeat·`bgm.cat.{kpop,citypop}`·`slides.*` 를 코드에만 추가해 모든 언어에서 라벨이 비던 드리프트를 정리. pre-commit `check-compile-integrity.mjs`(TranslationKey 강제)가 회귀 가드. | S-I18N-COMPLETE | `check-compile-integrity.mjs`(PASS) + `src/lib/__tests__/i18n-user-facing.test.ts`(키 집합·빈 값·로케일 배선) |
