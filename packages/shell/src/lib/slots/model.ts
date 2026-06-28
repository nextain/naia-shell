// S-SLOT 순수 모델 — FR-SLOT.1~5 (docs/requirements.md), R1/R2 정정 반영.
// 게이트(naia 계정 binary) → 6 클라우드 슬롯(main·sub·embedding·stt·tts·avatar) 각각 독립 설정.
// I/O 0(DOM/localStorage 접근 금지) — SettingsTab UI·온보딩 기본값 양쪽이 동일 로직 소비(비일관 방지).
// SoT: .agents/progress/naia-model-slots-architecture-2026-06-28.md
import type { AppConfig, SttProviderId, TtsProviderId } from "../config";
import type { ProviderId } from "../types";

// ── FR-SLOT.2: 6 슬롯 (순서 권위) ──
export type SlotId = "main" | "sub" | "embedding" | "stt" | "tts" | "avatar";
export const SLOT_IDS: readonly SlotId[] = [
	"main",
	"sub",
	"embedding",
	"stt",
	"tts",
	"avatar",
];

// ── R1-5: 3 그룹(Brain·Voice·Avatar). 6슬롯을 중복·누락 없이 완전 분할. ──
export type SlotGroupId = "brain" | "voice" | "avatar";
export interface SlotGroup {
	readonly id: SlotGroupId;
	readonly labelKey: string;
	readonly slots: readonly SlotId[];
}
export const SLOT_GROUPS: readonly SlotGroup[] = [
	{
		id: "brain",
		labelKey: "settings.slot.groupBrain",
		slots: ["main", "sub", "embedding"],
	},
	{
		id: "voice",
		labelKey: "settings.slot.groupVoice",
		slots: ["stt", "tts"],
	},
	{
		id: "avatar",
		labelKey: "settings.slot.groupAvatar",
		slots: ["avatar"],
	},
];

// ── FR-SLOT.1: 게이트. naiaKey 존재 = naia(크레딧 접근). GPU·로컬 무관(R1-3). ──
// "Naia"는 provider가 아닌 접근 유형(게이트). 구 naia/byo/local 3-profile 은 폐기(R1-7).
export type GateMode = "naia" | "byo";

export function deriveGate(naiaKeyPresent: boolean): GateMode {
	return naiaKeyPresent ? "naia" : "byo";
}

export function deriveGateFromConfig(
	config: AppConfig | null | undefined,
): GateMode {
	// naiaKey 존재 여부만 판단 — detectGpuVramGb/localGpuTier 는 게이트와 무관(R1-3).
	return deriveGate(!!config?.naiaKey);
}

// ── 슬롯 ↔ AppConfig 필드 매핑 (FR-SLOT.5 필드명 유지: memoryLlmProvider) ──
export const SLOT_FIELD_MAP: Record<SlotId, readonly string[]> = {
	main: ["provider", "model"],
	// sub: 필드명 memoryLlmProvider 유지(R1-1). rename→subLlm* 은 Phase 3.4 dual-write.
	sub: ["memoryLlmProvider", "memoryLlmModel"],
	embedding: [
		"memoryEmbeddingProvider",
		"memoryOfflineModel",
		"memoryEmbeddingModel",
	],
	stt: ["sttProvider", "sttModel"],
	tts: ["ttsProvider", "ttsVoice"],
	avatar: ["liveProvider", "liveModel", "voiceRefUrl", "naiaLocalUrl"],
};

// ── 슬롯 값 스냅샷 ──
export interface SlotSnapshot {
	main: { provider: ProviderId; model: string };
	sub: {
		provider: AppConfig["memoryLlmProvider"];
		model?: string;
	};
	embedding: {
		provider: AppConfig["memoryEmbeddingProvider"];
		model?: string;
	};
	stt: { provider?: SttProviderId; model?: string };
	tts: { provider?: TtsProviderId; voice?: string };
	avatar: {
		provider?: string;
		model?: string;
		voiceRefUrl?: string;
	};
}

/** AppConfig → 6슬롯 스냅샷 읽기(순수). */
export function readSlots(config: AppConfig): SlotSnapshot {
	return {
		main: { provider: config.provider, model: config.model },
		sub: {
			provider: config.memoryLlmProvider,
			model: config.memoryLlmModel,
		},
		embedding: {
			provider: config.memoryEmbeddingProvider,
			model:
				config.memoryEmbeddingProvider === "offline"
					? config.memoryOfflineModel
					: config.memoryEmbeddingModel,
		},
		stt: {
			provider: config.sttProvider,
			model: config.sttModel,
		},
		tts: {
			provider: config.ttsProvider,
			voice: config.ttsVoice,
		},
		avatar: {
			provider: config.liveProvider,
			model: config.liveModel,
			voiceRefUrl: config.voiceRefUrl,
		},
	};
}

type SlotValueOf<K extends SlotId> = SlotSnapshot[K];

/**
 * FR-SLOT.2: 한 슬롯만 갱신 — 타 슬롯 필드는 불변(독립성).
 * 반환은 새 객체(비파괴). 필드명은 SLOT_FIELD_MAP 기반(R1-1 sub 필드명 유지).
 */
