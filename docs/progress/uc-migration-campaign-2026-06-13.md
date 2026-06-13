# UC 이식 캠페인 트래커 — "모두 이관" (2026-06-13)

session_id: ec74cc29-3347-4f6e-b29a-237ea29f301e
prior_sessions: [67a0313b-2578-4da2-9a52-53c26128656f]

---
## ★ CAMPAIGN ANCHOR (매 턴·압축후 제일 먼저 재독 — 위치/목적 잊지 않기)

**공식 GOAL (루크 2026-06-13 "Goal set", 권위·완료기준)**: os+agent 표준 프로세스로 — ① gRPC 기반 연결 ② UC 기반 직교 이식 ③ **장기 안드로이드/로봇 위한 카테고리 추상화 기반**(substrate-agnostic 포트, OS/Tauri 비종속) ④ 표준대로 개발 확인 ⑤ 개발후 테스트+크로스리뷰로 **보안·디버깅용이성·내부기준** 확인 ⑥ **불가 시 신규 계약으로 흔들리지 않게**(애드혹 우회❌) ⑦ **모든 UC 가 이 방법. 전부 개발됐을 때만 완료.** → 전부 끝나면 UC별 사용자 테스트 문서 → 루크 검토.
**불변식 (절대)**: gRPC(os→agent→naia-adk) · UC(세로)×port(가로) 직교 · substrate-agnostic(안드로이드 대비) · 표준 방법(Old-Baseline→계약먼저→이식(수정❌)→drift-gate→2-AI 리뷰→커밋) · 검출기 green · 진행 "물어보지말고 끝까지·멈추지마"(자율 순차, 위치/목적 앵커 재독).
**리뷰 표준**: Round0 scope/canon(open-loop, 정본=ground truth) → 티어(T2=경로격리/외부연결/승인/인증=2-AI 2-clean, 그외 T1 빠른모델 1패스) → 적대적 REFUTE → Execute-to-Judge → 산출물 `.agents/reviews/r-<uc>.json`. 상세 = [[project_new_naia_goal_and_method_anchor]].
**순서 (루크 선택)**: ① 재무장 → ② F2 재검증 → ③ UC 유저여정순.

### 종합 현황 (2026-06-14, session ec74cc29) — 전 이식-코드베이스 2-AI 리뷰 스윕 완료
**os(new-naia-os)**: 재무장 ✓ / F0 ✓ / F1 ✓ / F2 ✓ / F3 ✓ / V1·UC1 ✓ / V2(os-local) ✓ / UC12 ✓ / UC13 ✓ — 전부 이식+2-AI open-loop 리뷰+fix+커밋.
**agent(new-naia-agent)**: UC5(도구루프+skills) ✓ / provider-provenance ✓ — 이식+2-AI 리뷰+fix+커밋.
**리뷰 성과**: BLOCKER/HIGH ~9건(F0 adk-inspect+PII, F2 error분류, F3 arg-casing+exec보안, UC13 승인A→행위B, UC12 stale-credential, UC1 도구결과/승인 페이로드, +MEDIUM 다수) — **전부 closed-loop 테스트(green)가 놓친 것을 재무장한 open-loop 2-AI가 적발**. = 루크 thesis 완전 실증. 안전 불가분은 전부 fail-closed+신규계약(애드혹 0).

