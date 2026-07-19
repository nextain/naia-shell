/**
 * VRAM-tier → capability data + selection (local GPU profile).
 *
 * Maps a detected GPU VRAM to which local capabilities a
 * tier can serve, as a *footprint-fit* projection built from private
 * footprint measurements; the tier thresholds come from a private deployment
 * draft.
 *
 * STATUS — wired into the settings UI (opt-in, default off). SettingsTab
 * detects GPU VRAM (`detectGpuVramGb` → Rust `detect_gpu_vram`) and shows
 * which local services are budget candidates. It must not hide external slots
 * until a runtime manager reports actual readiness.
 *
 * BOUNDARIES (do not violate):
 * - Consumer/UI view only — declares *which capabilities a tier could serve*,
 *   not how. The canonical tier/deploy *serving-supply* manifest (which
 *   models/engines to fetch) lives in private infra notes; the actual fetch/launch
 *   loader lives in naia-omni-windows-manager and is gated on real device RTF
 *   measurement. Neither the loader nor local serving is implemented here.
 * - Hard rule F1 (windows-manager): real-time (RTF<1) is a measured gate per
 *   GPU — NEVER claimed here. `realtime` is always "measurement-gated"; this
 *   module asserts only what *fits* in VRAM by footprint, not that it runs in
 *   real time.
 */

import type { ModelCapability } from "../types";

/**
 * 소비자 로컬 GPU 티어 (2026-07-08 재정의 — SoT: naia-video-avatar-voice-architecture).
 * 프라이버시의 진짜 민감 자산 = 브레인(LLM 추론 + 기억)이지 아바타 렌더가 아니다.
 * 그래서 로컬 능력을 **단조(monotonic)** 로 얹는다: avatar → +llm → +voice → +realtime.
 * 각 티어가 앞 티어 능력을 포함하며 하나씩 더한다(배타 선택 없음).
 */
export type VramTierId =
	| "avatar-6g"
	| "local-llm-avatar-8g"
	| "laptop-4060-8g"
	| "local-llm-voice-16g"
	| "local-voice-12g"
	| "full-realtime-24g";

/** 저장된 config 하위호환 — 구 티어 id → 신 id (2026-07-08 리네임 + 2026-07-15). */
const LEGACY_TIER_ALIAS: Record<string, VramTierId> = {
	"external-llm-6g": "avatar-6g",
	"avatar-or-voice-8g": "local-llm-avatar-8g",
	"avatar-voice-12g": "local-voice-12g",
	"full-local-24g": "full-realtime-24g",
	// 2026-07-15: LLM+음성 티어를 8g → 16g 로 정직화 (fp16 음성 6.1G 기준 — int8 미검증).
	"local-llm-voice-8g": "local-llm-voice-16g",
};

/**
 * 8G 배타 티어의 로컬 선택(2026-07-08 확정). 8G 는 로컬 LLM + 아바타를 넉넉히 동시에 올리기엔
 * tight → 셋 중 택1:
 * - "llm"    → 브레인만 로컬(추론·기억 프라이버시), 아바타는 클라우드/정적.
 * - "avatar" → 아바타(Ditto)만 로컬, 브레인은 클라우드.
 * - "both"   → 둘 다 로컬(compact LLM 필수, DNA3.0-4B Q4 ~3.4G+아바타 2.6G≈6G). VRAM 안 맞으면
 *              프리플라이트(fitLocalCapabilitiesToVram)가 llm 을 클라우드로 강등.
 * 음성(TTS/STT)은 8G 에선 **항상 클라우드**. 비배타 티어(6/12/24G)에선 이 focus 는 무시된다.
 */
export type Local8gFocus = "llm" | "avatar" | "both";

/** capability → VRAM footprint(GB). windows-manager capabilities.py 실측과 동형(SoT는 wm). */
const CAPABILITY_VRAM_COST_GB: Partial<Record<ModelCapability, number>> = {
	tts: 3.47, // VoxCPM2 int8 weight-only(8G 로컬 음성 정본, RTX 5060 실측 2026-07-04). wm tts_voxcpm2_int8 와 동형.
	avatar: 2.6, // Ditto TRT 립싱크(실측).
	llm: 4.0, // 로컬 compact LLM 4B-class Q4(DNA3.0-4B ~3.4G · gemma-e4b-q4 5.0G 중간값). 상위티어 대형모델은 더 큼(측정 게이트).
	embedding: 0.5,
	stt: 2.5,
};

