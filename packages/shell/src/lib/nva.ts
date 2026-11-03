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
	/** GPU 런타임 없이 WebView가 직접 재생하는 VRM-style WebM 슬롯. */
	vrm_slots?: NvaVrmSlots;
	expression_states?: Record<string, NvaExpressionSlot>;
	viseme_clips?: Record<string, NvaVisemeSlot>;
	prebaked_speech?: {
		mode?: string;
		selection?: string;
		utterances?: Record<string, NvaSpeechSlot>;
	};
	/** NVA v0.2 compatibility: authored utterance clips shipped by the ADK. */
	speech_clips?: Record<string, NvaSpeechSlot>;
	/** Safari 등 VP9 알파 미지원 환경을 위한 상하 분리(color-top-alpha-bottom) MP4 매핑. */
	stacked_alpha?: {
		layout?: string;
		clips?: Record<string, string>;
	};
}

export interface NvaLocalizedSpeech {
	text?: string;
	clip?: string;
	viseme?: string;
}

export interface NvaSpeechSlot extends NvaLocalizedSpeech {
	intent?: string;
	expression?: string;
	state?: string;
	locale?: string;
	audio?: string;
	by_locale?: Record<string, NvaLocalizedSpeech>;
}

export interface NvaExpressionSlot {
	label?: string;
	mood?: string;
	preview_image?: string;
	image?: string;
	animation?: string;
}

export interface NvaVisemeSlot {
	label?: string;
	clip: string;
}

export interface NvaVrmSlots {
	profile?: {
		generation_mode?: string;
		default_locale?: string;
		available_locales?: string[];
		locales?: string[];
		default_expression?: string;
		default_motion?: string;
	};
	expressions?: Record<string, NvaExpressionSlot>;
	visemes?: Record<string, NvaVisemeSlot>;
	motions?: Record<string, { clip: string; loop?: boolean; expression?: string }>;
	speech?: Record<string, NvaSpeechSlot>;
}

export function isPrebakedNvaManifest(manifest: NvaManifest): boolean {
	return (
		manifest.vrm_slots?.profile?.generation_mode === "prebaked_webm_only" ||
		Object.keys(manifest.vrm_slots?.speech ?? {}).length > 0 ||
		Object.keys(manifest.prebaked_speech?.utterances ?? {}).length > 0 ||
		Object.keys(manifest.speech_clips ?? {}).length > 0 ||
		Object.values(manifest.animations).some(
			(animation) => animation.can_talk || animation.loop,
		)
	);
}

function nvaSpeechSlots(manifest: NvaManifest): Record<string, NvaSpeechSlot> {
	return (
		manifest.vrm_slots?.speech ??
		manifest.prebaked_speech?.utterances ??
		manifest.speech_clips ??
		{}
	);
}

export function resolveNvaLocale(
	manifest: NvaManifest,
	requestedLocale?: string,
): string {
	const profile = manifest.vrm_slots?.profile;
	const speech = nvaSpeechSlots(manifest);
	const firstSpeech = Object.values(speech)[0];
	const available =
		profile?.available_locales ??
		profile?.locales ??
		Object.keys(firstSpeech?.by_locale ?? {});
	if (firstSpeech?.locale && !available.includes(firstSpeech.locale)) {
		available.push(firstSpeech.locale);
	}
	const requested = requestedLocale?.trim();
	if (requested && available.includes(requested)) return requested;
	if (requested) {
		const language = requested.split("-")[0]?.toLowerCase();
		const compatible = available.find(
			(locale) => locale.split("-")[0]?.toLowerCase() === language,
		);
		if (compatible) return compatible;
	}
	return profile?.default_locale ?? available[0] ?? requested ?? "ko-KR";
}

export function localizedNvaSpeech(
	manifest: NvaManifest,
	slot: NvaSpeechSlot,
	requestedLocale?: string,
): NvaLocalizedSpeech {
	const locale = resolveNvaLocale(manifest, requestedLocale);
	const defaultLocale = manifest.vrm_slots?.profile?.default_locale;
	return (
		slot.by_locale?.[locale] ??
		slot.by_locale?.[defaultLocale ?? ""] ?? {
			text: slot.text,
			clip: slot.clip,
			viseme: slot.viseme,
		}
	);
}

function normalizeSpeechText(text: string): string {
	return text
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function findPrebakedSpeech(
	manifest: NvaManifest,
	text: string,
	requestedLocale?: string,
): { id: string; slot: NvaSpeechSlot; localized: NvaLocalizedSpeech } | null {
	const speech = nvaSpeechSlots(manifest);
	const wanted = normalizeSpeechText(text);
	if (!wanted) return null;
	for (const [id, slot] of Object.entries(speech)) {
		const localized = localizedNvaSpeech(manifest, slot, requestedLocale);
		if (localized.text && normalizeSpeechText(localized.text) === wanted) {
			return { id, slot, localized };
		}
	}
	return null;
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

/**
 * 렌더러(PrebakedAvatarRenderer)가 매니페스트에서 읽을 수 있는 모든 클립 상대 경로를 모은다.
 * animations, vrm_slots(visemes·motions·speech), prebaked_speech.utterances, speech_clips
 * 의 기본 클립과 by_locale 현지화 클립, 그리고 stacked_alpha.clips 의 키·값을 모두 포함한다.
 */
export function collectNvaManifestClipPaths(manifest: NvaManifest): string[] {
	const paths: string[] = [];
	const pushClip = (clip: string | undefined) => {
		if (typeof clip === "string") paths.push(clip);
	};
	for (const anim of Object.values(manifest.animations ?? {})) {
		pushClip(anim?.clip);
	}
	for (const viseme of Object.values(manifest.vrm_slots?.visemes ?? {})) {
		pushClip(viseme?.clip);
	}
	for (const motion of Object.values(manifest.vrm_slots?.motions ?? {})) {
		pushClip(motion?.clip);
	}
	const speechRecords = [
		manifest.vrm_slots?.speech,
		manifest.prebaked_speech?.utterances,
		manifest.speech_clips,
	];
	for (const speechRecord of speechRecords) {
		for (const slot of Object.values(speechRecord ?? {})) {
			if (!slot) continue;
			pushClip(slot.clip);
			for (const localized of Object.values(slot.by_locale ?? {})) {
				pushClip(localized?.clip);
			}
		}
	}
	for (const [clipKey, stackedClip] of Object.entries(
		manifest.stacked_alpha?.clips ?? {},
	)) {
		pushClip(clipKey);
		pushClip(stackedClip);
	}
	return paths;
}
