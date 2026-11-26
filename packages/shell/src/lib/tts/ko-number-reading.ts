/**
 * 한국어 발화용 숫자 정규화 (#540, FR-VOICE-TEXT.5).
 *
 * TTS 엔진은 "90년대"를 자리읽기("구공년대")로 읽는다. 발화 전에 숫자를
 * 한국어 읽기로 풀어 쓴다. 단위(의존명사)가 한자어 수사(삼십 분)와 고유어
 * 수사(세 시)를 가르며, 분류는 아래 테이블이 정의한다 — 새 단위는 테이블에
 * 추가하는 것으로 끝난다.
 */

import copy from "./ko-number-lexicon.json";

const SINO_DIGITS = copy.sinoDigits;
const SPOKEN_DIGITS = copy.spokenDigits;
const SINO_SMALL_UNITS = copy.sinoSmallUnits;
const SINO_GROUP_UNITS = copy.sinoGroupUnits;

const NATIVE_ONES = copy.nativeOnes;
const NATIVE_TENS = copy.nativeTens;

/** 1–9999 한자어. 십·백·천 앞의 '일'은 생략한다 (일십→십). */
function sinoUnder10000(n: number): string {
	const digits = [
		Math.floor(n / 1000) % 10,
		Math.floor(n / 100) % 10,
		Math.floor(n / 10) % 10,
		n % 10,
	];
	let out = "";
	digits.forEach((digit, i) => {
		if (!digit) return;
		const unit = SINO_SMALL_UNITS[i];
		out += (digit === 1 && unit ? "" : SINO_DIGITS[digit]) + unit;
	});
	return out;
}

/** 음이 아닌 정수의 한자어 읽기. 만 단위 그룹 사이는 띄어 읽는다. */
export function sinoKoreanNumber(n: number): string {
	if (!Number.isSafeInteger(n) || n < 0) return String(n);
	if (n === 0) return copy.zero;
	let out = "";
	let group = 0;
	while (n > 0 && group < SINO_GROUP_UNITS.length) {
		const chunk = n % 10000;
		if (chunk) {
			// 만 앞의 '일'은 생략(일만→만)하되 억·조는 유지한다(일억).
			const part = chunk === 1 && group === 1 ? "" : sinoUnder10000(chunk);
			out = part + SINO_GROUP_UNITS[group] + (out ? ` ${out}` : "");
		}
		n = Math.floor(n / 10000);
		group++;
	}
	return out;
}

/** 1–99 관형 고유어 수사 (세 시, 스무 개, 스물한 명). 범위 밖은 한자어. */
export function nativeKoreanCounting(n: number): string {
	if (!Number.isSafeInteger(n) || n < 1 || n > 99) return sinoKoreanNumber(n);
	if (n === 20) return copy.twenty;
	return NATIVE_TENS[Math.floor(n / 10)] + NATIVE_ONES[n % 10];
}

/** 자리읽기 — 전화번호·코드 (010 → 공일공). */
export function digitWiseKorean(digits: string): string {
	return [...digits]
		.map((ch) => SPOKEN_DIGITS[Number(ch)] ?? ch)
		.join("");
}

// ── 단위 분류표 (FR-VOICE-TEXT.5 확장점) ──────────────────────────────────
// 매칭은 항상 긴 단위부터 시도한다 (개월이 개보다, 시간이 시보다 먼저).

const SINO_UNITS = copy.sinoUnits;

const NATIVE_UNITS = copy.nativeUnits;

const NATIVE_UNIT_SET = new Set(NATIVE_UNITS);

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const UNIT_ALTERNATION = [...SINO_UNITS, ...NATIVE_UNITS]
	.sort((a, b) => b.length - a.length)
	.map(escapeRegExp)
	.concat(["%", "℃"])
	.join("|");

const UNIT_PATTERN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})`, "g");

function readWithUnit(numText: string, unit: string): string {
	const [intPart, fracPart] = numText.split(".");
	const n = Number.parseInt(intPart, 10);
	const unitWord = unit === "%" ? copy.percent : unit === "℃" ? copy.degrees : unit;
	let reading: string;
	if (fracPart !== undefined) {
		// Decimals use Sino-Korean numbers.
		reading = `${sinoKoreanNumber(n)}${copy.decimal}${digitWiseKorean(fracPart)}`;
	} else if (NATIVE_UNIT_SET.has(unit) && n >= 1 && n <= 99) {
		reading = nativeKoreanCounting(n);
	} else {
		reading = sinoKoreanNumber(n);
	}
	return `${reading} ${unitWord}`;
}

/** 발화 텍스트의 숫자를 한국어 읽기로 정규화한다. */
export function normalizeKoreanNumbers(text: string): string {
	return (
		text
			// 천단위 콤마는 읽기 전에 지운다 (1,200 → 1200).
			.replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
			// 구분자 숫자열(전화번호·코드)은 자리읽기.
			.replace(/\b(\d{2,4}(?:-\d{2,4}){1,3})\b/g, (m) =>
				m.split("-").map(digitWiseKorean).join(" "),
			)
			// 숫자+단위 — 단위 분류표가 한자어/고유어 읽기를 가른다.
			.replace(UNIT_PATTERN, (_m, num: string, unit: string) =>
				readWithUnit(num, unit),
			)
			// Read decimals without a counter.
			.replace(
				/(\d+)\.(\d+)/g,
				(_m, i: string, f: string) =>
					`${sinoKoreanNumber(Number.parseInt(i, 10))}${copy.decimal}${digitWiseKorean(f)}`,
			)
			// 남은 정수: 0으로 시작하거나 아주 길면 자리읽기, 그 외 한자어.
			.replace(/\d+/g, (m) =>
				(m.length > 1 && m.startsWith("0")) || m.length > 15
					? digitWiseKorean(m)
					: sinoKoreanNumber(Number.parseInt(m, 10)),
			)
	);
}
