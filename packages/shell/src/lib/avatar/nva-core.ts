// nva-core — naia-video-avatar `src/main/nva-core.js` (v0.2) 의 **벤더 포팅**(TS).
//   정본 SoT = projects/naia-video-avatar/src/main/nva-core.js. 크로스레포 import 대신 필요한 순수
//   로직만 복사(0 의존). ⚠️정본 변경 시 이 파일도 동기화(derive/animKind 규칙은 cascade 로더와 동일 계약).
//   naia-shell 레이어드 플레이어(NvaLayeredPlayer)가 base 애니(idle/talk/gesture) 유도에 사용.

/** face_bbox = [x,y,l] 정사각(정규화) 또는 [x,y,w,h] 직사각. 립싱크 헤드 크롭/오버레이 위치. */
export type FaceBbox = number[];

export interface NvaAnimation {
	clip: string;
	loop?: boolean;
	can_talk?: boolean;
	face_bbox?: FaceBbox;
	entry_pose?: string;
	exit_pose?: string;
	head_image?: string;
	head_chroma?: string;
	head_time?: number;
	label?: string;
	intent?: string;
	triggers?: string[];
}

export interface NvaManifest {
	nva_version?: string;
	meta?: Record<string, unknown>;
	canvas: { width: number; height: number; fps?: number };
	background?: { type?: string; color?: string; src?: string };
	chroma_key?: string;
	animations: Record<string, NvaAnimation>;
	scenario?: {
		nodes?: Record<
			string,
			{ type: string; animation?: string; label?: string; dwell_ms?: number }
		>;
		edges?: Array<{ from: string; to: string }>;
	};
}

export function isTransition(a?: NvaAnimation): boolean {
	return (a?.entry_pose || "") !== (a?.exit_pose || "");
}

/** 조합 → 종류: talking(loop&can_talk) / idle(loop&!can_talk) / gesture(둘다 off) / transition. */
export function animKind(
	a: NvaAnimation,
): "talking" | "idle" | "gesture" | "transition" {
	if (isTransition(a)) return "transition";
	if (a.loop && a.can_talk) return "talking";
	if (a.loop) return "idle";
	return "gesture";
}

function scenarioStartAnim(m: NvaManifest): string | null {
	const nodes = m.scenario?.nodes || {};
	const edges = m.scenario?.edges || [];
	const sk = Object.keys(nodes).find((k) => nodes[k].type === "start");
	if (!sk) return null;
	const nx = edges.find((e) => e.from === sk)?.to;
	return nx && nodes[nx] ? (nodes[nx].animation ?? null) : null;
}

export interface NvaDerived {
	idleKey: string | null;
	talkKey: string | null;
	/** loop 아님/전환 = 제스처·이벤트 애니(LLM 트리거 대상). key→clip. */
	events: Record<string, string>;
	idle?: NvaAnimation;
	talking?: NvaAnimation;
}

/** cascade 로더/에디터와 **동일 파생 규칙**. idle/talk base 루프 + 이벤트(gesture) 추출. */
export function derive(m: NvaManifest): NvaDerived {
	const anims = m.animations || {};
	const isBase = (a: NvaAnimation) => !!a.loop && !isTransition(a);
	const start = scenarioStartAnim(m);
	const pick = (pred: (a: NvaAnimation) => boolean): string | null => {
		if (start && anims[start] && pred(anims[start])) return start;
		return Object.keys(anims).find((k) => pred(anims[k])) || null;
	};
	const idleKey = pick((a) => isBase(a) && !a.can_talk);
	const talkKey = pick((a) => isBase(a) && !!a.can_talk);
	const events = Object.fromEntries(
		Object.entries(anims)
			.filter(([, a]) => !a.loop || isTransition(a))
			.map(([k, a]) => [k, a.clip]),
	);
	return {
		idleKey,
		talkKey,
		events,
		idle: idleKey ? anims[idleKey] : undefined,
		talking: talkKey ? anims[talkKey] : undefined,
	};
}

/** face_bbox([x,y,l] 정사각 또는 [x,y,w,h]) → 캔버스 픽셀 [px,py,pw,ph]. */
export function bboxToPx(
	bb: FaceBbox,
	cw: number,
	ch: number,
): [number, number, number, number] {
	if (bb.length === 4) {
		const [x, y, w, h] = bb;
		return [x * cw, y * ch, w * cw, h * ch];
	}
	// [x,y,l] 정사각: 한 변 l = 폭 기준.
	const [x, y, l] = bb;
	const side = l * cw;
	return [x * cw, y * ch, side, side];
}
