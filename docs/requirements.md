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
| **FR-VOICE.3** | naia-local-voice **voice picker 채움**(registry voices=기본 음색 1) — 선택 시 stale 클라우드 voice id 잔존 방지. 설정 힌트=로컬 엔진 실행 필요(`settings.localVoiceEngineHint`) + 로컬 음성 포트(22600) placeholder | S-VOICE | registry · tsc |
| **FR-VOICE.4** | naia-local-voice `/tts` 합성이 **웹뷰 CORS 로 차단되지 않도록** Tauri 런타임에선 Rust 프록시(`local_voice_synthesize`, reqwest, CORS 면제)로 우회. VoxCPM2(stdlib http, ACAO 없음) 대상 웹뷰 `fetch(POST application/json)`가 preflight 501+ACAO 부재로 실패하던 버그 수정(2026-07-15 실측). 비-Tauri(브라우저/vitest)는 직접 fetch 유지 → 계약 무회귀. 대응 서버측 근본수정 = cascade `voxcpm2_service.py` CORS 헤더(별도, kiosk-4070 배포). ⚠️ **stale(2026-07-15 표면 전환)**: naia-local-voice 가 raw `/tts` → OpenAI `/v1/audio/speech`(3자 합의 정본 표면)로 이동, omni 서버는 CORS 허용(`ACAO:*` 실측) → Rust 프록시 코드 제거됨. 이 행은 이력 보존용 | S-VOICE | (대체: FR-VOICE.5) |
| **FR-VOICE.5** | **원격 omni 음성 + 로컬 Ditto 아바타(8g avatar-only) 립싱크 배선** (2026-07-16 부스 토폴로지, 루크 지시 "nva 플레이어 + ditto trt 를 naia-shell 에 이식"). ① naia-local-voice 합성 = OpenAI 표면 `/v1/audio/speech`(음색은 서버가 voice→ref 해석, `voice` 미지정 시 `naia-default` — 무지문 랜덤 음색 금지) → WAV 무변환 패스스루. ② `streamsAvatarPcm(provider)` 게이트(순수함수, synthesize.ts): nextain·naia-local-voice = **셸 합성 오디오를 cascade `/stream` 으로 직결**(AudioQueue 즉시재생 + speakAudio muted 립싱크). 구 "naia-local-voice 추가 금지" 경고는 raw `/tts`(음색 상태 우회) 전제였고 표면 전환으로 사유 소멸 — 8g avatar-only 파사드(자체 TTS 없음)에선 `/stream_text` 폴백이 무음이라 PCM 직결이 유일한 립싱크 경로. ③ 실패 시 FR-VOICE.2 유지(알림+무음, 위장 폴백 금지) | S-VOICE-AVATAR | `synthesize.test.ts`(신 표면 계약 5건 + `streamsAvatarPcm` 게이트 3건) · tsc |

