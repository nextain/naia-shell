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

> 범위: naia-omni-windows-manager#2 의 **naia-os UI측만**. 로더(fetch/launch)·auto-download = 4070 RTF 하드웨어 게이트(model-infra#19)=DEFER. 정본 tier manifest = model-infra(이 repo 아님). **hard rule F1: 측정 RTF 없이 realtime 단정 금지.** 트랙: `naia-vram-tier-capability-bridge-2026-06-25.md`.

| FR | 요구사항 | UC/시나리오 | 검증(P02) |
|----|---------|-----------|------|
| **FR-VRAM.1** | GPU VRAM 감지(Rust `detect_gpu_vram`, nvidia-smi) → 설정 UI 가 tier(6/12/24G+) 표시·수동 override. 감지 실패=null→수동 선택 | S-VRAM·UC12 | gpu 파싱 단위 · `vram-tiers.test.ts` |
| **FR-VRAM.2** | `selectVramTier(vramGb)`+`tierProvidedCapabilities` → **opt-in 시** effectiveCapabilities 에 fold(deriveSettingsSlots 반영, 로컬 tier 가 커버하는 외부 슬롯 숨김). **기본 off=무변경**(안전 기본값) | S-VRAM | `vram-tiers.test.ts` |
| **FR-VRAM.3** | footprint = model-infra#19 측정(Ditto 2.6G+VoxCPM2 6.7G). 각 tier `realtime: measurement-gated`(F1) — RTF 단정 0. 로컬 serving/auto-download = DEFER(loader 게이트) | — | F1 가드 테스트 / DEFER |

> NFR: NFR-isolation(VRAM 미감지·tier off 시 무회귀) · F1(measurement-gated, RTF 단정 금지).

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
