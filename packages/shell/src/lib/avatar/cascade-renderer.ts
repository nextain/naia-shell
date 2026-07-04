/**
 * CascadeAvatarRenderer — NVA 비디오 아바타의 "말하는 입"을 cascade 런타임에서 받아 그리는 렌더러.
 *
 * 아키텍처(TalkingKiosk `nva-renderer.ts` 검증 로직 이식): 클라이언트는 **얇은 MSE 이중버퍼 소비자**.
 * 실제 립싱크 픽셀은 cascade 런타임(Ditto TRT, GPU)이 생성해 fragmented MP4(또는 알파 webm)로 스트리밍한다.
 *   - host(`<video>`) = idle 루프(`GET {runtimeUrl}/idle`) — 비발화 시 노출.
 *   - buf(오버레이 `<video>`) = 발화 스트림(`POST /stream_text` 또는 `/stream`) — 첫 프레임에 host 위로 swap.
 *
 * naia-os 적응(TalkingKiosk 대비 차이):
 *   - gs:// 경로 제거 — cascade 가 `/load_nva` 로 이미 로드한 캐릭터를 쓴다(필요 시 `nvaName` query).
 *   - runtimeUrl = 로컬 임베드 cascade facade(예 http://127.0.0.1:8910) 또는 원격 GPU PC URL.
 *   - CODEC 설정 가능(facade 가 mp4/webm 중 무엇을 주는지에 따름).
 *   - `probeHealth()` 정적 헬퍼 — VideoAvatarCanvas 가 cascade 도달 가능 여부로 모드(cascade/미연결) 결정.
 *
 * SoT: .agents/progress/naia-os-cascade-talking-avatar-2026-07-01.md
 */

/** TalkingKiosk 기본 코덱(H.264 Constrained Baseline + AAC). 알파가 필요하면 webm 코덱으로 override. */
export const DEFAULT_CASCADE_CODEC =
	'video/mp4; codecs="avc1.42E01F, mp4a.40.2"';

/** 발화 종료 대기 상한(서버 행 방지). RTF~0.95 라 통상 수 초. */
const ENDED_WAIT_CAP_MS = 300_000;

/** 끊김(언더런) 방지용 소량 프리버퍼(초) — 첫 청크 즉시 재생 대신 이만큼 쌓은 뒤 시작. */
const PREBUFFER_S = 0.2;

export interface CascadeRendererConfig {
	/** cascade facade(output_cascade) 절대/상대 URL. 예: http://127.0.0.1:8910 또는 https://gpu-pc/avatar */
	runtimeUrl: string;
	/** cascade 가 멀티 캐릭터일 때 선택용(옵션). 보통 /load_nva 로 미리 로드하므로 생략. */
	nvaName?: string;
	/** MSE SourceBuffer 코덱. 기본 mp4(avc1+aac). 알파 webm 이면 호출측이 override. */
	codec?: string;
}

/**
 * `start_cascade` 의 CASCADE_READY 페이로드(JSON 문자열)에서 **로컬** facade URL 유도.
 * 아바타(ditto) 서비스가 실제로 떠 있을 때만 URL 반환 — 립싱크 가능한 경우에만 로컬 배선.
 * (focus=voice 로 avatar 서비스가 없으면 null → VideoAvatarCanvas 는 "미연결"로 표시, 아바타 노출 안 함.)
 * 파싱 실패 / facade_port 부재 / avatar 서비스 부재 → null(안전).
 * 페이로드 계약: windows-manager `loader/launcher.py` supervise() = `{facade_port, services:[{kind}]}`.
 */
export function localFacadeUrlFromReady(ready: string): string | null {
	try {
		const p = JSON.parse(ready) as {
			facade_port?: number;
			services?: Array<{ kind?: string }>;
		};
		const port = p.facade_port;
		if (typeof port !== "number" || !Number.isFinite(port)) return null;
		const hasAvatar =
			Array.isArray(p.services) && p.services.some((s) => s?.kind === "avatar");
		if (!hasAvatar) return null;
		return `http://127.0.0.1:${port}`;
	} catch {
		return null;
	}
}

