# V2 (음성 대화, UC2) — Old-Baseline + 포트 계약 (2026-06-13)

session_id: ec74cc29-3347-4f6e-b29a-237ea29f301e

> 표준 step1-2(Old-Baseline→계약). 음성 HW 불필요(코드 도출). UC2 = 감각(audio→STT)→지각→사고→표현(음성+avatar).
> ⚠️ 큰 버티컬 = 다중 provider + 세션 상태머신 + STT/TTS 레지스트리. **os-local 이식분 + external(루크머신/gateway) 신규계약** 분해.
> S-rows: S14 omni·S15 gemini-live·S16 openai-realtime(voice provider) / S17 tts / S18 voicewake(OpenClaw 잔재 미검증) / S19 avatar VRM / S49 STT 모델관리 / S50 audio output device.

---

## §A. Old-Baseline (코드 도출, old-naia-os/shell/src/lib)

### A.1 감각 입력 (audio→STT)
| 기능 | 소스 | 거동 | 구분 |
|---|---|---|---|
| mic 캡처 | `mic-stream.ts createMicStream` → `MicStream{start,stop}`, opts `{onChunk(base64Pcm), sampleRate=16000, bufferSize=4096, autoGainControl}` | getUserMedia PCM 캡처 → base64 chunk emit. echoCancellation 상시 on. | **os-local** ⚠️ getUserMedia=F2 startup-block 원인, lazy 필수 |
| STT | `stt/{registry,types,api-stt,web-speech-stt}` — `SttSession{start,stop}`, `SttEngineType= tauri\|api\|web\|vllm`, SttResult/ProviderMeta/ModelMeta | engine별 전사. web/tauri=로컬, api/vllm=외부 | **혼합**: web/tauri os-local, api/vllm external |
| STT 모델관리(S49) | stt download/delete/list (tauri 명령) | 로컬 모델 파일 관리 | **os-local** |

### A.2 표현 출력 (음성+avatar)
| 기능 | 소스 | 거동 | 구분 |
|---|---|---|---|
| 오디오 재생 | `audio-player.ts createAudioPlayer` → `AudioPlayer{enqueue(base64Pcm),clear,destroy,isPlaying}`, opts `{sampleRate,onPlaybackStart,onPlaybackEnd}` | PCM chunk 큐 재생 + drain margin | **os-local** |
| TTS | `tts/{registry,types,cost}` — TtsProviderMeta/VoiceMeta | 텍스트→음성 | **혼합**: 로컬/cloud |
| audio output device(S50) | `list_audio_output_devices` | 출력장치 목록 | **os-local** (F1 에서 이미 이식) |
| avatar 표현(S19) | AvatarCanvas(VRM) ExpressionPort | emote/lip-sync 렌더 | **os-local** (WebGL) |

### A.3 라이브 음성 세션 (realtime provider)
| 기능 | 소스 | 거동 | 구분 |
|---|---|---|---|
| VoiceSession | `voice/types.ts VoiceSession` {audioInput, connect(config), sendAudio, sendText, sendToolResponse, sendContextUpdate?, setRefAudioUrl?, ...} | WS realtime 세션, cold-start 인지(VoiceConnectionStatus) | **external** (WS→provider/gateway) |
| providers | `voice/{gemini-live,openai-realtime,naia-omni,vllm-omni}` — LiveProviderConfig 유형별 | gemini-live/openai-realtime/naia-omni/vllm-omni | **external**(루크머신/gateway, 키 필요) |
| 음색 클론 | setRefAudioUrl/ref_audio(base64) | mid-session 음색 전환(naia local=무과금 컨테이너 직송) | **external** |

### A.4 오류/cold-start
- VoiceConnectionStatus: connecting / cold-start(pod-starting 재시도 backoff) / sold-out / error / active. VoiceCloseInfo. = 정직 상태 보고(오보 금지, FR-F1.1 연속).

---

## §B. 포트 계약 (헥사고날, substrate-agnostic — 안드로이드 대비 host-neutral)

