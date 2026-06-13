# UC 이식 캠페인 트래커 — "모두 이관" (2026-06-13)

session_id: ec74cc29-3347-4f6e-b29a-237ea29f301e
prior_sessions: [67a0313b-2578-4da2-9a52-53c26128656f]

---
## ★ CAMPAIGN ANCHOR (매 턴·압축후 제일 먼저 재독 — 위치/목적 잊지 않기)

**공식 GOAL (루크 2026-06-13 "Goal set", 권위·완료기준)**: os+agent 표준 프로세스로 — ① gRPC 기반 연결 ② UC 기반 직교 이식 ③ **장기 안드로이드/로봇 위한 카테고리 추상화 기반**(substrate-agnostic 포트, OS/Tauri 비종속) ④ 표준대로 개발 확인 ⑤ 개발후 테스트+크로스리뷰로 **보안·디버깅용이성·내부기준** 확인 ⑥ **불가 시 신규 계약으로 흔들리지 않게**(애드혹 우회❌) ⑦ **모든 UC 가 이 방법. 전부 개발됐을 때만 완료.** → 전부 끝나면 UC별 사용자 테스트 문서 → 루크 검토.
**불변식 (절대)**: gRPC(os→agent→naia-adk) · UC(세로)×port(가로) 직교 · substrate-agnostic(안드로이드 대비) · 표준 방법(Old-Baseline→계약먼저→이식(수정❌)→drift-gate→2-AI 리뷰→커밋) · 검출기 green · 진행 "물어보지말고 끝까지·멈추지마"(자율 순차, 위치/목적 앵커 재독).
**리뷰 표준**: Round0 scope/canon(open-loop, 정본=ground truth) → 티어(T2=경로격리/외부연결/승인/인증=2-AI 2-clean, 그외 T1 빠른모델 1패스) → 적대적 REFUTE → Execute-to-Judge → 산출물 `.agents/reviews/r-<uc>.json`. 상세 = [[project_new_naia_goal_and_method_anchor]].
**순서 (루크 선택)**: ① 재무장 → ② F2 재검증 → ③ UC 유저여정순.

