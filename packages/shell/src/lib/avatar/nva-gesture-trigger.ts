// nva-gesture-trigger — P7 LLM gesture 트리거 파서. LLM 응답 텍스트의 gesture 마커를 파싱해 매니페스트의
//   gesture 애니 key 로 해석하고, 표시용 clean 텍스트(마커 제거)와 트리거할 gesture 순서를 반환한다.
//   마커 형식 = `[[gesture:X]]` 또는 짧게 `[[g:X]]`. X = gesture 애니의 key / label / intent / triggers[] 중 하나
//   (대소문자·공백 무시). = NvaAnimation 스키마의 label·intent·triggers 필드를 그대로 활용(설계 예정 경로).
//   consumer(shell)가 반환된 cleanText 를 화면/음성에, gestures 를 player.gesture(key) 로 소비.

import { type NvaManifest, animKind } from "./nva-core";

export interface ParsedGesture {
	/** 해석된 gesture 애니 key(매니페스트). */
	key: string;
	/** 마커에서 매칭된 원문(진단). */
	matched: string;
}

export interface GestureParseResult {
	/** 마커 제거 + 공백 정리된 표시용 텍스트. */
	cleanText: string;
	/** 출현 순서대로 해석된 gesture(중복 마커도 각각). 미해석 마커는 제외(텍스트에선 제거). */
	gestures: ParsedGesture[];
}

// [[gesture:X]] / [[g:X]] — X 는 `]` `[` 제외 1글자 이상. 대소문자 무시.
const MARKER = /\[\[\s*(?:gesture|g)\s*:\s*([^[\]]+?)\s*\]\]/gi;

/** gesture-kind 애니의 key/label/intent/triggers 를 소문자 인덱스 → 마커 값 해석용. */
function buildLookup(m: NvaManifest): Map<string, string> {
	const map = new Map<string, string>();
	for (const [key, a] of Object.entries(m.animations || {})) {
		if (animKind(a) !== "gesture") continue; // gesture 애니만(idle/talk/transition 제외)
		const add = (s?: string) => {
			const k = (s || "").trim().toLowerCase();
			if (k && !map.has(k)) map.set(k, key);
		};
		add(key);
		add(a.label);
		add(a.intent);
		for (const t of a.triggers || []) add(t);
	}
	return map;
}

/**
 * LLM 응답 텍스트에서 gesture 마커를 파싱. 반환 = {cleanText(마커 제거), gestures(해석된 key 순서)}.
 * 미해석/비-gesture 마커는 트리거하지 않고 텍스트에서만 제거(화면에 마커 노출 방지). 순수 함수.
 */
export function parseGestureTriggers(
	text: string,
	m: NvaManifest,
): GestureParseResult {
	const lookup = buildLookup(m);
	const gestures: ParsedGesture[] = [];
	const cleanText = (text || "")
		.replace(MARKER, (_full: string, raw: string) => {
			const val = String(raw).trim().toLowerCase();
			const key = lookup.get(val);
			if (key) gestures.push({ key, matched: String(raw).trim() });
			return ""; // 해석 성공/실패 무관 — 마커는 표시 텍스트에서 제거
		})
		.replace(/[ \t]{2,}/g, " ") // 마커 제거로 생긴 연속 공백 축약
		.replace(/ +(\n|$)/g, "$1") // 줄끝/문장끝 잉여 공백 제거
		.trim();
	return { cleanText, gestures };
}

/** player.gesture(key) 를 가진 대상. */
export interface GesturePlayer {
	gesture: (key: string) => Promise<void>;
}

/**
 * 파싱된 gesture 를 순차 트리거. 기본은 등장 순서대로 preempt(각 gesture 가 이전을 대체) — 마지막이 화면에 남고
 * 종료 후 base 복귀(P4 상태머신). onEach 훅으로 소비측이 개별 처리 가능. 알 수 없는 애니는 player 가 throw →
 * 격리(전체 시퀀스 중단 방지).
 */
export async function driveGestures(
	player: GesturePlayer,
	gestures: ParsedGesture[],
	onEach?: (g: ParsedGesture) => void,
): Promise<number> {
	let fired = 0;
	for (const g of gestures) {
		try {
			await player.gesture(g.key);
			onEach?.(g);
			fired += 1;
		} catch {
			/* 알 수 없는 gesture — 격리하고 계속 */
		}
	}
	return fired;
}