export interface VramTier {
	id: VramTierId;
	label: string;
	/** Minimum detected VRAM (GB) for this tier to be eligible. */
	minVramGb: number;
	/** Whether the LLM runs locally ("own") or via an external provider. */
	llm: "external" | "own";
	/**
	 * Local capabilities the tier can serve by VRAM footprint.
	 * NOT a real-time guarantee — see F1.
	 * `exclusiveLocal` 티어에서는 이 목록이 **동시 구동**이 아니라 **후보(택1)** 다.
	 */
	localCapabilities: ModelCapability[];
	/**
	 * 배타 티어 — `localCapabilities` 를 동시에 다 못 올린다(VRAM 부족). GPU 프로파일의
	 * avatar/voice focus 로 하나를 골라야 한다. 없으면(=false/미지정) 전부 동시 구동.
	 */
	exclusiveLocal?: boolean;
	/**
	 * 미검증 티어 = 피커 비노출 **+ auto 산출 제외**(2026-07-15 루크: "미검증 숨김 / 자동 없애던지").
	 * 실기 검증 안 된 티어는 (1) 피커에 안 뜨고 (2) selectVramTier(auto)가 안 고른다 — 잘못 골라
	 * 무음/VRAM 포화/미검증 아바타 자동주입이 나던 사고 차단(실증). **트레이드오프(문서화)**: 검증
	 * 티어가 하나(16G)뿐이라 <16GB VRAM 은 auto 로 로컬 프로파일을 못 받고 클라우드로 남는다 —
	 * 프리릴리스 단계라 허용, 티어가 검증되면 hidden 을 풀어 auto 대상에 편입. 저장값·구 id 하위호환
	 * (normalizeTierId)·명시 선택은 유지(숨김은 auto+피커에만 작용).
	 */
	hidden?: boolean;
	/** Approx summed VRAM of the local components (private measured). */
	approxLocalVramGb: number;
	/** windows-manager `--profile` override for named loader profiles. */
	loaderProfile?: string;
	/** Real-time (RTF<1) is a measured gate per GPU — never asserted (F1). */
	realtime: "measurement-gated";
	note: string;
}

/**
 * Tiers — 2026-07-08 재정의 × private measured footprints. Ordered ascending.
 * 단조: 각 티어가 로컬 능력을 하나씩 더한다(avatar → +llm → +voice → +realtime).
 * VRAM 산술은 CAPABILITY_VRAM_COST_GB(avatar 2.6 · llm 5.0 · tts 3.47) 기준.
 */
