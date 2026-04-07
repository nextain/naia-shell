# Plan: Issue #220 u2014 Silero ONNX VAD uad50uccb4 (minicpm-o.ts)

## ubaa9uc801
RMS uae30ubc18 VADub97c Silero ONNX ub274ub7f4ub9dd VADub85c uad50uccb4.
ud074ub77cuc774uc5b8ud2b8 uc22bucf54uc5d0 VAD uadac uc5f0uc0b0 (uad00ub9acub294 Naia).

## ubd84uc11d uc694uc57d

### ud604uc7ac RMS VAD ub9f8uc810
- RMS uc784uacc4uac12 uba39ub294 ubc29uc2dd: uc9c1uc811 uc2e0ud638 u2192 uc624ud0d0 ub9ceuc74c
- 1500ms uce68ubb35 ud0c0uc774uba38 uae30ubc18: ub2e8uc5b4 uac70uc5b4uc11c uc911uac04 uce68ubb35 uc2dc uc870uae30 ubd84ub9ac
- ub274ub7f4ub9dd VAD ub300ube44 uc624ud0d0uc728 ub192uc74c (RMSub294 ud654uc790ub0e9uc18cub9ac, ucca8uc8fcub450ub4dcub9ac uc0ddud63c)

### Silero VAD uc7a5uc810
- ub274ub7f4ub9dd ud655ub960 uae30ubc18: 0~1 ud655ub960 ucd9cub825 u2192 uc815ubc00ud55c ud559uc2b5 uae30ubc18 uac10uc9c0
- ud788uc2a4ud14cub9acuc2dcuc2a4: ub3c4uad6c threshold(0.8) vs neg_threshold(0.65) u2192 uc9e7uc740 uc794ub958 uc81cuac70
- uc2a4ud2b8ub9acubc0d: feed() ud638ucd9c uc2dc uc644uc131ub41c uc138uadf8uba3cud2b8ub9cc ubc18ud658 (None or np.ndarray)

### ONNX Runtime in Browser uac1cuc694
- `onnxruntime-web`: ube0cub77ecuc6b0uc800uc5d0uc11c ONNX ubaa8ub378 uc2e4ud589
- WebAssembly ubc31uc5d4ub4dc uc0acuc6a9
- `silero_vad.onnx` ud30cuc77cuc740 naia-os `public/models/` ub610ub294 ubc88ub4e4uc5d0 ud3ecud568

### ud3ecud305 uc2dc uc8fcuc758uc0acud56d
- uc785ub825 ud615uc2dd: Pythonuc740 float32 [-1, 1], TypeScriptub294 Int16Array u2192 uc815uaddcud654 ud544uc694
- LSTM uc0c1ud0dc(h, c): Float32Array(2 * 1 * 64) ucf54ub4dcub85c
- uc708ub3c4uc6b0 ud06cuae30: 1024 uc0d8ud50c (64ms @ 16kHz)
- ubc30uc5f4 uc5f0uacb0: `Float32Array.set()` ud328ud134

## uc791uc5c5 uacc4ud68d

### Step 1: uc9c4uc785uc810 uae30uc900 uc815ub9ac
`silero_vad.onnx` ubaa8ub378 uacbdub85c: `public/models/silero_vad.onnx`
- Vite + Tauri: `public/` ub514ub809ud1a0ub9ac uc790uc0b0uc740 `tauri://localhost/models/silero_vad.onnx`ub85c uc811uadfc
- modelUrl: `'/models/silero_vad.onnx'` (Vite dev), `'tauri://localhost/models/silero_vad.onnx'` (Tauri prod)
- uc2e4uc81c ubaa8ub378 ud30cuc77cuc740 `silero-vad-v5.onnx` GitHub ub2e4uc6b4ub85cub4dc ud544uc694: https://github.com/snakers4/silero-vad

### Step 2: SileroVAD TypeScript ud074ub798uc2a4 uc791uc131