export function writeSlot<K extends SlotId>(
	config: AppConfig,
	slot: K,
	value: Partial<SlotValueOf<K>>,
): AppConfig {
	const next = { ...config } as Record<string, unknown>;
	switch (slot) {
		case "main": {
			const v = value as Partial<SlotSnapshot["main"]>;
			if (v.provider !== undefined) next.provider = v.provider;
			if (v.model !== undefined) next.model = v.model;
			break;
		}
		case "sub": {
			const v = value as Partial<SlotSnapshot["sub"]>;
			if (v.provider !== undefined) next.memoryLlmProvider = v.provider;
			if (v.model !== undefined) next.memoryLlmModel = v.model;
			break;
		}
		case "embedding": {
			const v = value as Partial<SlotSnapshot["embedding"]>;
			if (v.provider !== undefined) {
				next.memoryEmbeddingProvider = v.provider;
			}
			if (v.model !== undefined) {
				if (v.provider === "offline") {
					next.memoryOfflineModel = v.model;
				} else {
					next.memoryEmbeddingModel = v.model;
				}
			}
			break;
		}
		case "stt": {
			const v = value as Partial<SlotSnapshot["stt"]>;
			if (v.provider !== undefined) next.sttProvider = v.provider;
			if (v.model !== undefined) next.sttModel = v.model;
			break;
		}
		case "tts": {
			const v = value as Partial<SlotSnapshot["tts"]>;
			if (v.provider !== undefined) next.ttsProvider = v.provider;
			if (v.voice !== undefined) next.ttsVoice = v.voice;
			break;
		}
		case "avatar": {
			const v = value as Partial<SlotSnapshot["avatar"]>;
			if (v.provider !== undefined) next.liveProvider = v.provider;
			if (v.model !== undefined) next.liveModel = v.model;
			if (v.voiceRefUrl !== undefined) next.voiceRefUrl = v.voiceRefUrl;
			break;
		}
	}
	return next as unknown as AppConfig;
}

// ── FR-SLOT.3: naia 계정 시 Gemini 기본값(자동 적용). R2-1 + §9 #5(모델 문자열 확정). ──
// §9 #5 해결: stale hardcode "gemini-2.5-flash" 회피 — registry 카탈로그 실존 모델 사용.
// avatar = R2-1 "후속 지정" → 본 기본값에서 제외(DEFER).
export type NaiaDefaultSlots = Pick<
	SlotSnapshot,
	"main" | "sub" | "embedding" | "stt" | "tts"
>;
export const NAIA_SLOT_DEFAULTS: NaiaDefaultSlots = {
	main: { provider: "nextain", model: "gemini-3.5-flash" },
	sub: { provider: "naia", model: "gemini-3.1-flash-lite" },
	embedding: { provider: "offline", model: "all-MiniLM-L6-v2" },
	// R2-1 "STT = free(Naia Voice offline)". vosk/whisper 둘 다 오프라인 무료,
	// wire 값 보존(R1-2 — 라벨만 Naia Voice). Lite 를 기본으로 선택.
	stt: { provider: "vosk" },
	// R2-1 "TTS = Gemini TTS". naia 클라우드 TTS(nextain)가 Gemini 계열 TTS 경로.
	tts: { provider: "nextain" },
};

/** 슬롯이 미설정(빈/none/브라우저기본) 여부 — 사용자 override 보존 판단. */
function isMainSet(c: AppConfig): boolean {
	return !!c.provider;
}
function isSubSet(c: AppConfig): boolean {
	return !!c.memoryLlmProvider && c.memoryLlmProvider !== "none";
}
function isEmbeddingSet(c: AppConfig): boolean {
	return (
		!!c.memoryEmbeddingProvider && c.memoryEmbeddingProvider !== "none"
	);
}
function isSttSet(c: AppConfig): boolean {
	// web-speech = loadConfig 브라우저 자동기본(사용자 미선택 간주) → naia 기본값 적용 대상.
	const p = c.sttProvider;
	return !!p && p !== "web-speech";
}
function isTtsSet(c: AppConfig): boolean {
	return !!c.ttsProvider;
}

/**
 * FR-SLOT.3: naia 계정 게이트 통과 시 미설정 슬롯에 Gemini 기본값 적용.
 * 비파괴·idempotent — 이미 설정된 슬롯은 보존(사용자 override 우선).
 * 게이트 판단(deriveGateFromConfig)은 호출처 책임 — 본 함수는 순수 기본값 적용만.
 */
export function applyNaiaSlotDefaults(config: AppConfig): AppConfig {
	let next = config;
	if (!isMainSet(next)) {
		next = writeSlot(next, "main", NAIA_SLOT_DEFAULTS.main);
	}
	if (!isSubSet(next)) {
		next = writeSlot(next, "sub", NAIA_SLOT_DEFAULTS.sub);
	}
	if (!isEmbeddingSet(next)) {
		next = writeSlot(next, "embedding", NAIA_SLOT_DEFAULTS.embedding);
	}
	if (!isSttSet(next)) {
		next = writeSlot(next, "stt", NAIA_SLOT_DEFAULTS.stt);
	}
	if (!isTtsSet(next)) {
		next = writeSlot(next, "tts", NAIA_SLOT_DEFAULTS.tts);
	}
	// avatar: R2-1 후속 지정 — 기본값 적용 안 함(DEFER).
	return next;
}
