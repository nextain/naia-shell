// adapters/tauri/v2 — V2(UC2) os-local 실배선 (graft). 주입형(@tauri-apps·Web Audio·getUserMedia 미import).
// old audio-player.ts/mic-stream.ts/stt/tts 함수를 *주입*받아 ExpressionPort/SensoryPort 구현.
// ⚠️ SensoryPort.startMicCapture = getUserMedia(lazy — 음성 활성 시에만, 기동 미접촉. F2 startup-block 교훈).
// external(providers WS/gRPC Voice RPC)는 별도 신규계약 — 여기 os-local(재생/캡처/STT/TTS/avatar)만.
import type {
  SensoryPort, ExpressionPort, MicCapture, Transcript, PcmChunk, Unsupported,
} from "../../ports/v2.js";

/** old audio-player.ts AudioPlayer 형상(주입 — 어댑터 경계 내부). */
interface InjectedAudioPlayer { enqueue(pcm: string): void; clear(): void; destroy(): void; readonly isPlaying: boolean }
/** old mic-stream.ts MicStream. */
interface InjectedMicStream { start(): void; stop(): void }

export interface V2LiveDeps {
  /** old createAudioPlayer — 1회 생성 lazy. */
  createAudioPlayer: () => InjectedAudioPlayer;
  /** old createMicStream — ⚠️ getUserMedia(lazy, 음성 활성 시에만). */
  createMicStream: (opts: { onChunk: (pcm: string) => void }) => Promise<InjectedMicStream>;
  /** STT 전사 (web/tauri 로컬 또는 api/vllm). 미지원 시 null. */
  transcribe?: (audio: string) => Promise<string | null>;
  /** TTS (혼합). 미지원 시 null. */
  synthesize?: (text: string, voice: string) => Promise<string | null>;
  /** avatar 표현(VRM emote/lip-sync). */
  express?: (emote: string) => void;
}

const unsupported = (reason: string): Unsupported => ({ unsupported: true, reason });

/** old 함수 주입 → V2 표현(음성 재생 + avatar) 실배선. */
export function makeV2Expression(d: V2LiveDeps): ExpressionPort {
  let player: InjectedAudioPlayer | null = null;
  const ensure = (): InjectedAudioPlayer => (player ??= d.createAudioPlayer()); // lazy 1회
  return {
    play(chunk: PcmChunk): void { ensure().enqueue(chunk); },
    clearAudio(): void { player?.clear(); }, // barge-in: 생성 안 됐으면 no-op
    async synthesize(text: string, voice: string): Promise<PcmChunk | Unsupported> {
      if (!d.synthesize) return unsupported("TTS 미주입(external 신규계약)");
      const r = await d.synthesize(text, voice);
      return r ?? unsupported("TTS 결과 없음");
    },
    express(emote: string): void { d.express?.(emote); }, // avatar 미주입 시 no-op
  };
}

/** old 함수 주입 → V2 감각(audio 캡처 + STT) 실배선. ⚠️ getUserMedia lazy. */
export function makeV2Sensory(d: V2LiveDeps): SensoryPort {
  return {
    async startMicCapture(onChunk: (pcm: PcmChunk) => void): Promise<MicCapture | Unsupported> {
      try {
        const mic = await d.createMicStream({ onChunk }); // ⚠️ getUserMedia 여기서만(lazy)
        mic.start();
        return { stop: () => mic.stop() };
      } catch (e) {
        return unsupported(`mic 캡처 불가: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    async transcribe(audio: PcmChunk): Promise<Transcript | Unsupported> {
      if (!d.transcribe) return unsupported("STT 미주입(api/vllm=external 신규계약)");
      const text = await d.transcribe(audio);
      return text === null ? unsupported("STT 결과 없음") : { text, final: true };
    },
  };
}
