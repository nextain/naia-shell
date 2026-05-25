# Adding a New Live Voice Provider

> Guide for contributors who want to add a new real-time voice conversation provider to Naia.

## Prerequisites

- The provider must support **native end-to-end speech-to-speech** via WebSocket
- STT+TTS pipeline providers are NOT accepted (see design philosophy in architecture docs)
- The provider must accept PCM audio input and produce PCM audio output

## Step-by-Step

### 1. Register the Provider ID

**File:** `shell/src/lib/voice/types.ts`

```typescript
// Add to LiveProviderId union
export type LiveProviderId = "gemini-live" | "openai-realtime" | "moshi" | "your-provider";

// Add label
export const LIVE_PROVIDER_LABELS: Record<LiveProviderId, string> = {
  "gemini-live": "Gemini Live",
  "openai-realtime": "OpenAI Realtime",
  moshi: "Moshi (Local)",
  "your-provider": "Your Provider Name",
};
```

### 2. Define the Provider Config

**File:** `shell/src/lib/voice/types.ts`

```typescript
export interface YourProviderConfig extends LiveProviderConfigBase {
  provider: "your-provider";
  // Add provider-specific fields (API key, server URL, etc.)
  apiKey?: string;
}

// Add to discriminated union
export type LiveProviderConfig =
  | GeminiLiveConfig
  | OpenAIRealtimeConfig
  | MoshiConfig
  | YourProviderConfig;
```

### 3. Implement VoiceSession

**File:** `shell/src/lib/voice/your-provider.ts`

Create a file that exports a function returning `VoiceSession`:

```typescript
import type { VoiceSession, YourProviderConfig, LiveProviderConfig } from "./types";
import { Logger } from "../logger";

export function createYourProviderSession(): VoiceSession {
  let ws: WebSocket | null = null;

  const session: VoiceSession = {
    isConnected: false,

    async connect(config: LiveProviderConfig) {
      const cfg = config as YourProviderConfig;
      // 1. Create WebSocket connection
      // 2. Set up message handlers
      // 3. Send setup/handshake if needed
      // 4. Set isConnected = true when ready
    },

    sendAudio(pcmBase64: string) {
      // Send audio to provider (base64 PCM or convert to provider's format)
    },

    sendText(text: string) {
      // Send text input if provider supports it
    },

    sendToolResponse(callId: string, result: unknown) {
      // Send tool call response if provider supports it
    },

    disconnect() {
      ws?.close();
      ws = null;
      (session as any).isConnected = false;
      session.onDisconnect?.();
    },

    // Events — set to null, ChatPanel will assign handlers
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

**Key patterns to follow:**
- Audio is always **base64-encoded PCM** in our interface. If the provider uses binary frames, convert in your adapter (see `moshi.ts` for example).
- Call `session.onAudio?.(base64)` when receiving audio from the provider.
- Call `session.onTurnEnd?.()` when the provider signals turn completion.
- Call `session.onError?.(new Error(...))` on errors, then optionally disconnect.
- Use `Logger` (not `console.log`) for all logging.

### 4. Register in Factory

**File:** `shell/src/lib/voice/index.ts`

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

### 5. Add Config Fields (if needed)

**File:** `shell/src/lib/config.ts` — Add provider-specific config fields (API keys, server URLs).

**File:** `shell/src/lib/secure-store.ts` — Add API key names to `SECRET_KEYS` if the provider requires secrets.

**File:** `shell/src/lib/lab-sync.ts` — Add non-secret config fields to `LAB_SYNC_FIELDS` if they should sync to Lab.

### 6. Add Settings UI

**File:** `shell/src/components/SettingsTab.tsx`

Add conditional settings (API key input, server URL, etc.) under the Voice Conversation section, similar to existing providers.

### 7. Add ChatPanel Config Building

**File:** `shell/src/components/ChatPanel.tsx`

In `handleVoiceToggle()`, add a case for your provider to build the correct `LiveProviderConfig`.

### 8. Write Tests

**File:** `shell/src/lib/voice/__tests__/your-provider.test.ts`

Test at minimum:
- Session creation (returns VoiceSession with correct initial state)
- Connect flow (WebSocket creation, setup handshake)
- Audio sending/receiving
- Disconnect behavior
- Error handling

See existing test files for patterns. All tests use a mock `WebSocket` global.

### 9. Update Context

After implementation, update these context files (triple mirror):
- `.agents/context/architecture.yaml` → `voice_architecture.live_providers`
- `.users/context/architecture.md` → Voice Architecture section
- `.users/context/ko/architecture.md` → Korean mirror

## MiniCPM-o via vllm-omni — Voice Cloning Reference

The `minicpm-o` provider connects to a self-hosted
[vllm-omni](https://github.com/vllm-project/vllm-omni) server speaking
the OpenAI Realtime API (`/v1/realtime`). Two integration milestones
landed on `main` (2026-04-27):

| Issue | Branch (merged) | What it added |
|---|---|---|
| `#219` | `issue-219-minicpm-realtime` | Migrate provider from `/v1/omni` (deprecated) to `/v1/realtime`; PCM16 16 kHz in / 24 kHz out; server VAD; multi-turn stability |
| `#232` | `issue-232-voice-clone` | First-class `refAudio` field on `MiniCpmOConfig`; WAV → 16 kHz mono → base64 encoder; `Invalid ref_audio` server-error surfacing |

