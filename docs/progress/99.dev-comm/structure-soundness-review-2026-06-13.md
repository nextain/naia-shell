# new-naia 구조 건전성 평가 — 드리프트-없는 역할분해 UC 개발 가능한가 (2026-06-13)

> **목적(루크 WHY)**: 프로젝트를 구조화해 **흔들리지 않아야** 오픈소스로서 **각 역할을 분해해 독립 기여자(사람·AI)가 병렬 개발/확장**할 수 있다.
> 평가 바 = **"자동 강제(CI 등)가 살아 독립 기여자 PR의 코드/계약/구조 드리프트를 자동으로 잡나"** + **"새 dev/AI가 동일 구조·사상으로 확장하게 컨텍스트가 정리됐나."**
> **정답(리뷰 open-loop 기준)** = 루크 canon(os→agent→adk, UC(수직)×wire(수평) 직교, 뇌중심/안드로이드 추상, 오픈소스 역할분해) + goal anchor + old-baseline. *이 문서가 정답이 아님.*
> **개정**: v2=라운드1(ISSUES7) 반영. **v3=라운드2(ISSUES6, material 2) 반영 — file-anchor 메커니즘 실재 발견(B1 재서술), TS wire union 손중복+R0 라이브wire 미보장(B-WIRE/R0 보정), 포트/pre-commit 정밀화.**

---

## A. 도달한 것 (이번 세션)

| 항목 | 상태 | 근거 |
|---|---|---|
| 수평 직교 os→gRPC→agent→adk | ⚠️ 동작 관찰(**수동/LIVE-게이트, 자동회귀 아님**) | 챗 UC1 4단 왕복(ingress `{kind:chat}`→z.ai→UI+store.json). 실검증=`uc-provider-provenance-live.spec.ts`(`RUN_LIVE_AGENT_E2E=1`)·`agent_grpc.rs:149`(`RUN_LIVE_RUST_GRPC=1`) → **CI skip + CI 시크릿 없음** = 수동 1회 |
| 입력/출력 포트화 | ✅ | `ports/uc1.ts` AgentIngressPort/AgentEgressPort (transport-neutral) |
| 경계 계약(H-agent wire) | ✅ 설계(단 동기검사 수동) | AgentOutbound/AgentMessage 폐쇄 union, 양방향 probe PASS(수동). **TS union은 os/agent 손-중복, 1:1을 주석으로만 단언**(아래 B-WIRE) |
| 컨트롤플레인 포트 분해 | ✅ | os `ports/`=f1/f2/f3/index/uc1(~13 포트: Config/Workspace/Settings/Onboarding…), agent `uc1.ts`(~10 포트) |
| UC×포트 앵커 문서 | ✅ 문서 | `new-naia-agent/docs/progress/agent-vertical-anchor-2026-06-10.md` — UC1~14 × 수평 포트 |

> "✅/⚠️"는 *설계·인터랙티브 세션·수동 관찰*이지 **CI 자동 회귀로 고정된 게 아님**(B0).

## B. 미도달 / 드리프트 위험 (검증됨)