```
SensoryPort (감각 입력):
  startMicCapture(opts): MicCapture{stop}        # os-local getUserMedia(⚠️lazy) → onChunk(pcm)
  transcribe(audio): SttResult | Unsupported     # 혼합: web/tauri 로컬, api/vllm=external
  sttModels(): SttModelMeta[] / download/delete   # os-local 모델관리(S49)
ExpressionPort (표현 출력):
  play(pcmChunk): void / clear() / stop()        # os-local AudioPlayer
  synthesize(text, voice): audio | Unsupported   # 혼합 TTS
  express(emote): void                           # os-local avatar(VRM, S19)
  outputDevices(): DeviceStatus[]                # os-local(F1 list_audio_output_devices 재사용)
VoiceProviderPort (라이브 realtime — external):
  connect(providerConfig): VoiceSession          # WS gemini-live/openai-realtime/naia-omni/vllm-omni
  sendAudio/sendText/sendToolResponse / setRefAudioUrl?
  status(): VoiceConnectionStatus                # cold-start/sold-out/error 정직
```
- 도메인(순수): VoiceConnectionStatus 전이 규칙, audioInput 요구(echo-gate), 정직 상태 판정. I/O 0.
- 포트는 **transport/provider 무지**(어댑터가 WS/getUserMedia/Tauri). substrate-agnostic.

## §C. os-local vs external 분해 (개발 순서)
1. **os-local 이식분 (autonomously, 음성HW 없이 단위/parity 가능)**: AudioPlayer(play/clear/stop) + MicCapture 어댑터(⚠️ getUserMedia lazy — startup 미접촉, F2 교훈) + STT 모델관리(S49 tauri) + outputDevices(F1 재사용) + avatar express 포트. **단, 실제 audio 입출력 라이브 검증 = 루크 머신.**
2. **external = 신규 계약 (GOAL ⑥)**: 
   - **gRPC Voice surface** (os↔agent): 라이브 음성을 gRPC 로 — 현재 Chat RPC 에 audio 미포함. 신규 RPC(VoiceStream: audio in/out 양방향 stream) 또는 Chat 확장. = agent gRPC 계약 추가.
   - **provider WS**(gemini-live/openai-realtime/naia-omni/vllm-omni) + api/vllm STT + cloud TTS = 외부 키/서버. 루크 머신 baseline.
3. **Luke-machine 게이트**: 실제 mic→STT→chat→TTS→speaker 왕복 + 음색클론 = voice/GPU/키 필요.

## §D. 리뷰 표준 (UC2 적용)
T2(외부연결+장치). open-loop 2-AI(정본=old voice 소스). 집중: getUserMedia lazy(startup 무블록), 정직 상태(cold-start 오보 금지), 음색클론 프라이버시(naia local=컨테이너 직송 무과금), provider 키 누출.

## §C-bis. 이식 슬라이스 범위 (2026-06-13 리뷰 정합)
- **이식 완료(이번 슬라이스)**: domain/voice.ts(VoiceConnectionStatus) + ports/v2.ts(Sensory/Expression/VoiceProvider) + adapters/tauri/v2.ts(makeV2Expression: play/clearAudio/synthesize/express; makeV2Sensory: startMicCapture[getUserMedia lazy]/transcribe). 2-AI 리뷰: BLOCKER 0(startup-block 불변 = type-only import + lazy device, 검증), 정직(Unsupported)·parity·직교 PASS.
- **deferred(다음 슬라이스, 계약엔 있으나 이번 미구현 — 정직 표기)**: `ExpressionPort.stop()`, `SensoryPort.sttModels()/download/delete`(S49 STT 모델관리), `outputDevices()`(S50 — F1 list_audio_output_devices 재사용). + VoiceProviderPort 라이브(external).

## §E. 다음 (V2 개발)
1. 이 계약 2-AI 리뷰(scope/parity) → 2. os-local 어댑터 이식(AudioPlayer 먼저=HW 의존 적음) + drift-gate → 3. 2-AI 리뷰 → 4. 커밋. external(gRPC Voice RPC + providers) = 신규계약 별도 + 루크머신.
> ⚠️ MicCapture getUserMedia 는 F2 startup-block(navigator.mediaDevices stall) 재발 위험 — 기동 미접촉, 음성 활성 시에만 lazy. UC2 이식 시 GstIntRange 장치회피/timeout-bound.
