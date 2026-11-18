import { effectiveAvatarProviderFromConfig } from "./avatar/nva-gate";
import {
	KIOSK_JINA_CARD_ID,
	KIOSK_JINA_SAVED_CARD,
	KIOSK_JINA_THEME,
	characterCardPatch,
	libraryCard,
} from "./character-theme";
import type { AppConfig } from "./config";
import { isKioskDemo } from "./kiosk-demo/flag";
import {
	WEB_DEFAULT_NVA,
	isLegacyWebNaiaSelection,
	isWebMode,
} from "./web-runtime/web-assets";
import {
	WEB_LLM_MODEL_ID,
	isWebLlmModelId,
} from "./web-runtime/webllm-model";

/**
 * FR-VOICE.15 (#418): retired config fields that the safety migration strips
 * (normalizeLocalRuntimeConfig in config.ts). Harness/e2e seeds must never
 * reintroduce them — a seeded retired field is treated as stale authority and
 * silently disables local voice (the 2026-08-11 voice-6g harness incident).
 * Keep in sync with the destructuring in normalizeLocalRuntimeConfig;
 * config-seed.test.ts pins the correspondence against real migration output.
 */
export const RETIRED_CONFIG_KEYS = [
	"cascadeRuntimeUrl",
	"local8gFocus",
	"localAvatarVoiceFocus",
	"localGpuTier",
] as const;

export type RetiredConfigKey = (typeof RETIRED_CONFIG_KEYS)[number];

/** Shell config shape a harness may seed: product schema minus retired keys. */
export type SeedableShellConfig = Partial<Omit<AppConfig, RetiredConfigKey>>;

/**
 * Build a harness/e2e config seed from the product schema. Excess-property
 * checking rejects unknown and retired keys at compile time for object
 * literals; the runtime guard rejects retired keys arriving through spreads.
 */
export function buildSeedShellConfig(
	seed: SeedableShellConfig,
): SeedableShellConfig {
	for (const key of RETIRED_CONFIG_KEYS) {
		if (key in seed) {
			throw new Error(`retired config key must not be seeded: ${key}`);
		}
	}
	return seed;
}

export const KIOSK_DEMO_LLM_PROVIDER = "nextain" as const;
export const KIOSK_DEMO_LLM_MODEL = "gpt-5.6-luna" as const;
export const KIOSK_DEMO_THINKING_LEVEL = "low" as const;
export const KIOSK_DEMO_ENABLE_TOOLS = true as const;
export const KIOSK_DEMO_ENVIRONMENT_AWARENESS = "off" as const;
export const KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT = false as const;
export const KIOSK_DEMO_LLM_FALLBACK_MODELS = [
	"deepseek-v4-pro",
	"deepseek-v4-flash",
	"solar-pro4",
	"solar-mini",
] as const;
export const KIOSK_DEMO_TTS_PROVIDER = "nextain" as const;
// 지나 고유 목소리(naia-voice:tpl-jina)가 운영 게이트웨이에 등록된 뒤 이 상수 한 곳만 바꾼다.
export const KIOSK_DEMO_TTS_VOICE = "ko-KR-Neural2-A" as const;
export const KIOSK_DEMO_NVA_MODEL = "jina";
export const DEFAULT_SHELL_NAIA_WIDTH = 320;
export const KIOSK_SHELL_NAIA_WIDTH = 520;
export const KIOSK_SHELL_CHAT_HEIGHT_MIN = 540;
export const KIOSK_SHELL_CHAT_HEIGHT_RATIO = 0.76;
export const KIOSK_SHELL_AVATAR_AREA_RATIO = 0.24;

let kioskGatewayServedModels: ReadonlySet<string> | null = null;

export function setKioskDemoGatewayServedModels(
	gatewayServed: ReadonlySet<string> | null,
): void {
	kioskGatewayServedModels = gatewayServed;
}

/**
 * 키오스크 시연의 주 모델은 크레딧 보호를 위해 gpt-5.6-luna로 고정하고,
 * 게이트웨이 /v1/models 목록에 luna가 없을 때만 대체 모델로 내린다.
 */
export function resolveKioskDemoMainModel(
	gatewayServed?: ReadonlySet<string> | null,
): string {
	const served =
		gatewayServed === undefined ? kioskGatewayServedModels : gatewayServed;
	if (!served || served.has(KIOSK_DEMO_LLM_MODEL)) {
		return KIOSK_DEMO_LLM_MODEL;
	}
	return (
		KIOSK_DEMO_LLM_FALLBACK_MODELS.find((id) => served.has(id)) ??
		KIOSK_DEMO_LLM_MODEL
	);
}

