# 요구사항 (P03 — FR/NFR) — 2단계 산출물

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
| **FR-F1.4** | **승인-세션 최소 결속** — *필수*: `correlation id`(승인↔실행↔결과 동일) + 승인-실행 *동일 session·context*; *불변식*: 다른 session/context 의 승인으로 실행 불가. **+ 행위 스코프 결속**: 승인은 *구체 행위(target·op·body·env)* 에 묶임. **실행 *전* 불일치(pre-exec drift) = block/재승인**(side-effect 없음). (실행 개시 후 drift = FR-F3.3 abort+미확정.) body·env·target·op = 실행 게이트. **context identity canon** = 결정적 **digest**{session id + workspace root(**canonical: symlink/mount/대소문자 정규화 또는 안정 workspace id** — raw path drift 방지) + active surface/panel(*headless/비-패널=null 허용, host-neutral*) + 승인시점 config 버전 + client id} (병렬 세션 구분; substrate별 값 부재 허용 = NFR-substrate-agnostic 정합) — 이 집합 불일치 = post-approval drift = 재승인 필요. (lease 전체=DEFER, 이 subset 만 지금) | UC13·UC10a(min) | binding 계약 |
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
| **FR-CONFIG-SOT.3** | 무회귀 — `writeNaiaConfig`·`stripForAgent`·키체인·107곳 동기 `loadConfig()` 리더 **무변경**. 캐시의 권위만 박탈 | S-CONFIG-SOT-3 | 기존 adk-store/config 테스트 무회귀 |
| **FR-CONFIG-SOT.4** | **UI 설정 SoT 완성** — `extractUiConfig`(ui-config.json write) 가 `UI_IDENTITY_KEYS`(9개) 대신 **`UI_ONLY_CONFIG_KEYS` 전체**를 뽑는다. "config.json 에서 strip 하는 UI 키 = ui-config.json 에 쓰는 키" 가 일치해야, 파일 SoT 없는 키(vllmTtsHost·theme·panelPosition·bgmVolume·ttsProvider·liveProvider 등)가 부팅 시 리셋되지 않는다. read/병합은 이미 통짜(`{...file, ...ui}`)라 대칭 자동. ⚠️ FR-CONFIG-SOT.1 도입 시 드러난 회귀(로컬 보이스 호스트 `vllmTtsHost` 미저장)의 근본 수정 | S-CONFIG-SOT-4 | ui-config 왕복 계약(UI_ONLY 전체 write→read 라운드트립) |
| **FR-CONFIG-SOT.5** | **AdkSetup 화면 중 되쓰기 게이트 유지** — `showAdkSetup` 분기에서 `configHydratedRef=true` 로 선마킹하지 않는다(하이드레이션 없이 게이트가 열려 mount-time `syncConfigToFile` 이 스테일 캐시를 파일에 되쓴 2026-07-16 시연장 클로버의 한 축). 설정 완료 → `showAdkSetup=false` → 하이드레이션 effect 재실행 후에만 게이트 개방 | S-CONFIG-SOT-2 | `e2e/config-sot-boot.spec.ts`(실 UI 부팅 3계약: 하이드레이션·무클로버·읽기지연 경쟁) |

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
| **FR-SLOT.3** | naia 계정 시 **Gemini 기본값 자동 적용**(main=gemini-flash·sub=gemini-flash-lite·embed=cpu offline·tts=Gemini TTS·stt=free). 사용자 개별 override 가능. ⚠️ 모델 문자열 확정(트랙 §9 #5) | S-SLOT | `settings-tab.test.ts`(기본값 적용) |
| **FR-SLOT.4** | 설정 탭·온보딩 모두 **게이트→슬롯 순서**. 구 engine/ai/models/memory 탭 중복 통합·재배열(회귀 无) | S-SLOT·UC12 | `onboarding-fresh.spec.ts` + Playwright E2E(게이트→클라우드 슬롯 흐름) |
| **FR-SLOT.5** | sub-LLM은 `memoryLlmProvider` 필드명 유지(R1-1), **역할 범용화**(기억+압축+adk 배치용). rename→`subLlm*`은 Slice C dual-write | S-SLOT | `settings-slots.contract.test.ts`(필드명·역할) |
| **FR-SLOT.6** (2026-07-15) | embedding 슬롯 offline(CPU) 모델에 **다국어(한국어) 2종** 노출 — `multilingual-e5-large`(1024d, 고정확) · `paraphrase-multilingual-MiniLM-L12-v2`(384d, 경량·빠름). all-MiniLM/all-mpnet 은 **영어 전용**이라 한국어 회상 품질 낮음(실측 2/5). **UI 라벨에 언어 명시**(`[영어 전용]`/`[한국어·다국어]`)로 유저가 구분 가능(핵심 요구). 배선 3-repo: naia-memory OfflineEmbeddingProvider(모델 allowlist·e5 q8 dtype·프리픽스) + naia-agent(검증 allowlist·dims 계약) + shell(union·드롭다운·i18n). 각 경계·SDLC 준수. 기본값(NAIA_SLOT_DEFAULTS) 무변경 | S-EMBKO·S-SLOT | `settings-slots.contract.test.ts`(offline union·다국어 2종 roundtrip) + naia-memory `embeddings.test.ts`(dims) + naia-agent `memory-adapter-embedding.contract.test.ts`(dims·allowlist) |

> NFR: NFR-isolation(슬롯 변경이 타 슬롯·부팅 안 깸) · NFR-deny-default(게이트 미설정 시 안전 기본값). ⚠️ 로컬 설정 영역(1.2b)·통합 VRAM(1.4)·STT 완전통합(Phase 6) = wm/별도 슬라이스 DEFER.

## 기능 요구사항 (FR) — 프로파일 UX 일관화 + 로컬 음성 정직화 (실사용 피드백, 셸 feature — 2026-06-30)

> 범위: naia-shell 설정 **프로파일 탭 디자인 일관화** + **naia-local-voice(로컬 음성) 정직화** (Round 1, naia-shell 단독). 실제 로컬 cascade 기동(lifecycle 임베딩) = **DEFER(Round 2 — naia-omni-windows-manager 정식 로더 #1 M5 의존)**. 트랙: `.agents/progress/naia-os-profile-design-gpu-voice-flow-2026-06-30.md`.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-PROF.1** | 프로파일 탭 **타이포/카드 일관화**. 클래스 없는 `<strong>`(밝은 `--cream` bold 튐) 제거 → 공통 토큰(`.settings-card`/`.settings-card-title`/`.settings-summary-{grid,row,key,value}`). 인라인 style 카드 박스 → 공통 클래스 | S-PROF | `SettingsTab.test.tsx`(35/35 무회귀) · 시각(HMR) |
| **FR-VOICE.1** | naia-local-voice 합성이 **로컬 음성 호스트(`vllmTtsHost`)** 사용 — LLM용 `vllmHost`(localhost:8000) 오용 버그 수정. `SynthesizeOpts.vllmTtsHost` 신설 + ChatPanel 2개 빌드부 + 합성 호출 배선 | S-VOICE | `SettingsTab.test.tsx` · tsc |
| **FR-VOICE.2** | **silent free 폴백 제거(정직화)**. naia-local-voice/vllm 합성 실패 시 브라우저 무료 TTS로 위장 금지 → 1회 명확 알림(`chat.localVoiceUnavailable`) + 무음. 클라우드 provider 는 기존 free 폴백 유지 | S-VOICE | `ChatPanel` 경로 · tsc |
| **FR-VOICE.3** | naia-local-voice **voice picker 채움**(registry voices=기본 음색 1) — 선택 시 stale 클라우드 voice id 잔존 방지. 설정 힌트=로컬 cascade 실행 필요(`settings.localVoiceEngineHint`) + public façade 포트(8910) placeholder | S-VOICE | registry · tsc |
| **FR-VOICE.4** | naia-local-voice `/tts` 합성이 **웹뷰 CORS 로 차단되지 않도록** Tauri 런타임에선 Rust 프록시(`local_voice_synthesize`, reqwest, CORS 면제)로 우회. VoxCPM2(stdlib http, ACAO 없음) 대상 웹뷰 `fetch(POST application/json)`가 preflight 501+ACAO 부재로 실패하던 버그 수정(2026-07-15 실측). 비-Tauri(브라우저/vitest)는 직접 fetch 유지 → 계약 무회귀. 대응 서버측 근본수정 = cascade `voxcpm2_service.py` CORS 헤더(별도, kiosk-4070 배포). ⚠️ **stale(2026-07-15 표면 전환)**: naia-local-voice 가 raw `/tts` → OpenAI `/v1/audio/speech`(3자 합의 정본 표면)로 이동, omni 서버는 CORS 허용(`ACAO:*` 실측) → Rust 프록시 코드 제거됨. 이 행은 이력 보존용 | S-VOICE | (대체: FR-VOICE.5) |
| **FR-VOICE.5** | **4060 half-duplex 로컬 음성 + Ditto 립싱크 배선**. ① `naia-local-voice`의 public cascade 계약은 `POST :8910/tts` body `{text,voice}`이며, :8901 VoxCPM2는 구현 상세로 숨긴다. `voice`는 내장 레퍼런스 팔레트 id이고 미지정 시 `naia-default`다. 반환 RIFF WAV는 변환 없이 통과한다. ② `streamsAvatarPcm(provider)` 게이트: `naia-local-voice`는 AudioQueue 재생과 같은 WAV를 `speakAudio(..., {muted:true})`→Ditto `/stream`에 **직렬** 전달한다. avatar-only 파사드에는 TTS가 없으므로 `/stream_text` 폴백은 금지한다. ③ CPU/NPU DNA3 두뇌와 VRAM VoxCPM2/Ditto 표현은 half-duplex로 동작하며 GPU 경쟁을 만들지 않는다. ④ 실패 시 FR-VOICE.2의 명확한 1회 알림+무음을 유지한다. | S-VOICE-AVATAR | `synthesize.test.ts`(`/tts` URL/payload·RIFF·음색 id·:8910 default) + `cascade-renderer.test.ts`(WAV→`/stream`, muted) + 실행 중 실제 façade probe(:8910 health·/tts RIFF·/stream Ditto) + Tauri UI 관찰 |

> NFR: NFR-honesty(미가용을 free 음성으로 위장 금지) · F1(measurement-gated). ⚠️ **DEFER Round 2**: 로컬 cascade lifecycle 임베딩(naia-shell Rust sidecar 기동/헬스체크) + windows-manager 정식 로더(#1 M5). 8GB 기기 적합성=미측정(소형/양자화 음성 모델 탐색 별도).

## 기능 요구사항 (FR) — 16GB 로컬 프로파일 자동설정 + 음색/에코 배선 (2026-07-15, 코스포 시연 로컬 장면)

> 배경: 루크 지시로 "GPU 프로파일 선택 하나로 두뇌·음성·아바타가 자동 설정"되는 시연 로컬 장면
> (9B 로컬 LLM + VoxCPM2 int8 로컬 음성 + VRM). FR-VRAM.4("추천만, 자동변경·숨김 없음")를
> **본 FR 이 개정**한다 — 루크가 명시적으로 자동 적용을 요구했으므로 추천→자동적용으로 전환.

| ID | 요구사항 | UC/시나리오 | 검증(P02) |
|----|----------|-----------|------|
| **FR-VRAM.5** | **검증-티어 전용 프로파일 + 자동설정** (FR-VRAM.4 개정). ① `hidden` 티어는 피커 비노출 **+ `selectVramTier`(auto) 제외** — 미검증 티어 자동선택이 NVA 아바타를 몰래 심던 사고 차단. 검증 티어에는 `laptop-4060-8g`와 `local-llm-voice-16g`가 포함된다. 4060 8GB는 DNA3를 CPU/NPU(`ollamaNumGpu=0`)에 두고 VRAM에는 VoxCPM2 int8 3.47GB+Ditto 2.6GB(계획 6.07GB)를 half-duplex로 둔다. ② 프로파일 선택 = **자동설정**(stageLocalSlots): 두뇌(로컬 LLM capability → provider=ollama + compact DNA3), 음성(tts capability → naia-local-voice + :8910 façade), 아바타(avatar capability 없으면 → VRM 복원). ③ 단독 설치는 loader가 필요한 모델·런타임 다운로드와 준비 상태를 노출한 뒤에만 실행 가능으로 전환하며, 저장값·구 id 하위호환(normalizeTierId)을 유지한다. | S-VRAM-AUTO | `vram-tiers.test.ts`(4060 6.07GB·hidden auto 제외) · `SettingsTab.test.tsx`(4060/16G 프로파일 자동설정) · `slots-manifest.contract.test.ts` · 실행 중 loader `plan --profile laptop_4060_8g` · Tauri 다운로드/준비 상태 UI |
| **FR-VOICE.6** | **로컬 음성 정본 호스트 = :8910 façade**. `DEFAULT_LOCAL_VOICE_HOST` = `http://localhost:8910`이며 public 표면은 `POST /tts`다. :8901 VoxCPM2와 구 :22600 raw 서비스는 Shell이 직접 호출하지 않는다. 프로파일 자동설정은 **빈 값·localhost/127.0.0.1 변형만** 이 기본으로 교체(원격 GPU Tailscale 호스트는 보존)한다. | S-VOICE-AUTO | `synthesize.test.ts`(:8910 `/tts` 기본 호스트) · `SettingsTab` 자동설정(원격 호스트 보존) |
| **FR-VOICE.7** | **프리셋 음색 façade 팔레트 id 전달**. naia-local-voice 의 `voice` = 사용자 음성 참조(`voiceRefUrl`)의 basename(쿼리/프래그먼트 제거 후 `.wav` 파일명 → façade `/ref/voices` 팔레트 id). 팔레트 밖 값(녹음/업로드·비-wav)은 `naia-default` 폴백(서버가 모르는 id 를 200+랜덤 음색으로 받으므로). **vllm provider 는 제외** — 범용 OpenAI 서버라 팔레트 id 를 모름, `"default"` 유지. 두 합성 경로(파이프라인·Live)가 단일 `resolveTtsVoiceId(config)` 공유 → 분기 드리프트 방지 | S-VOICE-PRESET | `ChatArea` 음색 해석(프리셋→id·쿼리스트링·vllm 분리) |
| **FR-ECHO.1** | **자기발화(에코) 방어 2단**. ① 재생 중 마이크(STT 세션) 정지 + 종료 0.8초 후 재개 — 재개 대기 타이머는 다음 문장 재생 시작 시 취소(문장 간 큐 드레인으로 마이크가 발화 중 재개통되던 누수 차단). ② 최근 TTS 문장과 유사도(문자 bigram Dice ≥ 0.6 또는 ≥8자 부분일치)면 STT 결과 스킵 — **짧은 정상 답변("좋아/네/그래")은 절대 스킵 금지**(bigram 폴백 정확일치, 부분일치 길이-게이트) | S-ECHO | `echo-text-filter.test.ts`(동일·부분·짧은답변·정상질문 8건) |

> NFR: FR-VRAM.5 <16GB 트레이드오프는 프리릴리스 한정. FR-ECHO.1 은 web-speech 지연배달 특성 대응(1차 마이크정지가 주 방어, 2차 텍스트필터는 누수 폴백). ⚠️ **후속(비블로킹)**: 부팅 병합(mergeBootConfig)이 localStorage-only 키(naiaKey 시크릿·discord 커서·세션 플래그)를 보존하지 않는 회귀 — 데모 실사용 정상 확인이나 재로그인/중복응답 가능성, 부팅 흐름 변경은 별도 안전작업으로 분리.

## 기능 요구사항 (FR) — BGM 스킬 배선 (2026-07-16, 시연 크리티컬 — 루크 demo freeze 해제 승인)

> 배경: 스킬 회귀 조사(naia-agent FR-PROV-6, ollama tools)에서 발견된 별개 이식 갭 — BGM 위젯(BgmPlayer)·
> 검색 사이드카(:18791, #335)·에이전트 UC8 어댑터는 전부 존재하나 **도구 등록 배선이 0** 이라 나이아가
> BGM 을 모름(구 monolith 는 agent 내장 스킬이 `bgm_youtube_*` 이벤트를 발사했음). 설계 = 패널(환경) 도구
> 경로(agent compose 주석 E1 "브라우저/BGM=셸 소유 환경") — **naia-agent 무변경**.

| ID | 요구사항 | UC/시나리오 | 검증(P02) |
|----|----------|-----------|------|
| **FR-BGM.1** | **skill_youtube_bgm 패널 도구 배선** (셸 단독, agent 무변경). ① `lib/bgm-skill.ts`: 도구 descriptor(액션 play/stop/pause/resume/next/prev/volume, tier 0 — App.tsx 가 이미 auto-allow) + `executeBgmSkill(args, deps)`(deps 주입: search=사이드카 `GET :18791/yt/search`, emitBgm=Tauri `emit("agent_response", …)` — **위젯이 이미 듣는 `bgm_youtube_*` 타입으로 발사**, BgmPlayer 무변경). play=videoId 직접 또는 query 검색 첫 결과(UC8 어댑터 동형), volume=0..1 clamp. ② 부팅 등록: App.tsx keepAlive 등록 effect 에서 `sendPanelSkills("bgm-widget", [SKILL_YOUTUBE_BGM])` — 위젯은 앱이 아니라 descriptor.tools 경로 부재. ③ 실행: ChatArea `dispatchPanelToolCall` 에 BGM 분기(appRegistry 소유자 탐색 앞) → `executeBgmSkill` → `sendPanelToolResult`. 음성 경로(onPanelToolCall)도 같은 dispatch 공유라 자동 커버. ⚠️ 음성/립싱크(FR-VOICE.5) 경로 무접촉 | S-BGM-SKILL·UC8 | `bgm-skill.test.ts`(단위 — 액션·검색·clamp·payload·오류) + **`e2e/bgm-skill.spec.ts`(실 UI 배선 회귀 가드 — 부팅 등록 + 채팅 턴 dispatch→위젯 재생, P04 실 UI 게이트 충족)** · tsc · 실 재생=부스 리허설(수동) |

## 기능 요구사항 (FR) — Shell 기본 라디오 DJ·행사 소개 스킬 (#362, 계획)

> 범위: 이 절은 구현 계획의 정본이다. 반복 발화의 일정·침묵·사용자 우선순위는 naia-agent가 소유하고, Shell은 실제 재생과 환경 관측 사실을 제공한다. `skill_youtube_bgm`은 저수준 제어로 유지하며 `skill_radio_dj`가 이를 조합하는 기본 스킬이다.

| ID | 요구사항 | 수용 기준 |
|---|---|---|
| **FR-RADIO-DJ.1** | Shell은 YouTube 재생 요청과 관측 결과를 구분해 `playbackId`, `commandId`, 단조 증가 `sequence`, `updatedAt`, `freshUntil`을 포함한 재생 스냅샷을 제공한다. 상태는 `requested/loading/playing/paused/ended/error/timeout`으로 분류한다. DJ 소개·대체·진행 위치 판단용 관측값의 최대 경과시간은 **5초**이며, 만료 뒤에는 재관측한다. | 이전 곡 A의 지연 오류가 새 곡 B의 상태를 덮어쓰지 않는다. 같은 `playbackId`의 더 낮은 sequence 이벤트는 무시된다. `freshUntil`이 지난 스냅샷으로는 멘트를 만들지 않고, 새 `playbackId/sequence` 관측 전에는 TTS를 시작하지 않는다. |
| **FR-RADIO-DJ.2** | `BgmPlayer`의 YouTube iframe 어댑터는 준비·상태 전이·오류·재생 위치/길이 이벤트를 수신하고, 로딩 제한시간과 오류 분류를 적용한다. | 패널 이벤트 발행이나 iframe URL 설정만으로 `playing`을 보고하지 않는다. 실제 iframe의 재생 확인 뒤에만 `playing`을 보고하며, `currentTime/duration`과 종료를 관측한다. |
| **FR-RADIO-DJ.3** | `skill_radio_dj`와 확장된 `skill_youtube_bgm`는 패널 스킬 등록, 허용 정책, `dispatchPanelToolCall`, `panel_tool_result`, 재등록/해제 수명주기에 모두 연결된다. | 대화·연속 발화·라디오 DJ·행사 소개 경로에서 동일한 도구 결과 계약을 받고, 창 재연결 뒤 중복 등록이나 유실이 없다. |
| **FR-RADIO-DJ.4** | 자율 발화 전 agent는 Shell 관측 컨텍스트를 요청·반영하고, 발화 문장 생성 전에 적격성을 판정한다. agent가 쿨다운, 곡 중복, 침묵, 사용자/마이크 우선순위 및 다음 재평가 시점을 소유한다. | Shell은 별도 스케줄러 없이 관측·표현 경계로서, agent의 허용 요청에 현재 `observationSequence`·`playbackId`를 묶은 **단일 사용 `speakPermit`**을 발급한다. TTS 직전 Shell은 permit·사용자 음성/채팅·현재 TTS·재생 sequence·`freshUntil`을 원자적으로 재검증한다. 하나라도 달라지면 permit을 폐기하고 TTS를 시작하지 않으며 agent는 다음 재평가를 예약한다. |
| **FR-RADIO-DJ.5** | DJ 멘트는 해당 `playbackId`의 관측된 `playing` 뒤에만 곡명·아티스트·길이·진행 위치를 소개한다. 오류·시간초과면 사실을 숨기지 않고 한 번만 알리거나 침묵하며, opt-in 자동재생일 때만 1회 대체곡을 시도한다. | `ok: true`(명령 접수)만으로 곡 소개를 하지 않는다. 실패 곡의 제목이나 길이를 현재 재생 중인 것처럼 말하지 않는다. |
| **FR-RADIO-DJ.6** | 시간·날씨 컨텍스트는 유효한 IANA 시간대와 명시적 날씨 동의에 한정한다. 설정·복원·profile 갱신에서 시간대를 검증하고, 유효하지 않으면 명시적 기본 시간대로 정규화하거나 시간 언급을 비활성화한다. Shell은 agent/LLM에 원 좌표 대신 관측 시각·날씨 결과·정밀도를 낮춘 위치 범위만 전달한다. 동의 철회 시 좌표·날씨 캐시를 즉시 폐기하고 프로필 갱신을 보낸다. | 구현 전에 날씨 캐시 TTL과 위치 정밀도(도시/권역)를 설정값으로 확정한다. 동의가 없거나 관측값이 오래되면 날씨 언급을 생략하며, 시간대 정규화/비활성 결과를 관측 가능하게 한다. |
| **FR-RADIO-DJ.7** | 검증은 결정론적 로컬 iframe 이벤트 fixture와 실제 Tauri 경로를 기본으로 한다. 외부 YouTube는 선택적 수동 smoke로 분리한다. | CI에서 ready/playing/error/ended, A→B→늦은 A 오류, 만료 스냅샷 재관측, 예약 뒤 사용자 인터럽트, 유효/무효 IANA 시간대와 DST 경계, 도구 결과와 activity 발화 조건을 재현한다. 외부 YouTube 재생 성공을 CI 합격 조건으로 두지 않는다. |

### 구현 순서 및 인계 항목

1. **프로토콜 설계:** agent↔Shell 관측 요청/응답, `playbackId`·`commandId`·sequence, 거절·시간초과·재평가 규칙을 문서화한다.
2. **재생 관측:** iframe 어댑터와 BGM 상태 모델을 구현하고, 기존의 낙관적 `setPlaying(true)` 경로를 관측 기반 상태로 교체한다.
3. **도구 연결:** 기본 `skill_radio_dj`와 BGM 저수준 도구를 패널 등록부터 결과 반환까지 일관되게 배선한다.
4. **자율 정책:** agent의 개인 라디오/행사 소개 스케줄러에 적격성 게이트와 근거 있는 멘트 규칙을 넣는다. Shell에는 중복 스케줄러를 만들지 않는다.
5. **환경·프라이버시:** 시간대·날씨 동의·캐시 폐기·위치 정밀도를 구현하고 노출 최소화 테스트를 추가한다.
6. **검증:** 로컬 fixture E2E, 순서 역전·오류·침묵·사용자 인터럽트 테스트 후 선택적 외부 smoke를 수행한다.
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

> NFR: **NFR-noWSL(불변)** — 빌드·설치·런타임 어느 구간에도 WSL 요구 금지(현행 0건을 요구사항으로 고정). · NFR-honesty — 미실측(mac 실기기)·미서명을 문서와 산출물 설명에 그대로 표기, "지원" 위장 금지. · 재현성 = "사람 기억에 의존하는 수동 단계 0". ⚠️ 범위 밖(별도 이슈로 후속): 코드 서명(win 인증서·mac 공증), updater `.sig` 생성/키, **updater endpoint stale**(base conf 가 폐기된 `nextain/naia-os` releases 를 가리킴 — 설치본 첫 실행 시 죽은 endpoint 조회, 후속 이슈로 교정), flatpak 경로, `WslSetupScreen` 죽은 레거시 삭제(기존 DEFER 유지).

> **FR-INSTALL.2 P3 실측 보강(2026-07-18)**: 필수 스테이징은 agent뿐 아니라 셸 소유 BGM
> sidecar도 포함한다. `stage-bgm-sidecar.mjs`가 prod-hoisted `dist`·`package.json`·`node_modules`를
> 생성하고 매트릭스 공통 리소스로 동봉한다. `stage-agent.mjs`는 TypeScript가 복사하지 않는
> `naia_agent.proto`를 compiled gRPC module 옆에 복사하고 실존을 게이트한다. 두 항목 모두 설치본
> 핸드셰이크 실측에서 발견된 배포 계약이며 dev 상대경로 폴백으로 대체하지 않는다.
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

> NFR: F1(RTF measurement-gated — VRAM 적합≠실시간 보장) · 원격 금지(로컬 사이드카만). ⚠️ **DEFER R2.3**: 8GB 음성 단독 실기동(모델/venv 설치 전제) RTF 실측 + 소형/양자화 필요성 판정. Windows 강제종료 고아 하드닝(job object / PID 기반 stale-kill)=후속. 검증: cargo check 0·tsc 0·windows-manager pytest 31·naia-shell SettingsTab+slots 66.

## 기능 요구사항 (FR) — 8G 로컬 GPU 재티어링(3모드) + 원격 cascade 연결 (2026-07-08, 셸 feature)

> 범위: 8GB GPU 는 로컬 LLM·비디오 아바타·음성을 동시 구동 불가(VRAM 예산 초과) → **배타 3모드 택1**(llm | avatar | both). 음성(VoxCPM2)은 8G 에선 항상 클라우드(로컬 음성 없음). cascade 소스를 로컬 auto-spawn(T1) 외에 **원격 URL(T3, 직접운영)** 로도 지정 가능(고급). 축 SoT = alpha-adk `.agents/progress/naia-video-avatar-voice-architecture-sot-2026-07-08.md`. 구 avatar/voice 6G/8G 축 폐기. **테스트의 로컬 라벨 FR-5/6/7/8 = 아래 FR-VRAM.5/6·FR-CASCADE.5/6/7** 로 매핑(spec ↔ 요구사항 정합).

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-VRAM.5** (spec FR-5) | 8G 배타 티어(`local-llm-avatar-8g`) = **llm/avatar/both 3모드 focus 택1**. `resolveLocalCapabilities` 배타 해소(llm→[llm]·avatar→[avatar]·both→[llm,avatar]), 음성=항상 클라우드(tts 로컬 제거). 구 "voice" focus→"avatar" 마이그레이션. 기본=llm(프라이버시). 비배타 12G+ 는 focus 무시(슬롯 그대로) | S-VRAM8G·UC12 | `vram-tiers.test.ts`·wm `test_manifest.py`(focus 배타·비8G 무시·voice→avatar)·`capability-settings.spec.ts`(FR-5 focus 셀렉터 3옵션) |
| **FR-VRAM.6** | **VRAM 프리플라이트 폴백** — `fitLocalCapabilitiesToVram(caps, freeVramGb, margin)` 이 free VRAM 부족 시 로컬 LLM→클라우드 강등(`llmFallbackToCloud`) + UI 정직 경고(`local-llm-vram-fallback`). 프라이버시 위장 금지(강등을 로컬로 표기 안 함) | S-VRAM8G | `vram-tiers.test.ts`(fit 폴백)·`capability-settings.spec.ts`(fallback 배지) |
| **FR-CASCADE.5** (spec FR-6) | 비디오 아바타 립싱크 노트 — 아바타 탭에서 naia-video-avatar 선택 + TTS off 시 경고(`nva-lipsync-note`, 립싱크엔 TTS 필요). 8G avatar 모드=음성 클라우드라 TTS 필수 안내 | S-AVATAR8G | `capability-settings.spec.ts`(FR-6) |
| **FR-CASCADE.6** (spec FR-7) | 비디오 아바타는 **cascade capability(명시적 로컬 avatar profile or 로그인) 게이트** — 로컬 프로파일이 avatar 미제공(저티어/off/legacy `auto`)이고 로그인도 없으면 video-avatar 옵션 비활성 + 안내(`avatar-cascade-required`). 로그아웃이어도 명시된 로컬 avatar-capable profile은 로컬 NVA 선택 가능하며, 원격 Host URL은 FR-CASCADE.7에 따라 로그인 전용이다. | S-AVATAR8G·UC12 | `capability-settings.spec.ts`(FR-7 게이트·로그아웃 교차·로컬 avatar profile·legacy auto 잠금) |
| **FR-CASCADE.7** (spec FR-8) | **NVA 원격 cascade 소스(T3)** — 로그인 사용자가 아바타 설정에서 NVA를 선택한 뒤 `cascadeRuntimeUrl`(http/https만, `normalizeCascadeUrl` 검증·정규화·trailing slash 제거)을 지정한다. 사용자가 명시한 NVA Host가 로컬 파사드보다 우선하며, 원격 장애를 이유로 로컬 Ditto를 암묵 기동하지 않는다. 원격 계약은 `GET /health` 성공 후 query 없는 `GET /idle` 전체 MP4를 Blob으로 재생하고, 원격 서버에 클라이언트의 NVA 경로를 `/load_nva`로 보내지 않는다. | S-CASCADE-T3·UC12 | `config.test.ts`(URL 정규화)·`capability-settings.spec.ts`(NVA 설정 표면/게이트)·`nva-remote-idle.live.spec.ts`(실 원격 idle opt-in) |
| **FR-CASCADE.8** | **원격 NVA 결합 발화·투명성 계약** — 명시한 원격 NVA Host는 `/stream_text`에서 서버가 합성한 음성과 아바타 영상을 함께 반환하며, Shell은 별도 로컬 TTS를 중복 재생하지 않는다. 로컬 음성 + 아바타 분리 경로는 기존대로 로컬 음성을 재생하고 원격 `/stream` 영상은 음소거한다. 투명 배경은 cascade가 VP9 `yuva420p` 알파 영상을 제공할 때만 성립하며, 불투명 H.264를 클라이언트에서 투명하다고 위장하지 않는다. | S-CASCADE-T3·UC-AV | `cascade-renderer.test.ts`(muxed/unmuted·split/muted 렌더)·`nva-remote-idle.live.spec.ts`(실 원격 idle/stream) |

> NFR: **NFR-voiceprint(불변)** — naia 가 VoxCPM2 를 쓸 때 **음성지문(ref voiceprint) 필수**(무지문 합성 금지). 8G 는 로컬 음성 없음(클라우드)이라 무지문 옵션 불요. 계약 = naia-omni-cascade `cascade-contract-governance.md` §5.5 + `tts_voxcpm2.py`(`require_voiceprint=True`). · NFR-honesty(VRAM 강등 위장 금지) · F1(RTF 단정 금지 — 8G 아바타 실시간=미측정, 사용자 실기 검증). ⚠️ **정리 대상(DEFER)**: in-shell WSL cascade 부트스트랩(`WslSetupScreen`+`setup_wsl`)=구 gateway-in-WSL 아키텍처 죽은 레거시(orphan 컴포넌트·`generate_handler!` 미등록·Rust 백엔드=macos 스텁뿐) → 삭제 결정 대기.

## 기능 요구사항 (FR) — 지식 근거→원문 칩 + 그래프 뷰어 (kb-compiler 통합 K2·K3, 셸 feature — 2026-06-30)

> 범위: naia-agent 지식 풀 도구(`skill_knowledge_ask`/`search`) tool-result(JSON)를 셸이 **답변 + 출처 칩**으로 렌더하고, 칩 클릭 시 **근거→원문**(URL=브라우저 패널 navigate / 파일=워크스페이스 openFile)으로 연다. 통합 설계 SoT = alpha-adk `.agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md`(K2). 백엔드(에이전트↔kb-compiler 배선·계약) = naia-agent UC-KNOWLEDGE(별 레포, live).
>
> **상태: Done (P04, 2026-06-30)** — 검증: `knowledge-result.test.ts`(파싱·출처분류·**그래프 파싱** 단위)·`knowledge-tool-result.test.tsx`(RTL 렌더+칩 dispatch)·`e2e/chat-tools.spec.ts` "지식 도구(K2)"·"**지식 그래프(K3)**"(Playwright 실 UI — 답변+칩+칩클릭→브라우저 패널 / 그래프 캔버스 렌더+2D/3D 토글). tsc0·셸 컴포넌트(src/main 밖→file-anchor 무대상).

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-KB-OS.1** | 지식 도구 tool-result(JSON) 파싱 — `ask`={abstained,answer,sources[{title,sourceUris}]}·`search`={hits[...]}. 형태불일치/비지식도구 = 기본 ToolActivity 렌더 폴백(무회귀) | UC-KNOWLEDGE(agent) | `knowledge-result.test.ts` |
| **FR-KB-OS.2** | 답변 + 출처 칩 렌더 — `ToolActivity` 가 지식 도구 분기 → `KnowledgeToolResult`(answer + sourceUris 칩). 기권 시 답변만(칩 0). 출처 sourceUris 보존(근거→원문 키) | UC-KNOWLEDGE | `knowledge-tool-result.test.tsx` |
| **FR-KB-OS.3** | 근거→원문 — 칩 클릭: URL=브라우저 패널 `navigate`+activate / 파일=워크스페이스 `openFile`(file:// 제거)+패널 전환. 기존 panel api 재사용(신규 패널 불요) | UC-KNOWLEDGE | `knowledge-tool-result.test.tsx`·`e2e/chat-tools.spec.ts`(지식 도구 K2) |
| **FR-KB-OS.4** (K3) | 지식 그래프 2D/3D 시각화 — `ToolActivity` 가 `skill_knowledge_graph` tool-result(nodes/edges+deg+군집) 분기 → `KnowledgeGraphView`(캔버스 force, 군집색·degree 크기, **2D↔3D 토글**, 원근+자동회전). 의존성 0(엔진 examples/cms 포팅). 파싱 실패=폴백 | UC-KNOWLEDGE(graph) | `knowledge-result.test.ts`(parseKnowledgeGraph)·`e2e/chat-tools.spec.ts`(지식 그래프 K3 — 캔버스 렌더+2D/3D 토글 실 UI) |

> NFR: NFR-isolation(지식 렌더 분기가 기존 도구 렌더 무회귀 — 파싱 실패 시 폴백)·NFR-reuse(브라우저/워크스페이스 패널 api 재사용·그래프 의존성 0 캔버스). 전용 그래프 패널(on-demand fetch) = post-MVP. 설정 지식 탭(관리 compile/소스) = 아래 K4.

## 기능 요구사항 (FR) — 지식 소스 관리 설정 탭 (kb-compiler 통합 K4, 셸 — 2026-06-30)

> 범위: 설정>지식 탭이 **"준비 중" placeholder 를 대체**해, 사용자가 **지식 소스(다중 폴더)·스코프**를 관리하고 **컴파일**을 트리거하는 관리면. 설정 정본 = `naia-settings/knowledge.json`(**셸만 쓰기, AI 에이전트 읽기전용** — config-write 도구 없음 = 신뢰경계 자가확장 차단). 컴파일 실행(폴더→kb.json)·답변(읽기)은 **naia-agent**(별 레포 — `CompileKnowledge` RPC·`openWorkspaceKnowledge`). 통합 설계 SoT = alpha-adk `.agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md`(K4).
>
> **상태: 진행 중 (P03→P04, 2026-06-30)** — 검증: `knowledge-config.test.ts`(config CRUD·kb 통계 파싱 단위)·`KnowledgeSettingsTab.test.tsx`(RTL 폴더 add/remove·상태 렌더)·`e2e/settings-knowledge.spec.ts`(Playwright 실 UI: 설정 지식 탭 폴더 추가/제거/상태). 컴파일 트리거(FR-KB-OS.8)는 에이전트 `CompileKnowledge` 배선에 의존.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-KB-OS.5** | 소스 폴더 레지스트리 — 다중 폴더 추가(폴더 선택 다이얼로그)/제거/목록. 정규화 dedup. `naia-settings/knowledge.json`(`{version,scope,sources[{path,label}]}`) 영속 — `read/write_naia_knowledge_config` Rust 커맨드(**셸 전용 write**) | UC-KB-MANAGE | `knowledge-config.test.ts`·`KnowledgeSettingsTab.test.tsx` |
| **FR-KB-OS.6** | 지식 스코프 표시 — 현 스코프(프로젝트, 기본 `default`) 표기. kb 정본 = `knowledge/<scope>/kb.json`(naia-adk) | UC-KB-MANAGE | `knowledge-config.test.ts` |
| **FR-KB-OS.7** | 컴파일 상태 — `read_naia_knowledge_kb({adkPath,scope})` 로 kb.json envelope(`{version,kb}`) 통계(카드·엔티티·관계·accepted) 표시, 부재 = "미컴파일" | UC-KB-MANAGE | `knowledge-config.test.ts`(parseKbStats)·RTL |
| **FR-KB-OS.8** | 컴파일 트리거 — "지금 컴파일" → `compile_knowledge({adkPath})` → 에이전트 `CompileKnowledge`(sources→compile→kb.json) → 완료 후 상태 재조회. 실패 = 정직 표기(throw 차단·UI 무붕괴) | UC-KB-MANAGE | `KnowledgeSettingsTab.test.tsx`·`e2e/settings-knowledge.spec.ts` |
| **FR-KB-OS.9**(보안) | 설정 불가침 — `knowledge.json` 은 **셸 UI 만 기록**. 에이전트엔 config-write 도구 없음·파일 도구도 `naia-settings/` 쓰기 거부(별 레포 K-SEC). UI 입력은 AI 미경유(직접 `invoke`) | UC-KB-MANAGE | (계약: config-write 도구 부재) |

> NFR: NFR-config-ownership(설정=사람/셸 소유, 에이전트 읽기전용 — FR-KB-OS.9)·NFR-isolation(컴파일 실패가 관리 UI 무붕괴)·NFR-reuse(`naia-settings` asset 커맨드·폴더 다이얼로그 기존 패턴 재사용).

## 기능 요구사항 (FR) — UI 재구성: 홈 몰입대화 + 워크스페이스 4단 관제탑 (#ui-reorg, 셸 feature — 2026-06-29)

> 범위: naia-shell 셸 UI(`App.tsx`·`ChatPanel.tsx`·`WorkspaceCenterPanel.tsx`·`Terminal.tsx`·`global.css` + 신규 `DocTabBar.tsx`). 사용자 실사용 피드백: "naia와 대화가 집중 안 됨 / 코딩 쓰기엔 좁음 / 터미널 여럿 + 문서 대량인데 작업문서 찾기 어려움". 트랙: alpha-adk `.agents/progress/naia-os-workspace-chat-reorg-2026-06-29.md`. 워크트리 `feat/ui-workspace-chat-reorg`.
>
> **상태: P04 GREEN (P05 대기 — process-status.json 갱신은 헌장이라 사용자 승인 후)** — tsc 0 · vitest 961 pass(1 fail=SettingsTab "Naia Voice" 선재, 무관) · e2e 91+120 18/18(무회귀) · e2e 119 신규 T6-T10 pass. 베이스 선재 플래키(T4/T5 터미널-생성 레이스)는 본 변경 무관(베이스 동일 실패 확인).

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-UI.1** | UI 모드는 **단일 신호**(`usePanelStore.activePanel` 파생 `data-ui-mode`). 새 모드 SoT 신설 금지 — `null`=home(VN)·`workspace`=4단·기타=panel(floating) | S-VN·S-WS4 | `119` T6/T7(data-ui-mode + variant) |
| **FR-UI.2** | ChatPanel은 **단일 인스턴스를 CSS로 재배치**(variant=vn/rail/floating). 모드 전환·레일 접기에도 **언마운트 금지**(voice/STT/TTS 세션 연속성). 마운트 조건은 activePanel과 분리 | S-VN·S-WS4 | `119` T8(레일 접기 시 `.chat-panel` attached 유지) |
| **FR-UI.3** | 워크스페이스 = 4단 `[대화창 레일 \| 워크트리 \| 문서뷰어(상)+터미널(하) \| 서브에이전트]`. 대화 레일 접기(persist)·중앙 상하 비율 자유 리사이즈·터미널 탭/그리드 토글 | S-WS4 | `119` T7/T8/T9 + 91 18/18 무회귀 |
| **FR-UI.4** | 문서뷰어 **탭바**로 다수 문서 유지·전환(`openDocs`). 서브에이전트 클릭 시 최근문서 탭 surface. "editor" 가짜 탭 제거(에디터=상시 상단 zone) | S-DOC | `119` T10(세션→탭 surface) + 91 S3/S6 |
| **FR-UI.5** | 터미널 파일경로 **기본 클릭=문서 열기(불변)** / **Alt+클릭=AI 질의**(naia:ask-ai). 문서 탭 ✦=AI 질의. 기존 `onFileSelect` 동작 회귀 0 | S-ASK | `Terminal.tsx` activate Alt 분기 + `naia:ask-ai` 수신(ChatPanel 기존) |
| **FR-UI.6** | 대화 레일 접힘 상태 **localStorage 영속**(`naia-ws-rail-collapsed`) | S-WS4 | `119` T8(토글 왕복) |

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
| **FR-WIRE-SHELL-04** | Rust proto 소비는 명시한 paired Agent proto만 사용하고, 경로 누락·unknown/UNSPECIFIED enum·오래된 proto를 fail-closed한다. paired commit, proto SHA-256, dirty 상태를 빌드 증거에 남긴다. | `src/test/uc-wire-v1-paired-proto.contract.test.ts`, Rust `wire_v1_*` tests | Implemented |

NFR: additive backward compatibility, secret/raw endpoint/raw evidence zero-transit,
bounded input/output, paired-proto reproducibility, unknown enum fail-closed,
stable-code-only wire, localized presentation.

## Discord setup/preflight policy (#388)

> Status: Contract frozen. The production Discord setup wizard remains hidden
> until native secret-backed setup/preflight facts are wired. Handoff note:
> `docs/progress/99.dev-comm/discord-wizard-prefreeze-policy-2026-07-19.md`.

| ID | Requirement | UC/Scenario | Verification | Status |
|---|---|---|---|:---:|
| **FR-DISCORD-SETUP-01** | Discord install URL policy uses only a canonical snowflake client id, `bot` scope, and minimum permissions/intents. Raw bot tokens must not cross WebView string IPC or UI persistence boundaries. | UC10/S36/S37, UC12 auth | `src/test/discord-install-policy.contract.test.ts` | Contract frozen; raw-token IPC guard enforced |
| **FR-DISCORD-SETUP-02** | Discord preflight policy classifies network, rate limit, token validity, message-content intent, guild install, channel visibility, permissions, and agent readiness into stable codes; malformed/unknown facts fail closed. This change freezes the policy only; production setup must supply native preflight facts before enabling the wizard. | UC10, UC14 degradation | `src/test/discord-preflight.contract.test.ts` | Contract frozen |

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
| **FR-LLM-ROLE.2** | main/sub/memory 역할의 provider·model·credentialRef를 독립 저장하고 복원한다. | role config roundtrip 계약 |
| **FR-LLM-ROLE.3** | dev/stage/Tauri build는 동일한 정확한 Agent commit과 proto SHA를 강제하며 임의 sibling checkout을 사용하지 않는다. | paired contract와 dirty/wrong-commit negative test |

- **NFR-LLM-ROLE-secret**: Codex 로그인 파일이나 토큰을 Shell 설정·wire·로그로 복사하지 않는다.
- **NFR-LLM-ROLE-pairing**: Agent 기능 변경 뒤 Shell pin을 새 정확한 commit으로 갱신하기 전에는 빌드가 실패해야 한다.

## 전주대 강의 Codex 준비 상태 요구사항 (2026-07-21)

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| **FR-COURSE-CODEX.1** | 사용자가 설정의 두뇌에서 Codex를 main provider로 선택했을 때, Shell은 `Codex 연결 확인`으로 해당 PC의 Codex CLI 설치와 로그인 상태를 확인하고 `준비됨`·`설치 필요`·`로그인 필요`·`확인 실패`을 구분해 표시한다. | Rust 명령 계약 테스트에서 Windows와 비-Windows 실행 경로·상태 분류를 확인하고, Settings 단위 테스트에서 상태 표시와 재시도를 확인한다. |
| **FR-COURSE-CODEX.2** | Codex 준비 확인은 인증 토큰·계정 식별자·CLI 출력 원문을 UI·설정·agent 요청·로그에 저장하거나 표시하지 않으며, provider·모델·워크스페이스 설정을 변경하지 않는다. | 실패 상태 단위 테스트와 IPC 결과 직렬화 검사에서 안전한 상태 코드만 노출되는지 확인한다. |
| **FR-COURSE-CODEX.3** | Codex가 아닌 provider를 선택하면 Codex 준비 확인 UI를 노출하지 않는다. Codex 선택으로 돌아오면 사용자가 명시적으로 다시 확인할 수 있다. | Settings FE 테스트에서 provider 전환과 재시도 동작을 확인한다. |

## Codex 코딩 작업자 요구사항 (2026-07-22)

| ID | Requirement | Verification |
|---|---|---|
| **FR-CODEX-WORKER.6** | Jeonju course mode is explicit and leaves the default isolated worktree behavior unchanged. Shell preflights the selected Git root, clean working tree, and remote before asking Agent for selected-workspace execution. | Shell UI/adapter contract and native preflight contract; normal workers remain `ISOLATED_WORKTREE`. |
| **FR-CODEX-WORKER.7** | The course file boundary is fixed in Rust IPC to `index.html` and `hero.svg`. WebView, LLM, Discord, and task text cannot provide or modify allowed files. Shell displays Agent's verification summary. | typed Tauri invoke contract, selected-workspace Agent contract, and Tauri E2E with an isolated course fixture. |
| **FR-CODEX-WORKER.8** | On course preflight or verification failure Shell creates no success state, gives a safe folder-readiness message, and preserves student changes for review. | rejection unit/adapter test and paired Agent failure contract. |

| ID | 요구사항 | 검증 기준 |
|---|---|---|
| **FR-CODEX-WORKER.1** | Shell은 Coding Workers 패널에서 `codex` provider, 절대 worktree 경로, 비어 있지 않은 작업 설명을 받아 worker adapter에 생성 요청할 수 있다. adapter가 없거나 실패하면 성공 상태를 만들지 않는다. | adapter fake 계약과 UI 테스트에서 생성 성공은 반환된 worker에만 한정되고 unavailable adapter는 오류·빈 목록으로 남는지 확인한다. |
| **FR-CODEX-WORKER.2** | worker는 안정적 ID, provider, worktree, task, 상태, 마지막 갱신 시각, 선택적 checkpoint ID를 가진다. 상태는 `queued`, `running`, `cancelling`, `cancelled`, `completed`, `failed`만 허용한다. | 도메인 검증 및 상태 렌더링 테스트. |
| **FR-CODEX-WORKER.3** | `queued`·`running`·`cancelling` worker가 점유한 worktree에는 새 worker를 요청하지 않고 충돌 이유를 표시한다. 병렬 작업은 서로 다른 격리 worktree에서만 시작한다. | same-worktree negative UI 테스트. |
| **FR-CODEX-WORKER.4** | 취소와 재개는 각각 worker adapter의 대상 ID 요청으로만 수행한다. 재개는 checkpoint ID가 있는 `cancelled` 또는 `failed` worker에만 가능하며, PTY kill 또는 새 shell 생성은 재개가 아니다. | cancel/resume adapter 호출 및 checkpoint negative 테스트. |
| **FR-CODEX-WORKER.5** | Shell은 원본 adapter 오류, Codex 로그인 토큰, 계정 식별자, CLI 출력 원문을 worker UI·로그·persistent config에 노출하지 않는다. | unavailable/error sanitization 테스트. |

- **NFR-CODEX-WORKER-contract**: Agent gRPC schema가 확정되기 전에는 Shell adapter가 worker lifecycle의 성공을 반환하거나 PTY를 worker로 위장하지 않는다.
