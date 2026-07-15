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
		const r = new CascadeAvatarRenderer({
			runtimeUrl: "http://127.0.0.1:8910",
		});
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

describe("CascadeAvatarRenderer.setVoice — PUT /voice 계약 (NVA 전환과 독립된 활성 음성)", () => {
	it("레퍼런스 URL 을 PUT /voice {audio_path} 로 민다", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchMock);
		try {
			const r = new CascadeAvatarRenderer({ runtimeUrl: "http://gpu:9449" });
			const ok = await r.setVoice(
				"https://storage.googleapis.com/naia-ref-audio-presets/cc0/cc0-ko-male-05.wav",
			);
			expect(ok).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("http://gpu:9449/voice");
			expect(init.method).toBe("PUT");
			expect(JSON.parse(init.body)).toEqual({
				audio_path:
					"https://storage.googleapis.com/naia-ref-audio-presets/cc0/cc0-ko-male-05.wav",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("URL 미지정(null/공백) = 서버 활성 음성 유지 — 요청을 보내지 않는다", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			const r = new CascadeAvatarRenderer({ runtimeUrl: "http://gpu:9449" });
			expect(await r.setVoice(null)).toBe(false);
			expect(await r.setVoice("  ")).toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("네트워크/서버 실패 = false (발화는 기존 활성 음성으로 계속 — 무음보다 안전)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
		try {
			const r = new CascadeAvatarRenderer({ runtimeUrl: "http://gpu:9449" });
			expect(await r.setVoice("https://x/ref.wav")).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
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

describe("CascadeAvatarRenderer.speak — Content-Type 라우팅 (webm=Blob / mp4=MSE)", () => {
	function makeHost(): HTMLVideoElement {
		const container = document.createElement("div");
		const host = document.createElement("video");
		container.appendChild(host);
		document.body.appendChild(container);
		return host;
	}
	function mockRes(contentType: string, blob: () => Promise<Blob>) {
		return {
			ok: true,
			body: {
				getReader: () => ({
					read: async () => ({ done: true, value: undefined }),
				}),
			},
			headers: {
				get: (k: string) =>
					k.toLowerCase() === "content-type" ? contentType : null,
			},
			blob,
		};
	}
	// jsdom 은 미디어 재생/MediaSource/URL.createObjectURL 미구현 → 최소 스텁.
	// play() 는 즉시 'ended' 를 쏴 waitEnded 를 해소(테스트 고착 방지).
	function withStubs<T>(msImpl: unknown, run: () => Promise<T>): Promise<T> {
		const orig = {
			create: URL.createObjectURL,
			revoke: URL.revokeObjectURL,
			play: HTMLMediaElement.prototype.play,
			ms: (globalThis as unknown as { MediaSource: unknown }).MediaSource,
			fetch: globalThis.fetch,
		};
		URL.createObjectURL = vi.fn(() => "blob:mock");
		URL.revokeObjectURL = vi.fn();
		HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
			setTimeout(() => {
				this.dispatchEvent(new Event("playing"));
				this.dispatchEvent(new Event("ended"));
			}, 0);
			return Promise.resolve();
		} as never;
		(globalThis as unknown as { MediaSource: unknown }).MediaSource = msImpl;
		return run().finally(() => {
			URL.createObjectURL = orig.create;
			URL.revokeObjectURL = orig.revoke;
			HTMLMediaElement.prototype.play = orig.play;
			(globalThis as unknown as { MediaSource: unknown }).MediaSource = orig.ms;
			globalThis.fetch = orig.fetch;
		});
	}

	it("video/webm 응답 → Blob 경로(res.blob 호출, MediaSource 미생성)", async () => {
		const msSpy = vi.fn();
		await withStubs(msSpy, async () => {
			const blobSpy = vi.fn(
				async () =>
					new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" }),
			);
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes("/idle")
					? mockRes(
							"video/mp4",
							async () => new Blob([new Uint8Array([9])], { type: "video/mp4" }),
						)
					: mockRes("video/webm", blobSpy),
			) as never;
			const host = makeHost();
			const r = new CascadeAvatarRenderer({
				runtimeUrl: "http://127.0.0.1:8910",
			});
			r.start(host);
			await r.speak("안녕");
			expect(blobSpy).toHaveBeenCalledTimes(1); // 마스크 video = 완전 파일 Blob 소비
			expect(msSpy).not.toHaveBeenCalled(); // MSE 안 씀
		});
	});

	it("releases split-mode audio once when avatar playback starts", async () => {
		await withStubs(vi.fn(), async () => {
			const blob = async () =>
				new Blob([new Uint8Array([1])], { type: "video/webm" });
			globalThis.fetch = vi.fn(async () => mockRes("video/webm", blob)) as never;
			const host = makeHost();
			const onPlaybackReady = vi.fn();
			const r = new CascadeAvatarRenderer({
				runtimeUrl: "http://127.0.0.1:8910",
			});
			r.start(host);
			await r.speak("hello", undefined, { muted: true, onPlaybackReady });
			expect(onPlaybackReady).toHaveBeenCalledTimes(1);
		});
	});

	it("releases split-mode audio once when avatar rendering fails", async () => {
		await withStubs(vi.fn(), async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("/idle")) {
					return mockRes("video/mp4", async () => new Blob([new Uint8Array([1])]));
				}
				return {
					ok: false,
					status: 503,
					body: {},
					headers: { get: () => "video/mp4" },
				};
			}) as never;
			const host = makeHost();
			const onPlaybackReady = vi.fn();
			const r = new CascadeAvatarRenderer({
				runtimeUrl: "http://127.0.0.1:8910",
			});
			r.start(host);
			await r.speak("hello", undefined, { muted: true, onPlaybackReady });
			expect(onPlaybackReady).toHaveBeenCalledTimes(1);
		});
	});

	it("video/mp4 응답 → MSE 경로(MediaSource 생성 시도, res.blob 미호출)", async () => {
		const msSpy = vi.fn();
		await withStubs(msSpy, async () => {
			const blobSpy = vi.fn(
				async () => new Blob([new Uint8Array([1])], { type: "video/mp4" }),
			);
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes("/idle")
					? mockRes(
							"video/mp4",
							async () => new Blob([new Uint8Array([9])], { type: "video/mp4" }),
						)
					: mockRes("video/mp4", blobSpy),
			) as never;
			const host = makeHost();
			const r = new CascadeAvatarRenderer({
				runtimeUrl: "http://127.0.0.1:8910",
			});
			r.start(host);
			await r.speak("안녕"); // MSE 스텁이 불완전해 내부 throw → speak 가 catch(발화 드롭). 분기 선택만 검증.
			expect(msSpy).toHaveBeenCalled(); // MSE 경로 진입
			expect(blobSpy).not.toHaveBeenCalled(); // Blob 경로 아님
		});
	});

	// ★2026-07-10 라이브 립싱크 폭주 근본수정 회귀가드: 여러 문장(TTS 청크)이 거의 동시에
	//   speak 를 호출해도 /stream 은 항상 1건만 in-flight(직렬) + 3건 모두 처리(supersede 드롭
	//   없음). 예전엔 각 speak 가 gen++ 로 이전을 취소 + 백엔드에 동시 요청 폭주 → facade 20s
	//   타임아웃으로 렌더 실패(립싱크·발화음성 둘 다 드롭). 큐 직렬화로 해소.
	it("동시 speak 호출은 직렬화된다(/stream in-flight 항상 1건, 3건 모두 처리)", async () => {
		await withStubs(vi.fn(), async () => {
			let inFlight = 0;
			let maxInFlight = 0;
			const blob = async () =>
				new Blob([new Uint8Array([1])], { type: "video/webm" });
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("/idle")) {
					return mockRes("video/mp4", blob);
				}
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 5)); // 렌더 시간 모사
				inFlight--;
				return mockRes("video/webm", blob);
			}) as never;
			const host = makeHost();
			const r = new CascadeAvatarRenderer({
				runtimeUrl: "http://127.0.0.1:8910",
			});
			r.start(host);
			// ChatArea 의 fire-and-forget(void speakAudio) 을 재현 — 3문장 동시 발화
			const ps = [r.speak("문장1"), r.speak("문장2"), r.speak("문장3")];
			await Promise.all(ps);
			expect(maxInFlight).toBe(1); // 동시 렌더 없음 = 큐 적체·타임아웃 소멸
			expect(
				globalThis.fetch as ReturnType<typeof vi.fn>,
			).toHaveBeenCalledTimes(4); // idle 1건 + 발화 3건
		});
	});

	it("interrupt 는 대기 중인 발화 큐를 비운다(barge-in)", async () => {
		await withStubs(vi.fn(), async () => {
			let started = 0;
			const blob = async () =>
				new Blob([new Uint8Array([1])], { type: "video/webm" });
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("/idle")) {
					return mockRes("video/mp4", blob);
				}
				started++;
				await new Promise((r) => setTimeout(r, 5));
				return mockRes("video/webm", blob);
			}) as never;
			const host = makeHost();
			const r = new CascadeAvatarRenderer({
				runtimeUrl: "http://127.0.0.1:8910",
			});
			r.start(host);
			const ps = [r.speak("A"), r.speak("B"), r.speak("C")];
			r.interrupt(); // 즉시 barge-in — 대기 B/C 취소, 대기자 resolve
			await Promise.all(ps); // 취소된 발화도 hang 없이 resolve
			expect(started).toBeLessThanOrEqual(1); // 첫 발화만 시작됐거나(경합) 0건
		});
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