/**
 * 키오스크 시연 판에서는 저장값(terra·다른 프로바이더·생각 세기·도구·작업 표면 설정 등)과 무관하게
 * 주 공급자("nextain"), 주 모델(resolveKioskDemoMainModel), 생각 세기(KIOSK_DEMO_THINKING_LEVEL = "low"),
 * 도구 사용(KIOSK_DEMO_ENABLE_TOOLS = true), 작업 표면 인지(KIOSK_DEMO_ENVIRONMENT_AWARENESS = "off"),
 * 터미널 직접 입력(KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT = false)을 한 곳에서 강제한다.
 */
export const KIOSK_LOCAL_ANSWER_STORAGE_KEY = "naia-kiosk-local-answer" as const;

export const isKioskLocalAnswerEnabled = (): boolean => {
	if (!isKioskDemo()) return false;
	try {
		if (typeof localStorage === "undefined") return false;
		return localStorage.getItem(KIOSK_LOCAL_ANSWER_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
};

export const setKioskLocalAnswerEnabled = (enabled: boolean): void => {
	try {
		if (typeof localStorage === "undefined") return;
		if (enabled) {
			localStorage.setItem(KIOSK_LOCAL_ANSWER_STORAGE_KEY, "1");
		} else {
			localStorage.removeItem(KIOSK_LOCAL_ANSWER_STORAGE_KEY);
		}
	} catch {
		// ignore storage errors
	}
};

export function applyKioskDemoMainModel<T extends Partial<AppConfig>>(
	config: T,
	gatewayServed?: ReadonlySet<string> | null,
): T {
	if (!isKioskDemo()) return config;
	const useLocalWebLlm =
		isKioskLocalAnswerEnabled() && config.provider === "webllm";
	const provider = useLocalWebLlm ? "webllm" : KIOSK_DEMO_LLM_PROVIDER;
	const model = useLocalWebLlm
		? typeof config.model === "string" && isWebLlmModelId(config.model)
			? config.model
			: WEB_LLM_MODEL_ID
		: resolveKioskDemoMainModel(gatewayServed);
	const currentMain =
		config.llmRoles?.main && typeof config.llmRoles.main === "object"
			? config.llmRoles.main
			: undefined;
	const { inherit: _ignoredInherit, ...restMain } = currentMain ?? {};
	const next = {
		...config,
		provider,
		model,
		enableTools: KIOSK_DEMO_ENABLE_TOOLS,
		thinkingLevel: KIOSK_DEMO_THINKING_LEVEL,
		enableThinking: (KIOSK_DEMO_THINKING_LEVEL as string) !== "off",
		environmentAwareness: KIOSK_DEMO_ENVIRONMENT_AWARENESS,
		environmentTerminalInput: KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT,
		llmRoles: {
			...config.llmRoles,
			main: {
				...restMain,
				provider,
				model,
				thinkingLevel: KIOSK_DEMO_THINKING_LEVEL,
			},
		},
	};
	if ("mainModelThinkingLevels" in (next as Record<string, unknown>)) {
		delete (next as Record<string, unknown>).mainModelThinkingLevels;
	}
	return next;
}

export function resolveShellAvatarSelection(
	config: AppConfig | null | undefined,
	detectedVramGb: number | null = null,
): {
	avatarProvider: "vrm" | "naia-video-avatar";
	nvaModel: string;
} {
	if (isKioskDemo()) {
		const saved = config?.nvaModel?.trim() ?? "";
		const activeCardId =
			typeof config?.uiPreferences?.b2cActiveCardId === "string"
				? config.uiPreferences.b2cActiveCardId
				: "";
		if (activeCardId && activeCardId !== KIOSK_JINA_CARD_ID && saved) {
			return {
				avatarProvider: "naia-video-avatar",
				nvaModel: saved,
			};
		}
		return {
			avatarProvider: "naia-video-avatar",
			nvaModel:
				saved && saved !== WEB_DEFAULT_NVA ? saved : KIOSK_DEMO_NVA_MODEL,
		};
	}
	const legacyWebNaia = isWebMode() && isLegacyWebNaiaSelection(config);
	return {
		avatarProvider: legacyWebNaia
			? "naia-video-avatar"
			: effectiveAvatarProviderFromConfig(config, detectedVramGb),
		nvaModel: legacyWebNaia ? WEB_DEFAULT_NVA : (config?.nvaModel ?? ""),
	};
}

function readStoredChatHeightRatioForSeed(): number | null {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem("naia-chat-height-ratio");
		const val = raw === null ? Number.NaN : Number(raw);
		return Number.isFinite(val) && val >= 0.2 && val <= 0.92 ? val : null;
	} catch {
		return null;
	}
}

function readStoredNaiaWidthForSeed(): number | null {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem("naia-layout-width");
		const val = raw === null ? Number.NaN : Number(raw);
		return Number.isFinite(val) && val >= 120 && val <= 1200
			? Math.round(val)
			: null;
	} catch {
		return null;
	}
}

