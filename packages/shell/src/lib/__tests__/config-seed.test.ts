// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileExplicitLocalProfile } from "../config";
import {
	KIOSK_DEMO_ENVIRONMENT_AWARENESS,
	KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT,
	RETIRED_CONFIG_KEYS,
	applyKioskDemoMainModel,
	buildKioskDemoConfigSeed,
	buildSeedShellConfig,
	type SeedableShellConfig,
} from "../config-seed";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("config-seed (FR-VOICE.15)", () => {
	it("passes a clean product-schema seed through unchanged", () => {
		const seed: SeedableShellConfig = {
			provider: "codex",
			model: "gpt-5.4",
			localVoiceEnabled: true,
			ttsProvider: "naia-local-voice",
			ttsEnabled: true,
			vllmTtsHost: "http://127.0.0.1:8910",
		};
		expect(buildSeedShellConfig(seed)).toEqual(seed);
	});

	it("rejects every retired key arriving through a spread at runtime", () => {
		const retiredValues: Record<string, unknown> = {
			cascadeRuntimeUrl: "http://localhost:8910",
			local8gFocus: "llm",
			localAvatarVoiceFocus: "llm",
			localGpuTier: "windows-voice-6g",
		};
		for (const key of RETIRED_CONFIG_KEYS) {
			const sneaky = {
				provider: "codex",
				model: "gpt-5.4",
				...{ [key]: retiredValues[key] },
			} as SeedableShellConfig;
			expect(() => buildSeedShellConfig(sneaky)).toThrow(key);
		}
	});

	it("matches the safety migration: every listed key is actually stripped", () => {
		// SoT tie — if normalizeLocalRuntimeConfig stops stripping a listed key
		// (or strips one not listed), this contract breaks and the list must be
		// reconciled instead of drifting silently.
		const retiredValues: Record<string, unknown> = {
			cascadeRuntimeUrl: "http://localhost:8910",
			local8gFocus: "llm",
			localAvatarVoiceFocus: "llm",
			localGpuTier: "windows-voice-6g",
		};
		expect(Object.keys(retiredValues).sort()).toEqual(
			[...RETIRED_CONFIG_KEYS].sort(),
		);
		for (const key of RETIRED_CONFIG_KEYS) {
			const migrated = reconcileExplicitLocalProfile({
				provider: "nextain",
				model: "gemini-3.5-flash",
				apiKey: "",
				[key]: retiredValues[key],
			});
			expect(
				(migrated as unknown as Record<string, unknown>)[key],
				`retired key '${key}' must be stripped by the migration`,
			).toBeUndefined();
		}
	});

	it("pins environmentAwareness to off and environmentTerminalInput to false in kiosk seed and applyKioskDemoMainModel while preserving them when kiosk is off", () => {
		expect(KIOSK_DEMO_ENVIRONMENT_AWARENESS).toBe("off");
		expect(KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT).toBe(false);

		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		const seed = buildKioskDemoConfigSeed();
		expect(seed.environmentAwareness).toBe("off");
		expect(seed.environmentTerminalInput).toBe(false);

		const pinned = applyKioskDemoMainModel({
			provider: "codex",
			model: "gpt-5.4",
			environmentAwareness: "always",
			environmentTerminalInput: true,
		});
		expect(pinned.environmentAwareness).toBe("off");
		expect(pinned.environmentTerminalInput).toBe(false);

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		expect(buildKioskDemoConfigSeed()).toEqual({});
		const preservedWeb = applyKioskDemoMainModel({
			provider: "nextain",
			model: "gpt-5.6-luna",
			environmentAwareness: "always",
			environmentTerminalInput: true,
		});
		expect(preservedWeb.environmentAwareness).toBe("always");
		expect(preservedWeb.environmentTerminalInput).toBe(true);

		vi.stubEnv("MODE", "production");
		const preservedDesktop = applyKioskDemoMainModel({
			provider: "codex",
			model: "gpt-5.4",
			environmentAwareness: "auto",
			environmentTerminalInput: true,
		});
		expect(preservedDesktop.environmentAwareness).toBe("auto");
		expect(preservedDesktop.environmentTerminalInput).toBe(true);
	});
});
