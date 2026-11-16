// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTtsVoiceId } from "../../../components/chat-voice-utils";
import type { AppConfig } from "../../config";
import { clearCachedLabCredits, primeLabCredits } from "../../lab-balance";
import { setWebAssetsModeForTests } from "../../web-runtime/web-assets";
import { resolveEffectiveTtsProvider } from "../resolve-web-tts-provider";

describe("resolveEffectiveTtsProvider & Official Web SaaS Cloud TTS unlock", () => {
	beforeEach(() => {
		clearCachedLabCredits();
		setWebAssetsModeForTests(null);
	});

	afterEach(() => {
		clearCachedLabCredits();
		setWebAssetsModeForTests(null);
		vi.unstubAllEnvs();
	});

	it("unlocks gateway cloud TTS (nextain) in Official Web SaaS mode when authenticated with a valid Naia key", () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");

		expect(
			resolveEffectiveTtsProvider(
				{ ttsProvider: undefined },
				"gw-live-authenticated-session-token",
			),
		).toBe("nextain");

		// Synced desktop configs with desktop-only providers ("edge", "naia-local-voice", "vllm")
		// also upgrade cleanly to "nextain" in authenticated web mode instead of failing on localhost.
		expect(
			resolveEffectiveTtsProvider(
				{ ttsProvider: "edge" },
				"gw-live-authenticated-session-token",
			),
		).toBe("nextain");
		expect(
			resolveEffectiveTtsProvider(
				{ ttsProvider: "naia-local-voice" },
				"gw-live-authenticated-session-token",
			),
		).toBe("nextain");
	});

	it("falls back to browser speechSynthesis in Official Web SaaS mode when unauthenticated, explicitly set to browser, or credits are exhausted", () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");

		// Unauthenticated or malformed key -> browser TTS
		expect(
			resolveEffectiveTtsProvider({ ttsProvider: undefined }, undefined),
		).toBe("browser");
		expect(resolveEffectiveTtsProvider({ ttsProvider: "nextain" }, "")).toBe(
			"browser",
		);
		expect(
			resolveEffectiveTtsProvider({ ttsProvider: "nextain" }, "short"),
		).toBe("browser");

		// Explicit user preference for free browser TTS is respected even when logged in
		expect(
			resolveEffectiveTtsProvider(
				{ ttsProvider: "browser" },
				"gw-live-authenticated-session-token",
			),
		).toBe("browser");

		// Cached credit balance confirmed <= 0 -> graceful fallback to browser TTS
		primeLabCredits(0);
		expect(
			resolveEffectiveTtsProvider(
				{ ttsProvider: "nextain" },
				"gw-live-authenticated-session-token",
			),
		).toBe("browser");

		// Positive credit balance -> cloud TTS unlocked
		primeLabCredits(2.5);
		expect(
			resolveEffectiveTtsProvider(
				{ ttsProvider: undefined },
				"gw-live-authenticated-session-token",
			),
		).toBe("nextain");
	});

	it("preserves Kiosk Demo default (nextain) and Desktop default (edge) unchanged", () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		expect(
			resolveEffectiveTtsProvider({ ttsProvider: undefined }, undefined),
		).toBe("nextain");

		setWebAssetsModeForTests(false);
		vi.stubEnv("MODE", "production");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		expect(
			resolveEffectiveTtsProvider({ ttsProvider: undefined }, undefined),
		).toBe("edge");
		expect(
			resolveEffectiveTtsProvider(
				{ ttsProvider: "naia-local-voice" },
				undefined,
			),
		).toBe("naia-local-voice");
	});

	it("resolves canonical Google Neural2 voice id on fresh Official Web SaaS cloud TTS configs", () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");

		const baseConfig: AppConfig = {
			provider: "nextain",
			model: "gpt-6.1-terra",
			apiKey: "",
			ttsProvider: "nextain",
		};
		expect(resolveTtsVoiceId(baseConfig)).toBe("ko-KR-Neural2-A");
		expect(
			resolveTtsVoiceId({ ...baseConfig, ttsVoice: "ko-KR-Neural2-C" }),
		).toBe("ko-KR-Neural2-C");
	});
});
