# naia-os 음성 상태머신 ↔ 웹(naia.nextain.io) 정렬 — 설계 & 갭 분석 (크로스리뷰용)

## 0. 목표 (사용자 지시)
- naia-os 음성 연결 상태/다국어를 웹 데모(`naia.nextain.io`)와 **의미적으로 동일하게** 맞춘다.
- **설계·추상화를 제대로** 한다. 단순 패치 금지.
- **이전(naia-os) 소스에 흔들리지 말 것** — 웹을 기준으로 깨끗하게 설계. 낡은 패턴을 관성으로 보존하지 않는다.
- 핵심 갭: **4002 superseded**(같은 계정이 다른 기기에서 접속 → 이 기기가 세션 양보, last-wins)가 naia-os에 전혀 없음.

## 1. 두 클라이언트의 공통 불변식 (SoT = gateway wire)
웹과 naia-os는 **동일한 gateway WS 프로토콜**을 공유한다:
- setup 프레임: `{setup:{apiKey, backend:"runpod", locale, instanceId}}`
- application close codes: **4001 = auth**, **4002 = superseded(다른 기기 takeover)**, **4003 = insufficient credits**
- cold-start: `pod-starting` → 지수 백오프 재시도, 10분 cap
- sold-out: 용량 초과

→ 그러므로 "close code → reason" 매핑은 **단일 정본 함수**여야 한다 (현재 naia-os는 4002 누락).

## 2. 현재 상태 (AS-IS)

### 웹 (기준, naia.nextain.io)
- `src/lib/realtime/naia-omni-client.ts`
  - `ConnectionState = idle | connecting | cold-start | active | sold-out | error | closed`
  - `ConnectionDetail = { reason?, elapsedSeconds?, code? }`
  - `closeReason(code)`: 4001→"auth", 4002→"superseded", 4003→"insufficient credits"
  - ws.onclose: **wasActive면 `setState("closed",{code,reason})`** + pre-session이면 `reject(closeReason||"closed (code)")`
  - 단일 채널: 모든 lifecycle이 `onConnectionState(state, detail)` 하나로 흐름
- `src/components/demo/demo-client.tsx` StateBadge: state→라벨 순수 파생
- i18n: `demo.state.{idle,coldStart,active,soldOut,error,closed}` + `demo.errors.{...}` 14개 언어

### naia-os (예전 버전)
- `shell/src/lib/voice/types.ts`
  - `VoiceConnectionStatus = connecting | cold-start{elapsedSeconds,attempt} | active | sold-out{tierAHint?} | error{reason: auth|credits|timeout|unknown, message}`
  - **idle/closed 없음. superseded 없음.**
- `shell/src/lib/voice/naia-omni.ts`
  - `closeCodeToMessage(code)`: 4001/4003만. **4002 누락** → "Connection closed before session ready"
  - `classifyErrorReason(msg)`: 문자열 매칭 auth|credits|timeout|unknown. superseded 없음.
  - emitStatus: connecting / cold-start / sold-out / error 만 emit ("active"는 emit 안 함)
  - **mid-session close (wasConnected)**: `session.onDisconnect?.()` 만 호출 — **code/reason 전달 안 함**(조용히 끊김). pre-session만 reject(closeCodeToMessage).
- `shell/src/components/ChatPanel.tsx`
  - **이중 상태**: `voiceMode: off|connecting|active` (버튼/disabled 구동) + `voiceStatus: VoiceConnectionStatus|null` (배너 구동) — 병렬 관리, ~10곳에서 setVoiceMode 직접 호출
  - `voiceFailureMessage(st, err)`: sold-out/credits/auth/timeout → 메시지. superseded 없음.
  - `onStatusChange`: voiceStatus만 갱신. `onDisconnect`: 인자 없음, cleanup + setVoiceMode("off").
  - 배너: `voiceMode==="connecting" && voiceStatus`일 때만. active 이후엔 배너 없음.
- i18n `shell/src/lib/i18n.ts`: `chat.voice*` (voiceSoldOut/voiceErrorCredits/voiceErrorAuth/voiceErrorTimeout 등). **superseded 없음.**
- 상태 emit은 **naia-omni.ts만**. openai-realtime/gemini-live/vllm-omni는 onStatusChange를 전혀 emit 안 함 → union 변경 blast radius = types + naia-omni + ChatPanel + i18n + 테스트 1개(naia-omni-coldstart.test.ts).

## 3. 갭 요약
| # | 갭 | 영향 |
|---|---|---|
| G1 | close code 4002 미처리 (pre + mid) | 다른 기기 takeover 시 "unknown" 에러 or 조용한 끊김 |
| G2 | mid-session close가 reason 없이 onDisconnect로만 흐름 | superseded/credits-mid-call 구분 불가 |
| G3 | 상태 enum에 idle/closed 없음 | 웹과 lifecycle 비대칭, mid-session 종료 상태 표현 불가 |
| G4 | error reason에 superseded 없음 | pre-session 4002 분류 불가 |
| G5 | i18n superseded 메시지 없음 (14개 언어) | 사용자 안내 불가 |
| G6 | voiceMode/voiceStatus 이중 상태 | 단일 상태머신 추상화 부재 (사용자 "추상화 제대로" 위반) |