### Connecting from naia-os

```ts
const session = createMiniCpmOSession();
await session.connect({
  provider: "minicpm-o",
  serverUrl: "ws://<naia-omni-host>:8000",  // direct to vllm-omni; no demo gateway needed
  systemInstruction: "...",
  refAudio: <File | Blob | ArrayBuffer | base64 string>,  // optional voice clone
  refAudioLanguage: "en",                                  // optional, defaults to en
});
```

`serverUrl` accepts `http(s)://` or `ws(s)://` — it's normalised to
`ws(s)://` and `/v1/realtime` is appended internally. naia-os speaks
the Realtime protocol directly; the Python demo gateway is not in the
path.

### Voice-clone wire contract

`refAudio` is encoded once during `connect()` — before the WebSocket
opens — so a malformed reference fails the connect promise rather than
producing a half-open session. `shell/src/lib/voice/ref-audio.ts:encodeRefAudio`:

1. `Blob` / `ArrayBuffer` → `AudioContext.decodeAudioData`
2. Multi-channel → mono downmix
3. `OfflineAudioContext` resample to 16 kHz
4. Minimal RIFF/WAVE header + base64

The base64 payload travels on the first `session.update` as
`session.ref_audio`. Server validation failures (malformed base64,
oversize > 4 MiB, non-WAVE bytes) come back as a Realtime `error`
event whose message starts with `"Invalid ref_audio"` and surface
through `session.onError`. The session itself keeps running on the
default voice.

### TLS note

vllm-omni serves plain HTTP/WS (no TLS). For external access prefer
**Tailscale** — the tunnel is already encrypted, so
`ws://<tailscale-ip>:8000` is safe end-to-end. On a public network,
terminate TLS in front of vllm-omni with a reverse proxy and point
naia-os at `wss://...`.

## Audio Format Reference

| Direction | Format | Sample Rate | Encoding |
|-----------|--------|-------------|----------|
| Mic → Provider | base64 PCM | 16kHz | Int16 mono |
| Provider → Speaker | base64 PCM | 24kHz | Int16 mono |

`mic-stream.ts` and `audio-player.ts` handle capture/playback. They are provider-agnostic — do NOT modify them for a new provider.

## Comparison with AIRI Project

[AIRI](https://github.com/moeru-ai/airi) takes a different approach:

| Aspect | Naia | AIRI |
|--------|------|------|
| **Voice architecture** | Native Live API only (end-to-end speech-to-speech) | STT + LLM + TTS pipeline |
| **Provider abstraction** | Single `VoiceSession` interface for all Live providers | Separate STT and TTS provider ecosystems |
| **Supported providers** | Gemini Live, OpenAI Realtime, Moshi | Multiple STT providers + multiple TTS providers |
| **Latency** | Low (~160ms local, ~500ms cloud) | Higher (STT + LLM + TTS chain) |
| **Flexibility** | Lower (requires native Live API support) | Higher (any STT + any LLM + any TTS) |
| **Open-source local** | Moshi (full-duplex native) | Whisper STT + various local TTS |

Naia deliberately chose the native-only approach for UX quality. The STT+TTS pipeline, while more flexible, produces noticeably worse conversational experience due to accumulated latency and loss of prosody.