/** PCM16 mono → WAV 컨테이너. speakAudio(외부 TTS PCM)를 /stream(wav)로 보내기 위함. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
	const n = pcm.length;
	const buf = new ArrayBuffer(44 + n);
	const v = new DataView(buf);
	const w = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
	};
	w(0, "RIFF");
	v.setUint32(4, 36 + n, true);
	w(8, "WAVE");
	w(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, 1, true); // mono
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, sampleRate * 2, true); // byte rate (16bit mono)
	v.setUint16(32, 2, true); // block align
	v.setUint16(34, 16, true); // bits
	w(36, "data");
	v.setUint32(40, n, true);
	new Uint8Array(buf, 44).set(pcm);
	return new Uint8Array(buf);
}

/**
 * 외부 TTS 오디오(base64) → /stream 에 보낼 WAV bytes.
 *  - RIFF/WAVE 컨테이너면 그대로(게이트웨이 LINEAR16 = Google TTS 는 WAV 로 반환).
 *  - raw PCM16(헤더 없음)이면 sampleRate 로 WAV 컨테이너를 씌움.
 * trt /stream 은 librosa.load(sr=16000) 로 WAV 헤더의 원 샘플레이트를 읽어 16k 로 리샘플하므로,
 * 이미 WAV 인 것을 다시 감싸면(이중 WAV) librosa 가 헤더를 PCM 으로 오독 → 노이즈. 그래서 감지 필요.
 */
export function ttsAudioToWav(
	audioBase64: string,
	sampleRate: number,
): Uint8Array {
	const bin = atob(audioBase64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	// "RIFF"(0x52494646) + offset8 "WAVE"(0x57415645) → 이미 WAV 컨테이너.
	const isWav =
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x41 &&
		bytes[10] === 0x56 &&
		bytes[11] === 0x45;
	return isWav ? bytes : pcm16ToWav(bytes, sampleRate);
}

/** cascade 도달 가능 여부 — `GET {url}/health`. VideoAvatarCanvas 의 모드 결정에 쓴다. */
export async function probeCascadeHealth(
	runtimeUrl: string,
	timeoutMs = 2000,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const base = runtimeUrl.replace(/\/$/, "");
	const ctrl = new AbortController();
	const to = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetchImpl(`${base}/health`, { signal: ctrl.signal });
		if (!res.ok) return false;
		// facade /health 는 {ok, ...} 또는 백엔드 not-ready 시 503. ok 필드 우선, 없으면 res.ok.
		try {
			const j = (await res.json()) as { ok?: boolean };
			return j.ok !== false;
		} catch {
			return true;
		}
	} catch {
		return false;
	} finally {
		clearTimeout(to);
	}
}

export class CascadeAvatarRenderer {
	private host: HTMLVideoElement | null = null;
	private buf: HTMLVideoElement | null = null;
	private active: HTMLVideoElement | null = null;
	private gen = 0; // 발화 세대 — barge-in/중복 무효화
	private disposed = false;
	private teardown: (() => void) | null = null;

	constructor(
		private readonly cfg: CascadeRendererConfig,
		/** 발화 시작/종료 콜백(자막·STT 에코게이트·setSpeaking 동기화용). */
		private readonly onTalking?: (talking: boolean) => void,
	) {}

	private get codec(): string {
		return this.cfg.codec ?? DEFAULT_CASCADE_CODEC;
	}

	/** 런타임 엔드포인트 URL. nvaName 이 있으면 query 로 부착. 상대경로는 location.origin 기준 해석. */
	streamUrl(path: string): string {
		const base = this.cfg.runtimeUrl.replace(/\/$/, "");
		const origin =
			typeof location !== "undefined" ? location.origin : "http://localhost";
		try {
			const u = new URL(`${base}${path}`, origin);
			if (this.cfg.nvaName) u.searchParams.set("nva", this.cfg.nvaName);
			return u.toString();
		} catch {
			return `${base}${path}`;
		}
	}