```typescript
import * as ort from 'onnxruntime-web';
// minicpm-o.ts ub0b4ubd80 ub610ub294 vad.ts ubd84ub9ac
// uc885uc18duc131: pnpm add onnxruntime-web

interface SileroVADState {
    h: Float32Array;  // (2, 1, 64) = 128
    c: Float32Array;  // (2, 1, 64) = 128
}

class SileroStreamingVAD {
    private session: ort.InferenceSession | null = null;
    private state: SileroVADState;
    private readonly threshold = 0.8;
    private readonly negThreshold = 0.65;  // threshold - 0.15
    private readonly windowSize = 1024;    // samples
    private readonly minSpeechSamples = 2048;   // 128ms @ 16kHz
    private readonly minSilenceSamples = 12800;  // 800ms @ 16kHz
    
    // uc0c1ud0dc uba38uc2e0
    private triggered = false;
    private speechBuffer: Float32Array[] = [];
    private speechStartSample = 0;
    private currentSample = 0;
    private silenceStartSample = 0;
    private leftover = new Float32Array(0);
    
    async init(modelUrl: string): Promise<void> {
        this.session = await ort.InferenceSession.create(modelUrl, {
            executionProviders: ['wasm'],
        });
        this._resetState();
    }
    
    private _resetState(): void {
        this.state = {
            h: new Float32Array(2 * 1 * 64),  // zeros
            c: new Float32Array(2 * 1 * 64),  // zeros
        };
    }
    
    reset(): void {
        this.triggered = false;
        this.speechBuffer = [];
        this.speechStartSample = 0;
        this.currentSample = 0;
        this.silenceStartSample = 0;
        this.leftover = new Float32Array(0);
        this._resetState();
    }
    
    /**
     * feed(): Int16Array PCM16 uccadud06c uc785ub825 u2192 uc644uc131ub41c uc74cuc131 uc138uadf8uba3cud2b8 ub610ub294 null
     * uc785ub825: Int16Array (16kHz, uc81cud55c uc5c6ub294 ud06cuae30)
     * ucd9cub825: Float32Array (uc74cuc131 uc138uadf8uba3cud2c8) ub610ub294 null
     */
    async feed(int16Chunk: Int16Array): Promise<Float32Array | null> {
        // Int16 u2192 float32 uc815uaddcud654 [-1, 1]
        const float32Chunk = new Float32Array(int16Chunk.length);
        for (let i = 0; i < int16Chunk.length; i++) {
            float32Chunk[i] = int16Chunk[i] / 32768.0;
        }
        
        // leftover uc5f0uacb0
        let audio: Float32Array;
        if (this.leftover.length > 0) {
            audio = new Float32Array(this.leftover.length + float32Chunk.length);
            audio.set(this.leftover);
            audio.set(float32Chunk, this.leftover.length);
        } else {
            audio = float32Chunk;
        }
        this.leftover = new Float32Array(0);
        
        let offset = 0;
        let result: Float32Array | null = null;
        
        while (offset + this.windowSize <= audio.length) {
            const window = audio.subarray(offset, offset + this.windowSize);
            const speechProb = await this._inferWindow(window);
            
            // uc74cuc131 uc2dcuc791 uac10uc9c0
            if (speechProb >= this.threshold && !this.triggered) {
                this.triggered = true;
                this.speechStartSample = this.currentSample;
                this.speechBuffer = [];
                this.silenceStartSample = 0;
            }
            
            if (this.triggered) {
                this.speechBuffer.push(window.slice(0));  // ubcf5uc0ac
            }
            
            // uce68ubb35 uc804ud658 uac10uc9c0
            if (speechProb < this.negThreshold && this.triggered) {
                if (this.silenceStartSample === 0) {
                    this.silenceStartSample = this.currentSample;
                }
                const silenceDuration = this.currentSample - this.silenceStartSample + this.windowSize;
                if (silenceDuration >= this.minSilenceSamples) {
                    const speechDuration = this.currentSample - this.speechStartSample;
                    if (speechDuration >= this.minSpeechSamples) {
                        result = this._concatBuffers(this.speechBuffer);
                    }
                    this.triggered = false;
                    this.speechBuffer = [];
                    this.silenceStartSample = 0;
                }
            } else if (this.triggered) {
                this.silenceStartSample = 0;
            }
            
            offset += this.windowSize;
            this.currentSample += this.windowSize;
        }
        
        // ub098uba38uc9c0 uc800uc7a5
        if (offset < audio.length) {
            this.leftover = audio.subarray(offset);
        }
        
        return result;
    }
    
    flush(): Float32Array | null {
        if (this.triggered && this.speechBuffer.length > 0) {
            const speechDuration = this.currentSample - this.speechStartSample;
            if (speechDuration >= this.minSpeechSamples) {
                const result = this._concatBuffers(this.speechBuffer);
                this.triggered = false;
                this.speechBuffer = [];
                return result;
            }
        }
        this.triggered = false;
        this.speechBuffer = [];
        return null;
    }
    
    get isSpeaking(): boolean {
        return this.triggered;
    }
    
    private async _inferWindow(window: Float32Array): Promise<number> {
        if (!this.session) throw new Error('VAD not initialized');
        
        // ONNX uc785ub825 ud3ecub9e7: input(1, 1024), h(2, 1, 64), c(2, 1, 64), sr(int64)
        const input = new ort.Tensor('float32', window, [1, this.windowSize]);
        const h = new ort.Tensor('float32', this.state.h, [2, 1, 64]);
        const c = new ort.Tensor('float32', this.state.c, [2, 1, 64]);
        const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(16000)]), []);
        
        const feeds = { input, h, c, sr };
        const results = await this.session.run(feeds);
        
        // uc0c1ud0dc uc5c5ub370uc774ud2b8 (LSTM hidden)
        this.state.h = results['hn'].data as Float32Array;
        this.state.c = results['cn'].data as Float32Array;
        
        return results['output'].data[0] as number;
    }
    
    private _concatBuffers(buffers: Float32Array[]): Float32Array {
        const total = buffers.reduce((sum, b) => sum + b.length, 0);
        const result = new Float32Array(total);
        let offset = 0;
        for (const buf of buffers) {
            result.set(buf, offset);
            offset += buf.length;
        }
        return result;
    }
}
```