export function resolveInitialShellChatLayout(viewportHeight: number): {
	naiaWidth: number;
	chatHeight: number;
} {
	const safeHeight =
		Number.isFinite(viewportHeight) && viewportHeight > 0
			? viewportHeight
			: 800;
	const storedRatio = readStoredChatHeightRatioForSeed();
	const storedWidth = readStoredNaiaWidthForSeed();
	if (isKioskDemo()) {
		const ratio = storedRatio ?? KIOSK_SHELL_CHAT_HEIGHT_RATIO;
		const rawHeight = Math.round(safeHeight * ratio);
		const maxUnclippedHeight = Math.max(180, safeHeight - 88);
		const chatHeight =
			storedRatio !== null
				? Math.min(maxUnclippedHeight, Math.max(160, rawHeight))
				: safeHeight < 620
					? Math.min(maxUnclippedHeight, Math.max(220, rawHeight))
					: Math.min(
							maxUnclippedHeight,
							Math.max(KIOSK_SHELL_CHAT_HEIGHT_MIN, rawHeight),
						);
		return {
			naiaWidth: storedWidth ?? KIOSK_SHELL_NAIA_WIDTH,
			chatHeight,
		};
	}
	return {
		naiaWidth: storedWidth ?? DEFAULT_SHELL_NAIA_WIDTH,
		chatHeight: Math.round(safeHeight * (storedRatio ?? 0.4)),
	};
}

/** OFF는 빈 패치: 일반판의 모든 기본값과 온보딩 선택을 보존한다. */
export function buildKioskDemoConfigSeed(): SeedableShellConfig {
	kioskGatewayServedModels = null;
	if (!isKioskDemo()) return {};
	setKioskLocalAnswerEnabled(false);
	const model = resolveKioskDemoMainModel(null);
	const jinaCardPatch = characterCardPatch(
		libraryCard(KIOSK_JINA_SAVED_CARD),
		"게스트",
		"ko",
	);
	return buildSeedShellConfig({
		agentName: jinaCardPatch.patch.agentName,
		userName: "게스트",
		honorific: "님",
		speechStyle: "formal",
		locale: "ko",
		persona: jinaCardPatch.patch.persona,
		personaDisabled: false,
		onboardingComplete: true,
		ttsEnabled: true,
		ttsProvider: KIOSK_DEMO_TTS_PROVIDER,
		ttsVoice: KIOSK_DEMO_TTS_VOICE,
		avatarProvider: "naia-video-avatar",
		nvaModel: KIOSK_DEMO_NVA_MODEL,
		backgroundVideo: KIOSK_JINA_THEME.backgroundVideo,
		uiPreferences: {
			b2cCardLibrary: [KIOSK_JINA_SAVED_CARD],
			b2cActiveCardId: KIOSK_JINA_CARD_ID,
			b2cNvaThemes: [KIOSK_JINA_THEME],
			b2cGreetingAutoplay: true,
		},
		provider: KIOSK_DEMO_LLM_PROVIDER,
		model,
		enableTools: KIOSK_DEMO_ENABLE_TOOLS,
		thinkingLevel: KIOSK_DEMO_THINKING_LEVEL,
		enableThinking: (KIOSK_DEMO_THINKING_LEVEL as string) !== "off",
		environmentAwareness: KIOSK_DEMO_ENVIRONMENT_AWARENESS,
		environmentTerminalInput: KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT,
		webAutoDefaultModel: false,
		llmRoles: {
			main: {
				provider: KIOSK_DEMO_LLM_PROVIDER,
				model,
				thinkingLevel: KIOSK_DEMO_THINKING_LEVEL,
			},
		},
	});
}
