// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTtsVoiceId } from "../../components/chat-voice-utils";
import { loadConfig, saveConfig } from "../config";
import {
	KIOSK_DEMO_TTS_HOST,
	KIOSK_DEMO_TTS_PROVIDER,
	KIOSK_DEMO_TTS_VOICE,
	buildKioskDemoConfigSeed,
} from "../config-seed";
import { isKioskDemo } from "../kiosk-demo/flag";
import { KIOSK_DEMO_PERSONA, buildSystemPrompt } from "../persona";
import { setWebAssetsModeForTests } from "../web-runtime/web-assets";
import {
	seedKioskDemoWebAuth,
	WEB_REMOTE_KEY_STORAGE_KEY,
} from "../web-runtime/web-auth";
import { prepareKioskDemoOnboarding } from "../onboarding-core";
import {
	consumeKioskGreeting,
	requestKioskGreeting,
} from "../kiosk-demo/entry";

const memory = vi.hoisted(() => new Map<string, string>());
const provision = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../web-runtime/web-adk", () => ({ installDefaultWebAdk: provision }));
vi.mock("../web-runtime/web-fs", () => ({
	getWebFs: () => ({
		readText: async (p: string) => memory.get(p) ?? null,
		writeBytes: async (p: string, v: string) => {
			memory.set(p, v);
		},
	}),
}));

beforeEach(() => {
	localStorage.clear();
	memory.clear();
	provision.mockClear();
	vi.stubEnv("MODE", "web");
	vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
	// Synthetic fixture, never a real account credential.
	vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "test-kiosk-fixture-only");
});
afterEach(() => {
	setWebAssetsModeForTests(null);
	vi.unstubAllEnvs();
});

describe("S3 kiosk isolation", () => {
	it.each([
		["web", "0"],
		["web", ""],
		["production", "1"],
	])(
		"OFF %s/%s leaves normal persona, onboarding and auth untouched",
		async (mode, flag) => {
			vi.stubEnv("MODE", mode);
			vi.stubEnv("VITE_NAIA_KIOSK_DEMO", flag);
			localStorage.setItem(
				"naia-config",
				JSON.stringify({ agentName: "Normal", onboardingComplete: false }),
			);
			localStorage.setItem(WEB_REMOTE_KEY_STORAGE_KEY, "test-personal-fixture");
			const before = localStorage.getItem("naia-config");
			expect(isKioskDemo()).toBe(false);
			expect(buildKioskDemoConfigSeed()).toEqual({});
			expect(seedKioskDemoWebAuth()).toBe(false);
			await prepareKioskDemoOnboarding();
			expect(provision).not.toHaveBeenCalled();
			expect(memory.size).toBe(0);
			expect(localStorage.getItem("naia-config")).toBe(before);
			expect(localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)).toBe(
				"test-personal-fixture",
			);
			expect(buildSystemPrompt()).not.toContain(KIOSK_DEMO_PERSONA);
		},
	);
	it("ON produces the requested polite Korean guide", () => {
		const seed = buildKioskDemoConfigSeed();
		expect(seed).toMatchObject({
			agentName: "지나",
			userName: "게스트",
			honorific: "님",
			speechStyle: "formal",
			locale: "ko",
			onboardingComplete: true,
			ttsEnabled: true,
			ttsProvider: KIOSK_DEMO_TTS_PROVIDER,
			vllmTtsHost: KIOSK_DEMO_TTS_HOST,
			ttsVoice: KIOSK_DEMO_TTS_VOICE,
		});
		const prompt = buildSystemPrompt(seed.persona, seed);
		for (const text of ["존댓말", "투자자", "넥스테인", "지어내지", "게스트"])
			expect(prompt).toContain(text);
	});
	it.each(["", "bad key", "short"])(
		"missing or invalid build key fails closed even with an existing personal login (%s)",
		(key) => {
			vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", key);
			localStorage.setItem(WEB_REMOTE_KEY_STORAGE_KEY, "test-personal-fixture");
			expect(seedKioskDemoWebAuth()).toBe(false);
		},
	);
	it("stores demo auth only in the existing web credential slot", () => {
		expect(seedKioskDemoWebAuth()).toBe(true);
		expect(localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)).toBe(
			"test-kiosk-fixture-only",
		);
		expect(localStorage.getItem("naia-config")).toBeNull();
	});
	it("persists persona and removes stale UI overrides without losing avatar or voice", async () => {
		memory.set(
			"naia-adk/naia-settings/config.json",
			JSON.stringify({
				agentName: "Old",
				nvaModel: "custom.nva",
				vllmTtsHost: "http://voice.invalid",
			}),
		);
		memory.set(
			"naia-adk/naia-settings/ui-config.json",
			JSON.stringify({
				agentName: "Stale",
				onboardingComplete: false,
				ttsEnabled: false,
				nvaModel: "ui.nva",
			}),
		);
		localStorage.setItem("naia-config", JSON.stringify({ naiaKey: "test-old-private-fixture" }));
		await prepareKioskDemoOnboarding();
		expect(provision).toHaveBeenCalledOnce();
		const saved = JSON.parse(memory.get("naia-adk/naia-settings/config.json")!);
		expect(saved).toMatchObject({
			agentName: "지나",
			onboardingComplete: true,
			nvaModel: "custom.nva",
			vllmTtsHost: "http://voice.invalid",
		});
		const ui = JSON.parse(memory.get("naia-adk/naia-settings/ui-config.json")!);
		expect(ui).toEqual({
			onboardingComplete: true,
			ttsEnabled: true,
			nvaModel: "ui.nva",
		});
		expect(JSON.parse(localStorage.getItem("naia-config")!).naiaKey).toBeUndefined();
		expect(JSON.stringify([...memory.values()])).not.toContain(
			"test-kiosk-fixture-only",
		);
	});
	it("a new workspace gets the complete persona and greeting is consumed only once", async () => {
		setWebAssetsModeForTests(true);
		await prepareKioskDemoOnboarding();
		expect(JSON.parse(localStorage.getItem("naia-config")!)).toMatchObject({
			agentName: "지나",
			onboardingComplete: true,
			ttsProvider: "naia-local-voice",
			vllmTtsHost: "https://bc250-0-voice.nextain.io",
			ttsVoice: "naia-default",
		});
		const loaded = loadConfig()!;
		expect(loaded.ttsProvider).toBe("naia-local-voice");
		expect(loaded.vllmTtsHost).toBe("https://bc250-0-voice.nextain.io");
		expect(resolveTtsVoiceId(loaded)).toBe("naia-default");
		expect(consumeKioskGreeting()).toBe(false);
		requestKioskGreeting();
		expect(consumeKioskGreeting()).toBe(true);
		expect(consumeKioskGreeting()).toBe(false);
	});
	it("forces ttsProvider to browser in ordinary web mode when kiosk demo flag is OFF", () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		saveConfig({
			provider: "naia",
			model: "gemini-3-flash-preview",
			apiKey: "",
			ttsProvider: "naia-local-voice",
			vllmTtsHost: "https://bc250-0-voice.nextain.io",
			ttsVoice: "naia-default",
		});
		const loaded = loadConfig()!;
		expect(loaded.ttsProvider).toBe("browser");
	});
});
