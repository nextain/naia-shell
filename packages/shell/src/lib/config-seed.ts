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
import jinaPersona from "./kiosk-demo/jina-persona.json";
import {
	WEB_DEFAULT_NVA,
	isLegacyWebNaiaSelection,
	isWebMode,
} from "./web-runtime/web-assets";
import {
	KIOSK_DEMO_LLM_PROVIDER,
	KIOSK_DEMO_THINKING_LEVEL,
	KIOSK_DEMO_ENABLE_TOOLS,
	KIOSK_DEMO_ENVIRONMENT_AWARENESS,
	KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT,
	KIOSK_DEMO_TTS_PROVIDER,
	KIOSK_DEMO_TTS_VOICE,
	resolveKioskDemoMainModel,
	setKioskDemoGatewayServedModels,
	setKioskLocalAnswerEnabled,
} from "./kiosk-demo/model-config";
export * from "./kiosk-demo/model-config";

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

export const KIOSK_DEMO_NVA_MODEL = "jina";
export const DEFAULT_SHELL_NAIA_WIDTH = 320;
export const KIOSK_SHELL_NAIA_WIDTH = 520;
export const KIOSK_SHELL_CHAT_HEIGHT_MIN = 540;
export const KIOSK_SHELL_CHAT_HEIGHT_RATIO = 0.76;
export const KIOSK_SHELL_AVATAR_AREA_RATIO = 0.24;

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
	setKioskDemoGatewayServedModels(null);
	if (!isKioskDemo()) return {};
	setKioskLocalAnswerEnabled(false);
	const model = resolveKioskDemoMainModel(null);
	const jinaCardPatch = characterCardPatch(
		libraryCard(KIOSK_JINA_SAVED_CARD),
		jinaPersona.defaultUserName,
		"ko",
	);
	return buildSeedShellConfig({
		agentName: jinaCardPatch.patch.agentName,
		userName: jinaPersona.defaultUserName,
		honorific: jinaPersona.defaultHonorific,
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
