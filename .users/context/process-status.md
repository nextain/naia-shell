<!-- src-sha: 40fa012a363d8ddd -->
<!-- 자동 번역 미러 (M13-mirror). 원본: .agents/context/process-status.json -->

# 프로세스 현황 (Process Status) SoT

**스키마 버전**: 1.0

**목적**: 프로세스 현황의 정본 기록 — 세션 시작/종료 시 반드시 업데이트. 구조명세, 이슈, 리소스를 유기적으로 링크.

---

## 참조 (References)

| 항목 | 경로 |
|------|------|
| 프로젝트 구조 | `docs/project-structure.md` |
| 규칙 SoT | `.agents/context/agents-rules.json` |
| 이슈 문서 디렉토리 | `docs/progress/` |
| 스크립트 레지스트리 | `scripts/README.md` |

---

## 현재 작업

**이슈**: `naia-shell-transplant`

**제목**: naia-shell 헥사고날 이식 — foundation 계층 F0~F3 (제어평면/자기상태/관측/조작)
- 저장소: `naia-shell`
- 참고: `naia-os`는 배포판 계층 (별개 관심사)

**이슈 문서**: `docs/progress/` (F0-baseline, F0-contract, F{1,2,3}-baseline-contract, F0-graft) + 00-PHASES.md

**GitHub 이슈**: 없음

**시작**: 2026-06-08

**마지막 업데이트**: 2026-07-17 00:00 KST

**상태**: 진행 중 (in_progress)

### 2026-07-17 크로스플랫폼 설치 파일 (#377, S-INSTALL / FR-INSTALL.1~6)

