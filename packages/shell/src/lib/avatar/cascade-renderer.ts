import { Logger } from "../logger";
/**
 * CascadeAvatarRenderer ??NVA 鍮꾨뵒???꾨컮???"留먰븯??????cascade ?고??꾩뿉??諛쏆븘 洹몃━???뚮뜑??
 *
 * ?꾪궎?띿쿂(TalkingKiosk `nva-renderer.ts` 寃利?濡쒖쭅 ?댁떇): ?대씪?댁뼵?몃뒗 **?뉗? MSE ?댁쨷踰꾪띁 ?뚮퉬??*.
 * ?ㅼ젣 由쎌떛???쎌?? cascade ?고???Ditto TRT, GPU)???앹꽦??fragmented MP4(?먮뒗 ?뚰뙆 webm)濡??ㅽ듃由щ컢?쒕떎.
 *   - host(`<video>`) = idle 猷⑦봽(`GET {runtimeUrl}/idle`) ??鍮꾨컻?????몄텧.
 *   - buf(?ㅻ쾭?덉씠 `<video>`) = 諛쒗솕 ?ㅽ듃由?`POST /stream_text` ?먮뒗 `/stream`) ??泥??꾨젅?꾩뿉 host ?꾨줈 swap.
 *
 * naia-os ?곸쓳(TalkingKiosk ?鍮?李⑥씠):
 *   - gs:// 寃쎈줈 ?쒓굅 ??cascade 媛 `/load_nva` 濡??대? 濡쒕뱶??罹먮┃?곕? ?대떎(?꾩슂 ??`nvaName` query).
 *   - runtimeUrl = 濡쒖뺄 ?꾨쿋??cascade facade(??http://127.0.0.1:8910) ?먮뒗 ?먭꺽 GPU PC URL.
 *   - CODEC ?ㅼ젙 媛??facade 媛 mp4/webm 以?臾댁뾿??二쇰뒗吏???곕쫫).
 *   - `probeHealth()` ?뺤쟻 ?ы띁 ??VideoAvatarCanvas 媛 cascade ?꾨떖 媛???щ?濡?紐⑤뱶(cascade/誘몄뿰寃? 寃곗젙.
 *
 * SoT: .agents/progress/naia-os-cascade-talking-avatar-2026-07-01.md
 */

/** TalkingKiosk 湲곕낯 肄붾뜳(H.264 Constrained Baseline + AAC). ?뚰뙆媛 ?꾩슂?섎㈃ webm 肄붾뜳?쇰줈 override. */
export const DEFAULT_CASCADE_CODEC =
	'video/mp4; codecs="avc1.42E01F, mp4a.40.2"';

/** 諛쒗솕 醫낅즺 ?湲??곹븳(?쒕쾭 ??諛⑹?). RTF~0.95 ???듭긽 ??珥? */
const ENDED_WAIT_CAP_MS = 300_000;

/** ?딄?(?몃뜑?? 諛⑹????뚮웾 ?꾨━踰꾪띁(珥? ??泥?泥?겕 利됱떆 ?ъ깮 ????대쭔???볦? ???쒖옉. */
const PREBUFFER_S = 0.2;

export interface CascadeRendererConfig {
	/** cascade facade(output_cascade) ?덈?/?곷? URL. ?? http://127.0.0.1:8910 ?먮뒗 https://gpu-pc/avatar */
	runtimeUrl: string;
	/** cascade 媛 硫??罹먮┃?곗씪 ???좏깮???듭뀡). 蹂댄넻 /load_nva 濡?誘몃━ 濡쒕뱶?섎?濡??앸왂. */
	nvaName?: string;
	/** MSE SourceBuffer 肄붾뜳. 湲곕낯 mp4(avc1+aac). ?뚰뙆 webm ?대㈃ ?몄텧痢≪씠 override. */
	codec?: string;
}

