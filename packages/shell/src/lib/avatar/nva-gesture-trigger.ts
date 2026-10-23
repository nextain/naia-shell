// nva-gesture-trigger — P7 LLM gesture 트리거 파서. LLM 응답 텍스트의 gesture 마커를 파싱해 매니페스트의
//   gesture 애니 key 로 해석하고, 표시용 clean 텍스트(마커 제거)와 트리거할 gesture 순서를 반환한다.
//   마커 형식 = `[[gesture:X]]` 또는 짧게 `[[g:X]]`. X = gesture 애니의 key / label / intent / triggers[] 중 하나
//   (대소문자·공백 무시). = NvaAnimation 스키마의 label·intent·triggers 필드를 그대로 활용(설계 예정 경로).
//   consumer(shell)가 반환된 cleanText 를 화면/음성에, gestures 를 player.gesture(key) 로 소비.

import { type NvaManifest, animKind } from "./nva-core";
import type { NvaGestureAction } from "./camera-actions";

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
// 악성/실수 입력 방어: 트리거할 gesture 수 상한 + 마커 값 길이 상한(초과분은 트리거 안 함, 텍스트에선 제거).
const MAX_GESTURES = 16;
const MAX_VALUE_LEN = 64;

/** gesture-kind 애니의 key/label/intent/triggers 를 소문자 인덱스 → 마커 값 해석용. */
function buildLookup(
	source: NvaManifest | readonly NvaGestureAction[],
): Map<string, string> {
	const map = new Map<string, string>();
	if (Array.isArray(source)) {
		for (const action of source) {
			const add = (value?: string) => {
				const key = (value || "").trim().toLowerCase();
				if (key && !map.has(key)) map.set(key, action.key);
			};
			add(action.key);
			add(action.label);
		}
		return map;
	}
	const m = source as NvaManifest;
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
	m: NvaManifest | readonly NvaGestureAction[],
): GestureParseResult {
	const lookup = buildLookup(m);
	const gestures: ParsedGesture[] = [];
	const cleanText = (text || "")
		.replace(MARKER, (_full: string, raw: string) => {
			const rawStr = String(raw).trim();
			// 길이/개수 상한 안에서만 해석(초과=미해석). 마커는 어느 경우든 표시 텍스트에서 제거.
			if (rawStr.length <= MAX_VALUE_LEN && gestures.length < MAX_GESTURES) {
				const key = lookup.get(rawStr.toLowerCase());
				if (key) gestures.push({ key, matched: rawStr });
			}
			return "";
		})
		.replace(/[ \t]{2,}/g, " ") // 마커 제거로 생긴 연속 공백 축약
		.replace(/ +(\n|$)/g, "$1") // 줄끝/문장끝 잉여 공백 제거
		.trim();
	return { cleanText, gestures };
}

const STREAM_MARKER = /^\[\[[ \t]*(?:gesture|g)[ \t]*:[ \t]*([^\[\]\r\n]+?)[ \t]*\]\]/i;

type MarkerInspection =
	| { kind: "complete"; length: number; marker: string }
	| { kind: "partial" }
	| { kind: "invalid" };

function inspectStreamMarker(value: string, start: number): MarkerInspection {
	const candidate = value.slice(start);
	const complete = STREAM_MARKER.exec(candidate);
	if (complete) {
		return {
			kind: "complete",
			length: complete[0].length,
			marker: complete[0],
		};
	}

	const body = candidate.slice(2);
	if (/[\[\]\r\n]/.test(body.slice(0, -1))) return { kind: "invalid" };
	const hasDanglingClose = body.endsWith("]");
	const prefix = hasDanglingClose ? candidate.slice(0, -1) : candidate;
	const partial = /^\[\[[ \t]*([a-z]*)[ \t]*(?::([^\[\]\r\n]*))?$/i.exec(prefix);
	if (!partial) return { kind: "invalid" };

	const kind = partial[1].toLowerCase();
	const rawValue = partial[2];
	if (rawValue === undefined) {
		if (hasDanglingClose || (!"gesture".startsWith(kind) && !"g".startsWith(kind))) {
			return { kind: "invalid" };
		}
		return { kind: "partial" };
	}
	if (kind !== "gesture" && kind !== "g") return { kind: "invalid" };
	if (rawValue.trim().length > MAX_VALUE_LEN) return { kind: "invalid" };
	if (hasDanglingClose && !rawValue.trim()) return { kind: "invalid" };
	return { kind: "partial" };
}

/** Incrementally strips gesture markers without exposing a split marker to UI or TTS. */
export class GestureTriggerStream {
	private pending = "";
	private afterRemovedMarker = false;
	private afterRemovedMarkerSpace = false;

	constructor(private readonly actions: readonly NvaGestureAction[] = []) {}

	push(chunk: string): GestureParseResult {
		this.pending += chunk;
		return this.drain(false);
	}

	flush(): GestureParseResult {
		return this.drain(true);
	}

	private drain(flushing: boolean): GestureParseResult {
		const source = this.pending;
		this.pending = "";
		let cleanText = "";
		const gestures: ParsedGesture[] = [];
		let cursor = 0;

		while (cursor < source.length) {
			const start = source.indexOf("[", cursor);
			if (start < 0) {
				cleanText = this.appendPlain(source.slice(cursor), cleanText);
				break;
			}

			if (source[start + 1] !== "[") {
				if (start + 1 === source.length && !flushing) {
					let holdFrom = start;
					while (holdFrom > cursor && /[ \t]/.test(source[holdFrom - 1])) {
						holdFrom -= 1;
					}
					cleanText = this.appendPlain(source.slice(cursor, holdFrom), cleanText);
					this.pending = source.slice(holdFrom);
					break;
				}
				cleanText = this.appendPlain(source.slice(cursor, start + 1), cleanText);
				cursor = start + 1;
				continue;
			}

			const marker = inspectStreamMarker(source, start);
			if (marker.kind === "partial") {
				if (flushing) {
					cleanText = this.appendPlain(source.slice(cursor), cleanText);
					break;
				}
				let holdFrom = start;
				while (holdFrom > cursor && /[ \t]/.test(source[holdFrom - 1])) {
					holdFrom -= 1;
				}
				cleanText = this.appendPlain(source.slice(cursor, holdFrom), cleanText);
				this.pending = source.slice(holdFrom);
				break;
			}

			cleanText = this.appendPlain(source.slice(cursor, start), cleanText);
			if (marker.kind === "invalid") {
				cleanText = this.appendPlain("[[", cleanText);
				cursor = start + 2;
				continue;
			}

			const parsed = parseGestureTriggers(marker.marker, this.actions);
			gestures.push(...parsed.gestures);
			const leftWhitespace = cleanText.match(/[ \t]+$/)?.[0] ?? "";
			if (leftWhitespace) {
				cleanText = `${cleanText.slice(0, -leftWhitespace.length)} `;
			}
			this.afterRemovedMarker = true;
			this.afterRemovedMarkerSpace = leftWhitespace.length > 0;
			cursor = start + marker.length;
		}

		return { cleanText, gestures };
	}

	private appendPlain(source: string, into: string): string {
		let result = into;
		for (const char of source) {
			if (this.afterRemovedMarker) {
				if (char === " " || char === "\t") {
					if (!this.afterRemovedMarkerSpace) result += " ";
					this.afterRemovedMarkerSpace = true;
					continue;
				}
				this.afterRemovedMarker = false;
				this.afterRemovedMarkerSpace = false;
			}
			result += char;
		}
		return result;
	}
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