- **배경**: Windows 설치 파일 검증 요청 → 조사 결과 설치 파일 0건 + clean checkout 재현 불가 (`node.exe`·MSVC 재배포 3종 = conf 선언만 있고 놓는 코드 부재, Windows 빌드가 `stage-cascade-loader` 누락한 채 딥머지 잔재로 우연 통과).
- **확정 설계 (루크 승인)**: 플랫폼 매트릭스(`src-tauri/platform-matrix.json`) = 유일 SoT → 단일 스크립트 `stage-runtime.mjs` 가 리소스 프로비저닝 + `tauri.conf.generated.json` 생성. Node 22 를 3 OS 모두 번들. WSL 불요 불변(NFR-noWSL). CI 3 OS 매트릭스(ubuntu 는 deb 설치 + PATH 에서 node 제거 + xvfb 기동 스모크). mac 완료선 = CI 빌드 성공(미서명 정직 표기).
- **P01~P03 산출물**: `docs/user-scenarios.md` S-INSTALL 행 + `docs/requirements.md` FR-INSTALL 섹션 + `docs/glossary.md` 배포·설치 용어. 적대 리뷰 1회차 16건(BLOCKER: `createUpdaterArtifacts=false` 매트릭스 이주 등) + 2회차 12건(BLOCKER: vosk dll 4종(libvosk+MinGW 3종) 이주, `--config` 머지 시맨틱스 — base 훅 `pnpm build` 축소, node arch 맵, ubuntu 스모크 판정 기준 등) + 3회차 9건(BLOCKER: vosk 하드검사 순서모순 제거 — build.rs 가 번들 전 생성이라 안전, `--config` 리터럴 dangling 회피 — stage-runtime 이 tauri build 직접 spawn, agent 리소스 매핑 소유 결정) + 4회차 7건(BLOCKER: R3 의 "agent 4종 base 이주" 결정을 tauri-build 실소스로 반증 — `copy_resources` 는 `tauri dev`·`cargo check` 포함 무조건 실행이라 gitignored 스테이징 산출물을 base 에 두면 dev 즉사 → 매트릭스 3 OS 공통 그룹→생성 conf 소유로 개정, 분담 규칙 = 커밋 자산=base / 스테이징 산출·OS 델타·조건부=생성 conf. MINOR 6건 중 5건 반영: NAIA_MINIMAL 스모크 전제·nsis-hooks 귀속 교정·S-INSTALL 검증열 보강·glossary 6용어·매트릭스 초기값 출처) 반영.
- **게이트 규칙**: 각 phase 종료 시 적대적 리뷰 2회 연속 클린(루크 명시). R1~R5 모두 NOT CLEAN → 반영 완료, **R6 부터 재개(클린 카운트 0)**. R4 잔여 MINOR 1건(`sdlc_gates` 구조화 필드에 #377 게이트 병기) = 2026-07-17 해소 — 아래 "병행 트랙: #377" 표.
- **적대 리뷰 5회차 (2026-07-17, 3렌즈 병렬 — tauri 실소스 대조 / 설계 정합·검증축 / 실현가능성·정직성)**: NOT CLEAN 7건 (MAJOR 2 + MINOR 5) 전부 반영.
  - **MAJOR ① 우분투 스모크가 번들 node 를 증명하지 못했다**: "PATH 에서 node 제거" 는 폴백을 못 막는다 — unix 폴백이 PATH 와 무관하게 사용자 홈 아래 `.nvm/versions/node` 를 직접 디렉토리 스캔한다(`lib.rs` 실측). 현 GitHub 러너가 통과하는 건 이미지가 우연히 비어 있어서일 뿐이라, 판정력을 외부 이미지에 위탁하는 셈이었다. 게다가 번들 node 가 최우선이라 PATH 제거는 정상 경로에 아무 영향이 없다. → 판정을 **"마커 출현 AND 실제 사용된 node 경로가 설치본 resource_dir 하위"** 2조건으로 교체하고, FR-INSTALL.3 에 `[Naia] node = <경로>` 로그 1줄을 신설했으며, 번들 node 를 일부러 지운 실행이 red 가 되는지 확인하는 변이 탐침(mutation probe)을 추가했다. 관측 대상이 "떴는가" 에서 **"무엇으로 떴는가"** 로 바뀌었다.
  - **MAJOR ② flatpak targets 이관 철회**: 이관하면 매트릭스 linux 행과 같은 사실이 **수기 파일에 두 번째 집**을 얻는데, 그 사본은 생성물이 아니라 어떤 검증 축에도 안 걸린다 — #377 이 근본원인으로 지목한 드리프트를 새로 만드는 것. repo 내 소비자도 0 건(실측)이라 보전할 것도 없었다. → `linux.json` 과 **동일한 외부 소비자 확인 규율**을 적용한 뒤, 소비자가 없으면 무변경(부활 시 매트릭스 flatpak 행).
  - **MINOR 5건**: 아이콘은 배열이라 머지가 병합이 아니라 **통째 대체**(RFC 7386) — mac 행은 전체 배열을 emit 하며 이는 겹침 금지의 명시적 예외 / vosk 빌드 순서의 진짜 보증자는 "번들러 수집 전" 이 아니라 **`links` 키** — 근거를 교정하고 `links` 실존을 게이트로 승격 / 단위 테스트 경로 확정(`scripts/__tests__/` — `src-tauri/**` 는 `vite.config.ts` 의 `test.exclude` 로 **영구 미수집**, 프로브로 실측 확인) / 추출 도구를 아카이브 포맷과 분리해 **3 OS 모두 OS 기본 `tar`** 로 명시 / mac 산출물이 **arm64 전용**(`macos-latest` = arm64 러너, Intel 몫 없음)임을 정직 표기.
  - **리뷰어 충돌 판정**: 렌즈 A 는 nvm 폴백이 스모크를 마스킹한다고 봤고 렌즈 C 는 러너 이미지 실측으로 반증했다. `lib.rs` 폴백 체인을 직접 읽어 판정 — 메커니즘은 A 가 맞고 현재 안 걸리는 건 C 가 맞다. 결론은 "지금은 우연히 통과하나 판정 근거가 외부에 있다" 이므로 A 의 교정을 채택했다.
- **핸드오프 (2026-07-17)**: P0 잔여(R5·R6 리뷰)~P1·P2·P5 는 **리눅스 머신에서 진행**(루크 지시). **P3 Windows 실측만 Windows PC 필요**(남겨둠). 리눅스 머신 = 시연 서버 — 상태 변경 실측(패키지 설치 등) 금지 유지, Linux 설치 스모크는 CI ubuntu job 담당.
- **트랙**: alpha-adk `.agents/progress/naia-shell-crossplatform-installer-2026-07-17.md` · GitHub #377.

### 2026-07-16 config SoT 클로버 픽스 (FR-CONFIG-SOT.5)

- **시연장 실측**: persona 21,187자 → 5,953자 클로버 4회 재발. App.tsx AdkSetup 분기가 하이드레이션 없이 게이트를 선개방(`configHydratedRef=true`) → mount-time `syncConfigToFile` 이 스테일 localStorage 를 config.json 에 되씀.
- **픽스**: 설정 화면 동안 게이트 닫힘 유지 — 설정 완료 후 하이드레이션 effect 재실행 시에만 개방.
- **검증**: 신규 `e2e/config-sot-boot.spec.ts` (Playwright 실 UI 3계약) 3/3 + config vitest 63/63 + tsc 0.
- **운영 수칙**: config.json 을 외부에서 수정할 땐 셸 종료 후 (떠 있는 셸의 unload flush 가 새 부팅 읽기보다 선행 — 캐시 오염 자기영속).
- **후속**: 에이전트 재스폰 시 패널 스킬 재등록 누락 / ollamaNumCtx 셸→에이전트 배선. 트랙 = alpha-adk `.agents/progress/naia-demo-knowledge-persona-clobber-2026-07-16.md`.

### 2026-07-16 시연 체크포인트

- **검증 구성**: 로컬 Ollama LLM + 원격 NVA full cascade `https://pc-bazzite.tail4f7a25.ts.net:9449` (VoxCPM2 음성 + 아바타).
- **실기 결과**: 실제 Tauri Shell에서 음성과 입 모양 동기화가 정상이며, 해당 실행에서는 온라인 LLM과 클라우드 TTS를 사용하지 않았다.
- **라우팅 사실**: NVA Host가 명시되면 Shell은 해당 호스트의 `/stream_text`를 호출하고 Shell 측 `vllmTtsHost` 합성 전에 반환한다. 따라서 이 원격 NVA 발화 경로에서는 설정된 `:8910` 음성 호스트를 사용하지 않는다.
- **3090 운영 확인**: VoxCPM2 음성과 아바타를 합친 cascade는 `:9449` 단일 엔드포인트로 통일해도 된다고 확인받았다.
- **시연 전 동결**: 현재 Ollama + `:9449` 경로를 유지한다. 시연 전에는 배경 마스크/알파 처리만 허용하며 음성 또는 입 모양 동기화가 깨지면 적용하지 않는다.
- **마스크 이후**: 원격 서버의 character/bundle 계약으로 NVA 캐릭터를 추가한다. Windows 로컬 번들 경로를 원격 `/load_nva`에 보내지 않는다.
- **음색 변경 문제 담당**: 음성/캐릭터 음색 선택이 반영되지 않는 문제는 Shell이 아니라 RTX 3090 `:9449` cascade 서버 측 문제다. 시연용 Shell 라우팅은 유지하고 서버에서 해결한다.
- **미해결 종료 결함**: `로컬 프로파일 = 없음`을 선택해도 이전에 시작한 로컬 서비스가 종료되었다고 확인되지 않으며 GPU VRAM이 약 11.2GB로 유지된다. 합격 조건은 실행 중인 `tauri:dev`는 건드리지 않은 채 프로파일 소유 서비스가 종료되고 VRAM이 내려가는 것이다.

### 작업 노트 (2026-07-15 기준)

**S-VOICE-AVATAR (FR-VOICE.5)**: 부스 토폴로지 립싱크 배선 완료
- **두뇌**: 로컬 ollama DNA + **음성**: 원격 omni (vllmTtsHost → `/v1/audio/speech`, 음색 서버 해석 voice=naia-default) + **아바타**: 로컬 Ditto TRT (8GB 아바타 전용)
- 셸에서 합성한 WAV를 cascade `/stream` 립싱크로 직결
- `streamsAvatarPcm()` 순수함수 (synthesize.ts)
- naia-local-voice=true 기본값, synthesize.test.ts 검약 계약 4건 → 신 표면 계약 5건 + 게이트 3건 갱신
- FR-VOICE.4 (Rust CORS 프록시) stale 표기 (omni ACAO:* 실측, 프록시 코드 제거됨)
- **검증**: tsc 0 에러, 셸 vitest 1150 GREEN (107개 파일)
- **⚠️ 외부 블로커**: omni :8892 `/v1/audio/speech`에서 HTTP 500 (핸들러 크래시, 전 파라미터 변형 재현) — 런타임 팀에 채널 보고 예정
- realtime WS 경로는 정상 (ref_audio_url e2e 225KB)

**2026-07-10**: 검증·경화 (8GB 아바타 근본수정 확인)
- opencode GLM 5.2 이식분 리뷰 + 실측 완료
- **근본 진단**: 아바타 스폰 = `gpu.tier(EXCLUSIVE_8G_TIERS)` + localFocus 구동
- `buildSlotsManifest`가 localGpuTier auto를 해석된 tier id (resolveActiveTier → normalizeTierId)로 기록해야 wm(windows-manager)이 avatar_ditto_trt 시작 가능 (미해소 시 캐릭터 미표시)
- adk-store.writeSlotsManifest = VRAM 미전달 시 detectGpuVramGb 자동감지
- dev-setup + Rust (lib.rs/linux/macos/windows) = cascade 8910 고아(uvicorn 손자) 정리 kill_stale_cascade (EADDRINUSE 방지, R2.2b)
- GLM 잔여 TSC 실패 (계약테스트 레거시 tier id 캐스트) 수정
- vite.config test.exclude에 `src-tauri/**` 추가 (스테이징 agent 620 테스트 스코프 오염 제거)
- **검증**: tsc 0 에러, 셸 vitest 101개 파일/1096 GREEN, cargo check 0 에러, Playwright 전 스펙 격리(--workers=1) GREEN (workspace-panel 17/17, capability+slots 17/17; 전체 병렬 40 실패 = 8GB 부하 flakiness, 회귀 아님)

**2026-06-30**: Round 2 (로컬 cascade 임베딩, 멀티레포) FR-CASCADE.1~4
- R2.1: windows-manager loader launch 슈퍼바이저 + plan --json (wm 1756f4b, pytest 31)
- R2.2: naia-os: slots-manifest write (Rust write_slots_manifest + adk-store writeSlotsManifest) + Rust start/stop/cascade_status + spawn_cascade (CASCADE_READY 핸드셰이크) + CascadeProcess (Drop/WindowEvent/PID) + 설정 토글 UI + i18n 6개 언어
- cargo 0 에러, tsc 0 에러, SettingsTab + slots 66개 테스트
- 원격 금지, 로컬 사이드카만 지원
- 8GB 음성 단독: 6.9GB 적합 (RTF = R2.3 DEFER)
- 추적 파일: alpha-adk .agents/progress/naia-os-local-cascade-embedding-round2-2026-06-30.md

**2026-06-30**: Round 1 — 프로파일 UX 일관화 + VRAM 슬롯 추천 폐루프 + 로컬 음성 정직화
- FR-VRAM.4 (tier → 슬롯 로컬 추천 배지, 숨김 아님)
- FR-PROF.1 (프로파일 탭 토큰 일관화)
- FR-VOICE.1~3 (naia-local-voice → vllmTtsHost 라우팅, silent free 폴백 제거 → 명확 미가용 알림, voice picker 채움)
- 신규 lib/capabilities/tier-slots.ts (+ test 6/6)
- 적대적 리뷰 2개 벤더 PASS (blocker 0) + 수정 (채팅모드 알림 재무장, engine-capability-summary 토큰화, 공개레포 내부명칭 중립화)
- **검증**: tsc 0 에러, 셸 vitest 1008 GREEN, 영향 테스트 72/73
- 추적 파일: alpha-adk .agents/progress/naia-os-profile-design-gpu-voice-flow-2026-06-30.md
- Round 2 (로컬 cascade 라이프사이클 임베딩 + wm #1 M5) = DEFER

**초기 (F0~F3)**: 계약 + 스캐폴드 (async, src/main) — 계약 + 통합 테스트 67/67

**2026-06-29**: 세션 2~3 — S-SLOT FR-SLOT.4 설정 탭 9개 재구성 완료 (#1~#13 전체 구현)
- profile / brain / voice / avatar / persona / memory / knowledge / skills / general
- tsc clean, test 35/35, cargo check 통과
- 커밋 미수행 (8개 파일)
- 추적 파일: alpha-adk .agents/progress/naia-os-settings-tab-restructure-2026-06-29.md §7

**2026-06-30**: K2 지식 근거 → 원문 칩 (kb-compiler 통합 셸측)
- ToolActivity 지식 도구 (skill_knowledge_ask/search) 분기 → KnowledgeToolResult (답변 + sourceUris 칩)
- 칩 클릭 근거 → 원문 (URL = 브라우저 navigate / 파일 = 워크스페이스 openFile, 기존 패널 API 재사용)
- 게이트 FR-KB-OS.1~3 + 셸 feature 시나리오
- **검증**: knowledge-result.test.ts (파싱) + knowledge-tool-result.test.tsx (RTL 렌더 + dispatch) + e2e/chat-tools.spec.ts 지식도구 K2 (Playwright 실 UI 답변 + 칩 + 칩클릭 → 브라우저 패널)
- 셸 vitest 977 GREEN, tsc 0 에러, 구조 게이트 (enforce-root, file-anchors, assembly) PASS
- 백엔드 = naia-agent UC-KNOWLEDGE (live)
- 추적 파일: alpha-adk .agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md (K2)

**2026-06-30**: K3 지식 그래프 2D/3D 뷰어
- ToolActivity skill_knowledge_graph 분기 → KnowledgeGraphView (캔버스 force, 군집색·degree 크기, 2D↔3D 토글·원근 + 자동회전, 의존성 0 엔진 examples/cms 포팅)
- 데이터 = kb-compiler toGraphData (2ecb342) + naia-agent skill_knowledge_graph (b7e3b8c)
- 게이트 FR-KB-OS.4
- **검증**: knowledge-result.test.ts parseKnowledgeGraph + e2e/chat-tools.spec.ts 지식그래프 K3 (Playwright 실 UI: 캔버스 렌더 + 노드 3개 + 2D/3D 토글 통과)
- tsc 0 에러

---

## SDLC 프로세스 게이트 (P01~P05)

| 게이트 | 상태 | 이름 | 산출물 (Deliverable) | 참조 |
|--------|------|------|---------------------|------|
| **P01** | 완료 | 사용자 시나리오 (user_scenarios) | `docs/user-scenarios.md` (UC1-14, S01~S71) | 완전성 13회 3연속 NONE |
| **P02** | 완료 | 테스트 시나리오 (test_scenarios) | `docs/user-scenarios.md` Test Coverage Map + `src/test/*.contract.test.ts` (계약 67/67) | 13회 |
| **P03** | 완료 | 요구사항 (requirements) | `docs/requirements.md` (FR-F0~F3, NFR) | 8회 |
| **P04** | 진행 중 | 통합 테스트 (integration_test) | `src/test/integration-reafference.test.ts` (인지흐름 관통 + negative + contamination) + `scripts/builds/f0-graft-smoke.sh` (Old-Baseline drift-gate 하네스) | 통합 67/67 통과; 라이브 trace (로컬 머신 graft) 대기 |
| **P05** | 보류 중 | 요구사항 완료 (requirements_complete) | — | 라이브 trace 등가 확인 + 후속 슬라이스 후 |

위 표의 상태·산출물은 **기본 트랙**(`current_work.issue` = naia-shell-transplant, F0~F3) 소유다. 병행 트랙은 아래에 따로 적는다 — 같은 사실을 두 곳에 적지 않기 위해 기본 트랙 상태를 여기에 복사하지 않는다.

### 병행 트랙: #377 크로스플랫폼 설치 파일 (installer_crossplatform_377)

| 게이트 | 상태 | 산출물 (Deliverable) | 참조 |
|--------|------|---------------------|------|
| **P01** | 진행 중 | `docs/user-scenarios.md` — 셸 feature 시나리오 표의 S-INSTALL 행 (#377, 2026-07-17) | 산출물 작성 완료 (후속 게이트 진행 가능). P0 종료 조건 = 적대 리뷰 2연속 클린 (루크 명시) — R1~R4 전부 NOT CLEAN 반영 완료, 클린 카운트 0, R5 부터 재개 |
| **P02** | 진행 중 | `docs/user-scenarios.md` — S-INSTALL 행의 검증 열 (`platform-matrix.test.ts` 단위 + `check-build-contract` 계약 + Windows 설치 실측 + ubuntu deb 설치·PATH node 제거·xvfb 기동 스모크 + 산출물 검증 스크립트/부정 케이스) | P01 과 동일 — P0 종료 = R5·R6 2연속 클린 대기 |
| **P03** | 진행 중 | `docs/requirements.md` — FR-INSTALL.1~6 + NFR-noWSL (불변) · NFR-honesty | P01 과 동일. R4 개정 반영: agent 리소스 4종 = 매트릭스 3 OS 공통 그룹 → 생성 conf 소유 (base 금지 — tauri-build `copy_resources` 가 dev/cargo check 포함 무조건 실행) |
| **P04** | 보류 중 | — | P1~P4 구현 후 — `platform-matrix.test.ts` golden + e2e-tauri (`TAURI_BINARY` 설치본) + CI 3 OS `build-installers.yml`. P3 Windows 실측은 Windows 머신 필요 |
| **P05** | 보류 중 | — | P5 (검증 스크립트 + README + manifest 정리 + 이슈 보고) 후 FR-INSTALL.1~6 상태 → Done |

---

## 리소스 레지스트리 (Resource Registry)

| 항목 | 값 |
|------|-----|
| 마지막 enforce 실행 | 2026-06-10 00:06 UTC |
| 위반사항 | 없음 |

---

## 사용법 (Usage Guidelines)

### 세션 시작 시

1. 이 파일 읽기
2. current_work 섹션 확인
3. `last_updated`를 현재 시각으로 갱신
4. sdlc_gates 상태 확인 후 작업 시작

### 세션 종료 시

1. 완료된 게이트 status → "완료" (done)
2. deliverable 경로 기재
3. `last_updated` 갱신
4. `.users/context/process-status.md` 동기화
5. 이 파일을 커밋에 포함

### 신규 이슈 시작 시

1. current_work 필드 업데이트
2. `docs/progress/issue-{N}-{slug}.md` 신규 생성
3. sdlc_gates 전체 status → "보류 중" (pending)으로 리셋
4. resource_registry.violations 초기화
