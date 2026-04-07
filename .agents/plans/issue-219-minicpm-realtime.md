# Plan: Issue #219 u2014 minicpm-o.ts /v1/realtime uc804ud658

## ubaa9uc801
`minicpm-o.ts`ub97c `/v1/omni` ub3c5uc790 ud504ub85cud1a0ucf5cuc5d0uc11c OpenAI Realtime API ud45cuc900 `/v1/realtime`uc73cub85c uc804ud658.

## ubd84uc11d uc694uc57d

### ud604uc7ac ud504ub85cud1a0ucf5c (`/v1/omni`)

**Client u2192 Server:**
- `{type: "session.config", model: ..., system: ...}` u2014 JSON
- binary PCM16 ud504ub808uc784ub4e4
- `{type: "input.done"}` u2014 JSON

**Server u2192 Client:**
- `{type: "turn.start"}`
- `{type: "transcript.delta", text: "..."}`
- `{type: "audio.start", format: "wav_chunk", sample_rate: 24000}`
- binary WAV uccadud06cub4e4
- `{type: "audio.done", total_bytes: N}`
- `{type: "turn.done"}`

### ubaa9ud45c ud504ub85cud1a0ucf5c (`/v1/realtime` OpenAI Realtime API)

**Client u2192 Server:**
- `{type: "session.update", model: ..., system_prompt: ...}` u2014 uc5f0uacb0 uc9c1ud6c4
- `{type: "input_audio_buffer.append", audio: "base64 PCM16"}` u2014 VAD ubc1cud654 uc911 uc138uadf8uba3cud2b8 uc804uc1a1
- `{type: "response.cancel"}` u2014 uc778ud130ub7fdud2b8 uc2dc

**Server u2192 Client:**
- `{type: "session.created"}` u2014 ud578ub4dcuc168uc774ud06c
- `{type: "response.created"}`
- `{type: "response.audio_transcript.delta", delta: "..."}` u2014 ud14duc2a4ud2b8
- `{type: "response.audio.delta", delta: "base64 PCM16"}` u2014 uc624ub514uc624
- `{type: "response.audio.done"}`
- `{type: "response.audio_transcript.done", transcript: "..."}`
- `{type: "response.done"}`
- `{type: "response.cancelled"}` u2014 uc778ud130ub7fdud2b8
- `{type: "input_audio_buffer.speech_started"}` u2014 uc11cubc84 VAD ubc1cud654 uc2dcuc791 uac10uc9c0 (Serveru2192Client, OpenAI uc2a4ud399)
- `{type: "input_audio_buffer.speech_stopped"}` u2014 uc11cubc84 VAD ubc1cud654 uc885ub8cc uac10uc9c0 (Serveru2192Client, OpenAI uc2a4ud399)
- `{type: "error", error: "..."}` u2014 uc5d0ub7ec

> **uc544ud0a4ud14duc3b2 uc8fcuc758**: Naiaub294 ud074ub77cuc774uc5b8ud2b8 uce21 Silero VADub97c uc0acuc6a9. uc11cubc84ub294 speech_started/stoppedub97c ud074ub77cuc774uc5b8ud2b8uc5d0 uc54cub9acuc9c0ub9cc, Naiaub294 uc774 uc774ubca4ud2b8ub97c uc11cubc84uc5d0 ubcf4ub0b4uc9c0 uc54aub294ub2e4. uc11cubc84 VAD ube44ud65cuc131ud654ub294 uc774uc288 #6uc5d0uc11c ubcc4ub3c4 ucc98ub9ac.

## ubcc0uacbd ubc94uc704 ubd84uc11d

