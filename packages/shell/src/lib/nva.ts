// nva(naia video clip avatar) — TalkingKiosk 정본 v0.2 포맷.
// states/transitions 폐기: animations(재료 풀, loop/can_talk) + scenario(노드 그래프).
// 브라우저(VideoAvatarCanvas)는 정적 폴백 시 default 애니의 clip 을 재생하고, cascade
// 토킹 모드에선 façade 가 이 번들을 로드해 face_bbox 헤드토킹을 렌더한다.

export interface NvaAnimation {
	clip: string;
	entry_pose: string;
	exit_pose: string;
	loop?: boolean;
	/** true면 face_bbox 영역에 헤드토킹(입) 오버레이 가능. */
	can_talk?: boolean;
	/** [x,y,w,h] 정규화 0~1. can_talk=true면 필수. */
	face_bbox?: [number, number, number, number];
}

export interface NvaScenarioNode {
	type: "start" | "scene";
	animation?: string;
	label?: string;
	dwell_ms?: number;
}

export interface NvaManifest {
	nva_version: "0.2";
	meta?: { name?: string; author?: string; owner?: string; license?: string; created?: string };
	canvas: { width: number; height: number; fps?: number };
	background?: { type?: "color" | "image" | "video" | "transparent"; color?: string; src?: string };
	/** 캐릭터 클립 크로마키 색(#RRGGBB). 알파(VP9 yuva420p) 클립이면 불요. */
	chroma_key?: string;
	poses?: string[];
	animations: Record<string, NvaAnimation>;
	scenario: { nodes: Record<string, NvaScenarioNode>; edges: Array<{ from: string; to: string }> };
}

/** default 재생 클립 = idle(안정 루프: loop && !can_talk && 전환아님).
 *  scenario start 가 가리키는 애니가 유효 idle 이면 우선, 아니면 첫 idle, 없으면 첫 애니.
 *  (cascade nva_loader.py 의 is_base_loop&!can_talk pick 과 parity — 같은 .nva 가 양쪽서 동일 default.) */
export function resolveDefaultAnimation(m: NvaManifest): NvaAnimation | undefined {
	const isIdle = (a?: NvaAnimation) =>
		!!a && !!a.loop && !a.can_talk && a.entry_pose === a.exit_pose;
	const nodes = m.scenario?.nodes ?? {};
	const startKey = Object.keys(nodes).find((k) => nodes[k].type === "start");
	if (startKey) {
		const next = (m.scenario?.edges ?? []).find((e) => e.from === startKey)?.to;
		const animKey = next ? nodes[next]?.animation : undefined;
		const startAnim = animKey ? m.animations[animKey] : undefined;
		if (isIdle(startAnim)) return startAnim; // scenario-start 가 유효 idle 일 때만 우선
	}
	const anims = Object.values(m.animations ?? {});
	return anims.find(isIdle) ?? anims[0];
}

/** VideoAvatarCanvas 호환: default 클립을 {video, mask?} 로. v0.2 는 별도 mask 없음
 *  (투명 = VP9 알파 클립 or chroma_key). */
export function defaultClipOf(m: NvaManifest): { video: string; mask?: string } {
	const a = resolveDefaultAnimation(m);
	if (!a?.clip) throw new Error("NVA has no playable default clip");
	return { video: a.clip };
}

export function parseNvaManifest(raw: string): NvaManifest {
	const parsed = JSON.parse(raw) as Partial<NvaManifest>;
	if (parsed.nva_version !== "0.2") {
		throw new Error("Unsupported NVA manifest schema (nva_version 0.2 required)");
	}
	if (!parsed.canvas || !parsed.animations || !parsed.scenario) {
		throw new Error("Invalid NVA manifest");
	}
	const manifest = parsed as NvaManifest;
	if (!defaultClipOf(manifest).video) {
		throw new Error("NVA default animation is missing a clip");
	}
	return manifest;
}

export function resolveNvaAssetPath(bundleDir: string, relativePath: string): string {
	if (!relativePath || relativePath.includes("..")) {
		throw new Error("Invalid NVA asset path");
	}
	const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
	const sep = bundleDir.includes("\\") ? "\\" : "/";
	return `${bundleDir.replace(/[/\\]+$/, "")}${sep}${normalized.replace(/\//g, sep)}`;
}