	private runTeardown(): void {
		const t = this.teardown;
		this.teardown = null;
		t?.();
	}

	/** host 비디오에 idle 루프를 걸고, 그 위에 발화용 오버레이 buf 를 만든다. */
	start(hostVideo: HTMLVideoElement): void {
		this.host = hostVideo;
		this.disposed = false;
		const b = document.createElement("video");
		b.playsInline = true;
		b.muted = true;
		b.style.cssText =
			"position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;transition:opacity .18s ease;pointer-events:none;z-index:0";
		b.style.objectFit = getComputedStyle(hostVideo).objectFit || "contain";
		b.style.background =
			getComputedStyle(hostVideo).backgroundColor || "transparent";
		const parent = hostVideo.parentElement;
		if (parent) {
			if (getComputedStyle(parent).position === "static")
				parent.style.position = "relative";
			parent.appendChild(b);
		}
		this.buf = b;
		hostVideo.style.transition = "opacity .18s ease";
		hostVideo.style.opacity = "1";
		hostVideo.loop = true;
		hostVideo.muted = true;
		hostVideo.src = this.streamUrl("/idle");
		void hostVideo.play().catch(() => undefined);
		this.active = hostVideo;
	}

	/** 텍스트 발화 — audioWav 미지정 시 cascade 내장 TTS(/stream_text), 지정 시 /stream(wav).
	 *  응답 Content-Type 로 렌더 방식 결정:
	 *   - video/webm(완전 파일, composite 마스크 video/알파) → Blob → `<video>.src` (전체 수신 후 재생).
	 *   - video/mp4(fragmented) → MSE 이중버퍼(첫 청크부터 저지연 재생).
	 *  ★composite 알파 webm 은 스트리밍 시 duration/cues 부재로 `<video>`가 비디오 트랙을 못 넘김
	 *   (오디오만·화면정지) → 서버가 **완전한 webm 파일**로 출력하고 클라는 Blob 으로 받아야 한다
	 *   (avatar_ditto_composite.py 의 "완전한 webm 파일로 출력" 주석과 대칭). */
	async speak(text: string, audioWav?: Uint8Array): Promise<void> {
		const t = text.trim();
		if ((!t && !audioWav) || this.disposed || !this.buf) return;
		const my = ++this.gen;
		this.runTeardown();
		const back = this.buf;

		try {
			const res = audioWav
				? await fetch(this.streamUrl("/stream"), {
						method: "POST",
						headers: { "Content-Type": "application/octet-stream" },
						body: audioWav as BodyInit,
					})
				: await fetch(this.streamUrl("/stream_text"), {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ text: t }),
					});
			if (my !== this.gen || this.disposed) return;
			if (!res.ok || !res.body) throw new Error(`cascade stream ${res.status}`);
			const ctype = (res.headers.get("content-type") || "").toLowerCase();
			if (ctype.includes("webm")) {
				await this.renderWebmFile(res, back, my);
			} else {
				await this.renderMseStream(res, back, my);
			}
		} catch (e) {
			if (my === this.gen) {
				console.warn(
					"[cascade-avatar] speak 실패 — 이 발화 드롭:",
					e instanceof Error ? e.message : e,
				);
			}
		} finally {
			// ★현 세대만 자기 정리를 한다. 발화가 새 speak/interrupt/stop 으로 대체되면 gen 이 올라가고,
			//   그 대체자가 자기 시작 시 runTeardown 으로 **이 세대의** cleanup 을 이미 실행한다. 여기서
			//   또 runTeardown 하면 this.teardown 이 가리키는 **더 새로운 세대**의 cleanup 을 잘못 실행해
			//   현재 발화의 objectURL 을 revoke 하고 swap/ended 리스너를 떼어버린다(정체성 가드 상실 회귀).
			if (my === this.gen) {
				this.onTalking?.(false);
				try {
					back.style.opacity = "0";
					back.muted = true;
				} catch {
					/* noop */
				}
				this.active = this.host;
				this.runTeardown();
			}
		}
	}

	/** 발화 종료 대기 — `ended` 이벤트 또는 폴링(back.ended)·상한(ENDED_WAIT_CAP_MS). endedFn 등록 콜백으로
	 *  호출측 cleanup 이 리스너를 제거하게 한다. barge-in(gen 변경) 시 즉시 resolve. */
	private waitEnded(
		back: HTMLVideoElement,
		my: number,
		registerEndedFn: (fn: () => void) => void,
	): Promise<void> {
		return new Promise<void>((res2) => {
			if (my !== this.gen) return res2();
			let settled = false;
			const fin = () => {
				if (settled) return;
				settled = true;
				clearInterval(iv);
				clearTimeout(to);
				res2();
			};
			registerEndedFn(fin);
			back.addEventListener("ended", fin, { once: true });
			const iv = setInterval(() => {
				if (my !== this.gen || this.disposed || back.ended) fin();
			}, 1000);
			const to = setTimeout(fin, ENDED_WAIT_CAP_MS);
		});
	}

	/** fragmented mp4 스트림 → MSE 이중버퍼. 첫 청크부터 재생, swap 시 host 위로 노출. */
	private async renderMseStream(
		res: Response,
		back: HTMLVideoElement,
		my: number,
	): Promise<void> {
		const body = res.body;
		if (!body) return;
		const ms = new MediaSource();
		const url = URL.createObjectURL(ms);
		back.src = url;
		back.muted = true;

		let sb: SourceBuffer | null = null;
		let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
		let pumpFn: (() => void) | null = null;
		let swapFn: (() => void) | null = null;
		let endedFn: (() => void) | null = null;
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			try {
				if (sb && pumpFn) sb.removeEventListener("updateend", pumpFn);
			} catch {
				/* noop */
			}
			try {
				if (swapFn) back.removeEventListener("playing", swapFn);
			} catch {
				/* noop */
			}
			try {
				if (endedFn) back.removeEventListener("ended", endedFn);
			} catch {
				/* noop */
			}
			try {
				void reader?.cancel();
			} catch {
				/* noop */
			}
			try {
				if (ms.readyState === "open") ms.endOfStream();
			} catch {
				/* updating 중이거나 이미 닫힘 */
			}
			try {
				URL.revokeObjectURL(url);
			} catch {
				/* noop */
			}
		};
		this.teardown = cleanup;

		await new Promise<void>((resolve, reject) => {
			ms.addEventListener("sourceopen", () => resolve(), { once: true });
			ms.addEventListener(
				"sourceclose",
				() => reject(new Error("sourceclose")),
				{
					once: true,
				},
			);
		});
		if (my !== this.gen || this.disposed) return;

		sb = ms.addSourceBuffer(this.codec);
		const queue: Uint8Array[] = [];
		let ended = false;
		let swapped = false;
		let playStarted = false;
		const maybePlay = () => {
			if (playStarted || this.disposed || my !== this.gen || !sb) return;
			try {
				if (
					sb.buffered.length &&
					sb.buffered.end(sb.buffered.length - 1) >= PREBUFFER_S
				) {
					playStarted = true;
					void back.play().catch(() => undefined);
				}
			} catch {
				/* noop */
			}
		};
		const pump = () => {
			maybePlay();
			if (!sb || sb.updating || my !== this.gen) return;
			if (queue.length) {
				try {
					sb.appendBuffer(queue.shift()! as BufferSource);
				} catch {
					/* SourceBuffer 닫힘/제거 경합 — 무시 */
				}
			} else if (ended && ms.readyState === "open") {
				try {
					ms.endOfStream();
				} catch {
					/* already closed */
				}
			}
		};
		pumpFn = pump;
		sb.addEventListener("updateend", pump);

		const swap = () => {
			if (swapped || my !== this.gen) return;
			swapped = true;
			this.onTalking?.(true);
			back.style.opacity = "1";
			back.muted = false;
			this.active = back;
		};
		swapFn = swap;
		back.addEventListener("playing", swap, { once: true });

		reader = body.getReader();
		let first = true;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (my !== this.gen || this.disposed) return;
			if (value) {
				first = false;
				queue.push(value);
				pump();
			}
		}
		ended = true;
		pump();
		if (!first && !playStarted) {
			playStarted = true;
			void back.play().catch(() => undefined);
		}
		if (first) return; // 빈 스트림 — 즉시 종료(고착 회피)
		await this.waitEnded(back, my, (fn) => {
			endedFn = fn;
		});
	}

	/** 완전한 VP9 알파 webm 파일(composite 마스크 video) → Blob → `<video>.src`.
	 *  전체 수신 후 재생(스트리밍 webm 은 브라우저가 비디오 트랙을 못 넘김). webm 에 오디오(opus)
	 *  포함 → swap 시 unmute 로 발화 음성 재생. */
	private async renderWebmFile(
		res: Response,
		back: HTMLVideoElement,
		my: number,
	): Promise<void> {
		const blob = await res.blob();
		if (my !== this.gen || this.disposed || blob.size === 0) return;
		const url = URL.createObjectURL(blob);

		let swapFn: (() => void) | null = null;
		let endedFn: (() => void) | null = null;
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			try {
				if (swapFn) back.removeEventListener("playing", swapFn);
			} catch {
				/* noop */
			}
			try {
				if (endedFn) back.removeEventListener("ended", endedFn);
			} catch {
				/* noop */
			}
			try {
				URL.revokeObjectURL(url);
			} catch {
				/* noop */
			}
		};
		this.teardown = cleanup;

		const swap = () => {
			if (my !== this.gen) return;
			this.onTalking?.(true);
			back.style.opacity = "1";
			back.muted = false; // webm 에 오디오(opus) 포함 → 발화 음성 재생
			this.active = back;
		};
		swapFn = swap;
		back.addEventListener("playing", swap, { once: true });

		back.loop = false;
		back.src = url;
		void back.play().catch(() => undefined);
		if (my !== this.gen || this.disposed) return;

		await this.waitEnded(back, my, (fn) => {
			endedFn = fn;
		});
	}

	/**
	 * 외부 TTS 오디오(base64) 주입 → /stream 립싱크. WAV 컨테이너면 그대로, raw PCM16 이면
	 * sampleRate 로 감싼다(ttsAudioToWav — 이중 WAV 방지). 게이트웨이 LINEAR16 = Google TTS WAV.
	 */
	async speakAudio(audioBase64: string, sampleRate = 24000): Promise<void> {
		if (!audioBase64 || this.disposed) return;
		return this.speak("(audio)", ttsAudioToWav(audioBase64, sampleRate));
	}

	/** 현재 발화 즉시 중단(barge-in). */
	interrupt(): void {
		this.gen++;
		this.runTeardown();
		try {
			if (this.buf) {
				this.buf.style.opacity = "0";
				this.buf.muted = true;
			}
			this.active = this.host;
		} catch {
			/* noop */
		}
		this.onTalking?.(false);
	}

	stop(): void {
		this.disposed = true;
		this.gen++;
		this.runTeardown();
		// 발화 중 정지(언마운트 등)면 setSpeaking(true) 가 전역 스토어에 남지 않도록 해제(interrupt 와 대칭).
		this.onTalking?.(false);
		try {
			this.active?.pause();
			this.host?.pause();
			this.buf?.pause();
			this.buf?.remove();
		} catch {
			/* noop */
		}
		this.buf = null;
	}
}
