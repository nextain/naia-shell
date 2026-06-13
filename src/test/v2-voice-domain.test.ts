// V2(UC2) 음성 도메인 테스트 — VoiceConnectionStatus 순수 전이 + 정직(가짜 active 금지).
import { describe, it, expect } from "vitest";
import {
  IDLE, nextVoiceStatus, shouldRetryColdStart, isVoiceConnected, isVoiceTerminal,
  MAX_COLD_START_RETRIES, type VoiceStatus,
} from "../main/domain/voice.js";

describe("VoiceConnectionStatus 전이 (정직)", () => {
  it("connect→connecting, open→active (★ open 만 active 승격, 가짜 active 금지)", () => {
    const c = nextVoiceStatus(IDLE, { kind: "connect" });
    expect(c.phase).toBe("connecting");
    expect(isVoiceConnected(c)).toBe(false); // connecting 은 연결됨 아님(오보 금지)
    const a = nextVoiceStatus(c, { kind: "open" });
    expect(a.phase).toBe("active");
    expect(isVoiceConnected(a)).toBe(true);
  });

  it("coldStart 는 retries 누적, 연결됨 아님", () => {
    let s = nextVoiceStatus(IDLE, { kind: "connect" });
    s = nextVoiceStatus(s, { kind: "coldStart" });
    expect(s.phase).toBe("cold-start");
    expect(s.retries).toBe(1);
    expect(isVoiceConnected(s)).toBe(false);
    expect(shouldRetryColdStart(s)).toBe(true);
  });

  it("cold-start 재시도 한도 초과 → 재시도 안 함(정직 포기)", () => {
    const over: VoiceStatus = { phase: "cold-start", retries: MAX_COLD_START_RETRIES + 1 };
    expect(shouldRetryColdStart(over)).toBe(false);
  });

  it("soldOut/error/closed = terminal, 연결됨 아님", () => {
    for (const ev of ["soldOut", "error"] as const) {
      const s = nextVoiceStatus(IDLE, { kind: ev });
      expect(isVoiceTerminal(s)).toBe(true);
      expect(isVoiceConnected(s)).toBe(false);
    }
    const closed = nextVoiceStatus({ phase: "active", retries: 0 }, { kind: "close", reason: "normal" });
    expect(closed.phase).toBe("closed");
    expect(isVoiceTerminal(closed)).toBe(true);
  });

  it("connect 는 retries 리셋", () => {
    const s = nextVoiceStatus({ phase: "cold-start", retries: 5 }, { kind: "connect" });
    expect(s.retries).toBe(0);
  });
});
