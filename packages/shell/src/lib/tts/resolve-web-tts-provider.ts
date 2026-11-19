import type { AppConfig, TtsProviderId } from "../config";
import { isKioskDemo } from "../kiosk-demo/flag";
import { readCachedLabCredits } from "../lab-balance";
import { isWebMode } from "../web-runtime/web-assets";
import { isValidWebAuthKey } from "../web-runtime/web-auth";

export interface ResolveEffectiveTtsProviderOptions {
	/**
	 * Explicit credit balance override (in normalized credits).
	 * When omitted, consults `readCachedLabCredits(Infinity)`: if known `<= 0`,
	 * falls back to `"browser"` so zero-credit web sessions still speak without HTTP 402 errors.
	 */
	knownCredits?: number | null;
}

/**
 * Resolve the effective pipeline TTS provider across Desktop, Kiosk Demo, and Official Web SaaS modes.
 *
 * - Kiosk Demo (`isKioskDemo()`): honors `config.ttsProvider` or defaults to `"nextain"`.
 * - Official Web SaaS (`isWebMode() && !isKioskDemo()`):
 *   - Honors explicit `"browser"` selection.
 *   - Uses gateway cloud TTS (`"nextain"`, `/v1/audio/speech` + NVA mouth sync) whenever a valid
 *     authenticated `naiaKey` is present and cached credits are not known to be exhausted (`<= 0`),
 *     even if a synced workspace config carried a desktop-only provider (`"edge"`, `"naia-local-voice"`, `"vllm"`).
 *   - Falls back to `"browser"` (`speechSynthesis`) when logged out or out of credits.
 * - Desktop (`!isWebMode()`): honors `config.ttsProvider` or defaults to `"edge"`.
 */
export function resolveEffectiveTtsProvider(
	config: Pick<AppConfig, "ttsProvider">,
	resolvedNaiaKey: string | undefined,
	opts?: ResolveEffectiveTtsProviderOptions,
): TtsProviderId {
	if (isKioskDemo()) {
		return config.ttsProvider || "nextain";
	}

	if (isWebMode()) {
		if (config.ttsProvider === "browser") {
			return "browser";
		}
		const trimmedKey = resolvedNaiaKey?.trim() ?? "";
		if (!isValidWebAuthKey(trimmedKey)) {
			return "browser";
		}
		const credits =
			opts?.knownCredits !== undefined
				? opts.knownCredits
				: (readCachedLabCredits(Number.POSITIVE_INFINITY)?.value ?? null);
		if (credits !== null && credits <= 0) {
			return "browser";
		}
		return "nextain";
	}

	return config.ttsProvider || "edge";
}