### Step 3: sendAudio() VAD ub85cuc9c1 uad50uccb4

```typescript
// uae30uc874 RMS uc0c1uc218ub4e4 uc0aduc81c:
// const SPEECH_RMS_THRESHOLD = 200;
// const SILENCE_TIMEOUT_MS = 1500;
// const MAX_BUFFER_MS = 6000;
// function rms(samples: Int16Array): number {...}

// uc0c8 uc0c1ud0dc
// const vad = new SileroStreamingVAD();
// uc5f0uacb0 uc2dc vad.init() ud638uc6a9

function sendAudio(pcmBase64: string): void {
    if (isAiSpeaking) return;
    
    const bytes = base64ToUint8Array(pcmBase64);
    const samples = new Int16Array(bytes.buffer);
    
    // VAD feed
    vad.feed(samples).then((segment) => {
        if (segment !== null) {
            // uc74cuc131 uc138uadf8uba3cud2b8 uc644uc131 u2192 uc804uc1a1
            _sendSegment(segment);
        }
        
        // uc74cuc131 uc0c1ud0dc uc2e0ud638 (ub418ud53cub4dc bc vad.isSpeaking)
        // Note: feed() uc790uccb4uac00 ube44ub3d9uae30uc774ubbc0ub85c uc0c1ud0dc ubcc0ud654ub294 then uc774ud6c4uc5d0 uc0dduac01
    });
}

// uc138uadf8uba3cud2b8 uc804uc1a1: append ub9cc uc804uc1a1
// speech_started/stopped ub294 OpenAI uc2a4ud399uc0c1 Serveru2192Client uc774ubca4ud2b8 u2014 ud074ub77cuc774uc5b8ud2b8uac00 uc1a1uc2e0ud558uc9c0 uc54aub294ub2e4
// uc11cubc84 VAD ub77cub294 uc81cu�4ud558uba74, uc11cubc84ub294 uc790ub3d9uc73cub85c speech_started/stopped ub97c ud074ub77cuc774uc5b8ud2b8uc5d0 uc54cub9b0ub2e4
function _sendSegment(float32Audio: Float32Array): void {
    if (!ws || !connected) return;
    
    // float32 u2192 Int16 ubcc0ud658 (uc11cubc84uac00 PCM16 uae30ub300)
    const int16 = new Int16Array(float32Audio.length);
    for (let i = 0; i < float32Audio.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32Audio[i] * 32768));
    }
    
    const audioB64 = uint8ArrayToBase64(new Uint8Array(int16.buffer));
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: audioB64 }));
    
    session.onInputTranscript?.("\uD83C\uDFA4 \uc74c\uc131 \uc785\ub825");
}
```