| # | 갭 | 사실(근거) | 영향(역할분해) |
|---|---|---|---|
| **B0** ★ | **모든 검출망이 CI 미연결** | CI `self-trust-gates.yml`(os+agent 동일, `ubuntu-latest`)이 `src/test/*.test.mjs`(구조·헌장·SDLC 메타 + security.test.mjs는 여기 걸려 **실행됨**)만 실행. **미실행**: vitest `.test.ts`(UC1 계약·tier 승인·통합 os13/agent19), Playwright, `check-compile-integrity`(tsc), `check-assembly-coverage`, `check-logging`, **`check-file-anchors`**, wire probe (`grep -E 'vitest\|assembly\|compile\|file-anchor' .github/workflows`=0) | 독립/fork 기여자 PR에서 **코드·계약·타입·파일계약 드리프트 자동검출 0** |
| **B0b** | **세션/cron 강제는 fork PR 미적용** | file-anchor-guard·conform-gate=PreToolUse(Claude 세션만). pre-commit=`core.hooksPath`(이 체크아웃엔 설정됨, compile-integrity(tsc)+logging 실행) but **client-side·`--no-verify` 우회·clone당 수동·fork 기여자 off**. check-file-anchors=cron(`verify-watch.sh`)만 | 인터랙티브 Claude 세션은 보호받으나 **웹/타 도구/fork PR은 전부 우회** |
| **B1** | **파일단위 계약 = 실재하나 CI 밖 / conform-gate는 C-only 부차** | ✅실재: `file-anchor-guard.js`(PreToolUse, `settings.json:42`) + `module-manifest.json`(**37 파일 등록 {layer,uc,contract}, populated**; agent repo도 대칭 32 files) + `check-file-anchors.mjs`. 단 위 B0b대로 CI 밖. 별개로 conform-gate는 추출기 C-only(`conform-gate.js:34` `.c\|.h`, `check.py` C regex)+regions 빈 배열 = TS/Rust엔 inert(부차적 region 심볼 체크) | 파일계약은 *세션*엔 살아있음 → 진짜 갭은 "CI 미연결"(B0). conform-gate 이식은 부차 |
| **B2** | **wire probe 수동** | `uc1-outbound-probe`/`uc1-variant-probe`(os outbound⊆agent accept, agent output⊆os classify = **TS union 동기검사 본체**) PASS지만 hook/CI 미등록(`uc1-graft-observe.sh`만) | 경계/union 발산 자동 차단 없음 |
| **B-WIRE** | **wire SoT 결합 + TS union 손중복** | ① proto SoT=`new-naia-agent/.../naia_agent.proto`를 os가 하드코드 형제경로 소비(`build.rs:7-8`); 결손 시 else(`build.rs:20`)→`cargo:warning`만(**silent degraded build**, gRPC 클라 없음). ② 계약 union이 os/agent `domain/chat.ts`에 **손-중복**, "1:1"을 주석으로만 단언(`agent chat.ts:2,27,89`), 필드 rename(id→toolCallId). 동기 강제=수동 probe(B2)뿐 | agent proto/union 변경 시 os가 조용히 어긋남/빌드 저하 |
| **B3** | **수직 UC 포트화 1/14** | vertical UC = `uc1`만 풀 슬라이스. UC2~14 미구현(컨트롤플레인 F0~F3 포트는 존재) | 수직 패턴 1회 적용 → 재현성 입증 부족 |
| **B4** | **UC 스캐폴드/온보딩 컨텍스트 부재** | "새 UC = 포트+계약테스트+어댑터+wire+manifest 등록+분류를 어디에" 명시 템플릿 없음(암묵) | 새 dev/AI가 패턴 **추론** = 드리프트 입구 (루크 2nd 요구 정면) |
| **B6** | 표현층 부재 + 처리부 모놀리식 | 표현=출력에 붙음(LLM `[HAPPY]`+os 아바타), `chat-turn-handler` 단일 덩어리 | 안드로이드용 뇌중심 추상 미도달(단일 텍스트 모달이라 당장 차단요인은 아니나, WHY상 부채로 명시) |
| **B7** | 수직 UC 미완(설정) | 빈 키 란 = naia-adk 저장값 Settings UI 미-되읽기(`*****` 미표기) | 설정 UC 슬라이스 미완 (루크 #3) |
| **B8** | 단단함 회귀 | `workspace.rs:399` `workspace_start_watch` 비-async 동기(`collect_workspace_git_dirs` 인라인, 관측 180s, 루크 #1). per-chunk 로그 홍수(F1) | 동작해도 단단함 미입증 |

## F. 디버깅 용이성(표준 로깅) — 부분
도달: `docs/logging.md` 규약+logs-first, `check-logging.mjs`(단 B0대로 CI 밖). 로그 중앙화(`.naia/logs/`). 레벨 게이트.
갭(검증): F1 per-chunk 홍수(`ChatPanel.tsx:1015-1020` text 청크마다 Logger.info, 턴당 수십~수백; finish/usage는 1회)→R-LOG-A. F2 correlation 미표준→R-LOG-B. F3 타임스탬프 불일치(Rust unix초 vs TS ISO)→R-LOG-C. F4 단계별 elapsedMs 비표준→R-LOG-D.
> ⚠️ 폐기: "requestId 리터럴 버그"(`composition/index.ts:67`)는 `in` 연산자 오독 = 가짜 finding.

## G. 보안 — 부분적 충분
도달(강함): 위협모델 문서 / 비밀 OS 키체인(평문 fallback 없음) / config strip(`stripForAgent`) / 파일권한(memory 0700) / `.gitignore`+`security.test.mjs`(CI 실행됨) / tier 승인 게이트.
갭(검증): G1 gRPC `createInsecure()`(`new-naia-agent .../grpc-server.ts:126`), 기본 `127.0.0.1:0`(양호)이나 `NAIA_AGENT_GRPC_ADDR`(`agent-stdio-entry.mjs:172`) env override로 0.0.0.0 가능+메서드 무인증→R-SEC-3(중,로컬). G2 기여자 보안 가이드 부재→R-SEC-4. G3 Store 암호화 미명시(`secure-store.ts:15`)→R-SEC-1(낮).

## C. 판정 (v3)
설계(포트·계약·UC×wire·**살아있는 file-anchor**)는 역할분해를 지원하고, **인터랙티브 Claude 세션 안에서는 드리프트가 상당히 잡힌다**(file-anchor-guard/conform 훅·pre-commit). 그러나 **오픈소스 독립/fork 기여자 경로엔 자동 강제가 사실상 없다**: 모든 실질 검출망(테스트·tsc·assembly·logging·file-anchor·probe)이 **CI 미연결(B0)**, 세션/cron/pre-commit은 그들에게 미적용(B0b). 더해 wire SoT가 손-중복+수동검사(B-WIRE/B2), 수직 UC 1회·스캐폴드 부재(B3/B4)다.
→ **"세션 내부는 부분적으로 단단, 오픈소스 협업 경계에선 흔들림 자동차단 미가동." 아직 "단단하다"고 할 수 없다.**

## D. 보강안

| ID | 보강 | 우선 | 닫는 갭 |
|---|---|---|---|
| **R0** ★ | **기존 검출자산 전부 CI 연결** — `self-trust-gates.yml`에 `pnpm -r test`(vitest .test.ts) + `check-compile-integrity`(tsc) + `check-logging` + `check-assembly-coverage` + **`check-file-anchors`** + wire probe(B2) 추가. pre-commit은 client-side 편의로 유지(우회 가능 명시) | **P0** | B0,B0b,B1,B2,B5 |
| **R-WIRE0** ★ | **라이브 wire 자동회귀** — R0의 vitest는 transport mock이라 *실 크로스-프로세스 wire 미검증*. (a) in-process fake-transport conformance(시크릿 불요, CI 가능) 또는 (b) CI에 z.ai 시크릿+LIVE job. + proto/TS-union 해시·일치 CI 체크 | **P0** | A실증,B-WIRE |
| **R3** ★ | **UC 스캐폴드 + 온보딩 컨텍스트** — `uc1` 본으로 "새 UC = 포트+계약테스트+어댑터+wire+manifest 등록+분류" 명시 체크리스트/템플릿 → 새 dev/AI가 따라만 하면 동일 구조·사상 | P1 | B3,B4 |
| **R6** | 루크 직접지적 — #1 watch 비동기화, #2 R-LOG-A(청크 로그 debug/집계), #3 설정 UC 키 `*****` 되읽기 | P1 | B7,B8,F1 |
| **R1** | conform-gate 언어이식(`.ts/.rs` 필터+추출기 교체+regions) — **부차**(file-anchor가 본체이므로 nice-to-have, region 심볼 검증 보강) | P2 | B1(보조) |
| **R4 / R-LOG-B,C,D / R-SEC-3,4,1 / R5** | assembly 코드매핑 / correlation·ISO·elapsed / gRPC 인증·보안가이드·Store명시 / 표현 egress 포트 예약 | P2 | B5,F2-4,G,B6 |

**우선순위(라운드1·2 정정)**: 본체 = **R0(검출자산 CI 연결) + R-WIRE0(라이브 wire 회귀)**. file-anchor가 이미 살아있으므로 conform-gate 이식(R1)은 부차로 강등.

## I. 온보딩 컨텍스트 (새 dev/AI 흔들림 없이 확장)
1. **사상 단일 문서** — os/agent AGENTS.md(=CLAUDE/GEMINI)에 "os→agent→adk + UC×wire 직교 + 입력/출력(/표현) 계층" 명문화(현재 anchor·이 평가에만 흩어짐; agents-rules·project-structure에도 없음). ⚠️ `docs/ARCHITECTURE.md`는 CLAUDE.md "정규 디자인 문서" 표에 등재됐으나 **파일 부재** → 이 사상의 SoT로 신설.
2. **UC 스캐폴드(R3)** — 추론 불요 재현.
3. **R0/R-WIRE0 CI** — 사상 위반 PR 자동 RED(컨텍스트가 *말*로 끝나지 않고 강제로 뒷받침).
4. 이 문서 = 현 위치+로드맵 SoT, 보강 완료 시 갱신.

## D2. 보강 적용 결과 (2026-06-13)

| ID | 적용 | 검증 |
|---|---|---|
| 사전 | vitest GREEN — os jest-dom(이중설치→명시 expect.extend, 84), chat-service .env 결정화(3), agent gRPC 회귀 재작성(1), **app-discord-auth unhandled-rejection(plugin-store mock, 재검증서 발견)** | **EXIT 0 검증**: os shell `pnpm -C packages/shell test`=826 pass/0 errors/exit0, os core=142/exit0, agent=232/exit0. (초기 "0 fail" 은 케이스만 봐 'Errors 4'+exit1 누락 → 재검증이 잡음) |
| **R0** | `code-gates` CI job 양 repo 추가 — vitest(core+shell/agent) + compile-integrity(tsc) + logging + file-anchor + assembly(os) + wire probe(os) | 넣은 검출 전부 로컬 green 검증. YAML 유효. ⚠️ GitHub Actions 실행은 미검증(node22/pnpm10 추론) |
| **R-WIRE0** | 라이브 wire 자동회귀 — (a) 재작성 통합테스트(gRPC server-stream, echo provider=무시크릿)가 agent vitest(CI)에 (b) wire probe(union 정합) os CI 에 | CI 자동실행. **잔여(B-WIRE)**: cross-repo proto 해시 일치 = 공유 패키지/서브모듈 결정 필요 follow-up |
| **ARCHITECTURE** | `docs/ARCHITECTURE.md` 신설(os=사상 SoT+§6 UC 레시피, agent=brain). 헌장 doc-registry 기등재 슬롯 충족(AGENTS 본문 미변경=churn 회피) | terminology PASS, doc-graph 등재 |
| **R3** | UC 추가 레시피 = ARCHITECTURE.md §6(os) 10단계 체크리스트 + agent §6 | 새 dev/AI 추론 불요 슬롯-채우기 |
| R1(conform-gate 이식)·R4·R-LOG-B/C/D·R-SEC | 미적용(P1/P2 follow-up) | — |

**판정 갱신**: B0(검출망 CI 미연결)=R0로 **닫힘**(green 위). 온보딩 컨텍스트(B4)=ARCHITECTURE/R3로 **닫힘**. 남은 핵심=B-WIRE cross-repo proto 해시(공유-proto 결정 대기). → 오픈소스 독립/fork 기여자 PR 이 이제 코드·계약·타입·계층·파일계약 드리프트에서 자동 RED.

## D3. 기동 지연 후속 진단 (2026-06-13 — 부분해결/미해결)

루크 #1 "로딩 너무 오래(180s)" 추적 결과(정직):
- ✅ **watch 비동기화는 작동** — Rust 로그 `start_watch collected 0 git dirs ms=0`, `watched ms=0`. 옛 180s watch 블록 제거됨.
- ❌ **그러나 체감 기동 지연(~90초)은 별개 원인이라 미해결**: 프론트 `workspace_set_root ok {ms:90072}`인데 **Rust set_root 핸들러는 ms=0** → 명령 로직 아니라 **invoke 응답이 90s 지연 = webview JS 스레드가 90s 통째 freeze**(그 구간 JS 로그 0줄). 끝나는 시점에 `[browser_wv] child webview created`(+180s) + AvatarCanvas VRM 로드.
- **틀린 가설 2개(정직 기록)**: (1) `.env`가 원인 — 아님(GTK가 진짜). (2) 소프트웨어 GL 아바타 — `WEBKIT_DISABLE_DMABUF_RENDERER=1` 제거(하드웨어 GL) 시 **오히려 더 느렸음** → GL 모드가 원인 아님. DMABUF off 유지.
- **남은 후보(미검증)**: ① browser child webview 생성이 기동 시 main/IPC 블록 → 지연 로드(panel 열 때 생성)로 회피? ② WebKit GStreamer 미디어 init(`GstIntRange` assertion 경고 버스트) ③ 세션 내 누적 stray 프로세스(BGM 18791/orphan agent/webkit) → **재부팅으로 청소 후 재측정 권장**.
- 다음 세션 작업: 재부팅 클린 상태에서 기동 타임라인 재관측(logs-first) → 90s 블록의 실제 점유자 격리(추측 금지) → 지연 로드/lazy webview 등 수정.

## E. 적대적 교차리뷰 기록 (2-clean 목표)
- **라운드1**(general-purpose): ISSUES(7) — B0 CI미연결 놓침 등 → v2 반영.
- **라운드2**(독립 general-purpose): ISSUES(6, material 2) — I-1 file-anchor 실재 누락, I-2 TS union 손중복+R0 라이브wire 미보장; nitpick: 포트수 과소·pre-commit 과소·build.rs silent-skip → **직접 검증 후 v3 반영**(B1 재서술, B-WIRE 확장, R-WIRE0 신설, A/B0b/포트 정밀화).
- **라운드3**(독립 confirm): **CLEAN (material 0)** — nitpick 3(build.rs 라인·agent file-anchor 대칭·gRPC 기본값) 반영. = clean #1.
- **라운드4**(독립 confirm): **CLEAN (material 0)** — 6개 핵심사실 repo 재대조 일치. nitpick(repo prefix·ARCHITECTURE.md 부재) 반영. = clean #2.
- **✅ 평가 2-clean 달성** (라운드3+4 독립 연속 clean).
- **보강 재검증 라운드A** (독립): ISSUES(2 material) — ① `pnpm -C packages/shell test` 가 app-discord-auth unhandled-rejection 4건으로 **exit 1**(내가 케이스 카운트만 보고 "0 fail" 오판 = false-success) ② code-gates CI/ARCHITECTURE **미커밋**(repo history 부재). → 수정: ① plugin-store mock 으로 exit 0 ② 이 커밋에 code-gates+ARCHITECTURE+테스트픽스 포함. agent wire 통합테스트·probe·ARCHITECTURE 정확성은 CLEAN 확인.
- **보강 재검증 라운드B**(커밋 후 독립 confirm): _대기_ — clean 이면 보강 2-clean.