/**
 * `start_cascade` ??CASCADE_READY ?섏씠濡쒕뱶(JSON 臾몄옄???먯꽌 **濡쒖뺄** facade URL ?좊룄.
 * ?꾨컮?(ditto) ?쒕퉬?ㅺ? ?ㅼ젣濡????덉쓣 ?뚮쭔 URL 諛섑솚 ??由쎌떛??媛?ν븳 寃쎌슦?먮쭔 濡쒖뺄 諛곗꽑.
 * (focus=voice 濡?avatar ?쒕퉬?ㅺ? ?놁쑝硫?null ??VideoAvatarCanvas ??"誘몄뿰寃?濡??쒖떆, ?꾨컮? ?몄텧 ????)
 * ?뚯떛 ?ㅽ뙣 / facade_port 遺??/ avatar ?쒕퉬??遺????null(?덉쟾).
 * ?섏씠濡쒕뱶 怨꾩빟: windows-manager `loader/launcher.py` supervise() = `{facade_port, services:[{kind}]}`.
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

export function remoteCascadeUrlFromConfig(
	config:
		| {
				naiaKey?: string | null;
				cascadeRuntimeUrl?: string | null;
		  }
		| null
		| undefined,
): string | undefined {
	if (!config?.naiaKey) return undefined;
	const url = config.cascadeRuntimeUrl?.trim();
	return url || undefined;
}

/**
 * The desktop's local-voice endpoint is the cascade facade, not the private
 * VoxCPM2 worker.  An explicitly selected local avatar profile can therefore
 * reconnect to an already-running :8910 facade after a Shell restart instead
 * of trying to launch a second cascade process.
 *
 * Keep this deliberately narrow: a non-loopback TTS URL is only a voice
 * endpoint and must never be treated as an avatar runtime.
 */
export function localCascadeUrlFromConfig(
	config:
		| {
				ttsProvider?: string | null;
				vllmTtsHost?: string | null;
		  }
		| null
		| undefined,
): string | undefined {
	if (config?.ttsProvider !== "naia-local-voice") return undefined;
	const raw = config.vllmTtsHost?.trim();
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		const isLoopback =
			url.hostname === "localhost" ||
			url.hostname === "127.0.0.1" ||
			url.hostname === "[::1]";
		if (!isLoopback || url.port !== "8910") return undefined;
		return raw.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

/** PCM16 mono ??WAV 而⑦뀒?대꼫. speakAudio(?몃? TTS PCM)瑜?/stream(wav)濡?蹂대궡湲??꾪븿. */
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
 * ?몃? TTS ?ㅻ뵒??base64) ??/stream ??蹂대궪 WAV bytes.
 *  - RIFF/WAVE 而⑦뀒?대꼫硫?洹몃?濡?寃뚯씠?몄썾??LINEAR16 = Google TTS ??WAV 濡?諛섑솚).
 *  - raw PCM16(?ㅻ뜑 ?놁쓬)?대㈃ sampleRate 濡?WAV 而⑦뀒?대꼫瑜??뚯?.
 * trt /stream ? librosa.load(sr=16000) 濡?WAV ?ㅻ뜑?????섑뵆?덉씠?몃? ?쎌뼱 16k 濡?由ъ깦?뚰븯誘濡?
 * ?대? WAV ??寃껋쓣 ?ㅼ떆 媛먯떥硫??댁쨷 WAV) librosa 媛 ?ㅻ뜑瑜?PCM ?쇰줈 ?ㅻ룆 ???몄씠利? 洹몃옒??媛먯? ?꾩슂.
 */