### Step 4: disconnect() flush ucd94uac00
```typescript
disconnect() {
    const remaining = vad.flush();
    if (remaining !== null) {
        _sendSegment(remaining);
    }
    vad.reset();
    // ...
}
```

### Step 5: init ud750ub984
```typescript
connect(config) {
    cfg = config;
    await vad.init('/models/silero_vad.onnx');
    // WebSocket uc5f0uacb0 ...
}
```

## uac80uc99d ubc29ubc95
1. ONNX ubaa8ub378 ub85cub4dc: `vad.init()` uc7a5uae30 ube14ub85cud0b9 uc5c6uc774 uc644ub8cc
2. uc9e7uc740 ubc1cud654 (0.5ucd08): `vad.feed()` uac00 segment ubc18ud658
3. uae34 uce68ubb35 ud6c4 ubc1cud654: uc720uc9c0ub41c ub9c8uc774ud06c uce68ubb35 (uc14aub2e8ud654 ub9c8uc774ud06cuc774 uc544ub2d8)
4. RMS ubcf4ub2e4 uc624ud0d0 uc904uc5b4uc9c4 uac70 ud655uc778
5. `flush()`: ub9c8uc9c0ub9a9 uc138uadf8uba3cud2b8 ubc18ud658 uc5ecubd80
6. uc5d4uc9c0 ucf00uc774uc2a4 uac80uc99d:
   - `feed(new Int16Array(0))` u2192 null (ube48 uc785ub825 ubb34uc2dc)
   - `reset()` ud6c4 `isSpeaking === false`, `flush() === null`
   - `flush()` 2ud68c ud638ucd9c u2192 2ubc88uc9f8 null
   - leftover: 1500 uc0d8ud50c uc785ub825 u2192 1024 uce98uc73cub85cub3c4 476 leftoverub85c ub0a8ub294uc9c0 ud655uc778

## uc120ud589 uc870uac74
- Issue #219 (/v1/realtime uc804ud658) uc644ub8cc ud6c4 uc801uc6a9
  - uc774uc720: speech_started/stopped uc2e0ud638 uc804uc1a1uc740 #219uc5d0uc11c uc815uc758ud55c ud504ub85cud1a0ucf5c ud544uc694

## ud30cuc77c ucd5cuc885 uc0c1ud0dc
```
uc218uc815: naia-os/shell/src/lib/voice/minicpm-o.ts
- SileroStreamingVAD ud074ub798uc2a4 ucd94uac00
- sendAudio() VAD ub85cuc9c1 uad50uccb4
- uae30uc874 RMS ucf54ub4dc/uc0c1uc218 uc0aduc81c
- connect()? init uc218uc815
uc120ud0dd: public/models/silero_vad.onnx ucd94uac00 (ubaa8ub378 ud30cuc77c)
```
