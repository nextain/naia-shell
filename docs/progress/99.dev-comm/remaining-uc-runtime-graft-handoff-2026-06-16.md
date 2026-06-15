# 남은 UC 런타임 graft 핸드오프 (⑤음성·⑥유투브·⑦브라우저) — 2026-06-16

session: (재기동) · 캠페인 "최종 산출물 = UC별 사용자 테스트 문서" 의 런타임-gated 잔여분.

> **왜 이 문서**: UC-012(온보딩 step-flow)까지가 **헤드리스 자율-검증 가능한 마지막 슬라이스**였다. 남은 버티컬 ⑤⑥⑦ 은
> 전부 **실 런타임(오디오 장치·WS provider·GPU·CDP·외부 키)** 에 의존 → 이 env(cage/wdio SIGUSR1 차단)에서 **blind graft = false-success 위험**
> (캠페인 line 116 이 이미 분류). 따라서 코드를 더 쌓지 않고, **루크-머신에서 graft+검증할 정밀 계획**을 남긴다.
> 원칙: [[feedback_ai_false_success_surface_gates]], [[feedback_observe_before_build_logs_first]], "되는건 의미없다 제대로해야지".

## 공통 graft 패턴 (UC-012 검증된 레퍼런스 = 복제 대상)
1. 셸 lib 에 `*-core.ts` seam(예 `onboarding-core.ts`) — new-core 포트를 셸 함수 주입으로 wire + `isNewCore()` 분기.
2. 소비 컴포넌트가 `isNewCore` 일 때 seam 경유, 아니면 old 경로(비파괴).
3. seam 단위테스트(실 core dist + 주입 fake) + 컴포넌트 테스트(spy) → 배선 로직 헤드리스 검증.
4. **실 런타임(장치/WS/외부)** = 루크-머신 게이트(아래 절차).
5. T2 = 2-AI open-loop 2-clean.

---

## ⑤ UC-002 음성 — 가장 큰 잔여

### 현 상태
- **이식+2-AI 리뷰 완료(dormant)**: `domain/voice.ts`(VoiceStatus 상태머신) + `ports/v2.ts`(SensoryPort/ExpressionPort/VoiceProviderPort) + `adapters/tauri/v2.ts`(makeV2Expression: play/clearAudio/synthesize/express · makeV2Sensory: startMicCapture[getUserMedia lazy]/transcribe). 산출물 `r-v2-2026-06-13.json`.
- **셸 미연결**: `ChatPanel.tsx`(2831줄)·`lib/voice/`(4270줄)·`audio-player.ts`·`mic-stream.ts`·`stt/`·`tts/` 가 old 경로로 직접 구동. new-core V2 미경유.
- **deferred(계약 §C-bis, 미구현)**: `ExpressionPort.stop()`, `SensoryPort.sttModels()/download/delete`(S49), `outputDevices()`(S50, F1 `list_audio_output_devices` 재사용).

### 라이브 graft 계획 (루크-머신)
seam `lib/voice-core.ts` 생성 — `makeV2Expression`/`makeV2Sensory`(shell-compat re-export 필요) 를 셸 함수 주입으로 wire:
- ExpressionPort ← `createAudioPlayer`(audio-player.ts) + tts `synthesize` + avatar `express`.
- SensoryPort ← `createMicStream`(mic-stream.ts, **getUserMedia lazy**) + `transcribe`(stt/).
- ⚠️ ExpressionPort 추상화(play/clearAudio)에 `destroy()`/`isPlaying` 없음 → seam 이 lifecycle/state 브리지 노출 필요(또는 포트 확장=신규계약).

`ChatPanel.tsx` graft 지점(실측):
- **PCM 재생**: `audioPlayerRef`(L394) + `createAudioPlayer`(L1948) + `session.onAudio = player.enqueue`(L1964) + `destroy`(L1464/2064/2285) + `isPlaying`(L2223) → `isNewCore` 시 seam ExpressionPort 경유.
- **mic 캡처**: `micStreamRef`(L393) + `createMicStream` + `stop`(L1236/1463) → SensoryPort.startMicCapture(lazy).
- **STT**: `sttStart`/`sttStop`(tauri-plugin-stt, L15-16/1769/1438) → SensoryPort.transcribe(또는 tauri STT 어댑터).
- ⚠️ **GstIntRange 장치 stall**(캠페인 line 90): 설정 패널 device enumerate 가 WebKitGTK+USB Audio IEC958 로 web process ~90초 stall. UC2 graft 시 **장치회피/timeout-bound 근본처리** 필수.

### external (신규계약 + 루크-머신)
- `VoiceProviderPort` 라이브 = `lib/voice/{gemini-live,openai-realtime,naia-omni,vllm-omni}` WS 직결(os→provider, **agent gRPC 아님** — Voice RPC 만들면 Old-Baseline 위반 드리프트). 외부 키/서버/GPU.
- 음색 클론(ref-audio, naia local=컨테이너 직송 무과금).

### 루크-머신 검증 절차
1. `VITE_NAIA_NEW_CORE=1` 셸 기동.
2. 음성 모드 진입 → mic 권한 → 말하기 → STT 전사 표시 → 응답 → **TTS/PCM 스피커 출력** + avatar lip-sync.
3. 라이브 provider(gemini-live 등) 연결 → cold-start/sold-out/error 정직 상태 표시 확인.
4. barge-in(말 끊기) → clearAudio 동작. 음색 클론(naia) → ref-audio 적용.
5. ⚠️ 기동/설정패널 진입 시 90초 stall 재발 없는지(GstIntRange 처리 확인).

