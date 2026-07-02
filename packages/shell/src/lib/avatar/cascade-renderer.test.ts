import { describe, expect, it } from "vitest";
import { pcm16ToWav, ttsAudioToWav } from "./cascade-renderer";

/** bytes → base64 (test helper, node/jsdom btoa via binary string). */
function b64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function riffTag(wav: Uint8Array): string {
	return String.fromCharCode(wav[0], wav[1], wav[2], wav[3]);
}
function waveTag(wav: Uint8Array): string {
	return String.fromCharCode(wav[8], wav[9], wav[10], wav[11]);
}

describe("ttsAudioToWav — 이중 WAV 방지 (게이트웨이 LINEAR16 = Google TTS WAV)", () => {
	it("raw PCM16 은 sampleRate 로 WAV 컨테이너를 씌운다", () => {
		const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // 헤더 없음
		const out = ttsAudioToWav(b64(pcm), 24000);
		expect(riffTag(out)).toBe("RIFF");
		expect(waveTag(out)).toBe("WAVE");
		// 44바이트 헤더 + 원본 PCM
		expect(out.length).toBe(44 + pcm.length);
		expect(Array.from(out.slice(44))).toEqual(Array.from(pcm));
		// 샘플레이트가 헤더(offset 24)에 그대로 기록
		const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
		expect(dv.getUint32(24, true)).toBe(24000);
	});

	it("이미 WAV(RIFF/WAVE)면 재포장 없이 그대로 통과(이중 WAV 아님)", () => {
		// 실제 WAV = pcm16ToWav 로 만든 컨테이너(게이트웨이 LINEAR16 반환 형태 모사)
		const wav = pcm16ToWav(new Uint8Array([9, 9, 9, 9]), 24000);
		const out = ttsAudioToWav(b64(wav), 24000);
		// 바이트 동일 — 감싸지 않았음
		expect(Array.from(out)).toEqual(Array.from(wav));
		// RIFF 는 정확히 하나(이중 WAV 였다면 data 청크 안에 두 번째 RIFF 존재)
		const asStr = String.fromCharCode(...out);
		expect(asStr.split("RIFF").length - 1).toBe(1);
	});

	it("12바이트 미만 조각은 WAV 로 오인하지 않고 감싼다", () => {
		const tiny = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF" 4바이트뿐
		const out = ttsAudioToWav(b64(tiny), 16000);
		expect(out.length).toBe(44 + tiny.length); // 감쌈
	});
});