| ud56dubaa9 | ud604uc7ac | ubcc0uacbd ud6c4 | uc601ud5a5 |
|------|------|--------|------|
| **uc5d4ub4dcud3ecuc778ud2b8** | `${base}/v1/omni` | `${base}/v1/realtime` | ub2e8uc21c ubb38uc790uc5f4 ubcc0uacbd |
| **ud578ub4dcuc178uc774ud06c** | uc5c6uc74c (uc11cubc84 ack uc5c6uc74c) | `session.created` uc218uc2e0 ud6c4 uc644ub8cc | connect() Promise ubcc0uacbd |
| **uc124uc815 uc804uc1a1** | `session.config` | `session.update` | ud0c0uc785uba85 uc218uc815 |
| **uc624ub514uc624 uc804uc1a1** | binary PCM16 | base64 JSON | flushAudio() uc804uba74 uc218uc815 |
| **uc2e0ud638** | `input.done` | `input_audio_buffer.append` (VAD uc138uadf8uba3cud2b8 uc644uc131 uc2dc) | flushAudio() ub85cuc9c1 uc804ub9c8 |
| **uc624ub514uc624 uc218uc2e0** | binary WAV ucad0ud06c | base64 PCM16 delta | handleAudioChunk u2192 handleMessage |
| **ud14duc2a4ud2b8 uc218uc2e0** | `transcript.delta` | `response.audio_transcript.delta` | handleMessage ucf54ub4dc |
| **ud134 uc885ub8cc** | `turn.done` | `response.done` | handleMessage ucf54ub4dc |
| **uc778ud130ub7fdud2b8** | uc5c6uc74c | `response.cancel` uc804uc1a1 + `response.cancelled` uc218uc2e0 | uc2e0uaddc |

## uc791uc5c5 uacc4ud68d

### Step 1: uc5d4ub4dcud3ecuc778ud2b8 ubcc0uacbd
```typescript
// AS-IS
const wsUrl = `${base}/v1/omni`;
// TO-BE
const wsUrl = `${base}/v1/realtime`;
```

### Step 2: connect() ud578ub4dcuc178uc774ud06c uc218uc815
```typescript
// AS-IS: ws.onopen uc5d0uc11c uc989uc2dc resolve()
// TO-BE: session.created uc218uc2e0 ud6c4 resolve()

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "session.created" && !connected) {
        connected = true;
        // session.update uc804uc1a1
        ws.send(JSON.stringify({
            type: "session.update",
            model: cfg.model,
            system_prompt: cfg.system ?? undefined,
        }));
        resolve();
        return;
    }
    handleMessage(msg);
};
```

### Step 3: flushAudio() uc218uc815
```typescript
async function flushAudio() {
    // ubcc0uacbd: binary uc804uc1a1 u2192 JSON base64 uc804uc1a1
    if (!ws || !pcmBuffer.length) return;
    
    const totalSamples = pcmBuffer.reduce((sum, b) => sum + b.length, 0);
    if (totalSamples < MIN_AUDIO_SAMPLES) {
        pcmBuffer = [];
        return;
    }
    
    // ud1b5ud569 PCM16 ubc84ud37c
    const merged = new Int16Array(totalSamples);
    let offset = 0;
    for (const chunk of pcmBuffer) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    pcmBuffer = [];
    
    // AS-IS: ws.send(merged.buffer)  u2190 binary
    // TO-BE: JSON base64 uc804uc1a1 (append ub9cc, speech_started/stopped uc81cuc678)
    // speech_started/stopped ub294 OpenAI uc2a4ud399uc0c1 Serveru2192Client uc774ubca4ud2b8 u2014 ud074ub77cuc774uc5b8ud2b8uac00 uc1a1uc2e0ud558uc9c0 uc54aub294ub2e4
    const audioB64 = uint8ArrayToBase64(new Uint8Array(merged.buffer));
    ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: audioB64,
    }));
    
    session.onInputTranscript?.("\uD83C\uDFA4 \uc74c\uc131 \uc785\ub825");  // placeholder \uc720\uc9c0
}
```