> NFR: NFR-honesty(미가용을 free 음성으로 위장 금지) · F1(measurement-gated). ⚠️ **DEFER Round 2**: 로컬 cascade lifecycle 임베딩(naia-shell Rust sidecar 기동/헬스체크) + windows-manager 정식 로더(#1 M5). 8GB 기기 적합성=미측정(소형/양자화 음성 모델 탐색 별도).

## 기능 요구사항 (FR) — 16GB 로컬 프로파일 자동설정 + 음색/에코 배선 (2026-07-15, 코스포 시연 로컬 장면)

> 배경: 루크 지시로 "GPU 프로파일 선택 하나로 두뇌·음성·아바타가 자동 설정"되는 시연 로컬 장면
> (9B 로컬 LLM + VoxCPM2 int8 로컬 음성 + VRM). FR-VRAM.4("추천만, 자동변경·숨김 없음")를
> **본 FR 이 개정**한다 — 루크가 명시적으로 자동 적용을 요구했으므로 추천→자동적용으로 전환.

| ID | 요구사항 | UC/시나리오 | 검증(P02) |
|----|----------|-----------|------|
| **FR-VRAM.5** | **검증-티어 전용 프로파일 + 자동설정** (FR-VRAM.4 개정). ① `hidden` 티어는 피커 비노출 **+ `selectVramTier`(auto) 제외** — 미검증 티어 자동선택이 NVA 아바타를 몰래 심던 사고 차단. 현재 검증 티어 = `local-llm-voice-16g`(3080 Ti 16G 실측). **트레이드오프(명시)**: <16GB VRAM 은 auto 로 로컬 프로파일 미수령(클라우드) — 프리릴리스 허용, 검증 시 hidden 해제로 편입. ② 프로파일 선택 = **자동설정**(stageLocalSlots): 두뇌(로컬 LLM capability → provider=ollama + compact 기본 `DNA3.0-4B`), 음성(tts capability → naia-local-voice + host), 아바타(avatar capability 없으면 → VRM 복원). ③ 저장값·구 id 하위호환(normalizeTierId) 유지 | S-VRAM-AUTO | `vram-tiers.test.ts`(hidden auto 제외·데이터 계약) · `SettingsTab.test.tsx`(프로파일 클릭 자동설정) · `slots-manifest.contract.test.ts` · e2e `settings-slots.spec.ts`(16G 프로파일 → 두뇌·음성·호스트·아바타 전환) |
| **FR-VOICE.6** | **로컬 음성 정본 호스트 = :8910 façade**. `DEFAULT_LOCAL_VOICE_HOST` = `http://localhost:8910`(OpenAI 표면 `/v1/audio/speech` 서빙 cascade façade). 구 `:22600`(raw `/tts`)은 이 표면이 없어 기본이 될 수 없다 — placeholder·힌트·주석 모두 :8910 으로 정정. 프로파일 자동설정은 **빈 값·localhost/127.0.0.1 변형만** 이 기본으로 교체(원격 GPU Tailscale 호스트는 보존 — 문서화된 원격 cascade 워크플로 파괴 금지) | S-VOICE-AUTO | `synthesize.test.ts`(:8910 기본 호스트) · `SettingsTab` 자동설정(원격 호스트 보존) |
| **FR-VOICE.7** | **프리셋 음색 façade 팔레트 id 전달**. naia-local-voice 의 `voice` = 사용자 음성 참조(`voiceRefUrl`)의 basename(쿼리/프래그먼트 제거 후 `.wav` 파일명 → façade `/ref/voices` 팔레트 id). 팔레트 밖 값(녹음/업로드·비-wav)은 `naia-default` 폴백(서버가 모르는 id 를 200+랜덤 음색으로 받으므로). **vllm provider 는 제외** — 범용 OpenAI 서버라 팔레트 id 를 모름, `"default"` 유지. 두 합성 경로(파이프라인·Live)가 단일 `resolveTtsVoiceId(config)` 공유 → 분기 드리프트 방지 | S-VOICE-PRESET | `ChatArea` 음색 해석(프리셋→id·쿼리스트링·vllm 분리) |
| **FR-ECHO.1** | **자기발화(에코) 방어 2단**. ① 재생 중 마이크(STT 세션) 정지 + 종료 0.8초 후 재개 — 재개 대기 타이머는 다음 문장 재생 시작 시 취소(문장 간 큐 드레인으로 마이크가 발화 중 재개통되던 누수 차단). ② 최근 TTS 문장과 유사도(문자 bigram Dice ≥ 0.6 또는 ≥8자 부분일치)면 STT 결과 스킵 — **짧은 정상 답변("좋아/네/그래")은 절대 스킵 금지**(bigram 폴백 정확일치, 부분일치 길이-게이트) | S-ECHO | `echo-text-filter.test.ts`(동일·부분·짧은답변·정상질문 8건) |

> NFR: FR-VRAM.5 <16GB 트레이드오프는 프리릴리스 한정. FR-ECHO.1 은 web-speech 지연배달 특성 대응(1차 마이크정지가 주 방어, 2차 텍스트필터는 누수 폴백). ⚠️ **후속(비블로킹)**: 부팅 병합(mergeBootConfig)이 localStorage-only 키(naiaKey 시크릿·discord 커서·세션 플래그)를 보존하지 않는 회귀 — 데모 실사용 정상 확인이나 재로그인/중복응답 가능성, 부팅 흐름 변경은 별도 안전작업으로 분리.

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
| **FR-CASCADE.6** (spec FR-7) | 비디오 아바타는 **cascade capability(로컬 avatar 제공 or 로그인) 게이트** — 로컬 프로파일이 avatar 미제공(저티어/off) 또는 로그아웃 시 video-avatar 옵션 비활성 + 안내(`avatar-cascade-required`) | S-AVATAR8G·UC12 | `capability-settings.spec.ts`(FR-7 게이트·로그아웃 교차) |
| **FR-CASCADE.7** (spec FR-8) | **원격 cascade 소스(T3, 고급)** — `cascadeRuntimeUrl`(http/https만, `normalizeCascadeUrl` 검증·정규화·trailing slash 제거) 로 원격 파사드 지정. 접힌 `<details>` 격리(소비자 기본 표면 아님)·naiaKey 게이트·egress 경고. 로컬 auto-spawn(T1) 우선(localFacadeUrl 있으면 원격 무시). WSL 안 cascade 는 이 T3 URL 경로로 연결(셸이 WSL 부트스트랩 안 함) | S-CASCADE-T3·UC12 | `config.test.ts`(normalizeCascadeUrl 4케이스)·`capability-settings.spec.ts`(FR-8 URL 검증·게이트) |

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
