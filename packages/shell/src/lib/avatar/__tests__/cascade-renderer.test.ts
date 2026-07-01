// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	CascadeAvatarRenderer,
	localFacadeUrlFromReady,
	pcm16ToWav,
	probeCascadeHealth,
} from "../cascade-renderer";

describe("CascadeAvatarRenderer.streamUrl", () => {
	it("절대 URL base + path 결합", () => {
		const r = new CascadeAvatarRenderer({ runtimeUrl: "http://127.0.0.1:8910" });
		expect(r.streamUrl("/idle")).toBe("http://127.0.0.1:8910/idle");
		expect(r.streamUrl("/stream_text")).toBe(
			"http://127.0.0.1:8910/stream_text",
		);
	});

	it("trailing slash 정규화", () => {
		const r = new CascadeAvatarRenderer({ runtimeUrl: "http://gpu:8910/" });
		expect(r.streamUrl("/idle")).toBe("http://gpu:8910/idle");
	});

	it("nvaName 이 query 로 부착됨", () => {
		const r = new CascadeAvatarRenderer({
			runtimeUrl: "http://gpu:8910",
			nvaName: "alpha-real-video",
		});
		expect(r.streamUrl("/idle")).toBe(
			"http://gpu:8910/idle?nva=alpha-real-video",
		);
	});

	it("상대 경로는 location.origin 기준 해석(동일출처 리버스프록시)", () => {
		const r = new CascadeAvatarRenderer({ runtimeUrl: "/avatar" });
		expect(r.streamUrl("/idle")).toBe(`${location.origin}/avatar/idle`);
	});
});

describe("pcm16ToWav", () => {
	it("44바이트 WAV 헤더 + 데이터 길이", () => {
		const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const wav = pcm16ToWav(pcm, 24000);
		expect(wav.length).toBe(44 + 8);
		const dv = new DataView(wav.buffer);
		// "RIFF"
		expect(String.fromCharCode(wav[0], wav[1], wav[2], wav[3])).toBe("RIFF");
		// "WAVE"
		expect(String.fromCharCode(wav[8], wav[9], wav[10], wav[11])).toBe("WAVE");
		// PCM(1), mono(1)
		expect(dv.getUint16(20, true)).toBe(1);
		expect(dv.getUint16(22, true)).toBe(1);
		// sampleRate
		expect(dv.getUint32(24, true)).toBe(24000);
		// byteRate = sr*2 (16bit mono)
		expect(dv.getUint32(28, true)).toBe(48000);
		// bits = 16
		expect(dv.getUint16(34, true)).toBe(16);
		// data chunk size
		expect(dv.getUint32(40, true)).toBe(8);
		// payload 보존
		expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});
});

describe("probeCascadeHealth", () => {
	it("200 + {ok:true} → true", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true }),
		});
		await expect(
			probeCascadeHealth("http://gpu:8910", 2000, fetchImpl as never),
		).resolves.toBe(true);
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://gpu:8910/health",
			expect.objectContaining({ signal: expect.anything() }),
		);
	});

	it("200 + {ok:false}(백엔드 미준비) → false", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: false }),
		});
		await expect(
			probeCascadeHealth("http://gpu:8910", 2000, fetchImpl as never),
		).resolves.toBe(false);
	});

	it("non-2xx → false", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: false,
			json: async () => ({}),
		});
		await expect(
			probeCascadeHealth("http://gpu:8910", 2000, fetchImpl as never),
		).resolves.toBe(false);
	});

	it("JSON 아님이어도 200이면 true", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => {
				throw new Error("not json");
			},
		});
		await expect(
			probeCascadeHealth("http://gpu:8910", 2000, fetchImpl as never),
		).resolves.toBe(true);
	});

	it("fetch throw(미도달) → false", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(
			probeCascadeHealth("http://gpu:8910", 2000, fetchImpl as never),
		).resolves.toBe(false);
	});
});

describe("localFacadeUrlFromReady", () => {
	it("avatar 서비스 있으면 로컬 facade URL", () => {
		const ready = JSON.stringify({
			facade_port: 8910,
			services: [
				{ id: "ditto_avatar", port: 8902, kind: "avatar", pid: 1 },
				{ id: "cascade_facade", port: 8910, kind: "facade", pid: 2 },
			],
		});
		expect(localFacadeUrlFromReady(ready)).toBe("http://127.0.0.1:8910");
	});

	it("avatar 서비스 없으면(voice-only) null → 립싱크 불가라 폴백", () => {
		const ready = JSON.stringify({
			facade_port: 8910,
			services: [
				{ id: "voxcpm2_tts", port: 22600, kind: "tts", pid: 1 },
				{ id: "cascade_facade", port: 8910, kind: "facade", pid: 2 },
			],
		});
		expect(localFacadeUrlFromReady(ready)).toBeNull();
	});

	it("facade_port 부재/비숫자 → null", () => {
		expect(
			localFacadeUrlFromReady(
				JSON.stringify({ services: [{ kind: "avatar" }] }),
			),
		).toBeNull();
		expect(
			localFacadeUrlFromReady(
				JSON.stringify({ facade_port: "x", services: [{ kind: "avatar" }] }),
			),
		).toBeNull();
	});

	it("JSON 파싱 실패 → null(안전)", () => {
		expect(localFacadeUrlFromReady("not json")).toBeNull();
		expect(localFacadeUrlFromReady("")).toBeNull();
	});
});