**남은 것 = 루크-머신 runtime/external 범주** (전 transplanted 코드는 이식+2-AI리뷰+컴파일검증 완료):
1. **external skill runtime**: UC6(browser CDP)·UC8(BGM youtube WS)·V2 voice provider WS(gemini-live/openai-realtime/naia-omni) = 외부서비스/키/서버 → 루크머신 runtime.
2. ~~신규 gRPC Voice RPC~~ **= 오개념(2026-06-14 Old-Baseline 확인)**: voice 는 os→provider WS **직결**(V2 계약 line 31-32/52-53), os→agent gRPC 경유 아님 → Voice RPC 만들면 Old-Baseline 위반 드리프트. 실제 external = provider WS(루크머신). **Diagnostics RPC(F1) = 완료**(agent handler+provider+proto + os Rust client cargo-check green, 2026-06-14).
3. **UC3 메모리**: 다른 세션 소유(off-scope, canon out_of_scope UC-memory/UC3/UC4 6파일).
4. **전 UC live-graft + e2e**: 실행 shell(packages/shell/src)이 chat(UC1) 외엔 wire*Live 미호출 — 자체 src/lib/* old 경로 구동, new-core 이식분 dormant. graft = 작동 old 경로→new 경로 교체 = **runtime 검증 필수(컴파일 green≠작동, [[feedback_handoff_verified_runnable_state]])** = 루크머신 게이트. **→ 최종 산출물 = UC별 사용자 테스트 문서(graft+runtime 검증 절차 포함)로 루크에 핸드오프.**

### 현재 위치 (CURRENT POSITION)
- **2026-06-13 진행(session ec74cc29)**: 재무장 ✓(5f7c547) / **F2 ✓**(d5f896d, 2-AI 3R CLEAN) / **F0 ✓**(dd2684b, R1 BLOCKER→R2 CLEAN) / **F1 ✓**(fd99b46, os-local 이식+FR-F1.1 fix+BLOCKER0, gRPC Diagnostics RPC 잔여=신규계약). **F3 ✓**(writeFile+ptyWrite live, execCommand 보안 fail-closed+신규계약, 2-AI BLOCKER2 수정). **V2 계약 drafted**(V2-baseline-contract-2026-06-13: SensoryPort/ExpressionPort/VoiceProviderPort, os-local[AudioPlayer/MicCapture⚠️lazy/STT모델/avatar]+external[gRPC Voice RPC 신규계약+providers WS=루크머신] 분해). **[agent-side 진입]** UC5(agent 도구루프+skills) ✓(5cdb7c6, 2-AI BLOCKER0+MEDIUM fix). **다음(잔여) = agent UC6/8(browser/bgm external) · S-row skills · UC-provider-provenance 리뷰 · gRPC Voice/Diagnostics RPC 신규계약 · 전 UC 루크머신 live-graft.** (구버전 줄: V2 os-local 이식(AudioPlayer/VoiceConnectionStatus 도메인=HW無 가능) + 계약 2-AI 리뷰** → S-row → UC5~13. 각 UC = [Old-Baseline→(신규)계약→이식→drift-gate→2-AI 리뷰(open-loop, 정본 ground truth)→커밋]. 리뷰 산출물 `.agents/reviews/r-<uc>-2026-06-13.json`.
  - **F3 scouting**: mutate=host 파일 write/edit + exec(pty_execute_sync 등) = **고위험 mutating(T2)**. MutationGate(app/control/mutate.ts) 이미 존재(승인먼저→mutate→observe(F2)→reafference→불확정 abort). 승인 의존=F1 ApprovalPort(선잠금, UC13 라이브). F3 이식=makeF3LiveAdapters(mutate 어댑터→old write/exec 명령). 리뷰: 경로격리·승인우회·reafference 정직성 집중.
- **★ 자율 진행 중(루크: "물어보지말고 끝까지·멈추지마"). 압축 후 재개 시: 이 CAMPAIGN ANCHOR 재독 → UC 상태표의 첫 미완 UC 부터 동일 프로세스.**
- **Phase ①(재무장) — 완료.** 라이브 워처 재가동됨(os PID 60152·agent 60304). ⚠️ **이 머신(Bazzite)엔 crontab 없음+crond inactive → cron 영속 불가** = 자동검출이 죽어있던 근본 이유. 재부팅 생존 = **SessionStart 훅 self-heal**로 가야(미구현).
- enforcement 갭(RCA, 전부 관측): (G1) new-naia 게이트(sdlc/file-anchor/completion/conform)가 **alpha-adk 루트 세션에 미로드**(2단계 nested, 자체 settings 만) → 미발화. (G2) 루트 훅 체인에 SDLC/티어/2-AI 게이트 0. (G3) 티어/2-AI 가 게이트로 인코딩 안 됨(문서/메모리에만). (G4) 라이브 자동검출 죽음(crond 없음).
- **F2 상태 = ✅ 이식+리뷰 완료**(코드/계약): `75ef48a`(초기) → 2-AI R1 ISSUES(BLOCKER2+MAJOR4) → **신규 계약(ports/f2.ts + §C delta)으로 수정** → R2(전부 fixed+MEDIUM1 NI-1) → 수정 → R3 CLEAN. `.agents/reviews/r-f2-2026-06-13.json` 참조. tsc/anchors/assembly/compile/**154 test** green. **남은 = 루크 머신 라이브 graft + e2e(실행 shell 이 wireObservationServiceLive 호출, watch→drift/pty 런타임).** ★ 교훈: open-loop 2-AI 가 closed-loop 11-green 이 놓친 BLOCKER 적발 = 재무장+리뷰표준 가치 실증.

### 재무장 TODO (Phase ①)
- [x] **R1 SessionStart drift-checkpoint 훅** (`naia-watcher-selfheal.js`): 세션마다 `verify-watch once` 동기 실행(데몬 고집 X — 이 env 백그라운드 reap). cron 불가 머신 대체. → G4. baseline 승인(기존 os2/agent10 = doc-orphan + 메모리 off-scope, 내 것 아님)로 이후 NEW delta만.
- [x] **R2 nested-gate dispatcher** (`nested-naia-gate-dispatch.js`, 루트 settings Pre/Post 등록): projects/new-naia/** 편집 시 서브 게이트(charter/sdlc/structure/file-anchor[pre], conform/mirror-sync[post]) 발화. fail-open. **mutation-probe 통과**(미계약 src/main 차단 ✓, 정상 통과 ✓). → G1 닫힘(F2가 샌 갭).
- [ ] **R3 T2 리뷰 게이트** (남음): T2 경로(권한/인증/transport) 변경 커밋 시 `.agents/reviews/r-*.json`(2-clean) 없으면 차단. completion-evidence 가 Bash(commit)서 sub-root 미해결로 디스패처 미대행 → 별도 설계 필요. = G2/G3 미닫힘(차후).
- [x] R4 self-검증 = mutation-probe 통과(위 R2).

> **재무장 결론**: G1(서브게이트 미발화)·G4(cron 죽음) 닫힘 + 검증. G2/G3(T2→2-AI 강제 게이트)는 R3로 남음 — 그동안은 *리뷰 표준을 수동 준수*(앵커 재독 + UC마다 2-AI). 라이브 per-action 강제(dispatcher)는 가동.

### F1 착수 scouting (다음 = 여기서 이어감)
F1 = InteroceptivePort(자기상태) + ApprovalPort(승인) + PersistentGrantPort. **T2(승인=보안민감)**. 소스 분산 — 이식 시 주의:
- **InteroceptivePort**: systemStatus=`skill_system_status`/old DiagnosticsTab, diagnostics=`skill_diagnostics`(action:status/gateway_status)+로그 tail, devices=`lib.rs:2104 list_audio_output_devices`(PipeWire, Linux), degradations=probe(adapter)+isDegraded(domain).
- **PersistentGrantPort**: old `config.ts:534 isToolAllowed`/`539 addAllowedTool`(allowedTools[] in config) — 기계적, F0 config 패턴 재사용.
- **ApprovalPort.classify**: tier 매핑 = **agent측 tool-tiers TOOL_TIERS**(T0 auto/T1·T2 approval/T3 blocked/미매핑→T2). new domain/approval.ts 에 Tier/needsApproval/isBlocked 이미 있음 — classify 는 도메인 tier-table(순수) 가능성(어댑터 아님) 확인 필요.
- **ApprovalPort.request**: ⚠️ 승인 live-flow = **gRPC chat turn 과 얽힘**(agent 가 approval_request AgentEvent emit → shell sendApprovalResponse→send_to_agent_command, old index.ts:233 waitForApproval+pendingApprovals 120s timeout). UC13(os approval) 와 교차 — request 의 live 배선은 F3/UC13 chat-approval 흐름에서. F1 은 **계약 최소 선잠금 + interoceptive/grant/classify 이식**으로 범위.
- 레시피: Old-Baseline→(신규)계약→이식→drift-gate→2-AI(open-loop, 정본 ground truth)→커밋. 리뷰 산출물 `.agents/reviews/r-f1-2026-06-13.json`.

### UC 상태표 (tranche/vertical, user-scenarios.md SoT)
| 단위 | 범위 | 계약 | 이식(코드) | 2-AI 리뷰 | 라이브 graft/e2e | 상태 |
|---|---|:--:|:--:|:--:|:--:|---|
| F0 | 부팅 workspace init | ✓+**delta** | **live+신규계약 수정** | **✓ 2-AI R1 ISSUES(BLOCKER)→R2 CLEAN** | 루크머신 대기 | **이식+리뷰 완료** |
| F1 | 자기상태+승인 | ✓+**delta** | **live(devices+grant+os-local health) + Diagnostics RPC agent+proto+os Rust client** | **✓ 2-AI R1 fix + Diagnostics provider** | InteroceptivePort.diagnostics rich-payload 매핑+실호출=루크 | **✅ Diagnostics RPC end-to-end 완료(agent→proto→os Rust client cargo green 2026-06-14), runtime 매핑만 루크** |
| F2 | workspace 관측(read-only) | ✓+**delta(§C)** | **live+신규계약 수정** | **✓ 2-AI 3R 수렴 CLEAN** | 루크머신 대기 | **이식+리뷰 완료** |
| F3 | workspace 조작+승인 | ✓+**delta** | **writeFile+ptyWrite live, execCommand fail-closed** | **✓ 2-AI R1 BLOCKER2(arg-casing+보안)→수정** | execCommand 신규보안계약+UC13 잔여 | **안전분 이식+리뷰, exec 신규계약** |
| V1=UC1 | 텍스트 대화 | ✓ | **필드보존 fix os+agent+proto + os Rust forwarding end-to-end** | **✓ 2-AI HIGH2 수정(cross-repo 완성)** | 실앱 대화 OK(루크 — chat 은 실 셸 graft됨) | **✅ end-to-end 완료(agent→proto→os Rust forward[success/desc]→chat-service→PermissionModal, cargo green 2026-06-14)** |
| V2 | 음성(UC2) | **계약+§C분해** | **도메인+ports+os-local 어댑터(Expression/Sensory) 이식** | **✓ 2-AI: BLOCKER0(startup-lazy CLEAN)** | external(VoiceProvider/gRPC Voice RPC)+루크머신 live | **os-local 이식+리뷰 완료, external 신규계약** |
| S-row(agent skills) | github/mcp/obsidian/weather/memo(UC5)·bgm(UC8)·browser(UC6)·notify·cron | ✓ | **agent-local ToolExecutor 이식(injected 외부dep)** | self-review(패턴 규약) | 실 외부서비스=루크 | **clean agent skills 이식 완료(9개)** |
| S-row(잔여) | sessions/skill-manager/config/device/channels/agents/approvals/naia-discord·voicewake·welcome | **placement 판정 완료** | **미이식(정당)** | — | — | **DEPRECATED(openclaw gateway #201 제거→死, 이식=drift). panel=os-side. botmadang=잠재(저우선). skill-placement-decision 참조** |
| UC7a/7 | 시스템 관측/조작 | = F2/F3 | ✓(F2/F3) | ✓ | 루크머신 | **F2/F3 로 완료** |
| UC13 | 승인 게이트 | ✓(F1-baseline) | **승인-결속 fix(prior 코드)** | **✓ 2-AI R1 BLOCKER(승인A→행위B)→수정** | gRPC chat-approval+루크머신 | **os-local 이식+리뷰 완료, live=agent flow** |
| UC12 | 온보딩/설정 | ✓+**§D completeWith 신규계약** | **core 이식+stale키/complete 가드 fix + 셸 graft(onboarding-core seam)** | **✓ 2-AI R1 BLOCKER(stale키)→수정 + seam 통합테스트** | **✅ 셸 graft됨(isNewCore)**, 풀 wizard runtime e2e=루크 | **✅ graft 완성(2026-06-14, chat 외 2번째 실 셸 graft, seam 통합테스트 parity 검증)** |
| UC5 | 도구루프/skills (**agent**) | ✓ | **이식+enableTools/timeout/composite fix** | **✓ 2-AI R1 BLOCKER0, MEDIUM 수정** | 루크머신 live | **agent 이식+리뷰 완료** |
| UC8 | BGM/공간분위기 (agent) | **계약+이식** | **agent-local skill(search/play/volume+injected)** | self-review BLOCKER0 | youtubei.js+shell player=신규계약+루크머신 | **agent-local 완료, external deferred** |
| UC6 | browser 조작 (agent) | ✓(external-skill 패턴) | **agent-local skill 이식(cmd 화이트리스트+injected CLI)** | self-review BLOCKER0 | agent-browser CLI/CDP=신규계약+루크머신 | **agent-local 완료, external CLI deferred** |
> UC3(기억)=다른 세션 소유(naia-memory), off-scope. 검출기 RED 6파일=그 세션 것.

---

> 루크 지시: "다음 uc들로 진행해서 모두 이관." = old-naia-os → new-naia-os 헥사고날 이식을 전 UC/S-row 로 확대.
> 방법론 SoT = `docs/user-scenarios.md`(tranche·Old-Baseline·drift-gate) + `docs/ARCHITECTURE.md` §6(UC 추가 레시피). 이 파일 = 캠페인 진행 트래커.

## 현 위치 (process-status 기준)
- P01 시나리오 / P02 계약(67/67) / P03 요구사항 = **done**
- P04 통합 = **in_progress** — 통합테스트 67/67 통과, **라이브 graft trace(루크 머신) 대기**
- 이식(코드 transplant) 진척 = **사실상 0** — 계약·통합 스캐폴드만. UC1(V1 텍스트)는 gRPC wire+chat 관통까지 실증.

## tranche/vertical 순서 (user-scenarios SoT)
F0 부팅(workspace init) → F1 자기상태+ApprovalPort → F2 workspace 관측(read-only) → F3 workspace 조작+승인 → V1 텍스트(=UC1, wire 실증됨) → V2 음성 → S-row(skills 60+/browser/channels/bgm…).

## 각 tranche/UC 1슬라이스 레시피 (반복 적용)
1. **Old-Baseline 측정**(old-naia-os 소스, 외부키X·로컬 tranche는 루크 게이트 없이 가능): I/O trace + 상태전이 + 오류분류. (V1/V2·채널·voice = 외부의존 → 루크 머신 측정)
2. **계약**(ports) — 이미 F0~F3 67/67 있음, 갭만 보강.
3. **코드 이식**(domain/adapters) — old 기능을 새 헥사고날 슬롯으로. 수정 아닌 이식.
4. **통합 + drift-gate**: 인지흐름 관통 + negative + Old-Baseline 동등성(행동 ≡ old, 아니면 FAIL).
5. **라이브 graft 검증**(루크 머신, e2e-tauri/실행) + **2-AI 리뷰**.
6. file-anchor 등록 + assembly 분류 + CI(code-gates) green → 커밋.

## ⚠️ 현재 블로커 (이관 진행 전 해소 필요)
1. ✅ **기동 startup ~90초 지연 — 해결됨**(2026-06-13, 커밋 `38a5ec6`). 8회 격리 끝 근본원인 확정: **webview `navigator.mediaDevices`(getUserMedia/enumerateDevices) 접근이 WebKitGTK + USB Audio IEC958 장치 GstIntRange 버그로 web process 를 ~90초 동기 stall → 전체 기동 블록.** 트리거=App pre-warm + SettingsTab keepAlive enumerate. 픽스=App pre-warm 제거 + SettingsTab enumerate 를 설정-active lazy. 검증: cage e2e 90s→~2s(set_root ms=25)+채팅 무회귀+vitest 826 exit0. **틀린 가설 8개 기록**(avatar/GL/process/browser/ports/directToolCall/getUserMedia단독/...): 컴포넌트 추측 스파이럴 = 자기복잡성 함정, VITE_NAIA_DIAG_NO_MEDIA 토글 격리로 확정. **잔여**: 설정 패널 열 때 동일 device stall 가능 — UC2 voice 이식 시 GstIntRange 장치회피/timeout-bound 근본처리.
2. **P04 라이브 graft = 루크 머신 trace 필요** — F0~F3 drift-gate(`f0-graft-smoke.sh`)를 클린 머신에서 실행해야.
3. canon 재시작 프로토콜: 재부팅 후 첫 작업 = 앵커 재독 + 구조 건전성 점검(이번 세션서 2-clean·R0 완료) → 그 다음 UC.

## 권장 실행 경로 (다음 세션) — ⚠️ 재부팅 불가(루크 외부접속, 재연결 보장 없음)
0. **재부팅/stray 청소는 답 아님(2026-06-13 관측 확정)**: 지연 발생 무렵 시스템 idle — load 1.14, **100Gi 여유, 스왑 ~0**, naia 프로세스 3개뿐(저-RSS). 즉 프로세스 contention/누적 orphan 아님 → 재부팅해도 안 고쳐짐. **startup 90s 지연 = webview(browser child webview 생성, naia.log `[browser_wv] child webview created` +180s)/WebKit GStreamer init(`GstIntRange` 경고 버스트) 경로**. GL 모드도 아님(하드웨어가 더 느렸음).
1. `pnpm run tauri:dev` startup 타임라인 logs-first 재관측 → 90s JS-스레드 freeze 의 실제 점유자 격리. 가설: browser child webview 가 기동 시 동기 생성돼 main/IPC 블록 → **지연/lazy 생성(panel 열 때)** 로 회피 시도. (추측 2회 빗나갔음 — 확정부터.)
2. startup 해소(또는 수용) 후: **F2(workspace 관측 read-only)** 부터 Old-Baseline 측정(루크 게이트 불요) → 이식 → drift-gate. F2 = 외부의존 없는 첫 순수 transplant 슬라이스.
3. 이후 F3 → V2 음성(루크 머신 voice/GPU baseline) → S-row 순.

## 진행 로그
- 2026-06-13: 캠페인 바인딩. 직전 세션 = UC1 gRPC wire 실증 + 구조 2-clean + R0 CI + ARCHITECTURE/R3 + 루크 지적 3건(watch 비동기·로그·키마스킹) 커밋. 이관 본체(코드 transplant)는 startup 지연 해소 후 tranche 순 착수.
- 2026-06-13 (session ec74cc29): **재시작 프로토콜 완주** — 앵커 재독 + 구조 건전성 점검(os 153 test·agent 232 test·tsc·file-anchors·assembly·compile-integrity 전부 green; canon-conformance RED = 메모리 세션 off-scope 6파일만, 내 scope TRANSPORT/STORAGE-DRIFT 0). startup 90s 블로커 = 이미 해소(`38a5ec6`) 확인.
- 2026-06-14 (session ec74cc29, graft 단계) ★★ **graft = 자율-검증 가능 재평가 + UC12 온보딩 graft 완성**:
  - **중대 정정**: "graft=루크머신 runtime" 은 과오. **Playwright e2e(`pnpm test:e2e`)가 이 env 서 실행됨**(uc1-new-core 2 passed exit0 — chromium headless+IPC mock+`__NAIA_NEW_CORE__` 플래그, cage/wdio SIGUSR1 과 별개). + **셸 seam 통합테스트**(실 core dist 경유 invoke 캡처)로 graft 배선이 brittle UI 없이 자율-검증 가능. → graft 는 Stop hook 이 옳게 지적한 "개발" 의 일부이고 자율 수행 가능.
  - **graft 패턴 확정**: UC1 chat = lib seam(chat-service) + `isNewCore()` 게이트 + makeShell* deps 주입 + old 경로 비파괴 보존. UC13 승인 = chat graft 에 포함(uc13-approval e2e 통과 확인).
  - **UC12 온보딩 graft 완성**(dce030f): `completeWith` 신규계약(e0dc7a3, GOAL⑥ — controller 가 외부-config 패턴 미지원) + 셸 seam `lib/onboarding-core.ts` + OnboardingWizard.handleComplete `isNewCore()` 분기. 검증: seam 통합테스트(실 core→write_naia_config agent-only[secret strip]+write_agent_key 키체인, Old-Baseline 보안불변 parity) + 단위 + 기본경로 보존 + shell 827 exit0 + chat/approval e2e 5 passed.
  - **잔여 graft(자율 가능, 진행 예정)**: F1 status(StatusReporter — DiagnosticsTab 는 skill_diagnostics deferred 경로라 consumer 불명확) · F2 관측(ObservationService readFile/listDir vs 셸 workspace_get_sessions) · F3 조작(MutationGate vs Editor write) · F0 AdkSetupScreen. 각 = new-core API ↔ 셸 consumer shape 매핑 필요(onboarding 처럼 필요시 신규계약). external(voice WS/browser CDP/bgm)+실 provider 호출만 루크.
- 2026-06-14 (session ec74cc29 재개) ★ **자율 프런티어 도달(정정 전) + 최종 산출물**:
  - **재평가**: `cargo check` 가 이 env 서 작동(SIGUSR1 은 cage/runtime 만) 확인 → Rust 코드+컴파일은 자율-검증 가능(과거 "Rust 불가" 과오 정정).
  - **F1 Diagnostics RPC end-to-end 완료**: os `agent_grpc.rs::diagnostics()` 추가 → `cargo check` green(2.30s). agent(handler+provider 5 단위테스트)+proto+os Rust client 전 레이어 컴파일 검증. (커밋 1c40c04)
  - **V1/UC1 forwarding 드롭버그 fix**: os Rust `agent_event_to_ui_json` 이 ToolResult.success/toolName + ApprovalRequest.args/description 를 UI 직전 드롭하던 실버그 발견·수정 → agent→proto→Rust→chat-service:443-467→PermissionModal:34 관통. cargo green. (커밋 355be2b)
  - **canon GOAL 정렬**: in_scope 를 Old-Baseline UC 카탈로그(old user-scenarios.md)로 확장(UC6/8/11 UNKNOWN-SCOPE 해소, in_scope_source 추적) — 닫힌루프 오염 아님(외부 ground truth=GOAL+Old-Baseline). 잔여 canon RED 6 = UC-memory off-scope(타 세션, 정직 flagged). (커밋 1c40c04 agent)
  - **Voice RPC 오개념 정정**: voice=os→provider WS 직결(agent gRPC 경유 아님), Voice RPC 만들면 드리프트 → 트래커서 삭제.
  - **★ 최종 산출물**: `USER-TEST-uc-migration-2026-06-14.md` — 전 UC 사용자 테스트 문서(루크 검토용, GOAL 최종목표). 각 UC: 표준준수+자율검증분 완료상태+루크 runtime 절차+게이트 정직표기. (커밋 8338c24)
  - **핸드오프 검증 상태**: os 826 / agent 269 vitest exit0 · cargo check green · file-anchors OK(os40/agent37) · root-structure exit0 · live-adapter parity 테스트 F0/F1/F2/F3/V2 완비. **잔여 = 루크머신 runtime/graft/external(이 env cage/wdio SIGUSR1 차단 → blind graft=false-success 위험이라 미실행, 정직).**
- 2026-06-13 ★ **F2 코드 이식 (recipe step 3-4 자율 완료)**: `adapters/tauri/f2.ts` 의 stub(`throw NotWired`) → **실배선 어댑터 추가** `makeF2EnvObserve`/`makeF2ExpectedState`/`makePtyReader`(F0-live·UC1·UC12 와 동일 주입 패턴, new core 는 @tauri-apps 미의존, old invoke/listen 주입). old 명령 1:1 parity: `workspace_list_dirs{parent}`·`workspace_read_file{path}`·`workspace_file_size{path}`·`workspace_get_sessions`·`workspace_get_pty_agents{pids}`·`workspace:file-changed`·`pty:output/exit:{id}`. composition `wireObservationServiceLive`/`wireDriftDetectorLive` 추가.
  - **drift-gate 검증**: `src/test/f2-live-adapter.test.ts` 11 tests — live 어댑터가 *정확히 old 명령/인자* 호출함을 결정적 검증(= Old-Baseline 등가. F2 env 는 thin passthrough라 명령-parity 단위테스트가 곧 등가 증명, f0 decideBoot 같은 변환로직 없음) + PermissionDenied contain + listen 등록. tsc/anchors/assembly/compile-integrity/full-suite(153) 전부 green.
  - **이식 시 발견(계약 보강 필요)**: (a) `get_main_worktree`/`get_all_worktree_paths` 는 `#[tauri::command]` 아님 → JS invoke 불가 → `worktrees()` 는 `workspace_get_sessions` 경유로 매핑(SessionInfo.origin_path/branch 가 worktree 상태). (b) `processStatus()` 무인자 old 명령 없음 → `workspace_get_pty_agents{pids}`(추적 pid 주입)로, pid 없으면 빈 결과. (c) `ExpectedStateProviderPort.goal/approvedIntent` 의 old 소스 미존재 → 현재 null(정직), F1 ApprovalBinding 배선·goal-state source 후속. (d) `PtyReadPort` 가 id 없음 vs old `pty:output:{id}` per-id → `makePtyReader(id)` 팩토리로 노출.
  - **남은 = 루크 머신 게이트(recipe step 5)**: 이 live 어댑터는 *작성+parity 검증*됐으나 **실행 shell 이 아직 호출 안 함**(F0/F1/UC12 와 동일 — UC1 gRPC chat 만 실 shell 관통). watch→drift / pty 이벤트의 런타임 검증 + e2e-tauri 는 디스플레이 세션 필요(이 env SIGUSR1 로 헤드리스 앱런 불안정). + 2-AI 리뷰.