## 4. 목표 설계 (TO-BE) — 웹 정렬 + 단일 상태머신 추상화

### 4.1 canonical 타입 (types.ts) — 웹 ConnectionState와 1:1
```ts
// 웹 naia-omni-client.ts ConnectionState 와 1:1 (phase 명칭 동일)
export type VoiceCloseReason =
  | "auth" | "credits" | "superseded" | "normal" | "unknown";

export type VoiceConnectionStatus =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "cold-start"; elapsedSeconds: number; attempt: number }
  | { phase: "active" }
  | { phase: "sold-out"; tierAHint?: string }
  | { phase: "error"; reason: "auth" | "credits" | "timeout" | "superseded" | "unknown"; message: string }
  | { phase: "closed"; code?: number; reason: VoiceCloseReason };
```
- 웹은 (state, detail) 튜플이지만 naia-os는 TS 내로잉이 강한 discriminated union 유지가 더 안전 → phase 명칭을 웹과 동일하게 맞춰 "의미적 동일" 달성. (단순 모방보다 타입안전 우선이 "추상화 제대로"에 부합한다고 판단. 리뷰어 검증 요청)
- `error`(pre-session 터미널 실패)와 `closed`(active였다가 드랍) 을 웹과 동일하게 구분.

### 4.2 단일 close-code 매핑 SoT (naia-omni.ts)
```ts
// SoT — 웹 naia-omni-client.closeReason 미러. 기존 closeCodeToMessage 제거.
function closeCodeReason(code: number): VoiceCloseReason {
  if (code === 4001) return "auth";
  if (code === 4002) return "superseded"; // 같은 계정 다른 기기 takeover (last-wins)
  if (code === 4003) return "credits";
  if (code === 1000) return "normal";     // 정상/사용자 종료
  return "unknown";
}
```
- pre-session close: reject 메시지를 reason 기반으로 생성 → classifyErrorReason이 reason을 그대로 신뢰(또는 reason을 직접 error.reason으로 전파).
- mid-session close(wasConnected): **`emitStatus({phase:"closed", code, reason: closeCodeReason(code)})`** 후 onDisconnect 호출(cleanup). ← G1/G2/G3 해소.

### 4.3 ChatPanel — voiceMode를 voiceStatus에서 파생 (G6)
```ts
// 순수 파생. voiceStatus가 단일 SoT. voiceMode useState 제거.
function phaseToMode(s: VoiceConnectionStatus | null): "off"|"connecting"|"active" {
  if (!s) return "off";
  switch (s.phase) {
    case "connecting": case "cold-start": return "connecting";
    case "active": return "active";
    default: return "off"; // idle/closed/error/sold-out
  }
}
const voiceMode = phaseToMode(voiceStatus);
```
- 기존 `setVoiceMode("off")` ~10곳 → `setVoiceStatus({phase:"idle"})` 또는 적절한 터미널 phase로 치환. `setVoiceMode("active")` → `setVoiceStatus({phase:"active"})`.
- `onStatusChange("closed")` 핸들러: reason이 superseded/credits/auth면 시스템 chat 메시지 1건 추가(데스크톱 UX — 배너는 connecting 전용이므로). normal/unknown이면 silent.
- `voiceFailureMessage`에 superseded 케이스 추가.

### 4.4 i18n (G5) — 신규 키 1개 × 14개 언어
- `chat.voiceErrorSuperseded` = "다른 기기에서 음성 대화를 이어받았어요." / "Voice chat was taken over on another device." (+12개 언어)
- credits/auth mid-session은 기존 `voiceErrorCredits`/`voiceErrorAuth` 재사용.
- 웹 badge 라벨(state.idle/closed 등)은 naia-os UX(배너+chat)가 badge를 안 쓰므로 **과잉 포팅하지 않음** (역방향 "흔들림" 방지). ← 리뷰어 검증 요청.

## 5. 파일별 변경 계획
1. `types.ts`: VoiceConnectionStatus union 교체(idle/closed 추가, error reason에 superseded). VoiceCloseReason 신규.
2. `naia-omni.ts`: closeCodeReason SoT 도입(closeCodeToMessage 제거), classifyErrorReason에 superseded, mid-session close에서 emitStatus("closed") 추가.
3. `ChatPanel.tsx`: voiceMode → phaseToMode 파생, setVoiceMode 호출 치환, onStatusChange("closed") 처리, voiceFailureMessage superseded.
4. `i18n.ts`: voiceErrorSuperseded 14개 언어.
5. `__tests__/naia-omni-coldstart.test.ts` (+ 신규 테스트): 4002 pre/mid 시나리오, phaseToMode 파생, closed emit.