### 현재 위치 (CURRENT POSITION)
- **Phase ①(재무장) 진행 중.** 라이브 워처 재가동됨(os PID 60152·agent 60304). ⚠️ **이 머신(Bazzite)엔 crontab 없음+crond inactive → cron 영속 불가** = 자동검출이 죽어있던 근본 이유. 재부팅 생존 = **SessionStart 훅 self-heal**로 가야(미구현).
- enforcement 갭(RCA, 전부 관측): (G1) new-naia 게이트(sdlc/file-anchor/completion/conform)가 **alpha-adk 루트 세션에 미로드**(2단계 nested, 자체 settings 만) → 미발화. (G2) 루트 훅 체인에 SDLC/티어/2-AI 게이트 0. (G3) 티어/2-AI 가 게이트로 인코딩 안 됨(문서/메모리에만). (G4) 라이브 자동검출 죽음(crond 없음).
- **F2 상태 = ✅ 이식+리뷰 완료**(코드/계약): `75ef48a`(초기) → 2-AI R1 ISSUES(BLOCKER2+MAJOR4) → **신규 계약(ports/f2.ts + §C delta)으로 수정** → R2(전부 fixed+MEDIUM1 NI-1) → 수정 → R3 CLEAN. `.agents/reviews/r-f2-2026-06-13.json` 참조. tsc/anchors/assembly/compile/**154 test** green. **남은 = 루크 머신 라이브 graft + e2e(실행 shell 이 wireObservationServiceLive 호출, watch→drift/pty 런타임).** ★ 교훈: open-loop 2-AI 가 closed-loop 11-green 이 놓친 BLOCKER 적발 = 재무장+리뷰표준 가치 실증.

### 재무장 TODO (Phase ①)
- [x] **R1 SessionStart drift-checkpoint 훅** (`naia-watcher-selfheal.js`): 세션마다 `verify-watch once` 동기 실행(데몬 고집 X — 이 env 백그라운드 reap). cron 불가 머신 대체. → G4. baseline 승인(기존 os2/agent10 = doc-orphan + 메모리 off-scope, 내 것 아님)로 이후 NEW delta만.
- [x] **R2 nested-gate dispatcher** (`nested-naia-gate-dispatch.js`, 루트 settings Pre/Post 등록): projects/new-naia/** 편집 시 서브 게이트(charter/sdlc/structure/file-anchor[pre], conform/mirror-sync[post]) 발화. fail-open. **mutation-probe 통과**(미계약 src/main 차단 ✓, 정상 통과 ✓). → G1 닫힘(F2가 샌 갭).
- [ ] **R3 T2 리뷰 게이트** (남음): T2 경로(권한/인증/transport) 변경 커밋 시 `.agents/reviews/r-*.json`(2-clean) 없으면 차단. completion-evidence 가 Bash(commit)서 sub-root 미해결로 디스패처 미대행 → 별도 설계 필요. = G2/G3 미닫힘(차후).
- [x] R4 self-검증 = mutation-probe 통과(위 R2).

> **재무장 결론**: G1(서브게이트 미발화)·G4(cron 죽음) 닫힘 + 검증. G2/G3(T2→2-AI 강제 게이트)는 R3로 남음 — 그동안은 *리뷰 표준을 수동 준수*(앵커 재독 + UC마다 2-AI). 라이브 per-action 강제(dispatcher)는 가동.

### UC 상태표 (tranche/vertical, user-scenarios.md SoT)
| 단위 | 범위 | 계약 | 이식(코드) | 2-AI 리뷰 | 라이브 graft/e2e | 상태 |
|---|---|:--:|:--:|:--:|:--:|---|
| F0 | 부팅 workspace init | ✓67/67 | live어댑터 작성 | ✗ | 루크머신 대기 | scaffold+live |
| F1 | 자기상태+승인 | ✓ | stub | ✗ | — | 계약만 |
| F2 | workspace 관측(read-only) | ✓+**delta(§C)** | **live+신규계약 수정** | **✓ 2-AI 3R 수렴 CLEAN** | 루크머신 대기 | **이식+리뷰 완료** |
| F3 | workspace 조작+승인 | ✓ | stub | ✗ | — | 계약만 |
| V1=UC1 | 텍스트 대화 | ✓ | **gRPC 관통 실증** | codex부분 | **실앱 대화 OK(루크확인)** | 거의완료 |
| V2 | 음성 | △ | ✗ | ✗ | 루크머신 voice baseline | 미착수 |
| S-row | skills 60+/browser/channels/bgm | 측정 | ✗ | ✗ | — | 미착수 |
| UC5/6/7/8/12/13 | (user-scenarios 참조) | 부분 | UC12=온보딩 live | ✗ | — | 부분 |
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
- 2026-06-13 ★ **F2 코드 이식 (recipe step 3-4 자율 완료)**: `adapters/tauri/f2.ts` 의 stub(`throw NotWired`) → **실배선 어댑터 추가** `makeF2EnvObserve`/`makeF2ExpectedState`/`makePtyReader`(F0-live·UC1·UC12 와 동일 주입 패턴, new core 는 @tauri-apps 미의존, old invoke/listen 주입). old 명령 1:1 parity: `workspace_list_dirs{parent}`·`workspace_read_file{path}`·`workspace_file_size{path}`·`workspace_get_sessions`·`workspace_get_pty_agents{pids}`·`workspace:file-changed`·`pty:output/exit:{id}`. composition `wireObservationServiceLive`/`wireDriftDetectorLive` 추가.
  - **drift-gate 검증**: `src/test/f2-live-adapter.test.ts` 11 tests — live 어댑터가 *정확히 old 명령/인자* 호출함을 결정적 검증(= Old-Baseline 등가. F2 env 는 thin passthrough라 명령-parity 단위테스트가 곧 등가 증명, f0 decideBoot 같은 변환로직 없음) + PermissionDenied contain + listen 등록. tsc/anchors/assembly/compile-integrity/full-suite(153) 전부 green.
  - **이식 시 발견(계약 보강 필요)**: (a) `get_main_worktree`/`get_all_worktree_paths` 는 `#[tauri::command]` 아님 → JS invoke 불가 → `worktrees()` 는 `workspace_get_sessions` 경유로 매핑(SessionInfo.origin_path/branch 가 worktree 상태). (b) `processStatus()` 무인자 old 명령 없음 → `workspace_get_pty_agents{pids}`(추적 pid 주입)로, pid 없으면 빈 결과. (c) `ExpectedStateProviderPort.goal/approvedIntent` 의 old 소스 미존재 → 현재 null(정직), F1 ApprovalBinding 배선·goal-state source 후속. (d) `PtyReadPort` 가 id 없음 vs old `pty:output:{id}` per-id → `makePtyReader(id)` 팩토리로 노출.
  - **남은 = 루크 머신 게이트(recipe step 5)**: 이 live 어댑터는 *작성+parity 검증*됐으나 **실행 shell 이 아직 호출 안 함**(F0/F1/UC12 와 동일 — UC1 gRPC chat 만 실 shell 관통). watch→drift / pty 이벤트의 런타임 검증 + e2e-tauri 는 디스플레이 세션 필요(이 env SIGUSR1 로 헤드리스 앱런 불안정). + 2-AI 리뷰.