export const VRAM_TIERS: readonly VramTier[] = [
	{
		id: "avatar-6g",
		// 라벨 원칙: "로컬로 도는 것"을 앞에 명시 (2026-07-15 루크: 구 라벨이 무엇이 로컬인지 모호했음)
		label: "6GB — 로컬은 비디오 아바타만 (LLM·음성 = 클라우드)",
		minVramGb: 6,
		llm: "external",
		// 6GB: 로컬 LLM(≥5G)+아바타(2.6G)=7.6G > 6G → 로컬 LLM 불가. 아바타만 로컬, 브레인·음성 클라우드.
		localCapabilities: ["avatar"],
		approxLocalVramGb: 2.6,
		hidden: true, // 실기 미검증(2026-07-15) — 피커 비노출, 검증 후 해제
		realtime: "measurement-gated",
		note: "6GB: 로컬 아바타(Ditto 2.6G)만. LLM·STT·TTS = 클라우드. 로컬 LLM은 8GB부터.",
	},
	{
		id: "local-llm-avatar-8g",
		label: "8GB — 로컬 LLM · 아바타 · 둘 다 (택1, 음성 클라우드)",
		minVramGb: 8,
		llm: "own",
		// 8GB(4060/5060) 배타 티어 — 로컬 LLM(compact, DNA3.0-4B Q4 ~3.4G 검증)+아바타(2.6G)≈6G 는
		// 둘 다 올릴 수 있으나 디스플레이 reserve 감안 tight → focus 로 택1: llm / avatar / both.
		// 음성 3.47G 는 동시상주 불가 → STT/TTS = 항상 클라우드. 프라이버시 = 추론·기억 로컬(브레인 스코프).
		localCapabilities: ["llm", "avatar"],
		exclusiveLocal: true, // focus = llm | avatar | both (음성 없음).
		approxLocalVramGb: 6.0, // both = compact LLM(DNA3.0-4B Q4 ~3.4G) + avatar 2.6G.
		hidden: true, // 실기 미검증(2026-07-15) — 피커 비노출, 검증 후 해제
		realtime: "measurement-gated",
		// ⚠️ both 는 tight — 런타임 프리플라이트(fitLocalCapabilitiesToVram)가 free VRAM 부족 시 llm 을
		// 클라우드로 강등(아바타 보존). compact 모델 강제(DNA3.0-4B Q4 등) + context cap 필요.
		note: "8GB 택1: 로컬 LLM(DNA3.0-4B Q4 등 compact) / 아바타 / 둘 다. 음성=클라우드. both 는 VRAM 부족 시 LLM 클라우드 폴백.",
	},
	{
		id: "laptop-4060-8g",
		label:
			"8GB RTX 4060 laptop: local int8 voice + video avatar (LLM/STT cloud)",
		minVramGb: 8,
		llm: "external",
		localCapabilities: ["tts", "avatar"],
		approxLocalVramGb: 6.07,
		loaderProfile: "laptop_4060_8g",
		realtime: "measurement-gated",
		note: "RTX 4060 Laptop 8GB + Ryzen 8845H/8645HS class: windows-manager laptop_4060_8g profile. Runs VoxCPM2 int8 TTS + Ditto avatar locally; LLM/STT stay external. Full local realtime voice is not claimed.",
	},
	{
		id: "local-voice-12g",
		label: "12GB (4070+) — 로컬 LLM + 아바타 + 음성",
		minVramGb: 12,
		llm: "own",
		// 12GB(4070+): LLM(5)+아바타(2.6)+음성 int8(3.47)=11.1G ≤ 12G → 오디오까지 로컬.
		// 음성은 batch(VoxCPM2 RTF>1). 실시간 아님 — 실시간은 24G/ggml 게이트.
		localCapabilities: ["llm", "avatar", "tts"],
		approxLocalVramGb: 11.1,
		hidden: true, // 실기 미검증(2026-07-15) — 피커 비노출, 검증 후 해제
		realtime: "measurement-gated",
		note: "12GB(4070+): LLM+아바타+음성 전부 로컬. 음성 batch(composed, RTF>1). 실시간 배지는 24G/ggml 측정 후.",
	},
	{
		id: "local-llm-voice-16g",
		label: "16GB — 로컬 LLM + 음성",
		minVramGb: 16,
		llm: "own",
		// LLM+음성 로컬, Ditto 아바타 제외(아바타 = 셸 VRM 렌더 or 클라우드) — 2026-07-15 루크 지시
		// "VoxCPM2 + LLM 프로파일". **16GB 정직화**(루크: "8GB 프로파일인데 16GB 가 부족하다면 모순"):
		// int8 음성(3.47G)은 Windows 미검증이라 실제 도는 건 fp16(~6.1G) → compact LLM(3.4~4)과
		// 합쳐 ~10G + 데스크톱/버퍼 = 16GB 가 정직한 하한. int8 검증되면 8GB 변형을 다시 연다.
		// auto: 검증된 티어는 이것뿐이므로 16GB+ auto = 이 티어 (hidden 티어는 auto 제외 —
		// 2026-07-15 루크 실증: auto 가 숨긴 12g 를 골라 NVA 를 심었음). 3080 Ti 16G 시연 정본.
		localCapabilities: ["llm", "tts"],
		approxLocalVramGb: 10.0, // fp16 음성 6.1 + compact LLM ~3.9 (int8 검증 전 정직 산술)
		realtime: "measurement-gated",
		note: "로컬 LLM(compact) + 로컬 음성(VoxCPM2 fp16). Ditto 아바타 없음 — 아바타는 VRM(셸 렌더, GPU 미미) 또는 클라우드. 음성 표면 = 로컬 cascade façade /v1/audio/speech. 실기 검증: 3080 Ti 16G (2026-07-15).",
	},
	{
		id: "full-realtime-24g",
		label: "24/32GB+ — 완전 로컬 + 실시간(ggml 게이트)",
		minVramGb: 24,
		llm: "own",
		localCapabilities: ["llm", "avatar", "tts"],
		approxLocalVramGb: 12, // fp16 여유. + 로컬 LLM(모델 의존, 미합산).
		hidden: true, // 실기 미검증(2026-07-15) — 피커 비노출, 검증 후 해제
		realtime: "measurement-gated",
		note: "24G+: 완전 로컬. 실시간(RTF<1) = ggml/VoxCPM.cpp 트랙, 측정 통과 시에만 realtime 배지(F1).",
	},
];

