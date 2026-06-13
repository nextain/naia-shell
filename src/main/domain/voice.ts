// domain/voice — V2(UC2) 음성 연결 상태 (순수, contract V2-baseline §B 도메인). I/O 0.
// old VoiceConnectionStatus(connecting/cold-start/sold-out/error/active) 충실 — cold-start 인지 + 정직 보고(오보 금지, FR-F1.1).
// substrate-agnostic: provider/transport 무지(WS/getUserMedia 는 어댑터). 안드로이드 대비 host-neutral.

/** 라이브 음성 연결 단계. active = *실제 연결됨*만(가짜 active 금지). */
export type VoicePhase = "idle" | "connecting" | "cold-start" | "active" | "sold-out" | "error" | "closed";

/** old VoiceCloseReason — 종료 분류(정직). */
export type VoiceCloseReason = "normal" | "cold-start" | "sold-out" | "error";

export interface VoiceStatus {
  readonly phase: VoicePhase;
  /** cold-start 재시도 횟수(backoff 판정용). */
  readonly retries: number;
}

export type VoiceEvent =
  | { kind: "connect" }
  | { kind: "open" } // WS open + 서버 ready
  | { kind: "coldStart" } // 서버 pod-starting
  | { kind: "soldOut" }
  | { kind: "error" }
  | { kind: "close"; reason: VoiceCloseReason };

export const IDLE: VoiceStatus = { phase: "idle", retries: 0 };

/** 순수 전이. cold-start 는 connecting 으로 재시도 누적; open 만이 active 로 승격(정직). */
export function nextVoiceStatus(s: VoiceStatus, e: VoiceEvent): VoiceStatus {
  switch (e.kind) {
    case "connect":
      return { phase: "connecting", retries: 0 };
    case "open":
      return { phase: "active", retries: s.retries }; // ★ 실제 open 만 active (가짜 active 금지)
    case "coldStart":
      return { phase: "cold-start", retries: s.retries + 1 };
    case "soldOut":
      return { phase: "sold-out", retries: s.retries };
    case "error":
      return { phase: "error", retries: s.retries };
    case "close":
      return { phase: "closed", retries: s.retries };
  }
}

/** cold-start 재시도 한도(backoff). 한도 초과 = 포기(정직 error/sold-out 표면화). */
export const MAX_COLD_START_RETRIES = 12;
export function shouldRetryColdStart(s: VoiceStatus): boolean {
  return s.phase === "cold-start" && s.retries <= MAX_COLD_START_RETRIES;
}

/** 정직: 오직 active(실제 open) 만 "연결됨". connecting/cold-start 를 연결됨으로 오보 금지. */
export function isVoiceConnected(s: VoiceStatus): boolean {
  return s.phase === "active";
}

/** 종점(더 진행 불가) 단계. */
export function isVoiceTerminal(s: VoiceStatus): boolean {
  return s.phase === "closed" || s.phase === "sold-out" || s.phase === "error";
}