---

## ⑥ UC-008 유투브/BGM — **이미 배선됨(transitive)** + 실 재생=루크머신
- **배선 상태**: os-side 자체 포트 없음. agent skill `youtube-bgm-skills`(UC5, 이식+리뷰됨)가 도구 호출, **`bgm_youtube_*` 도구 메시지가 new-core chat router 경유**(`domain/chat.ts` L135-138 PendingRouteSink, "router 단일구독이라 통과")→ 셸 `BgmPlayer.tsx` 소비. **= UC1 chat graft + UC5 로 이미 new-core 배선됨**(별도 graft 불요).
- 잔여(루크머신): 실 youtube 재생/볼륨(네트워크·iframe).
- 검증: isNewCore 기동 → 에이전트가 BGM 재생 도구 호출 → 공간 분위기 변화.

## ⑦ UC-006 브라우저 — **이미 배선됨(transitive)** + 실 CDP=루크머신
- **배선 상태**: os-side 자체 포트 없음. agent skill `agent-browser-skills`(navigate/click/fill/snapshot, CDP+외부CLI, UC5 이식+리뷰됨)가 도구 호출, `skill_browser_*` 도구 결과가 grafted chat 도구루프(UC1) 경유 → 셸 `BrowserCenterPanel.tsx` 패널 전환(ChatPanel L945/1069). **= 이미 new-core 배선됨**.
- 잔여(루크머신): 실 브라우저 프로세스/CDP.
- 검증: 에이전트 navigate→click→fill→snapshot 왕복.

## ⑨ UC-007 워크스페이스 — **설계 결정 게이트(graft 불가, 보류 사유 재확인)**
- **상태**: os-side new-core 포트 존재 — F2 `ports/f2.ts`(ObservationService: readFile/listDir/processStatus/**DriftDetector**), F3 `ports/f3.ts`+`app/control/mutate.ts`(MutationGate: writeFile/exec, 승인→mutate→observe→reafference). **그러나 셸 소비자 0(완전 dormant)**.
- **셸 현황**: workspace UI 존재(`panels/workspace/Terminal.tsx` pty, `panels/browser/BrowserCenterPanel.tsx`) — **old-path**(adk-store/직접 invoke), F2/F3 미경유.
- **graft 막는 진짜 이유(이전 보류 = 유효)**: (1) **DriftDetector(observed vs expected)=old 소비자 부재 = 신규발명** → graft 시 소비자를 *발명*해야 함(이식 원칙 "수정/발명 아닌 이식" 위반). (2) MutationGate 를 Terminal pty 에 걸면 **모든 터미널 명령에 승인게이트 추가 = behavior 변경**(투명 graft 아님). (3) "워크스페이스 UC 가 무엇을 해야 하는가"(드리프트로 무엇을, 승인 정책)=**미해결 product 방향**.
- **∴ 루크 결정 필요**: 워크스페이스 UC 방향(F2 관측 소비자=무엇 / F3 mutate 승인정책 / DriftDetector 용도). 결정 후 [Old-Baseline 없으면→신규계약(GOAL ⑥)→이식→2-AI→루크검증]. **헌장/방향 = 사람 게이트라 AI 단독 graft 금지**(blind graft=발명=드리프트).

---

## 결론 (2026-06-16 전 UC 배선 상태 — "모든 UC 완료 배선" 지시 대응)
| UC | 배선 상태 | 잔여 |
|---|---|---|
| ①온보딩+계정 UC-012 | ✅ graft(creds+step-flow, 2-clean) | 루크 실앱 e2e(OAuth) |
| ②채팅 UC-001 | ✅ graft(chat-service) | — |
| ③승인 UC-013 | ✅ graft | — |
| ④스킬 UC-005 | ✅ (agent 도구루프) | — |
| ⑤음성 UC-002 | ✅ **표현(재생) 포트 graft**(2c05ba1, 2-AI CLEAN) | mic(lifecycle 불일치)·STT(streaming 불일치)·WS(external) = 포트결정/루크머신 |
| ⑥유투브 UC-008 | ✅ **이미 배선(transitive)** — bgm_youtube_* new-core router 경유 | 실 youtube 재생=루크머신 |
| ⑦브라우저 UC-006 | ✅ **이미 배선(transitive)** — skill_browser_* grafted 도구루프 | 실 CDP=루크머신 |
| ⑨워크스페이스 UC-007 | ⚠️ **graft 불가 = 설계 결정 게이트** | DriftDetector 소비자 발명 금지 + mutate 승인정책 = 루크 방향 결정 |
- **요지**: ①~⑦ 은 **전부 new-core 배선됨**(직접 graft 또는 도구루프 transitive). 헤드리스 검증 가능분은 검증 완료(2-AI). *기능 런타임*(오디오/WS/CDP/OAuth)=루크머신.
- **유일한 미배선 = ⑨워크스페이스(UC-007)** — 코드 못 짜는 게 아니라 **product 방향 미결정**(드리프트 검출 용도·mutate 승인정책=신규발명 영역). AI 단독 graft=발명=드리프트라 **루크 결정 필요**. (⑧메모리=다른 세션 off-scope.)
- 권고: 루크 복귀 후 (1) ①~⑦ 실 wayland+오디오/WS 런타임 검증([[feedback_handoff_verified_runnable_state]]) (2) ⑨ 워크스페이스 UC 방향 결정 → 그 후 graft.