/**
 * Pick the richest tier whose `minVramGb` the detected VRAM satisfies.
 * Returns null when VRAM is below the lowest tier (→ external-only / cloud).
 */
export function selectVramTier(vramGb: number): VramTier | null {
	let chosen: VramTier | null = null;
	for (const tier of VRAM_TIERS) {
		// hidden(미검증) 티어는 auto 에서도 제외 (2026-07-15 루크 실증: 16GB auto 가 숨긴
		// 12g 티어를 골라 NVA 아바타를 심었다). 자동 = **검증된 티어만** 고른다 — 피커와 동일 기준.
		if (tier.hidden) continue;
		if (vramGb >= tier.minVramGb) chosen = tier;
	}
	return chosen;
}

/**
 * Resolve the active local tier from the config setting + detected VRAM.
 * - "off" / undefined → null (local profile disabled; safe default → no slot change)
 * - "auto" → tier derived from detected VRAM (null if VRAM unknown)
 * - explicit tier id → that tier (manual override)
 */
/**
 * 구/신 티어 id 를 신 id 로 정규화(하위호환). 알 수 없는 값이면 null.
 * ★ tier id 를 소비하는 **모든 경계**(config 직독·select 바인딩·manifest·라벨 조회)
 *   앞단에서 이걸 통과시켜야 저장된 구 id 가 조용히 깨지지 않는다.
 */
export function normalizeTierId(
	id: string | null | undefined,
): VramTierId | null {
	if (!id) return null;
	const aliased = LEGACY_TIER_ALIAS[id] ?? id;
	return VRAM_TIERS.some((t) => t.id === aliased)
		? (aliased as VramTierId)
		: null;
}

/**
 * config 설정값(티어 id | "auto" | "off" | 구 id | undefined)을 유효 설정값으로 정규화.
 * "auto"/"off" 는 그대로, 구 티어 id 는 신 id 로, 알 수 없으면 "off".
 * SettingsTab select 바인딩·config 로드에서 사용.
 */
export function normalizeTierSetting(
	setting: string | null | undefined,
): VramTierId | "auto" | "off" {
	if (setting === "auto" || setting === "off") return setting;
	return normalizeTierId(setting) ?? "off";
}

export function resolveActiveTier(
	setting: VramTierId | "auto" | "off" | undefined,
	detectedVramGb: number | null,
): VramTier | null {
	if (!setting || setting === "off") return null;
	if (setting === "auto") {
		return detectedVramGb != null ? selectVramTier(detectedVramGb) : null;
	}
	// 하위호환: 저장된 구 티어 id 를 신 id 로 정규화한 뒤 조회.
	const id = normalizeTierId(setting);
	return id ? (VRAM_TIERS.find((t) => t.id === id) ?? null) : null;
}

/**
 * Capabilities a tier could serve locally by VRAM footprint. This is a budget
 * candidate list, not a readiness signal.
 */
export function tierProvidedCapabilities(tier: VramTier): ModelCapability[] {
	return [...tier.localCapabilities];
}

/**
 * 8G focus 미지정 시 기본 = "llm" (브레인만 로컬 = 프라이버시-우선 + 최안전 VRAM).
 * codex 재리뷰: "both" 는 8G 에서 tight(6.6G)해 프리플라이트가 어차피 llm 을 강등할 수 있어
 * 기본으로 부적절 → 항상 맞고(4.0G) 프라이버시 값이 가장 큰 "llm" 을 기본으로.
 */
const DEFAULT_8G_FOCUS: Local8gFocus = "llm";

/**
 * 저장값을 유효 Local8gFocus 로 정규화(검증 + 구 축 마이그레이션).
 * 신 값(llm/avatar/both) 그대로, 구 축 "voice"(로컬 음성=새 축 없음) → "avatar", 그 외 → 기본.
 * ★ local8gFocus(정본) ?? localAvatarVoiceFocus(legacy) 를 이걸로 통과시켜 읽는다.
 */
