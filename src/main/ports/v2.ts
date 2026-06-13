// ports/v2 — V2(UC2) 음성 driven 인터페이스 (contract V2-baseline §B). domain 만 의존. substrate-agnostic.
// 감각(audio→STT) / 표현(음성+avatar) / 라이브 provider. transport/provider/getUserMedia 무지(어댑터가 구현).
import type { VoiceStatus } from "../domain/voice.js";

/** PCM 오디오 청크 = base64 (old MicStream/AudioPlayer 형식). host-neutral. */
export type PcmChunk = string;

export type Unsupported = { readonly unsupported: true; readonly reason: string };
export function isUnsupported<T>(r: T | Unsupported): r is Unsupported {
  return typeof r === "object" && r !== null && (r as Unsupported).unsupported === true;
}

/** STT 전사 결과(old SttResult 최소). */
export interface Transcript {
  readonly text: string;
  readonly final: boolean;
}

/** 마이크 캡처 핸들(old MicStream{start,stop}). */
export interface MicCapture {
  stop(): void;
}

/** 감각 입력 — audio 캡처 + STT. ⚠️ 캡처=getUserMedia(어댑터, lazy 필수 — F2 startup-block 교훈). */
export interface SensoryPort {
  /** 마이크 캡처 시작 → onChunk(pcm). 반환=정지 핸들. (lazy: 음성 활성 시에만 호출) */
  startMicCapture(onChunk: (pcm: PcmChunk) => void): Promise<MicCapture | Unsupported>;
  /** STT 전사 (web/tauri=로컬, api/vllm=external). */
  transcribe(audio: PcmChunk): Promise<Transcript | Unsupported>;
}

/** 표현 출력 — 음성 재생 + avatar. */
export interface ExpressionPort {
  /** PCM 청크 큐 재생(old AudioPlayer.enqueue). */
  play(chunk: PcmChunk): void;
  /** 재생 큐 비우기(barge-in). */
  clearAudio(): void;
  /** 텍스트→음성 (혼합: 로컬/cloud). */
  synthesize(text: string, voice: string): Promise<PcmChunk | Unsupported>;
  /** avatar 표현(emote/lip-sync, VRM). */
  express(emote: string): void;
}

/** 라이브 realtime 음성 세션 (external — WS provider/gateway). 상태=domain VoiceStatus. */
export interface VoiceProviderPort {
  connect(providerConfig: Readonly<Record<string, unknown>>): Promise<void>;
  sendAudio(pcm: PcmChunk): void;
  sendText(text: string): void;
  status(): VoiceStatus;
  disconnect(): void;
}

export type { VoiceStatus };
