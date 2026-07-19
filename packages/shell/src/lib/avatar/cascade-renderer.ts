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
import { Logger } from "../logger";

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

/** 크로마 키잉 — NVA 플레이어(에디터 compose)의 색거리 키잉 이식 + 유리룩 보정.
 *  에디터 원본은 순수 크로마(초록) 배경 전제라 거리<90 일괄 투명화지만, 셸이 받는 프레임은
 *  **flatten 배경**이고 나이아 몸이 유리(반투명) 룩 = 배경과 색이 가까워 90 이면 몸까지 빠진다
 *  (2026-07-16 실기 "알파 과함"). 그래서 이중 임계:
 *   - 색거리 ≤ hard(기본 24) = 순수 배경 → 완전 투명 (h264 압축 노이즈 흡수 여유)
 *   - hard~soft(기본 56)     = 배경 근접(유리 가장자리) → 거리 비례 페더(반투명)
 *   - 그 밖                  = 캐릭터 → 보존 */
export function chromaKeyImage(
	d: Uint8ClampedArray,
	r: number,
	g: number,
	b: number,
	// ⚠️ 기본값 초보수(2026-07-16 실기 2차): 나이아 몸=유리(반투명 베이크)라 배경과 색이 섞여
	// 있어 임계를 조금만 키워도 몸이 통째로 뚫린다("다 뚫려보여"). 색거리 키잉은 flatten 배경의
	// 근사 제거까지만 담당하고, **진짜 마스크는 서버 알파(VP9 yuva420p) 채널이 정본** — 알파가
	// 오면 sampleCornerKey 가 null 을 반환해 이 함수 자체가 호출되지 않는다.
	hard = 12,
	soft = 20,
): void {
	const h2 = hard * hard;
	const s2 = soft * soft;
	const span = soft - hard;
	for (let i = 0; i < d.length; i += 4) {
		const dr = d[i] - r;
		const dg = d[i + 1] - g;
		const db = d[i + 2] - b;
		const q = dr * dr + dg * dg + db * db;
		if (q <= h2) {
			d[i + 3] = 0;
		} else if (q < s2) {
			const t = (Math.sqrt(q) - hard) / span;
			const a = Math.round(t * 255);
			if (a < d[i + 3]) d[i + 3] = a;
		}
	}
}

/** 프레임 배경(키) 색 추출 — 4모서리(2px 안쪽) 평균. NVA 계약상 캐릭터는 캔버스 중앙,
 *  배경은 단색 flatten 이므로 모서리 = 배경색. 모서리가 이미 투명(서버 알파 webm)이면
 *  null = 키잉 불요. 모서리 4점의 색이 서로 크게 다르면(배경이 단색이 아님 — 실사 등)
 *  null = 키잉하면 안 되는 소스. */