export function normalizeLocal8gFocus(
	v: string | null | undefined,
): Local8gFocus {
	if (v === "llm" || v === "avatar" || v === "both") return v;
	if (v === "voice") return "avatar";
	return DEFAULT_8G_FOCUS;
}

/**
 * 티어의 로컬 capability 를 해소한다.
 * - 비배타 티어(6/12/24G) → 후보 전부(focus 무시).
 * - 배타 티어(8G) → focus 로 택1: "llm"→["llm"], "avatar"→["avatar"], "both"→[llm, avatar].
 *   (음성은 8G 후보에 없음.) 실제 VRAM 맞춤은 fitLocalCapabilitiesToVram 가 별도로 조정.
 */
export function resolveLocalCapabilities(
	tier: VramTier | null,
	focus: Local8gFocus | undefined,
): ModelCapability[] {
	if (!tier) return [];
	if (!tier.exclusiveLocal) return [...tier.localCapabilities];
	const f = focus ?? DEFAULT_8G_FOCUS;
	const cands = tier.localCapabilities;
	if (f === "both") return cands.filter((c) => c === "llm" || c === "avatar");
	const want: ModelCapability = f === "llm" ? "llm" : "avatar";
	if (cands.includes(want)) return [want];
	const fb = cands.find((c) => c === "llm" || c === "avatar");
	return fb ? [fb] : [];
}

/** 이 티어가 아바타+음성을 **동시에** 로컬 구동할 수 있는가(배타 아님 + tts 후보). 8G(음성 없음)=false. */
export function tierFitsBoth(tier: VramTier | null): boolean {
	if (!tier) return false;
	const hasAvatar = tier.localCapabilities.includes("avatar");
	const hasVoice = tier.localCapabilities.includes("tts");
	return hasAvatar && hasVoice && !tier.exclusiveLocal;
}

/** capability footprint(GB) — 미등록이면 0. 예산 판정/표시용. */
export function capabilityVramCostGb(cap: ModelCapability): number {
	return CAPABILITY_VRAM_COST_GB[cap] ?? 0;
}

export interface VramFitResult {
	/** 조정 후 실제 로컬 구동 capability. */
	caps: ModelCapability[];
	/** 로컬 LLM 이 free VRAM 에 안 맞아 클라우드로 강등됐나(브레인은 클라우드도 무방). */
	llmFallbackToCloud: boolean;
	/** 요청 caps 합계(GB). */
	requiredGb: number;
	/** 판정에 쓴 가용 VRAM(GB), 미측정이면 Infinity. */
	availableGb: number;
}

/**
 * 프리플라이트 VRAM 판정 (codex 요구: 8G OOM 폴백의 셸측 구현).
 * 요청 로컬 caps 가 **가용(free) VRAM** 에 마진 두고 맞는지 확인하고, 안 맞으면 **LLM 을 먼저
 * 클라우드로 강등**해 아바타를 보존한다(브레인은 클라우드도 가능, 아바타는 로컬만 의미 있음).
 * 인퍼런스-타임 실제 OOM 캐치는 wm/serving 담당 — 여기선 기동 전 예산 판정만.
 * @param availableVramGb 실제 free VRAM(디스플레이 reserve 제외). null=미측정→그대로 통과.
 * @param marginGb 안전 여유(기본 1.0G: WDDM reserve/KV cache/fragmentation).
 */
export function fitLocalCapabilitiesToVram(
	caps: ModelCapability[],
	availableVramGb: number | null,
	marginGb = 1.0,
): VramFitResult {
	const requiredGb = caps.reduce((s, c) => s + capabilityVramCostGb(c), 0);
	if (availableVramGb == null) {
		return {
			caps,
			llmFallbackToCloud: false,
			requiredGb,
			availableGb: Number.POSITIVE_INFINITY,
		};
	}
	const budget = availableVramGb - marginGb;
	if (requiredGb <= budget || !caps.includes("llm")) {
		return {
			caps,
			llmFallbackToCloud: false,
			requiredGb,
			availableGb: availableVramGb,
		};
	}
	// 안 맞음 + llm 포함 → llm 을 클라우드로 강등(아바타 등 나머지 보존).
	return {
		caps: caps.filter((c) => c !== "llm"),
		llmFallbackToCloud: true,
		requiredGb,
		availableGb: availableVramGb,
	};
}
