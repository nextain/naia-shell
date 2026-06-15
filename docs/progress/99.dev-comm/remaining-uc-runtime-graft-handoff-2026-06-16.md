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

## ⑥ UC-008 유투브/BGM — external runtime
- 셸: `components/BgmPlayer.tsx` + youtube search/play/volume(WS/iframe). agent skill `youtube-bgm-skills`(이식+리뷰됨).
- graft: BGM 제어를 agent skill 경유(도구루프 UC5 패턴). 실 youtube 재생/볼륨 = 루크-머신(네트워크·재생).
- 검증: BGM 검색→재생→볼륨 제어가 실제 공간 분위기로 동작.

## ⑦ UC-006 브라우저 — external runtime
- agent skill `agent-browser-skills`(navigate/click/fill/snapshot, CDP + 외부 CLI, 이식+리뷰됨).
- graft: 셸 트리거 → agent 도구루프 → CDP. 실 브라우저 프로세스 = 루크-머신.
- 검증: navigate→click→fill→snapshot 왕복.

---

## 결론
- 남은 ⑤⑥⑦ = **런타임/external 게이트** — 헤드리스 자율-검증 슬라이스 없음(UC-012가 마지막). 코드의 *배선 로직*은 위 패턴으로 헤드리스 검증 가능하나, *기능*(오디오/WS/CDP)은 루크-머신.
- **권고**: 루크 복귀 후 ⑤ 음성부터 위 graft 계획대로 실 wayland+오디오에서 진행(기동 검증=[[feedback_handoff_verified_runnable_state]], 실UI 통합테스트=[[feedback_integration_test_drive_real_ui]]). 각 = Old-Baseline→계약→이식→drift-gate→2-AI 2-clean→루크 실앱 검증.
- 이미 완료(이식+리뷰+dormant): V2 os-local 어댑터·UC5 도구루프·UC6/8 agent skill·provider-provenance. **연결(graft)+런타임만 잔여.**