export function ttsAudioToWav(
	audioBase64: string,
	sampleRate: number,
): Uint8Array {
	const bin = atob(audioBase64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	// "RIFF"(0x52494646) + offset8 "WAVE"(0x57415645) ???대? WAV 而⑦뀒?대꼫.
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

/** ?щ줈留??ㅼ엵 ??NVA ?뚮젅?댁뼱(?먮뵒??compose)???됯굅由??ㅼ엵 ?댁떇 + ?좊━猷?蹂댁젙.
 *  ?먮뵒???먮낯? ?쒖닔 ?щ줈留?珥덈줉) 諛곌꼍 ?꾩젣??嫄곕━<90 ?쇨큵 ?щ챸?붿?留? ?몄씠 諛쏅뒗 ?꾨젅?꾩?
 *  **flatten 諛곌꼍**?닿퀬 ?섏씠??紐몄씠 ?좊━(諛섑닾紐? 猷?= 諛곌꼍怨??됱씠 媛源뚯썙 90 ?대㈃ 紐멸퉴吏 鍮좎쭊??
 *  (2026-07-16 ?ㅺ린 "?뚰뙆 怨쇳븿"). 洹몃옒???댁쨷 ?꾧퀎:
 *   - ?됯굅由???hard(湲곕낯 24) = ?쒖닔 諛곌꼍 ???꾩쟾 ?щ챸 (h264 ?뺤텞 ?몄씠利??≪닔 ?ъ쑀)
 *   - hard~soft(湲곕낯 56)     = 諛곌꼍 洹쇱젒(?좊━ 媛?μ옄由? ??嫄곕━ 鍮꾨? ?섎뜑(諛섑닾紐?
 *   - 洹?諛?                 = 罹먮┃????蹂댁〈 */
export function chromaKeyImage(
	d: Uint8ClampedArray,
	r: number,
	g: number,
	b: number,
	// ?좑툘 湲곕낯媛?珥덈낫??2026-07-16 ?ㅺ린 2李?: ?섏씠??紐??좊━(諛섑닾紐?踰좎씠????諛곌꼍怨??됱씠 ?욎뿬
	// ?덉뼱 ?꾧퀎瑜?議곌툑留??ㅼ썙??紐몄씠 ?듭㎏濡??ル┛??"???ル젮蹂댁뿬"). ?됯굅由??ㅼ엵? flatten 諛곌꼍??
	// 洹쇱궗 ?쒓굅源뚯?留??대떦?섍퀬, **吏꾩쭨 留덉뒪?щ뒗 ?쒕쾭 ?뚰뙆(VP9 yuva420p) 梨꾨꼸???뺣낯** ???뚰뙆媛
	// ?ㅻ㈃ sampleCornerKey 媛 null ??諛섑솚?????⑥닔 ?먯껜媛 ?몄텧?섏? ?딅뒗??
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

/** ?꾨젅??諛곌꼍(?? ??異붿텧 ??4紐⑥꽌由?2px ?덉そ) ?됯퇏. NVA 怨꾩빟??罹먮┃?곕뒗 罹붾쾭??以묒븰,
 *  諛곌꼍? ?⑥깋 flatten ?대?濡?紐⑥꽌由?= 諛곌꼍?? 紐⑥꽌由ш? ?대? ?щ챸(?쒕쾭 ?뚰뙆 webm)?대㈃
 *  null = ?ㅼ엵 遺덉슂. 紐⑥꽌由?4?먯쓽 ?됱씠 ?쒕줈 ?ш쾶 ?ㅻⅤ硫?諛곌꼍???⑥깋???꾨떂 ???ㅼ궗 ??
 *  null = ?ㅼ엵?섎㈃ ???섎뒗 ?뚯뒪. */
export function sampleCornerKey(
	d: Uint8ClampedArray,
	w: number,
	h: number,
): [number, number, number] | null {
	if (w < 32 || h < 32) return null;
	const px = (x: number, y: number) => (y * w + x) * 4;
	// ?좑툘 ?몄뀑 = 蹂??2%(理쒖냼 4px). 理쒖쇅怨?2~3px ?먯꽌 戮묒쑝硫?h264 ?꾨젅??寃쎄퀎???대몢??
	// ?뚮몢由??꾪떚?⑺듃瑜?諛곌꼍?됱쑝濡??ㅼ씤?쒕떎 ??2026-07-16 ?ㅼ륫(Jina idle): 諛곌꼍(254,240,213)
	// 洹좎씪?쒕뜲 (2,2)=(239,225,199) ???ㅺ? 26 嫄곕━濡??닿툔??97.8% 蹂댁〈(諛곌꼍 遺덊닾紐?.
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
	if (a / 4 < 250) return null; // ?뚯뒪媛 ?대? ?뚰뙆 梨꾨꼸 蹂댁쑀 ???댁쨷 ?ㅼ엵 湲덉?
	r = Math.round(r / 4);
	g = Math.round(g / 4);
	b = Math.round(b / 4);
	for (const p of pts) {
		const dr = d[p] - r;
		const dg = d[p + 1] - g;
		const db = d[p + 2] - b;
		if (dr * dr + dg * dg + db * db > 8100) return null; // 紐⑥꽌由?遺덉씪移?= ?⑥깋 諛곌꼍 ?꾨떂
	}
	return [r, g, b];
}

/** cascade ?꾨떖 媛???щ? ??`GET {url}/health`. VideoAvatarCanvas ??紐⑤뱶 寃곗젙???대떎. */
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
		// facade /health ??{ok, ...} ?먮뒗 諛깆뿏??not-ready ??503. ok ?꾨뱶 ?곗꽑, ?놁쑝硫?res.ok.
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

/** ?먭꺽 cascade ???쒖꽦 罹먮┃???꾪솚 ?????쇱빱??踰덈뱾 ?대뜑紐?minho ?????쒕쾭 ?깅줉
 *  bundle_id(manifest meta.name, ??"Minho" / "Naia (湲곕낯 罹먮┃??")濡??댁꽍??
 *  `POST /use_character/{bundle_id}`. NVA ?먮뵒?곗? ?숈씪 怨꾩빟 ?????몄텧???놁쑝硫??몄뿉??
 *  ?꾨컮?瑜?諛붽퓭???쒕쾭媛 ?댁쟾 罹먮┃?곕? 怨꾩냽 ?대낫?몃떎(2026-07-16 ?ㅺ린: jina/minho 臾대컲??.
 *  ?뚯꽦? 遺꾨━ 怨꾩빟(PUT /voice)?대씪 罹먮┃?곕? ?꾪솚?대룄 ?뚯깋? ??諛붾먮떎.
 *  留ㅼ묶: bundle_id ?뺥솗?쇱튂 ??bundle_id ?묐몢?쇱튂 ??name ?묐몢?쇱튂 (??뚮Ц??臾댁떆).
 *  ?ㅽ뙣/誘몃벑濡?= false (?쒕쾭 ?쒖꽦 罹먮┃???좎? ??fail-soft). */
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

/** ?먭꺽 cascade ???좏깮 罹먮┃?곌? ?쒖꽦?붾릺?꾨줉 **蹂댁옣**?쒕떎:
 *  ??`useCascadeCharacter` 濡??꾪솚 ?쒕룄 ???깃났?대㈃ ??
 *  ???쒕쾭 誘몃벑濡??? ?щ??낆쑝濡?/tmp ?낅줈?쒕텇 ?뚯떎)?대씪 ?ㅽ뙣?섎㈃ `uploader` 濡?濡쒖뺄 踰덈뱾??
 *     ?쒕쾭???낅줈??`POST /upload_nva`, ?먮뵒??casUpload 怨꾩빟)????**??踰???* ?꾪솚 ?쒕룄.
 *  uploader ??Tauri invoke("upload_nva_bundle") 二쇱엯 ?????⑥닔 ?먯껜??Tauri 鍮꾩쓽議??뚯뒪??媛??.
 *  諛섑솚 = 理쒖쥌 ?꾪솚 ?깃났 ?щ?. ?낅줈?쒓? throw ?섎㈃ false(?쒕쾭 ?쒖꽦 罹먮┃???좎?, fail-soft). */
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
	private gen = 0; // 諛쒗솕 ?몃? ??barge-in/以묐났 臾댄슚??
	private disposed = false;
	private teardown: (() => void) | null = null;
	private idleObjectUrl: string | null = null;
	// ?? 留덉뒪??諛곌꼍 ?쒓굅) 罹붾쾭????NVA ?뚮젅?댁뼱(?먮뵒??compose 猷⑦봽) ?댁떇 ??
	// NVA 怨꾩빟? ?щ챸 諛곌꼍 罹먮┃??manifest background=transparent)?몃뜲, cascade 遺덊닾紐?mp4)
	// 異쒕젰? 諛곌꼍???⑥깋?쇰줈 flatten ???⑤떎. ?뚮젅?댁뼱(??媛 ?꾨젅?꾩쓣 罹붾쾭?ㅼ뿉 洹몃━硫?紐⑥꽌由?
	// ?섑뵆??=flatten 諛곌꼍??怨쇱쓽 ?됯굅由?90 ?쎌????щ챸?뷀븳?? ?쒕쾭媛 ?뚰뙆 webm ??二쇰㈃
	// (紐⑥꽌由??뚰뙆<250) ?ㅼ엵 ?놁씠 ?뚰뙆 蹂댁〈 洹몃?濡????댁쨷 泥섎━ ?놁쓬.
	private mask: HTMLCanvasElement | null = null;
	private maskOff: HTMLCanvasElement | null = null;
	private maskRaf = 0;
	private maskLastTs = 0;
	// ??026-07-10 由쎌떛??吏곷젹 ???쇱씠釉?諛쒗솕 ??＜ 洹쇰낯?섏젙): ?щ윭 臾몄옣(TTS 泥?겕)??嫄곗쓽 ?숈떆??
	//   speak 瑜??몄텧?대룄 **?섎굹???쒖꽌?濡?* ?뚮뜑/?ъ깮?쒕떎. ?덉쟾??媛?speak 媛 gen++ 濡??댁쟾??
	//   supersede ???쒕줈 痍⑥냼 + 諛깆뿏??cascade facade)???숈떆 /stream ??＜ ???⑥씪 GPU ???곸껜 ??
	//   facade 20s read ??꾩븘?껋쑝濡??뚮뜑 ?ㅽ뙣 ??由쎌떛??룸컻?붿쓬??webm mux) ?????쒕∼.
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
		/** 諛쒗솕 ?쒖옉/醫낅즺 肄쒕갚(?먮쭑쨌STT ?먯퐫寃뚯씠?맞톝etSpeaking ?숆린?붿슜). */
		private readonly onTalking?: (talking: boolean) => void,
	) {}

	private get codec(): string {
		return this.cfg.codec ?? DEFAULT_CASCADE_CODEC;
	}

	/** ?고????붾뱶?ъ씤??URL. nvaName ???덉쑝硫?query 濡?遺李? ?곷?寃쎈줈??location.origin 湲곗? ?댁꽍. */
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

	/** ?쒖꽦 ?덊띁?곗뒪 ?뚯깋 ?ㅼ젙 ??cascade `PUT /voice` 怨꾩빟(2026-07-16 3???⑹쓽: NVA/罹먮┃???꾪솚怨?
	 *  ?낅┰???고????뚯꽦). ?좑툘 ?몃?(GCS ?? URL ??**洹몃?濡?蹂대궡吏 ?딅뒗??* ???쒕쾭媛 ?몃? ?뚯씪??
	 *  ?ㅼ슫濡쒕뱶???덊띁?곗뒪濡??곕㈃ ?섑뵆?덉씠??遺덉씪移섎줈 ?⑹꽦??源⑥쭊 ?ㅼ쬆(2026-07-16 ?덈꼍, ?쒖뿰 ?쒕쾭
	 *  臾댁쓬 ?ш퀬). cascade ??媛숈? ?꾨━?뗫뱾??48kHz 濡쒖뺄 誘몃윭 ?붾젅??`GET /ref/voices` ??
	 *  `/ref/audio/<name>`)瑜?媛吏誘濡? **?뚯씪紐낅쭔 戮묒븘 ?붾젅??URL 濡?蹂??*??蹂대궦??
	 *  ?붾젅?몄뿉 ?녿뒗 ?대쫫 = ?쒕쾭 400 fail-closed(湲곗〈 ?쒖꽦 ?뚯꽦 ?좎?) ??false.
	 *  誘몄??뺤씠硫??꾨Т寃껊룄 蹂대궡吏 ?딆븘 ?쒕쾭 湲곕낯(naia ?붾젅??default)???좎??쒕떎. */
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

	/** host 鍮꾨뵒?ㅼ뿉 idle 猷⑦봽瑜?嫄멸퀬, 洹??꾩뿉 諛쒗솕???ㅻ쾭?덉씠 buf 瑜?留뚮뱺?? */
	start(hostVideo: HTMLVideoElement): void {
		this.host = hostVideo;
		this.disposed = false;
		const b = document.createElement("video");
		b.playsInline = true;
		b.muted = true;
		// ??026-07-11 諛쒗솕 ?ㅻ쾭?덉씠(buf)瑜?idle(host)怨?**?뺥솗??寃뱀튂寃?*. ?덉쟾??buf=absolute 100%횞100%
		//   ??host(VIDEO_BASE_STYLE=maxWidth min(100%,56vh)/maxHeight 92% 濡?以묒븰 異뺤냼)蹂대떎 ?ш쾶 ?좎꽌
		//   諛쒗솕 ?곸긽???ㅻⅨ ?꾩튂/?ш린(媛?대뜲 ?ш쾶)濡??섏솕???ъ슜??蹂닿퀬 ??諛쒗솕 overlay媛 ?댁젣
		//   ?붾㈃???좎꽌 ?먮옒 ?덈뜕 踰꾧렇媛 ?쒕윭??. host ???ш린?쒖빟(maxWidth/maxHeight)쨌objectFit ??
		//   **洹몃?濡?蹂듭궗**?섍퀬 width/height=auto(??媛숈? 鍮꾨뵒??= 媛숈? 諛뺤뒪), **?덈? 以묒븰?뺣젹**濡?寃뱀튇??
		//   pan(host transform)? 以묒븰?뺣젹 ?ㅼ뿉 ?댁뼱遺숈뿬 ?숈씪 ?꾩튂. inline 蹂듭궗??諛섏쓳???좎?.
		//   (grid-area 諛⑹떇? host 瑜??ㅼ쓬 ?됱쑝濡?諛?대궡 ?몃줈 ?닿툔????absolute 以묒븰?뺣젹濡??뚭?.)
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

		// 留덉뒪??罹붾쾭????buf ? 媛숈? 諛뺤뒪/?뺣젹濡?videos ??z-index 2)???밴퀬, ?먮낯 videos ??
		// visibility 濡??④릿???ъ깮/?붿퐫?⑹? 怨꾩냽 ??罹붾쾭?ㅺ? 留??꾨젅???ш린???쎌뼱 洹몃┛??.
		// ?ㅻ뵒?ㅻ뒗 video ?붿냼?먯꽌 洹몃?濡??섏삩??visibility ???뚯냼嫄곗? 臾닿?).
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

	/** 留덉뒪???뚮뜑 猷⑦봽 ???쒖꽦 鍮꾨뵒??idle host ?먮뒗 諛쒗솕 buf) ?꾨젅?꾩쓣 ?ㅼ엵??罹붾쾭?ㅼ뿉 洹몃┛??
	 *  25fps ?대┰?대?濡?~30ms 濡??ㅻ줈?(遺덊븘?뷀븳 getImageData ?덉빟). */
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
							// h264 ?꾨젅??理쒖쇅怨쎌쓽 ?대몢??寃쎄퀎 ?꾪떚?⑺듃(?ㅼ륫: 醫뚯슦 6px 諛대뱶 ??
							// keyed ?붿〈 col 0~5쨌714~719, Minho/Jina idle)瑜?留곸쑝濡??쒓굅.
							// NVA ?꾨젅?대컢??罹먮┃?곌? 理쒖쇅怨?8px ???우? ?딆쑝誘濡??덉쟾.
							// ?ㅼ엵??耳쒖쭊(遺덊닾紐?flatten) ?꾨젅?꾩뿉留??곸슜.
							const RING = 8;
							ctx.clearRect(0, 0, w, RING);
							ctx.clearRect(0, h - RING, w, RING);
							ctx.clearRect(0, 0, RING, h);
							ctx.clearRect(w - RING, 0, RING, h);
						}
					} catch {
						// getImageData ?ㅽ뙣(taint ?? ???ㅼ엵 ?ш린, ?먮낯 ?꾨젅??洹몃?濡??몄텧
						ctx.clearRect(0, 0, w, h);
						ctx.drawImage(v, 0, 0, w, h);
					}
				}
			}
		}
		this.maskRaf = requestAnimationFrame(this.drawMask);
	};

	/** 諛쒗솕 ?붿껌 ??**吏곷젹 ??*???ｌ뼱 ?섎굹???쒖꽌?濡??뚮뜑/?ъ깮?쒕떎(?숈떆 ??＜ 諛⑹?). ?щ윭 臾몄옣??
	 *  TTS 泥?겕媛 嫄곗쓽 ?숈떆??speakAudio?뭩peak 瑜??몄텧?대룄, 媛?諛쒗솕????諛쒗솕媛 ?앸궃 ???쒖옉?쒕떎.
	 *  interrupt()/stop() ???湲??먮? 鍮꾩슫??barge-in). ?ㅼ젣 ?뚮뜑/?ъ깮? speakNow. */
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

	/** ?먮? ?섎굹???쒖감 泥섎━(?ъ쭊??諛⑹?). ??諛쒗솕媛 ?앸굹???ㅼ쓬???쒖옉 ??諛깆뿏?쒖뿉 /stream ??
	 *  ??긽 1嫄대쭔 in-flight ?????곸껜쨌??꾩븘???뚮㈇. disposed/?먮퉬? ??醫낅즺. */
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
			// drain ?꾩쨷 ?덈줈 ?ㅼ뼱????ぉ???덉쑝硫??댁뼱??泥섎━(寃쏀빀 諛⑹?).
			if (this.speakQueue.length && !this.disposed) void this.drainSpeakQueue();
		}
	}

	/** ?띿뒪??諛쒗솕(吏곷젹 ??drainSpeakQueue 媛 ?몄텧) ??audioWav 誘몄?????cascade ?댁옣 TTS(/stream_text),
	 *  吏????/stream(wav). ?묐떟 Content-Type 濡??뚮뜑 諛⑹떇 寃곗젙:
	 *   - video/webm(?꾩쟾 ?뚯씪, composite 留덉뒪??video/?뚰뙆) ??Blob ??`<video>.src` (?꾩껜 ?섏떊 ???ъ깮).
	 *   - video/mp4(fragmented) ??MSE ?댁쨷踰꾪띁(泥?泥?겕遺???吏???ъ깮).
	 *  ?꿤omposite ?뚰뙆 webm ? ?ㅽ듃由щ컢 ??duration/cues 遺?щ줈 `<video>`媛 鍮꾨뵒???몃옓??紐??섍?
	 *   (?ㅻ뵒?ㅻ쭔쨌?붾㈃?뺤?) ???쒕쾭媛 **?꾩쟾??webm ?뚯씪**濡?異쒕젰?섍퀬 ?대씪??Blob ?쇰줈 諛쏆븘???쒕떎
	 *   (avatar_ditto_composite.py ??"?꾩쟾??webm ?뚯씪濡?異쒕젰" 二쇱꽍怨??移?. */
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
				Logger.warn("cascade-avatar", "speak failed before playback", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		} finally {
			// Never swallow speech when rendering fails or returns an empty stream.
			signalPlaybackReady();
			// ?낇쁽 ?몃?留??먭린 ?뺣━瑜??쒕떎. 諛쒗솕媛 ??speak/interrupt/stop ?쇰줈 ?泥대릺硫?gen ???щ씪媛怨?
			//   洹??泥댁옄媛 ?먭린 ?쒖옉 ??runTeardown ?쇰줈 **???몃???* cleanup ???대? ?ㅽ뻾?쒕떎. ?ш린??
			//   ??runTeardown ?섎㈃ this.teardown ??媛由ы궎??**???덈줈???몃?**??cleanup ???섎せ ?ㅽ뻾??
			//   ?꾩옱 諛쒗솕??objectURL ??revoke ?섍퀬 swap/ended 由ъ뒪?덈? ?쇱뼱踰꾨┛???뺤껜??媛???곸떎 ?뚭?).
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

	/** 諛쒗솕 醫낅즺 ?湲???`ended` ?대깽???먮뒗 ?대쭅(back.ended)쨌?곹븳(ENDED_WAIT_CAP_MS). endedFn ?깅줉 肄쒕갚?쇰줈
	 *  ?몄텧痢?cleanup ??由ъ뒪?덈? ?쒓굅?섍쾶 ?쒕떎. barge-in(gen 蹂寃? ??利됱떆 resolve. */
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

	/** fragmented mp4 ?ㅽ듃由???MSE ?댁쨷踰꾪띁. 泥?泥?겕遺???ъ깮, swap ??host ?꾨줈 ?몄텧. */
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
				/* updating 以묒씠嫄곕굹 ?대? ?ロ옒 */
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
					/* SourceBuffer ?ロ옒/?쒓굅 寃쏀빀 ??臾댁떆 */
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
		if (first) return; // 鍮??ㅽ듃由???利됱떆 醫낅즺(怨좎갑 ?뚰뵾)
		await this.waitEnded(back, my, (fn) => {
			endedFn = fn;
		});
	}

	/** ?꾩쟾??VP9 ?뚰뙆 webm ?뚯씪(composite 留덉뒪??video) ??Blob ??`<video>.src`.
	 *  ?꾩껜 ?섏떊 ???ъ깮(?ㅽ듃由щ컢 webm ? 釉뚮씪?곗?媛 鍮꾨뵒???몃옓??紐??섍?). webm ???ㅻ뵒??opus)
	 *  ?ы븿 ??swap ??unmute 濡?諛쒗솕 ?뚯꽦 ?ъ깮. */
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
	 * ?몃? TTS ?ㅻ뵒??base64) 二쇱엯 ??/stream 由쎌떛?? WAV 而⑦뀒?대꼫硫?洹몃?濡? raw PCM16 ?대㈃
	 * sampleRate 濡?媛먯떬??ttsAudioToWav ???댁쨷 WAV 諛⑹?). 寃뚯씠?몄썾??LINEAR16 = Google TTS WAV.
	 */
	async speakAudio(
		audioBase64: string,
		sampleRate = 24000,
		opts?: { muted?: boolean; onPlaybackReady?: () => void },
	): Promise<void> {
		if (!audioBase64 || this.disposed) return;
		return this.speak("(audio)", ttsAudioToWav(audioBase64, sampleRate), opts);
	}

	/** ?湲???鍮꾩슦湲???媛??湲곗옄瑜?議곗슜??resolve(await ??諛⑹?). interrupt/stop 怨듭슜. */
	private clearSpeakQueue(): void {
		const pending = this.speakQueue;
		this.speakQueue = [];
		for (const p of pending) p.resolve();
	}

	/** ?꾩옱 諛쒗솕 利됱떆 以묐떒(barge-in). ?湲?以묒씤 ?먮룄 紐⑤몢 痍⑥냼?쒕떎. */
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
		// 諛쒗솕 以??뺤?(?몃쭏?댄듃 ??硫?setSpeaking(true) 媛 ?꾩뿭 ?ㅽ넗?댁뿉 ?⑥? ?딅룄濡??댁젣(interrupt ? ?移?.
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
