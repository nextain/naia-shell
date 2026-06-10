/**
 * Unit tests for the pure WAV encoder used by the ref-voice recorder.
 * (encodeRefAudio itself needs Web Audio decode/resample, so it's covered by
 * integration/manual testing; encodeWav is pure and trivially testable here.)
 */

import { describe, expect, it } from "vitest";
import { encodeWav } from "../ref-audio";

describe("encodeWav", () => {
	it("writes a valid 16-bit mono RIFF/WAVE header at the given rate", () => {
		const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
		const wav = encodeWav(samples, 16000);
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		const ascii = (o: number, n: number) =>
			Array.from({ length: n }, (_, i) => String.fromCharCode(wav[o + i])).join("");

		expect(ascii(0, 4)).toBe("RIFF");
		expect(ascii(8, 4)).toBe("WAVE");
		expect(ascii(12, 4)).toBe("fmt ");
		expect(view.getUint16(20, true)).toBe(1); // PCM
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(16000); // sample rate
		expect(view.getUint16(34, true)).toBe(16); // bits per sample
		expect(ascii(36, 4)).toBe("data");
	});

	it("emits 44-byte header + 2 bytes per sample", () => {
		const samples = new Float32Array(5);
		const wav = encodeWav(samples, 24000);
		expect(wav.byteLength).toBe(44 + 5 * 2);
		// reported byte rate = sampleRate * bytesPerSample
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		expect(view.getUint32(28, true)).toBe(24000 * 2);
	});

	it("clamps samples to the Int16 range (+1 -> 0x7fff, -1 -> -0x8000)", () => {
		const samples = new Float32Array([1, -1, 2, -2]); // out-of-range clamps too
		const wav = encodeWav(samples, 16000);
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
		expect(view.getInt16(44 + 0 * 2, true)).toBe(0x7fff);
		expect(view.getInt16(44 + 1 * 2, true)).toBe(-0x8000);
		expect(view.getInt16(44 + 2 * 2, true)).toBe(0x7fff); // clamped from 2
		expect(view.getInt16(44 + 3 * 2, true)).toBe(-0x8000); // clamped from -2
	});

	it("handles an empty take (header-only WAV)", () => {
		const wav = encodeWav(new Float32Array(0), 16000);
		expect(wav.byteLength).toBe(44);
	});
});