export function sampleCornerKey(
	d: Uint8ClampedArray,
	w: number,
	h: number,
): [number, number, number] | null {
	if (w < 32 || h < 32) return null;
	const px = (x: number, y: number) => (y * w + x) * 4;
	// ⚠️ 인셋 = 변의 2%(최소 4px). 최외곽 2~3px 에서 뽑으면 h264 프레임 경계의 어두운
	// 테두리 아티팩트를 배경색으로 오인한다 — 2026-07-16 실측(Jina idle): 배경(254,240,213)
	// 균일한데 (2,2)=(239,225,199) → 키가 26 거리로 어긋나 97.8% 보존(배경 불투명).
	const ix = Math.max(4, Math.round(w * 0.02));
	const iy = Math.max(4, Math.round(h * 0.02));
	const pts = [
		px(ix, iy),
		px(w - 1 - ix, iy),
		px(ix, h - 1 - iy),
		px(w - 1 - ix, h - 1 - iy),
	];
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	for (const p of pts) {
		r += d[p];
		g += d[p + 1];
		b += d[p + 2];
		a += d[p + 3];
	}
	if (a / 4 < 250) return null; // 소스가 이미 알파 채널 보유 — 이중 키잉 금지
	r = Math.round(r / 4);
	g = Math.round(g / 4);
	b = Math.round(b / 4);
	for (const p of pts) {
		const dr = d[p] - r;
		const dg = d[p + 1] - g;
		const db = d[p + 2] - b;
		if (dr * dr + dg * dg + db * db > 8100) return null; // 모서리 불일치 = 단색 배경 아님
	}
	return [r, g, b];
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

/** 원격 cascade 의 활성 캐릭터 전환 — 셸 피커의 번들 폴더명(minho 등)을 서버 등록
 *  bundle_id(manifest meta.name, 예 "Minho" / "Naia (기본 캐릭터)")로 해석해
 *  `POST /use_character/{bundle_id}`. NVA 에디터와 동일 계약 — 이 호출이 없으면 셸에서
 *  아바타를 바꿔도 서버가 이전 캐릭터를 계속 내보낸다(2026-07-16 실기: jina/minho 무반응).
 *  음성은 분리 계약(PUT /voice)이라 캐릭터를 전환해도 음색은 안 바뀐다.
 *  매칭: bundle_id 정확일치 → bundle_id 접두일치 → name 접두일치 (대소문자 무시).
 *  실패/미등록 = false (서버 활성 캐릭터 유지 — fail-soft). */
export async function useCascadeCharacter(
	runtimeUrl: string,
	bundleName: string,
): Promise<boolean> {
	const base = runtimeUrl.replace(/\/$/, "");
	const want = bundleName.trim().toLowerCase();
	if (!want) return false;
	try {
		const res = await fetch(`${base}/characters`);
		if (!res.ok) return false;
		const list = (await res.json()) as Array<{
			bundle_id?: string;
			name?: string;
		}>;
		const hit =
			list.find((b) => (b.bundle_id ?? "").toLowerCase() === want) ??
			list.find((b) => (b.bundle_id ?? "").toLowerCase().startsWith(want)) ??
			list.find((b) => (b.name ?? "").toLowerCase().startsWith(want));
		if (!hit?.bundle_id) return false;
		const put = await fetch(
			`${base}/use_character/${encodeURIComponent(hit.bundle_id)}`,
			{ method: "POST" },
		);
		return put.ok;
	} catch {
		return false;
	}
}

/** 원격 cascade 에 선택 캐릭터가 활성화되도록 **보장**한다:
 *  ① `useCascadeCharacter` 로 전환 시도 → 성공이면 끝.
 *  ② 서버 미등록(예: 재부팅으로 /tmp 업로드분 소실)이라 실패하면 `uploader` 로 로컬 번들을
 *     서버에 업로드(`POST /upload_nva`, 에디터 casUpload 계약)한 뒤 **한 번 더** 전환 시도.
 *  uploader 는 Tauri invoke("upload_nva_bundle") 주입 — 이 함수 자체는 Tauri 비의존(테스트 가능).
 *  반환 = 최종 전환 성공 여부. 업로드가 throw 하면 false(서버 활성 캐릭터 유지, fail-soft). */
export async function ensureRemoteCharacter(
	runtimeUrl: string,
	bundleName: string,
	uploader: () => Promise<void>,
): Promise<boolean> {
	if (await useCascadeCharacter(runtimeUrl, bundleName)) return true;
	try {
		await uploader();
	} catch {
		return false;
	}
	return useCascadeCharacter(runtimeUrl, bundleName);
}

export class CascadeAvatarRenderer {
	private host: HTMLVideoElement | null = null;
	private buf: HTMLVideoElement | null = null;
	private active: HTMLVideoElement | null = null;
	private gen = 0; // 발화 세대 — barge-in/중복 무효화
	private disposed = false;
	private teardown: (() => void) | null = null;
	private idleObjectUrl: string | null = null;
	// ── 마스크(배경 제거) 캔버스 — NVA 플레이어(에디터 compose 루프) 이식 ──
	// NVA 계약은 투명 배경 캐릭터(manifest background=transparent)인데, cascade 불투명(mp4)
	// 출력은 배경이 단색으로 flatten 돼 온다. 플레이어(셸)가 프레임을 캔버스에 그리며 모서리
	// 샘플색(=flatten 배경색)과의 색거리<90 픽셀을 투명화한다. 서버가 알파 webm 을 주면
	// (모서리 알파<250) 키잉 없이 알파 보존 그대로 — 이중 처리 없음.
	private mask: HTMLCanvasElement | null = null;
	private maskOff: HTMLCanvasElement | null = null;
	private maskRaf = 0;
	private maskLastTs = 0;
	// ★2026-07-10 립싱크 직렬 큐(라이브 발화 폭주 근본수정): 여러 문장(TTS 청크)이 거의 동시에
	//   speak 를 호출해도 **하나씩 순서대로** 렌더/재생한다. 예전엔 각 speak 가 gen++ 로 이전을
	//   supersede → 서로 취소 + 백엔드(cascade facade)에 동시 /stream 폭주 → 단일 GPU 큐 적체 →
	//   facade 20s read 타임아웃으로 렌더 실패 → 립싱크·발화음성(webm mux) 둘 다 드롭.
	private speakQueue: Array<{
		text: string;
		audioWav?: Uint8Array;
		muted?: boolean;
		onPlaybackReady?: () => void;
		resolve: () => void;
	}> = [];
	private draining = false;

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

	/** 활성 레퍼런스 음색 설정 — cascade `PUT /voice` 계약(2026-07-16 3자 합의: NVA/캐릭터 전환과
	 *  독립된 런타임 음성). ⚠️ 외부(GCS 등) URL 을 **그대로 보내지 않는다** — 서버가 외부 파일을
	 *  다운로드해 레퍼런스로 쓰면 샘플레이트 불일치로 합성이 깨진 실증(2026-07-16 새벽, 시연 서버
	 *  무음 사고). cascade 는 같은 프리셋들의 48kHz 로컬 미러 팔레트(`GET /ref/voices` →
	 *  `/ref/audio/<name>`)를 가지므로, **파일명만 뽑아 팔레트 URL 로 변환**해 보낸다.
	 *  팔레트에 없는 이름 = 서버 400 fail-closed(기존 활성 음성 유지) → false.
	 *  미지정이면 아무것도 보내지 않아 서버 기본(naia 팔레트 default)이 유지된다. */
	async setVoice(refUrl: string | null | undefined): Promise<boolean> {
		const raw = refUrl?.trim();
		if (!raw) return false;
		const name = raw.split(/[/\\]/).pop()?.split("?")[0] ?? "";
		if (!/\.(wav|mp3|flac|ogg)$/i.test(name)) return false;
		const base = this.cfg.runtimeUrl.replace(/\/$/, "");
		try {
			const res = await fetch(this.streamUrl("/voice"), {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ audio_path: `${base}/ref/audio/${name}` }),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	private async loadIdle(hostVideo: HTMLVideoElement): Promise<void> {
		try {
			const res = await fetch(this.streamUrl("/idle"));
			if (!res.ok) return;
			const blob = await res.blob();
			if (this.disposed || blob.size === 0 || this.host !== hostVideo) return;
			if (this.idleObjectUrl) URL.revokeObjectURL(this.idleObjectUrl);
			this.idleObjectUrl = URL.createObjectURL(blob);
			hostVideo.src = this.idleObjectUrl;
			void hostVideo.play().catch(() => undefined);
		} catch {
			/* Health remains authoritative; the canvas keeps its reconnect state. */
		}
	}

	/** host 비디오에 idle 루프를 걸고, 그 위에 발화용 오버레이 buf 를 만든다. */
	start(hostVideo: HTMLVideoElement): void {
		this.host = hostVideo;
		this.disposed = false;
		const b = document.createElement("video");
		b.playsInline = true;
		b.muted = true;
		// ★2026-07-11 발화 오버레이(buf)를 idle(host)과 **정확히 겹치게**. 예전엔 buf=absolute 100%×100%
		//   라 host(VIDEO_BASE_STYLE=maxWidth min(100%,56vh)/maxHeight 92% 로 중앙 축소)보다 크게 떠서
		//   발화 영상이 다른 위치/크기(가운데 크게)로 나왔다(사용자 보고 — 발화 overlay가 이제
		//   화면에 떠서 원래 있던 버그가 드러남). host 의 크기제약(maxWidth/maxHeight)·objectFit 을
		//   **그대로 복사**하고 width/height=auto(→ 같은 비디오 = 같은 박스), **절대 중앙정렬**로 겹친다.
		//   pan(host transform)은 중앙정렬 뒤에 이어붙여 동일 위치. inline 복사라 반응형 유지.
		//   (grid-area 방식은 host 를 다음 행으로 밀어내 세로 어긋남 → absolute 중앙정렬로 회귀.)
		const _hcs = getComputedStyle(hostVideo);
		b.style.cssText =
			"position:absolute;top:50%;left:50%;width:auto;height:auto;opacity:0;transition:opacity .18s ease;pointer-events:none;z-index:1";
		b.style.maxWidth = hostVideo.style.maxWidth || "100%";
		b.style.maxHeight = hostVideo.style.maxHeight || "100%";
		b.style.objectFit = hostVideo.style.objectFit || _hcs.objectFit || "contain";
		b.style.transform = `translate(-50%,-50%) ${hostVideo.style.transform || ""}`.trim();
		b.style.background = _hcs.backgroundColor || "transparent";
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
		void this.loadIdle(hostVideo);
		this.active = hostVideo;

		// 마스크 캔버스 — buf 와 같은 박스/정렬로 videos 위(z-index 2)에 얹고, 원본 videos 는
		// visibility 로 숨긴다(재생/디코딩은 계속 — 캔버스가 매 프레임 여기서 읽어 그린다).
		// 오디오는 video 요소에서 그대로 나온다(visibility 는 음소거와 무관).
		const cvs = document.createElement("canvas");
		cvs.style.cssText =
			"position:absolute;top:50%;left:50%;width:auto;height:auto;pointer-events:none;z-index:2";
		cvs.style.maxWidth = hostVideo.style.maxWidth || "100%";
		cvs.style.maxHeight = hostVideo.style.maxHeight || "100%";
		cvs.style.transform = `translate(-50%,-50%) ${hostVideo.style.transform || ""}`.trim();
		if (parent) parent.appendChild(cvs);
		this.mask = cvs;
		this.maskOff = document.createElement("canvas");
		hostVideo.style.visibility = "hidden";
		b.style.visibility = "hidden";
		this.maskRaf = requestAnimationFrame(this.drawMask);
	}

	/** 마스크 렌더 루프 — 활성 비디오(idle host 또는 발화 buf) 프레임을 키잉해 캔버스에 그린다.
	 *  25fps 클립이므로 ~30ms 로 스로틀(불필요한 getImageData 절약). */
	private drawMask = (ts = 0): void => {
		if (this.disposed || !this.mask || !this.maskOff) return;
		if (ts - this.maskLastTs >= 30) {
			this.maskLastTs = ts;
			const v = this.active;
			if (v && v.readyState >= 2 && v.videoWidth > 0) {
				const w = v.videoWidth;
				const h = v.videoHeight;
				const off = this.maskOff;
				const cvs = this.mask;
				if (off.width !== w || off.height !== h) {
					off.width = w;
					off.height = h;
					cvs.width = w;
					cvs.height = h;
				}
				const octx = off.getContext("2d", { willReadFrequently: true });
				const ctx = cvs.getContext("2d");
				if (octx && ctx) {
					octx.clearRect(0, 0, w, h);
					octx.drawImage(v, 0, 0, w, h);
					try {
						const img = octx.getImageData(0, 0, w, h);
						const key = sampleCornerKey(img.data, w, h);
						if (key) chromaKeyImage(img.data, key[0], key[1], key[2]);
						ctx.clearRect(0, 0, w, h);
						ctx.putImageData(img, 0, 0);
						if (key) {
							// h264 프레임 최외곽의 어두운 경계 아티팩트(실측: 좌우 6px 밴드 —
							// keyed 잔존 col 0~5·714~719, Minho/Jina idle)를 링으로 제거.
							// NVA 프레이밍상 캐릭터가 최외곽 8px 에 닿지 않으므로 안전.
							// 키잉이 켜진(불투명 flatten) 프레임에만 적용.
							const RING = 8;
							ctx.clearRect(0, 0, w, RING);
							ctx.clearRect(0, h - RING, w, RING);
							ctx.clearRect(0, 0, RING, h);
							ctx.clearRect(w - RING, 0, RING, h);
						}
					} catch {
						// getImageData 실패(taint 등) — 키잉 포기, 원본 프레임 그대로 노출
						ctx.clearRect(0, 0, w, h);
						ctx.drawImage(v, 0, 0, w, h);
					}
				}
			}
		}
		this.maskRaf = requestAnimationFrame(this.drawMask);
	};

	/** 발화 요청 — **직렬 큐**에 넣어 하나씩 순서대로 렌더/재생한다(동시 폭주 방지). 여러 문장의
	 *  TTS 청크가 거의 동시에 speakAudio→speak 를 호출해도, 각 발화는 앞 발화가 끝난 뒤 시작한다.
	 *  interrupt()/stop() 이 대기 큐를 비운다(barge-in). 실제 렌더/재생은 speakNow. */
	async speak(
		text: string,
		audioWav?: Uint8Array,
		opts?: { muted?: boolean; onPlaybackReady?: () => void },
	): Promise<void> {
		const t = text.trim();
		if ((!t && !audioWav) || this.disposed || !this.buf) return;
		await new Promise<void>((resolve) => {
			this.speakQueue.push({
				text,
				audioWav,
				muted: opts?.muted,
				onPlaybackReady: opts?.onPlaybackReady,
				resolve,
			});
			void this.drainSpeakQueue();
		});
	}

	/** 큐를 하나씩 순차 처리(재진입 방지). 한 발화가 끝나야 다음이 시작 → 백엔드에 /stream 이
	 *  항상 1건만 in-flight → 큐 적체·타임아웃 소멸. disposed/큐비움 시 종료. */
	private async drainSpeakQueue(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.speakQueue.length && !this.disposed) {
				const item = this.speakQueue.shift()!;
				try {
					await this.speakNow(
						item.text,
						item.audioWav,
						item.muted,
						item.onPlaybackReady,
					);
				} finally {
					item.resolve();
				}
			}
		} finally {
			this.draining = false;
			// drain 도중 새로 들어온 항목이 있으면 이어서 처리(경합 방지).
			if (this.speakQueue.length && !this.disposed) void this.drainSpeakQueue();
		}
	}

	/** 텍스트 발화(직렬 큐 drainSpeakQueue 가 호출) — audioWav 미지정 시 cascade 내장 TTS(/stream_text),
	 *  지정 시 /stream(wav). 응답 Content-Type 로 렌더 방식 결정:
	 *   - video/webm(완전 파일, composite 마스크 video/알파) → Blob → `<video>.src` (전체 수신 후 재생).
	 *   - video/mp4(fragmented) → MSE 이중버퍼(첫 청크부터 저지연 재생).
	 *  ★composite 알파 webm 은 스트리밍 시 duration/cues 부재로 `<video>`가 비디오 트랙을 못 넘김
	 *   (오디오만·화면정지) → 서버가 **완전한 webm 파일**로 출력하고 클라는 Blob 으로 받아야 한다
	 *   (avatar_ditto_composite.py 의 "완전한 webm 파일로 출력" 주석과 대칭). */
	private async speakNow(
		text: string,
		audioWav?: Uint8Array,
		muted = false,
		onPlaybackReady?: () => void,
	): Promise<void> {
		const t = text.trim();
		if ((!t && !audioWav) || this.disposed || !this.buf) return;
		const my = ++this.gen;
		let playbackReadySignaled = false;
		const signalPlaybackReady = () => {
			if (playbackReadySignaled) return;
			playbackReadySignaled = true;
			onPlaybackReady?.();
		};
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
				await this.renderWebmFile(res, back, my, muted, signalPlaybackReady);
			} else {
				await this.renderMseStream(res, back, my, muted, signalPlaybackReady);
			}
			} catch (e) {
				if (my === this.gen) {
					Logger.warn("cascade-avatar", "speak 실패 — 이 발화 드롭", {
						error: e instanceof Error ? e.message : String(e),
					});
				}
		} finally {
			// Never swallow speech when rendering fails or returns an empty stream.
			signalPlaybackReady();
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
		muted = false,
		onPlaybackReady?: () => void,
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
			onPlaybackReady?.();
			// Split mode keeps the stream muted; the first frame releases local audio.
			if (!muted) back.muted = false;
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
		muted = false,
		onPlaybackReady?: () => void,
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
			onPlaybackReady?.();
			// A WebM may contain Opus. Split mode stays muted because local audio is released here.
			if (!muted) back.muted = false;
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
	async speakAudio(
		audioBase64: string,
		sampleRate = 24000,
		opts?: { muted?: boolean; onPlaybackReady?: () => void },
	): Promise<void> {
		if (!audioBase64 || this.disposed) return;
		return this.speak("(audio)", ttsAudioToWav(audioBase64, sampleRate), opts);
	}

	/** 대기 큐 비우기 — 각 대기자를 조용히 resolve(await 행 방지). interrupt/stop 공용. */
	private clearSpeakQueue(): void {
		const pending = this.speakQueue;
		this.speakQueue = [];
		for (const p of pending) p.resolve();
	}

	/** 현재 발화 즉시 중단(barge-in). 대기 중인 큐도 모두 취소한다. */
	interrupt(): void {
		this.clearSpeakQueue();
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
		this.clearSpeakQueue();
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
		if (this.idleObjectUrl) {
			URL.revokeObjectURL(this.idleObjectUrl);
			this.idleObjectUrl = null;
		}
		this.buf = null;
		if (this.maskRaf) cancelAnimationFrame(this.maskRaf);
		this.maskRaf = 0;
		this.mask?.remove();
		this.mask = null;
		this.maskOff = null;
	}
}
