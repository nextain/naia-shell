# UC 이식 캠페인 트래커 — "모두 이관" (2026-06-13)

session_id: 67a0313b-2578-4da2-9a52-53c26128656f

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