## 6. 단계별 구현 + 검증 (사용자 지시: 단계마다 테스트+크로스리뷰)
- S1 types + naia-omni 상태로직 → vitest(naia-omni-coldstart) + tsc → 크로스리뷰
- S2 ChatPanel 파생/소비 → tsc + 관련 테스트 → 크로스리뷰
- S3 i18n 14개 언어 → tsc + i18n 키 존재 테스트 → 크로스리뷰
- 각 단계 2회 연속 클린 패스까지 반복 리뷰.

## 7. 리뷰어에게 묻는 열린 질문
- Q1. discriminated union 유지(타입안전) vs 웹처럼 (state, detail) 튜플 모방 — 어느 쪽이 "추상화 제대로 + 의미적 동일"에 맞나?
- Q2. mid-session superseded를 chat 메시지로 알리는 게 맞나, 아니면 active 중에도 배너를 띄워야 하나?
- Q3. `closed` reason에 "normal" 포함이 적절한가, 아니면 pre/mid 구분만으로 충분한가?
- Q4. voiceMode useState 완전 제거(순수 파생)가 안전한가 — 놓친 setVoiceMode 경로가 상태 누수를 만들 위험은?
- Q5. 웹 badge 라벨(idle/closed 등) 미포팅 결정이 "의미적 동일"을 해치지 않나?
- Q6. 그 외 빠뜨린 갭 / 설계 결함?

---
## 8. 크로스리뷰 반영 (codex gpt-5.5 + gemini 2.x, 둘 다 GO-WITH-CHANGES)

### 합의된 결정 (Q1-Q6)
- Q1 discriminated union 유지(타입안전) ✓  · Q2 mid-session = system chat 메시지 ✓ · Q3 reason에 "normal" 포함(단 UI suppress) ✓ · Q4 파생 OK but 전 경로 audit 필수 · Q5 badge 라벨 미포팅 ✓ · Q6 provider 연결상태 ≠ UI readiness 구분 유지.

### 크로스리뷰가 잡은 추가 결함 (반드시 반영)
- **[gemini 최우선] 파이프라인 음성 경로(ChatPanel ~L1676)**: `setVoiceMode("active")`만 하고 voiceStatus 미설정. voiceMode를 파생화하면 파이프라인(Vosk/Whisper) 음성이 "connecting"에 영구 고착 → **모든 active 경로가 setVoiceStatus({phase:"active"}) 해야 함**.
- **[codex Q6] active는 mic-gated**: 웹은 session.created에서 active, naia-os는 mic 셋업 성공 후 active(L1995-2014). → **provider(naia-omni)는 "active"를 emit하지 않는다.** ChatPanel이 active 소유.
- **[codex/gemini race] mid-session closed emit→cleanup 경쟁**: onStatusChange로 closed emit 시 phaseToMode(closed)=off가 cleanup 전 버튼 재활성화 → mic/player stale ref 누수·중복 WS. **[gemini thrash]** closed emit 직후 onDisconnect→idle 이중 렌더로 closed 소실.

### 최종 확정 설계 (위 결함 모두 해소)
1. **provider onStatusChange = pre-active 전용**: connecting / cold-start / sold-out / error 만 emit. active·closed 안 함.
2. **mid-session close → onDisconnect 시그니처 변경**: `onDisconnect?: ((info?: { code?: number; reason: VoiceCloseReason }) => void) | null`. naia-omni ws.onclose(wasConnected)에서 `onDisconnect({code, reason: closeCodeReason(code)})` 호출. (onStatusChange로 closed emit 안 함 → race/thrash 원천 제거.)
3. **ChatPanel onDisconnect 핸들러 = 원자적**: (순서) ① bridge detach + mic stop + player destroy + ref null (동기) → ② reason ∈ {superseded,credits,auth} 면 system chat 메시지 1건 → ③ `setVoiceStatus({phase:"closed", code, reason})` 단 1회. 동기 cleanup이 setState보다 먼저 끝나므로 re-render(버튼 enable) 시점엔 이미 정리됨 → race 없음. 단일 최종 setState → thrash 없음.
4. **voiceStatus 단일 SoT** (비-nullable, 초기 `{phase:"idle"}`). `voiceMode = phaseToMode(voiceStatus)` 순수 파생, voiceMode useState 제거.
5. **전 경로 audit/치환** (codex+gemini 지목): setVoiceMode("active") → L1676(파이프라인)·L2011(omni) 둘 다 setVoiceStatus({phase:"active"}). setVoiceMode("off") → 적절히 idle. setVoiceMode("connecting") → connecting.
6. closed reason "normal"/user-initiated → 메시지 없음(silent). superseded/credits/auth → 메시지.

### 단계별(각 단계 vitest+tsc+codex/gemini 크로스리뷰, 2-clean)
- S1 types.ts + naia-omni.ts (union, closeCodeReason SoT, classify superseded, onDisconnect(info), mid-session 호출)
- S2 ChatPanel (phaseToMode 파생, 전 경로 치환, onDisconnect 원자 핸들러, voiceFailureMessage superseded)
- S3 i18n voiceErrorSuperseded 14개 언어
