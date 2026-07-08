import type { Local8gFocus } from "../capabilities/vram-tiers";
// slots-manifest — Phase 2 계약(§5.2.1/2.2): naia-os 가 write 하고 windows-manager 가 read 하는
// 로컬 런타임 구동 결정 매니페스트. AppConfig(평면) → 직렬화 가능 매니페스트(구조화).
// wm 은 이 매니페스트로 어느 로컬 서비스(avatar/tts/sub-llm/embed)를 띄울지 결정(Phase 4.1).
// SoT: alpha-adk .agents/progress/naia-model-slots-architecture-2026-06-28.md §3.4·§5.2.
import type { AppConfig } from "../config";
import {
	type GateMode,
	type SlotSnapshot,
	deriveGate,
	readSlots,
} from "./model";

export const SLOTS_MANIFEST_VERSION = 1 as const;

/** 매니페스트 슬롯 뷰 — wm 이 읽는 값(비밀 없음, provider/model/localUrl 만). */
export interface ManifestSlots {
	main: { provider: string; model: string };
	sub: { provider: string; model?: string };
	embedding: { provider: string; model?: string };
	stt: { provider?: string };
	tts: { provider?: string };
	avatar: { provider?: string; model?: string; localUrl?: string };
}

/** wm 이 을 일으키는 로컬 서비스를 결정하는 매니페스트. 직렬화 가능(JSON). 비밀 0. */
export interface SlotsManifest {
	version: typeof SLOTS_MANIFEST_VERSION;
	gate: { naiaAccount: boolean; mode: GateMode };
	slots: ManifestSlots;
	gpu: {
		detectedVramGb?: number;
		tier?: string;
		/**
		 * 배타 VRAM 티어(8G)에서 로컬 집중(2026-07-08: llm | avatar | both) — wm 이
		 * llm_only vs avatar_only vs 둘다 프로파일을 고를 근거. 음성은 8G 에선 항상 클라우드.
		 * 미지정 → 기본 "llm"(브레인 로컬).
		 * ⚠️ Phase 4 게이트: wm capabilities.py 는 아직 구 축(avatar_only/tts_only) 해석 —
		 *   llm/avatar/both 해석은 미구현. 이 셸↔wm 계약 skew 를 **배포 전 Phase 4 에서** 닫을 것.
		 */
		localFocus?: Local8gFocus;
	};
	/** 빌드 일시(디버그·추적). ISO 문자열. */
	builtAt?: string;
}

/** AppConfig → SlotsManifest. 순수. 비밀(naiaKey/apiKey)은 절대 포함 안 함(strip). */
export function buildSlotsManifest(
	config: AppConfig,
	opts: { detectedVramGb?: number; now?: () => string } = {},
): SlotsManifest {
	const snap: SlotSnapshot = readSlots(config);
	const naiaAccount = !!config.naiaKey;
	const mode = deriveGate(naiaAccount);
	return {
		version: SLOTS_MANIFEST_VERSION,
		gate: { naiaAccount, mode },
		slots: {
			main: { provider: snap.main.provider, model: snap.main.model },
			sub: {
				provider: snap.sub.provider ?? "none",
				...(snap.sub.model ? { model: snap.sub.model } : {}),
			},
			embedding: {
				provider: snap.embedding.provider ?? "none",
				...(snap.embedding.model ? { model: snap.embedding.model } : {}),
			},
			stt: snap.stt.provider ? { provider: snap.stt.provider } : {},
			tts: snap.tts.provider ? { provider: snap.tts.provider } : {},
			avatar: {
				...(snap.avatar.provider ? { provider: snap.avatar.provider } : {}),
				...(snap.avatar.model ? { model: snap.avatar.model } : {}),
				...(config.naiaLocalUrl ? { localUrl: config.naiaLocalUrl } : {}),
			},
		},
		gpu: {
			...(opts.detectedVramGb !== undefined
				? { detectedVramGb: opts.detectedVramGb }
				: {}),
			...(config.localGpuTier ? { tier: config.localGpuTier } : {}),
			// 정본 local8gFocus ?? 구 localAvatarVoiceFocus(legacy).
			...((config.local8gFocus ?? config.localAvatarVoiceFocus)
				? {
						localFocus:
							config.local8gFocus ?? config.localAvatarVoiceFocus,
					}
				: {}),
		},
		...(opts.now ? { builtAt: opts.now() } : {}),
	};
}

/** 매니페스트 파스/검증(fail-closed). 잘못된 입력 = null(wm 이 안전하게 무시). 순수. */
export function parseSlotsManifest(raw: unknown): SlotsManifest | null {
	if (!raw || typeof raw !== "object") return null;
	const m = raw as Record<string, unknown>;
	if (m.version !== SLOTS_MANIFEST_VERSION) return null;
	if (!m.slots || typeof m.slots !== "object") return null;
	if (!m.gate || typeof m.gate !== "object") return null;
	// 최소 구조 검증 — 상세 필드는 wm 이 관대히 읽음(버전 고정이 주 계약).
	return m as unknown as SlotsManifest;
}

/** 매니페스트 직렬화(JSON). 파일/IPC 전송용. */
export function serializeSlotsManifest(manifest: SlotsManifest): string {
	return JSON.stringify(manifest);
}
