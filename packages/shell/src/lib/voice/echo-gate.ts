/**
 * Barge-in energy gate — shared SoT from omni development (#216).
 *
 * Extracted from naia-omni.ts so the gate survives that provider's passthrough
 * refactor (no client-side VAD/buffering remains there). ChatArea applies this
 * gate while the AI is speaking — on weak-AEC platforms (WebKitGTK) it stops
 * AEC-residual echo from self-triggering the server VAD into an interrupt loop.
 * Gemini Live and naia-omni share this one threshold.
 */

/**
 * RMS threshold for client-side speech detection (Int16 scale 0–32767,
 * ~3% of full scale). Validated during omni development (#216 minicpm-o).
 */
export const SPEECH_RMS_THRESHOLD = 200;

/** Root-mean-square amplitude of Int16 PCM samples. */
function rms(samples: Int16Array): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return Math.sqrt(sum / samples.length);
}

/**
 * RMS (Int16 scale 0–32767) of a base64-encoded Int16-LE PCM chunk. Shared
 * SoT helper for the barge-in energy gate (see {@link SPEECH_RMS_THRESHOLD}).
 */
export function rmsFromBase64Pcm(b64: string): number {
	const bytes = base64ToUint8Array(b64);
	if (bytes.byteLength < 2) return 0;
	const samples = new Int16Array(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength >> 1,
	);
	return rms(samples);
}

// ── 자기발화(에코) 텍스트 필터 (2026-07-15 루크: "이전 발화내용 있으니 일정 이상 유사도면 스킵") ──
// 파이프라인 음성에서 나이아 TTS 가 스피커→마이크로 되들어와 STT 가 나이아 말을 사용자
// 입력으로 올리는 루프의 2차 방어선. 1차 = 재생 중 마이크 정지(캡처 차단)지만, web-speech
// 연속 인식의 지연 배달(재생 중 캡처분이 게이트 해제 후 도착)은 텍스트로만 걸러진다.

/** 비교 정규화 — 공백/문장부호 제거 + 소문자화 (한국어는 자모 그대로 비교). */
function normalizeForEcho(s: string): string {
	return s
		.toLowerCase()
		.replace(/[\s.,!?~…'"“”‘’()\[\]{}<>:;·\-—]/g, "");
}

/** 문자 bigram Dice 계수 (0~1). 짧은 문자열(<4자)은 **정확 일치**로만 폴백 —
 *  substring 폴백은 짧은 정상 답변("좋아")을 긴 문장("피자좋아하세요") 안에 포함된다는
 *  이유로 에코 오판하게 만든다(2026-07-15 리뷰). 부분일치 판정은 상위 isLikelySelfEcho 의
 *  길이-게이트(MIN_SUBSTRING_ECHO)가 전담. */
function bigramDice(a: string, b: string): number {
	if (!a || !b) return 0;
	if (a.length < 4 || b.length < 4) {
		return a === b ? 1 : 0;
	}
	const grams = (s: string) => {
		const m = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const g = s.slice(i, i + 2);
			m.set(g, (m.get(g) ?? 0) + 1);
		}
		return m;
	};
	const ga = grams(a);
	const gb = grams(b);
	let inter = 0;
	for (const [g, ca] of ga) inter += Math.min(ca, gb.get(g) ?? 0);
	return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/**
 * STT transcript 가 최근 TTS 발화의 에코인지 판정.
 * - 전체 문장 유사도(Dice ≥ threshold) 또는 **부분 에코**(transcript 가 발화문 안에
 *   그대로 포함 — 문장 꼬리만 잡히는 전형) 를 에코로 본다.
 * - threshold 0.6: 실사용에서 사용자 자연발화가 직전 나이아 문장과 60% 이상 겹칠
 *   가능성은 낮고, AEC 잔향 에코는 대부분 0.8+ 로 잡힌다(보수적 기본).
 */
export function isLikelySelfEcho(
	transcript: string,
	recentTtsTexts: readonly string[],
	threshold = 0.6,
): boolean {
	const t = normalizeForEcho(transcript);
	// ★짧은 입력은 에코 판정에서 제외(2026-07-15 리뷰): "좋아/네/그래/알겠어" 같은 정상
	//   확인 답변은 나이아 질문 문장("...좋아하세요?") 안에 부분일치로 들어가 삼켜졌다.
	//   부분일치(substring) 에코는 **충분히 긴** 꼬리(≥8자)에만 적용하고, 그보다 짧으면
	//   전체 문장 유사도(Dice)로만 판정 — 짧은 사용자 발화가 절대 안 먹히게 한다.
	const MIN_SUBSTRING_ECHO = 8;
	if (t.length < 2) return false;
	for (const spoken of recentTtsTexts) {
		const s = normalizeForEcho(spoken);
		if (!s) continue;
		// 부분 에코(문장 꼬리)는 길이가 충분할 때만 — 짧은 정상 답변 오탐 방지.
		if (t.length >= MIN_SUBSTRING_ECHO && s.includes(t)) return true;
		if (bigramDice(t, s) >= threshold) return true;
	}
	return false;
}

function base64ToUint8Array(b64: string): Uint8Array {
	let bin: string;
	try {
		bin = atob(b64);
	} catch {
		// Malformed base64 from the mic encoder is treated as a silent chunk
		// rather than a thrown exception that would kill the caller.
		return new Uint8Array(0);
	}
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}
