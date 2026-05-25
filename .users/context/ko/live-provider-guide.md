# 새 Live 음성 프로바이더 추가 가이드

> 기여자를 위한 가이드: Naia에 새로운 실시간 음성 대화 프로바이더를 추가하는 방법.

## 전제조건

- 프로바이더가 WebSocket을 통한 **네이티브 엔드투엔드 음성-음성**을 지원해야 함
- STT+TTS 파이프라인 방식의 프로바이더는 허용되지 않음 (아키텍처 문서의 설계 철학 참조)
- PCM 오디오 입력을 받고 PCM 오디오 출력을 생성해야 함

## 단계별 가이드

### 1. 프로바이더 ID 등록

**파일:** `shell/src/lib/voice/types.ts`

```typescript
// LiveProviderId 유니온에 추가
export type LiveProviderId = "gemini-live" | "openai-realtime" | "moshi" | "your-provider";

// 라벨 추가
export const LIVE_PROVIDER_LABELS: Record<LiveProviderId, string> = {
  "gemini-live": "Gemini Live",
  "openai-realtime": "OpenAI Realtime",
  moshi: "Moshi (Local)",
  "your-provider": "프로바이더 이름",
};
```

### 2. 프로바이더 설정 정의

**파일:** `shell/src/lib/voice/types.ts`

```typescript
export interface YourProviderConfig extends LiveProviderConfigBase {
  provider: "your-provider";
  // 프로바이더별 필드 추가 (API 키, 서버 URL 등)
  apiKey?: string;
}

// 구분 합집합에 추가
export type LiveProviderConfig =
  | GeminiLiveConfig
  | OpenAIRealtimeConfig
  | MoshiConfig
  | YourProviderConfig;
```

### 3. VoiceSession 구현

**파일:** `shell/src/lib/voice/your-provider.ts`

`VoiceSession`을 반환하는 함수를 export하는 파일 생성:

```typescript
import type { VoiceSession, YourProviderConfig, LiveProviderConfig } from "./types";
import { Logger } from "../logger";

export function createYourProviderSession(): VoiceSession {
  let ws: WebSocket | null = null;

  const session: VoiceSession = {
    isConnected: false,

    async connect(config: LiveProviderConfig) {
      const cfg = config as YourProviderConfig;
      // 1. WebSocket 연결 생성
      // 2. 메시지 핸들러 설정
      // 3. 필요시 setup/핸드셰이크 전송
      // 4. 준비 완료 시 isConnected = true 설정
    },

    sendAudio(pcmBase64: string) {
      // 프로바이더에 오디오 전송 (base64 PCM 또는 프로바이더 형식으로 변환)
    },

    sendText(text: string) {
      // 프로바이더가 지원하면 텍스트 입력 전송
    },

    sendToolResponse(callId: string, result: unknown) {
      // 프로바이더가 지원하면 도구 호출 응답 전송
    },

    disconnect() {
      ws?.close();
      ws = null;
      (session as any).isConnected = false;
      session.onDisconnect?.();
    },

    // 이벤트 — null로 설정, ChatPanel이 핸들러를 할당
    onAudio: null,
    onInputTranscript: null,
    onOutputTranscript: null,
    onToolCall: null,
    onTurnEnd: null,
    onInterrupted: null,
    onError: null,
    onDisconnect: null,
  };

  return session;
}
```

**따라야 할 핵심 패턴:**
- 오디오는 항상 인터페이스에서 **base64 인코딩된 PCM**. 프로바이더가 바이너리 프레임을 사용하면 어댑터에서 변환 (`moshi.ts` 참조).
- 프로바이더에서 오디오를 받으면 `session.onAudio?.(base64)` 호출.
- 프로바이더가 턴 완료를 알리면 `session.onTurnEnd?.()` 호출.
- 에러 시 `session.onError?.(new Error(...))` 호출 후 필요시 disconnect.
- 모든 로깅에 `Logger` 사용 (`console.log` 금지).

### 4. 팩토리에 등록

**파일:** `shell/src/lib/voice/index.ts`

```typescript
import { createYourProviderSession } from "./your-provider";

export function createVoiceSession(provider: LiveProviderId): VoiceSession {
  switch (provider) {
    case "gemini-live":
      return createGeminiLiveSession();
    case "openai-realtime":
      return createOpenAIRealtimeSession();
    case "moshi":
      return createMoshiSession();
    case "your-provider":
      return createYourProviderSession();
    default:
      throw new Error(`Unknown live provider: ${provider}`);
  }
}
```

### 5. 설정 필드 추가 (필요시)

**파일:** `shell/src/lib/config.ts` — 프로바이더별 설정 필드 추가 (API 키, 서버 URL 등).

**파일:** `shell/src/lib/secure-store.ts` — 시크릿이 필요하면 `SECRET_KEYS`에 API 키 이름 추가.

**파일:** `shell/src/lib/lab-sync.ts` — Lab에 동기화할 비-시크릿 설정 필드를 `LAB_SYNC_FIELDS`에 추가.

### 6. 설정 UI 추가

**파일:** `shell/src/components/SettingsTab.tsx`

음성 대화 섹션 아래에 조건부 설정 추가 (API 키 입력, 서버 URL 등). 기존 프로바이더와 동일한 패턴 사용.

### 7. ChatPanel 설정 구성 추가

**파일:** `shell/src/components/ChatPanel.tsx`

`handleVoiceToggle()`에서 올바른 `LiveProviderConfig`를 빌드하는 case 추가.

### 8. 테스트 작성

**파일:** `shell/src/lib/voice/__tests__/your-provider.test.ts`

