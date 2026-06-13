// V2(UC2) os-local 어댑터 parity 테스트 (drift-gate). 주입형(mock audio/mic) — 음성 HW 없이 검증.
import { describe, it, expect } from "vitest";
import { makeV2Expression, makeV2Sensory } from "../main/adapters/tauri/v2.js";
import { isUnsupported } from "../main/ports/v2.js";

describe("V2 startup-block 불변 (F2 교훈)", () => {
  it("★ 생성(construction) 시 device 미접촉 — createMicStream/createAudioPlayer 미호출(eager getUserMedia/AudioContext 금지)", () => {
    let audioCreated = 0;
    let micCreated = 0;
    const player = { enqueue: () => {}, clear: () => {}, destroy: () => {}, isPlaying: false };
    const mic = { start: () => {}, stop: () => {} };
    const deps = {
      createAudioPlayer: () => { audioCreated++; return player; },
      createMicStream: async () => { micCreated++; return mic; },
    };
    makeV2Expression(deps);
    makeV2Sensory(deps);
    expect(audioCreated).toBe(0); // 생성만으론 AudioContext 안 만듦
    expect(micCreated).toBe(0);   // 생성만으론 getUserMedia 안 함(startup 무블록)
  });
});

describe("V2 Expression — 재생/avatar (os-local)", () => {
  it("play → AudioPlayer.enqueue (lazy 1회 생성)", () => {
    const enq: string[] = [];
    let created = 0;
    const exp = makeV2Expression({ createAudioPlayer: () => { created++; return { enqueue: (p) => enq.push(p), clear: () => {}, destroy: () => {}, isPlaying: false }; }, createMicStream: async () => ({ start: () => {}, stop: () => {} }) });
    exp.play("a"); exp.play("b");
    expect(enq).toEqual(["a", "b"]);
    expect(created).toBe(1); // lazy 1회
  });
  it("clearAudio: 생성 전 no-op, 생성 후 clear", () => {
    let cleared = 0;
    const exp = makeV2Expression({ createAudioPlayer: () => ({ enqueue: () => {}, clear: () => { cleared++; }, destroy: () => {}, isPlaying: false }), createMicStream: async () => ({ start: () => {}, stop: () => {} }) });
    exp.clearAudio(); expect(cleared).toBe(0); // 생성 전 no-op(crash X)
    exp.play("x"); exp.clearAudio(); expect(cleared).toBe(1);
  });
  it("synthesize 미주입 → Unsupported(정직)", async () => {
    const exp = makeV2Expression({ createAudioPlayer: () => ({ enqueue: () => {}, clear: () => {}, destroy: () => {}, isPlaying: false }), createMicStream: async () => ({ start: () => {}, stop: () => {} }) });
    expect(isUnsupported(await exp.synthesize("hi", "v"))).toBe(true);
  });
  it("synthesize 주입 → 결과", async () => {
    const exp = makeV2Expression({ createAudioPlayer: () => ({ enqueue: () => {}, clear: () => {}, destroy: () => {}, isPlaying: false }), createMicStream: async () => ({ start: () => {}, stop: () => {} }), synthesize: async () => "tts-pcm" });
    expect(await exp.synthesize("hi", "v")).toBe("tts-pcm");
  });
});

describe("V2 Sensory — 캡처/STT (os-local, getUserMedia lazy)", () => {
  it("startMicCapture → createMicStream + start, onChunk 전달, stop 핸들", async () => {
    const chunks: string[] = [];
    let started = 0;
    const sen = makeV2Sensory({ createAudioPlayer: () => ({ enqueue: () => {}, clear: () => {}, destroy: () => {}, isPlaying: false }), createMicStream: async ({ onChunk }) => ({ start: () => { started++; onChunk("c1"); }, stop: () => {} }) });
    const cap = await sen.startMicCapture((p) => chunks.push(p));
    expect(isUnsupported(cap)).toBe(false);
    expect(started).toBe(1);
    expect(chunks).toEqual(["c1"]);
  });
  it("getUserMedia 실패 → Unsupported(정직, crash X)", async () => {
    const sen = makeV2Sensory({ createAudioPlayer: () => ({ enqueue: () => {}, clear: () => {}, destroy: () => {}, isPlaying: false }), createMicStream: async () => { throw new Error("NotAllowedError"); } });
    const cap = await sen.startMicCapture(() => {});
    expect(isUnsupported(cap)).toBe(true);
  });
  it("transcribe 미주입 → Unsupported", async () => {
    const sen = makeV2Sensory({ createAudioPlayer: () => ({ enqueue: () => {}, clear: () => {}, destroy: () => {}, isPlaying: false }), createMicStream: async () => ({ start: () => {}, stop: () => {} }) });
    expect(isUnsupported(await sen.transcribe("a"))).toBe(true);
  });
});
