// nva(naia video clip avatar) — naia-video-avatar 정본 v0.2 포맷.
// states/transitions 폐기: animations(재료 풀, loop/can_talk 조합) + (선택) scenario(노드 그래프).
// ★재정의(단일상태, 2026-07): 시작=idle(loop, 말하기 베이스) + speak(can_talk, head_image 헤드토킹)
//   + 동작 N개(gesture). scenario/poses/entry_pose·exit_pose 는 다음 버전(멀티 idle 상태)이라 **선택**.
//   구 번들(alpha-real-video: scenario+entry/exit 포함)도 계속 수용(하위호환).
// 브라우저(VideoAvatarCanvas)는 cascade 토킹 모드에서 façade(/load_nva)가 이 번들을 로드해
// face_bbox 헤드토킹을 렌더한다. cascade `output_cascade/nva_loader.py` 와 필드/파생 로직 parity.

export interface NvaAnimation {
	clip: string;
	/** 선택 — 자세 변화(앉기/눕기)가 있는 멀티상태에서만. 단일상태(서있기) 아바타는 없음. */
	entry_pose?: string;
	exit_pose?: string;
	loop?: boolean;
	/** true면 face_bbox 영역에 헤드토킹(입) 오버레이 가능. */
	can_talk?: boolean;
	/** [x,y,l] 정사각(3) 또는 [x,y,w,h] 직사각(4) 정규화 0~1. can_talk=true면 필수. */
	face_bbox?: [number, number, number] | [number, number, number, number];
	/** 헤드토킹 소스 정지이미지(반짝이 헤드 PNG, 얼굴고정). composite 아바타 = 헤드 PNG 모드. */
	head_image?: string;
	/** head_image 를 뜬 speak 클립 내 시각(초) — 에디터 메타(런타임 무영향). */
	head_time?: number;
	/** 헤드 PNG 크로마키 색(#RRGGBB). staging/composite 가 동일 색으로 배경 제거. */
	head_chroma?: string;
	label?: string;
	description?: string;
	/** 이 애니를 언제 재생하면 좋은지(LLM/런타임 힌트). */
	intent?: string;
	/** 감정·의도 키워드(소비 앱 LLM 트리거). */
	triggers?: string[];
}

export interface NvaScenarioNode {
	type: "start" | "scene";
	animation?: string;
	label?: string;
	dwell_ms?: number;
}

export interface NvaManifest {
	nva_version: "0.2";
	meta?: {
		name?: string;
		author?: string;
		owner?: string;
		license?: string;
		created?: string;
		[key: string]: unknown;
	};
	canvas: { width: number; height: number; fps?: number };
	background?: {
		type?: "color" | "image" | "video" | "transparent";
		color?: string;
		src?: string;
	};
	/** 캐릭터 클립 크로마키 색(#RRGGBB). 알파(VP9 yuva420p) 클립이면 불요. */
	chroma_key?: string;
	poses?: string[];
	animations: Record<string, NvaAnimation>;
	/** 노드 그래프 — **선택**(재정의 단일상태 번들엔 없음; 멀티 idle 상태 번들에서만). */
	scenario?: {
		nodes: Record<string, NvaScenarioNode>;
		edges: Array<{ from: string; to: string }>;
	};
	/** 표준 감정/의도 키 → animation 키 매핑(선택). VRM expression 유사 — 소비 앱 LLM 이 사용. */
	expressions?: Record<string, string>;
}

/** default 재생 클립 = idle(안정 루프: loop && !can_talk && 전환아님).
 *  scenario start 가 가리키는 애니가 유효 idle 이면 우선, 아니면 첫 idle, **idle 없으면 undefined**.
 *  (cascade nva_loader.py 의 pick(is_base_loop&!can_talk) 과 parity — idle 부재 시 Python 도 None →
 *   같은 .nva 가 양쪽서 동일 default. 폴백으로 첫 애니(제스처/토킹)를 idle 로 오선택하지 않는다.) */
export function resolveDefaultAnimation(
	m: NvaManifest,
): NvaAnimation | undefined {
	// idle = 안정 base 루프(loop && !can_talk) 이고 전환(entry_pose!=exit_pose)이 아님.
	// 재정의 단일상태 번들은 entry/exit 부재(둘 다 undefined→"") 라 전환이 아님 → idle 판정 통과.
	const isIdle = (a?: NvaAnimation) =>
		!!a &&
		!!a.loop &&
		!a.can_talk &&
		(a.entry_pose ?? "") === (a.exit_pose ?? "");
	const nodes = m.scenario?.nodes ?? {};
	const startKey = Object.keys(nodes).find((k) => nodes[k].type === "start");
	if (startKey) {
		const next = (m.scenario?.edges ?? []).find((e) => e.from === startKey)?.to;
		const animKey = next ? nodes[next]?.animation : undefined;
		const startAnim = animKey ? m.animations[animKey] : undefined;
		if (isIdle(startAnim)) return startAnim; // scenario-start 가 유효 idle 일 때만 우선
	}
	const anims = Object.values(m.animations ?? {});
	// idle 이 없으면 undefined(Python idle_key=None 과 동일). 첫 애니로 폴백하지 않음 —
	// 제스처/토킹 루프를 idle 로 오선택하면 양쪽 default 가 어긋난다.
	return anims.find(isIdle);
}

/** VideoAvatarCanvas 호환: default 클립을 {video, mask?} 로. v0.2 는 별도 mask 없음
 *  (투명 = VP9 알파 클립 or chroma_key). */
export function defaultClipOf(m: NvaManifest): {
	video: string;
	mask?: string;
} {
	const a = resolveDefaultAnimation(m);
	if (!a?.clip) throw new Error("NVA has no playable default clip");
	return { video: a.clip };
}

export function parseNvaManifest(raw: string): NvaManifest {
	const parsed = JSON.parse(raw) as Partial<NvaManifest>;
	if (parsed.nva_version !== "0.2") {
		throw new Error(
			"Unsupported NVA manifest schema (nva_version 0.2 required)",
		);
	}
	// scenario 는 **선택**(재정의 단일상태 번들엔 없음) — canvas/animations 만 필수.
	// 재생 가능 애니 부재는 아래 defaultClipOf 가 잡는다(빈 animations 도 거부).
	if (!parsed.canvas || !parsed.animations) {
		throw new Error("Invalid NVA manifest");
	}
	const manifest = parsed as NvaManifest;
	// 재생 가능한 default idle 클립이 있어야 한다 — 없으면 defaultClipOf 가 throw(빈/무클립/idle부재 거부).
	// (재정의 규약 = 시작 idle 베이스 필수. cascade 는 idle=None 을 관대히 허용하나 셸 검증 게이트는 요구.)
	defaultClipOf(manifest);
	return manifest;
}

export function resolveNvaAssetPath(
	bundleDir: string,
	relativePath: string,
): string {
	if (!relativePath || relativePath.includes("..")) {
		throw new Error("Invalid NVA asset path");
	}
	const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
	const sep = bundleDir.includes("\\") ? "\\" : "/";
	return `${bundleDir.replace(/[/\\]+$/, "")}${sep}${normalized.replace(/\//g, sep)}`;
}