최소 테스트 항목:
- 세션 생성 (올바른 초기 상태의 VoiceSession 반환)
- 연결 흐름 (WebSocket 생성, setup 핸드셰이크)
- 오디오 송수신
- 연결 해제 동작
- 에러 처리

기존 테스트 파일을 패턴으로 참조. 모든 테스트는 mock `WebSocket` global 사용.

### 9. 컨텍스트 업데이트

구현 후 아래 컨텍스트 파일을 업데이트 (삼중 미러):
- `.agents/context/architecture.yaml` → `voice_architecture.live_providers`
- `.users/context/architecture.md` → Voice Architecture 섹션
- `.users/context/ko/architecture.md` → 한국어 미러

## MiniCPM-o via vllm-omni — Voice Cloning 참조

`minicpm-o` 프로바이더는 OpenAI Realtime API (`/v1/realtime`)를
지원하는 자체 호스트 [vllm-omni](https://github.com/vllm-project/vllm-omni)
서버에 연결한다. 두 단계 통합이 main에 머지됨 (2026-04-27):

| 이슈 | 머지된 브랜치 | 추가된 내용 |
|---|---|---|
| `#219` | `issue-219-minicpm-realtime` | 프로바이더를 `/v1/omni`(deprecated)에서 `/v1/realtime`으로 마이그레이션; PCM16 16 kHz in / 24 kHz out; 서버 VAD; 멀티턴 안정성 |
| `#232` | `issue-232-voice-clone` | `MiniCpmOConfig`의 first-class `refAudio` 필드; WAV → 16 kHz mono → base64 인코더; `Invalid ref_audio` 서버 에러 surfacing |

### naia-os에서 연결

```ts
const session = createMiniCpmOSession();
await session.connect({
  provider: "minicpm-o",
  serverUrl: "ws://<naia-omni-host>:8000",  // vllm-omni 직결; 데모 gateway 불필요
  systemInstruction: "...",
  refAudio: <File | Blob | ArrayBuffer | base64 string>,  // 선택, voice clone
  refAudioLanguage: "en",                                  // 선택, 기본 en
});
```

`serverUrl`은 `http(s)://` 또는 `ws(s)://` 양쪽 받아 내부에서
`ws(s)://`로 normalize, `/v1/realtime` 자동 append. naia-os가 Realtime
프로토콜을 직접 사용하므로 Python 데모 gateway는 경로에 없음.

### Voice-clone wire 계약

`refAudio`는 `connect()` 동안 — WebSocket 열기 전에 — 한 번
인코드된다. malformed reference는 connect promise를 reject 시켜서
half-open 세션을 만들지 않음. `shell/src/lib/voice/ref-audio.ts:encodeRefAudio`:

1. `Blob` / `ArrayBuffer` → `AudioContext.decodeAudioData`
2. 멀티채널 → 모노 downmix
3. `OfflineAudioContext`로 16 kHz resample
4. minimal RIFF/WAVE 헤더 + base64

base64 payload가 첫 `session.update`의 `session.ref_audio`로 전송됨.
서버 검증 실패 (malformed base64, > 4 MiB, non-WAVE 바이트)는 Realtime
`error` 이벤트로 돌아옴 (메시지가 `"Invalid ref_audio"`로 시작).
`session.onError`로 surface, 세션 자체는 기본 voice로 유지.

### TLS 주의

vllm-omni는 평문 HTTP/WS (TLS 없음). 외부 접속은 **Tailscale** 권장 —
터널이 이미 암호화돼있어 `ws://<tailscale-ip>:8000` 도 end-to-end
안전. 공개망이면 vllm-omni 앞에 reverse proxy로 TLS 종단 후
naia-os는 `wss://...` 사용.

## 오디오 형식 참조

| 방향 | 형식 | 샘플레이트 | 인코딩 |
|------|------|-----------|--------|
| 마이크 → 프로바이더 | base64 PCM | 16kHz | Int16 mono |
| 프로바이더 → 스피커 | base64 PCM | 24kHz | Int16 mono |

`mic-stream.ts`와 `audio-player.ts`가 캡처/재생을 담당한다. 프로바이더 비의존적이므로 새 프로바이더를 위해 수정하지 말 것.

## AIRI 프로젝트와의 비교

[AIRI](https://github.com/moeru-ai/airi)는 다른 접근 방식을 취한다:

| 측면 | Naia | AIRI |
|------|------|------|
| **음성 아키텍처** | 네이티브 Live API만 (엔드투엔드 음성-음성) | STT + LLM + TTS 파이프라인 |
| **프로바이더 추상화** | 모든 Live 프로바이더에 단일 `VoiceSession` 인터페이스 | 별도의 STT, TTS 프로바이더 생태계 |
| **지원 프로바이더** | Gemini Live, OpenAI Realtime, Moshi | 여러 STT 프로바이더 + 여러 TTS 프로바이더 |
| **지연시간** | 낮음 (~160ms 로컬, ~500ms 클라우드) | 높음 (STT + LLM + TTS 체인) |
| **유연성** | 낮음 (네이티브 Live API 지원 필요) | 높음 (임의의 STT + LLM + TTS 조합) |
| **오픈소스 로컬** | Moshi (풀듀플렉스 네이티브) | Whisper STT + 다양한 로컬 TTS |

Naia는 UX 품질을 위해 의도적으로 네이티브 전용 접근을 선택했다. STT+TTS 파이프라인은 유연성이 높지만, 누적 지연시간과 운율 손실로 인해 대화 경험이 현저히 나빠진다.
