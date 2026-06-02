# naia-os 음성 상태머신 ↔ 웹(naia.nextain.io) 정렬 — 2026-06-02

## 상태: ✅ 커밋 `6d078b40`(§4 정렬) + `e77d514c`(stale-socket race fix) — 미푸시(승인 후). consent 인터랙티브 + handleSend 동시성 + prod host = 후속

## 통합(holistic) 크로스리뷰 + 수정 (2026-06-02, 커밋 후)
- 커밋된 완성본 전체를 codex+gemini로 **통합 리뷰** → 단계별 리뷰가 놓친 **HIGH 버그 발견(둘 다 수렴)**: `ws`/`connected`가 cold-start retry 시도 간 공유 → stale 소켓의 늦은 close(예: cold-start 시도 종료 4503가 새 시도 active 이후 도착)가 `connected` 뒤집고 onDisconnect 발화 → **멀쩡한 활성 세션 종료**. §4의 늘어난 pre-active reject 경로가 윈도우 확대.
- **수정 `e77d514c`**: attemptConnect가 시도별 소켓 `sock` 캡처, 모든 핸들러 `sock !== ws` 가드(superseded 소켓 무시). onclose는 `ws !== null && sock !== ws`(disconnect가 ws=null → teardown close는 진행해야 promise settle, 아니면 disconnect-중-connecting hang). onopen/timeout은 `sock` 사용. 회귀 테스트 추가(superseded 늦은 close 무시). 재-크로스리뷰 codex+gemini **SHIP**.
- 자체 발견·수정: 위 가드가 disconnect-중-connecting을 hang시키던 회귀를 기존 cancel 테스트가 잡아냄 → onclose ws-null 예외로 해결.
- 검증: vitest **136 passed**(coldstart 15 incl. race 회귀), tsc 0.

## 후속 (사용자 결정 필요)
- **consent branches(replace/add) 인터랙티브**: 송신 프로토콜 미정의(웹도 표면화만) — 게이트웨이 스펙 후.
- **handleSend text→voice 동시성**(gemini Medium, 기존 코드): omni 모델에 텍스트 전송 시 cold-start 중 finishStreaming/completeCurrentRequest를 await 전에 호출 → cold-start(수분) 중 추가 전송이 중복 handleVoiceToggle 유발 가능. 제가 개발한 voice-state 범위 밖(기존 handleSend) — 추측 없이 surface. 가드(connecting 중 재진입 차단) 추가 검토 필요.
- **prod host** `wss://gateway.nextain.io` (config는 run.app) — ops 결정.

## 배경
naia-omni 배포 준비. 웹 데모(`/[lang]/manual/demo`)가 cascade 작업(2026-06-01)에서 추가한
**WS close code 4002 = superseded**(같은 계정이 다른 기기에서 접속 → 이 기기가 세션 양보,
last-wins) 상태가 naia-os("예전 버전")에 전혀 없었음. 멀티 디바이스(웹+데스크톱 동시)에서
조용한 끊김/unknown 에러 발생. 웹을 기준으로 상태/다국어를 정렬하고 상태머신을 제대로 추상화.

## 설계 (codex gpt-5.5 + gemini 2.x 크로스리뷰 반영, 단계별 GO)
- **단일 정본**: `VoiceConnectionStatus`(types.ts)를 웹 `ConnectionState`와 1:1 정렬
  (idle/connecting/cold-start/active/sold-out/error/closed). `voiceMode`는 useState 제거 →
  `phaseToMode(voiceStatus)` 순수 파생.
- **close code SoT**: naia-omni `closeCodeReason()` (4001 auth / 4002 superseded / 4003 credits /
  1000·1005 normal / else unknown) — 웹 `closeReason` 미러. `closeCodeMessage()` = pre-session reject 문구.
- **active = mic-gated**: provider는 active/closed를 emit 안 함(pre-active만). active는 ChatPanel 소유.
- **mid-session close → onDisconnect(info?: {code, reason})** (시그니처 변경). ChatPanel 핸들러가
  동기 teardown 후 단일 setVoiceStatus(terminal) — race/thrash 제거(원자적).
- i18n `chat.voiceErrorSuperseded` 14개 언어 신규.

## 변경 파일
- `shell/src/lib/voice/types.ts` — VoiceCloseReason/VoiceCloseInfo, union 정렬, onDisconnect(info)
- `shell/src/lib/voice/naia-omni.ts` — closeCodeReason/closeCodeMessage(구 closeCodeToMessage 대체),
  classifyErrorReason +superseded, ws.onclose mid-session onDisconnect(info)
- `shell/src/lib/voice/index.ts` — VoiceCloseReason/VoiceCloseInfo 재export
- `shell/src/components/ChatPanel.tsx` — voiceStatus 단일 SoT + phaseToMode 파생, 전 경로 치환,
  onDisconnect 원자 핸들러, voiceFailureMessage/voiceCloseMessage superseded, 파이프라인 active 버그 수정
- `shell/src/lib/i18n.ts` — voiceErrorSuperseded ×14
- `shell/src/lib/voice/__tests__/naia-omni-coldstart.test.ts` — 4002 pre/mid + normal 테스트 4종

## 검증
- vitest: voice 111 + ChatPanel 19 = 130 passed (e2e 4 skipped). tsc --noEmit exit 0.
- 크로스리뷰: 계획(GO-WITH-CHANGES→반영) · S1(GO) · S2(GO, codex+gemini). 비차단 nit(voiceSessionRef null) 반영.

