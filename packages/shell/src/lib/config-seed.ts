import { effectiveAvatarProviderFromConfig } from "./avatar/nva-gate";
import type { AppConfig } from "./config";
import { isKioskDemo } from "./kiosk-demo/flag";
import { getDefaultLlmModel } from "./llm/registry";
import { KIOSK_DEMO_PERSONA } from "./persona";
import {
	WEB_DEFAULT_NVA,
	isLegacyWebNaiaSelection,
	isWebMode,
} from "./web-runtime/web-assets";

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

export const KIOSK_DEMO_TTS_PROVIDER = "naia-local-voice" as const;
export const KIOSK_DEMO_TTS_HOST = "https://bc250-0-voice.nextain.io";
export const KIOSK_DEMO_TTS_VOICE = "naia-default";
export const KIOSK_DEMO_NVA_MODEL = "jina";
export const DEFAULT_SHELL_NAIA_WIDTH = 320;
export const KIOSK_SHELL_NAIA_WIDTH = 560;
export const KIOSK_SHELL_CHAT_HEIGHT_MIN = 540;
export const KIOSK_SHELL_CHAT_HEIGHT_RATIO = 0.78;

export function resolveShellAvatarSelection(
	config: AppConfig | null | undefined,
	detectedVramGb: number | null = null,
): {
	avatarProvider: "vrm" | "naia-video-avatar";
	nvaModel: string;
} {
	if (isKioskDemo()) {
		const saved = config?.nvaModel?.trim() ?? "";
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

export function resolveInitialShellChatLayout(viewportHeight: number): {
	naiaWidth: number;
	chatHeight: number;
} {
	if (isKioskDemo()) {
		return {
			naiaWidth: KIOSK_SHELL_NAIA_WIDTH,
			chatHeight: Math.max(
				KIOSK_SHELL_CHAT_HEIGHT_MIN,
				Math.round(viewportHeight * KIOSK_SHELL_CHAT_HEIGHT_RATIO),
			),
		};
	}
	return {
		naiaWidth: DEFAULT_SHELL_NAIA_WIDTH,
		chatHeight: Math.round(viewportHeight * 0.4),
	};
}

/** OFF는 빈 패치: 일반판의 모든 기본값과 온보딩 선택을 보존한다. */
export function buildKioskDemoConfigSeed(): SeedableShellConfig {
	if (!isKioskDemo()) return {};
	return buildSeedShellConfig({
		agentName: "지나",
		userName: "게스트",
		honorific: "님",
		speechStyle: "formal",
		locale: "ko",
		persona: KIOSK_DEMO_PERSONA,
		personaDisabled: false,
		onboardingComplete: true,
		ttsEnabled: true,
		ttsProvider: KIOSK_DEMO_TTS_PROVIDER,
		vllmTtsHost: KIOSK_DEMO_TTS_HOST,
		ttsVoice: KIOSK_DEMO_TTS_VOICE,
		avatarProvider: "naia-video-avatar",
		nvaModel: KIOSK_DEMO_NVA_MODEL,
		provider: "nextain",
		model: getDefaultLlmModel("nextain"),
		llmRoles: {
			main: { provider: "nextain", model: getDefaultLlmModel("nextain") },
		},
	});
}