### Step 4: handleMessage() uc218uc815
```typescript
function handleMessage(msg: any) {
    switch (msg.type) {
        case "response.created":
            isAiSpeaking = true;
            audioOutputCapped = false;
            silentOutputChunks = 0;
            outputSamplesTotal = 0;
            break;
        case "response.audio_transcript.delta":
            session.onOutputTranscript?.(msg.delta);
            break;
        case "response.audio.delta":
            // base64 PCM16 u2192 uc7acuc0dd
            handleAudioDelta(msg.delta);
            break;
        case "response.audio.done":
            // ub85cuae45ub9cc
            break;
        case "response.audio_transcript.done":
            // ub85cuae45ub9cc (full transcript uc788uc74c)
            break;
        case "response.done":
            isAiSpeaking = false;
            session.onTurnEnd?.();
            break;
        case "response.cancelled":
            isAiSpeaking = false;
            session.onInterrupted?.();
            break;
        case "input_audio_buffer.speech_started":
            // Serveru2192Client: uc11cubc84 VAD ubc1cud654 uc2dcuc791 uac10uc9c0
            // (openai-realtime.ts uc774ubbf8 uad6cud604 ud328ud134 ub3d9uc77c)
            session.onInterrupted?.();
            break;
        case "input_audio_buffer.speech_stopped":
            // Serveru2192Client: uc11cubc84 VAD ubc1cud654 uc885ub8cc uac10uc9c0
            // uc751ub2f5 uc0dduc131uc740 uc11cubc84uac00 uc790ub3d9 uc2dcuc791 (input_audio_buffer.commit ub4f1 ub3d9ub4f1)
            break;
        case "error":
            Logger.error("minicpm-o", msg.error);
            session.onError?.(new Error(msg.error));
            break;
    }
}
```

### Step 5: handleAudioChunk() u2192 handleAudioDelta() ub9acub124uc774ubc0d
- uc785ub825: base64 PCM16 (WAV ub4a4uc2b9 uc5c6uc74c)
- WAV ud5e4ub354 ud30cuc2f1 uc81cuac70
- uc9c1uc811 PCM16 ub514ucf54ub529: `base64 u2192 Uint8Array u2192 Int16Array`
- ud558ub4dcucf1c ubc0f uce68ubb35 uac10uc9c0 ub85cuc9c1 uc720uc9c0
- 4096 ud504ub808uc784 ub2e8uc704ub85c `onAudio(base64)` ucf5cubc31

### Step 6: disconnect() uc5d0uc11c response.cancel uc804uc1a1
```typescript
disconnect() {
    if (ws && isAiSpeaking) {
        ws.send(JSON.stringify({ type: "response.cancel" }));
    }
    // ...
}
```

## uc0aduc81cud560 ucf54ub4dc
- `decodeWavToPcm()` uc644uc804 uc0aduc81c (WAV ud5e4ub354 ubd88ud544uc694)
- `resampleLinear()` uc0aduc81c (uc11cubc84uac00 24kHz PCM16 uc9c1uc811 ubc18ud658)
- binary ud504ub808uc784 ucc98ub9ac (`event.data instanceof ArrayBuffer` ubd84uae30) uc0aduc81c

## uac80uc99d ubc29ubc95
1. uc2e4uc81c `/v1/realtime` uc5f0uacb0 ud14cuc2a4ud2b8:
   - WebSocket uc5f0uacb0 u2192 `session.created` uc218uc2e0 ud655uc778 (connect() resolve uc804 uc218uc2e0ud574uc57c ud568)
   - `session.update` uc804uc1a1 ud6c4 uc5d0ub7ec uc5c6uc5b4uc57c ud568
2. vllm-omni#6 uc644ub8cc ud6c4 ub85cuce7c E2E: uc74cuc131 uc785ub825 u2192 ud14duc2a4ud2b8 + uc624ub514uc624 uc218uc2e0
   - `response.audio.delta` uc774ubca4ud2b8 base64 ub370ucf54ub529 uc720ud6a8uc131 ud655uc778 (PCM16 ud615uc2dd)
3. uc778ud130ub7fdud2b8: AI uc751ub2f5 uc911 uc0c8 uc74cuc131 uc785ub825 u2192 `response.cancelled` ud655uc778
4. uba40ud2f0ud134: 2ubc88uc9f8 uc5f0uc18d ub300ud654 ub3d9uc791 ud655uc778 (uc774uc804 ub300ud654 ucee8ud14duc2a4ud2b8 uc720uc9c0)
5. uc0c1ud0dc uc810uac80: ub2e4uc218 ud131ub178 ud6c4 `isAiSpeaking=false`, `connected=true` uc720uc9c0

## ud30cuc77c ucd5cuc885 uc0c1ud0dc
```
uc218uc815: naia-os/shell/src/lib/voice/minicpm-o.ts (1uac1c ud30cuc77c)
```