## 주의 (working tree)
- naia-os working tree에 **세션 이전부터 미커밋된 cold-start/abandon/onStatusChange 피처**가
  존재(naia-omni.ts·i18n.ts 광범위 reformatting 포함). 본 작업은 그 위에 얹은 superseded 정렬분.
  커밋 시 사전 reformatting 포함 여부는 사용자 결정 필요.

## 남은 일
- (선택) ChatPanel voice 상태 단위/E2E 테스트 보강(현재 type+크로스리뷰로 검증, 단위 미보강).
- 커밋/푸시 = 사용자 승인 후.

## 스펙 재검토 (2026-06-02 12:36, 웹 git pull 후)
- 웹 스펙 변경은 **origin/main `49e141d` (#34)** "§4 client status contract"에 있음. 로컬 naia.nextain.io는 `naia-omni-0.9` 브랜치(origin/main보다 6커밋 뒤) — pull은 그 브랜치 기준이라 변경 미포함. main에서 직접 확인함.
- **새 §4 계약 (manual `naia-omni-cascade.md` + client `naia-omni-client.ts`):**
  - JSON 상태 이벤트(close 전 전송): `session.preparing`/`session.queued`(close **4503**, `eta_s`·`position`·`reservation_token`) = cold-start WAIT(에러 아님) · `session.sold_out`(4503, `retry_after_s`) · `session.consent_required`(**4409**, `branches` replace/add) · `session.error`(4503).
  - close 코드: 4001 auth / 4002 superseded / 4003 credits / **4409 consent** / **4503 transient(준비중·대기·매진·일시오류 — 직전 JSON으로 구분)**.
  - **규칙: 4503을 closed/error로 표시 금지.** bare 4503도 transient → 같은 instance로 재연결(백오프 5→60s, ~10min cap).
  - prod 엔드포인트: `wss://gateway.nextain.io/v1/realtime?model=...&instance=<userId>:<random>` (host 변경, always wss).
- **naia-os 갭 (대조 결과):**
  - ✅ 이미 일치: 4001/4002/4003, cold-start 재시도 루프(5→60s,10min), sold-out, instance param.
  - ❌ CRITICAL: naia-os는 cold-start/sold-out을 **에러 메시지 문자열**(`msg.includes("pod-starting"/"sold-out")`)로만 감지 — 새 typed 이벤트(session.preparing/queued/sold_out/error) 미인식. **close 4503 → closeCodeReason "unknown" → error** 처리(새 스펙 위반, gateway가 새 wire 쓰면 cold-start가 에러로 깨짐).
  - ❌ NEW: 4409 / `session.consent_required`(branches replace/add) 미구현.
  - ⚠️ eta_s·position을 cold-start UX에 미표시(현재 elapsed초만). prod host gateway.nextain.io 설정 미반영(config = run.app).
- **수정 범위**: onmessage에 session.preparing/queued/sold_out/consent_required/error 분기 추가 + closeCodeReason에 4503(transient/pod-starting)·4409(consent) + 재시도 루프(이미 pod-starting 처리) — 웹 #34 diff와 동형. consent(4409) branches UI는 별도 피처.

## §4 구현 완료 (2026-06-02, 사용자 "§4 전체 consent 포함" 승인)
- **naia-omni.ts**: onmessage에 §4 typed 이벤트 분기(session.preparing/queued→pod-starting[+eta/pos], sold_out→sold-out, consent_required→consent-required, session.error→err). 레거시 msg.error wire 유지(둘 다 지원). closeCodeReason +4409 consent. closeCodeMessage: consent + **bare 4503→pod-starting**(retry, error 아님). classifyErrorReason +consent. retry loop: pod-starting 메시지에서 :eta=/:pos= 파싱 → cold-start 상태에 etaSeconds/queuePosition.
- **types.ts**: VoiceCloseReason +consent, error.reason +consent, cold-start phase +etaSeconds?/queuePosition?.
- **ChatPanel.tsx**: voiceFailureMessage/voiceCloseMessage +consent, 배너에 queuePosition·etaSeconds 표시.
- **i18n.ts**: chat.voiceErrorConsent / voiceColdStartQueue / voiceColdStartEta ×14.
- **테스트**: §4 신규 5종(preparing+eta/pos, sold_out, consent_required, bare 4503→cold-start, 4409→consent). 전체 vitest **135 passed**(voice 116 + ChatPanel 19, e2e 4 skip), tsc exit 0.
- **크로스리뷰**: codex+gemini 둘 다 **GO**(4503 retry 정확, 브랜치 순서 안전, eta/pos 파싱 견고, 하위호환 유지, 버그 없음). 비차단 향후정리: eta/pos를 Error.message 인코딩 대신 구조화(웹도 동일 방식이라 보류).

## ⚠️ 설계 갭 — consent branches(replace/add) 인터랙티브 보류 (사용자 결정 필요)
- §4 매뉴얼은 `session.consent_required`에 `branches`(replace/add) 선택을 명시하나, **선택을 게이트웨이로 돌려보내는 송신 프로토콜이 매뉴얼·웹 reference 어디에도 미정의**(웹 #34도 "consent-required"로 표면화만, demo는 생짜 에러). 추측 금지 원칙에 따라 naia-os도 **consent를 전용 상태+메시지로 표면화까지만** 구현, 인터랙티브 replace/add는 **게이트웨이가 송신 wire를 정의한 후** 진행. → 게이트웨이/매뉴얼에 branches 송신 스펙 추가 필요.

## 추가 확인 필요 (마이너)
- prod 엔드포인트 host: 매뉴얼은 `wss://gateway.nextain.io`로 변경, naia-os config(LAB_GATEWAY_URL)는 run.app — ops/배포 결정 사항(코드 미변경).
