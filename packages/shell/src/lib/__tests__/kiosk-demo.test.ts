// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTtsVoiceId } from "../../components/chat-voice-utils";
import { loadConfig, saveConfig } from "../config";
import {
	DEFAULT_SHELL_NAIA_WIDTH,
	KIOSK_DEMO_NVA_MODEL,
	KIOSK_DEMO_TTS_HOST,
	KIOSK_DEMO_TTS_PROVIDER,
	KIOSK_DEMO_TTS_VOICE,
	KIOSK_SHELL_NAIA_WIDTH,
	buildKioskDemoConfigSeed,
	resolveInitialShellChatLayout,
	resolveShellAvatarSelection,
} from "../config-seed";
import { isKioskDemo } from "../kiosk-demo/flag";
import { KIOSK_DEMO_PERSONA, buildSystemPrompt } from "../persona";
import {
	WEB_DEFAULT_NVA,
	setWebAssetsModeForTests,
} from "../web-runtime/web-assets";
import {
	seedKioskDemoWebAuth,
	verifyKioskDemoWebAuth,
	WEB_REMOTE_KEY_STORAGE_KEY,
} from "../web-runtime/web-auth";
import { installWebRuntime } from "../web-runtime/install";
import { registerWebLlmProvider } from "../web-runtime/llm-provider";
import {
	getLlmProvider,
	getStaticModelsRecord,
	listLlmProviders,
} from "../llm/registry";
import { INITIAL_WEB_WORKSPACE_CONFIG } from "../web-runtime/web-workspace-commands";
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
				JSON.stringify({
					agentName: "Normal",
					onboardingComplete: false,
					avatarProvider: INITIAL_WEB_WORKSPACE_CONFIG.avatarProvider,
					nvaModel: INITIAL_WEB_WORKSPACE_CONFIG.nvaModel,
				}),
			);
			localStorage.setItem(WEB_REMOTE_KEY_STORAGE_KEY, "test-personal-fixture");
			const before = localStorage.getItem("naia-config");
			expect(isKioskDemo()).toBe(false);
			expect(buildKioskDemoConfigSeed()).toEqual({});
			expect(INITIAL_WEB_WORKSPACE_CONFIG.avatarProvider).toBe(
				"naia-video-avatar",
			);
			expect(INITIAL_WEB_WORKSPACE_CONFIG.nvaModel).toBe(WEB_DEFAULT_NVA);
			expect(seedKioskDemoWebAuth()).toBe(false);
			await prepareKioskDemoOnboarding();
			expect(provision).not.toHaveBeenCalled();
			expect(memory.size).toBe(0);
			expect(localStorage.getItem("naia-config")).toBe(before);
			expect(JSON.parse(localStorage.getItem("naia-config")!)).toMatchObject({
				avatarProvider: "naia-video-avatar",
				nvaModel: WEB_DEFAULT_NVA,
			});
			expect(localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)).toBe(
				"test-personal-fixture",
			);
			expect(buildSystemPrompt()).not.toContain(KIOSK_DEMO_PERSONA);
		},
	);
	it("ON produces the requested polite Korean guide and Jina real-person avatar", () => {
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
			avatarProvider: "naia-video-avatar",
			nvaModel: KIOSK_DEMO_NVA_MODEL,
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
	it("persists Jina persona and avatar and removes stale UI overrides without losing voice", async () => {
		memory.set(
			"naia-adk/naia-settings/config.json",
			JSON.stringify({
				agentName: "Old",
				avatarProvider: "vrm",
				vrmModel: "/models/naia-default.vrm",
				nvaModel: "naia",
				vllmTtsHost: "http://voice.invalid",
			}),
		);
		memory.set(
			"naia-adk/naia-settings/ui-config.json",
			JSON.stringify({
				agentName: "Stale",
				onboardingComplete: false,
				ttsEnabled: false,
				avatarProvider: "vrm",
				vrmModel: "/models/ui.vrm",
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
			avatarProvider: "naia-video-avatar",
			nvaModel: "jina",
			vllmTtsHost: "http://voice.invalid",
		});
		expect(saved.vrmModel).toBeUndefined();
		const ui = JSON.parse(memory.get("naia-adk/naia-settings/ui-config.json")!);
		expect(ui).toEqual({
			onboardingComplete: true,
			ttsEnabled: true,
		});
		expect(JSON.parse(localStorage.getItem("naia-config")!).naiaKey).toBeUndefined();
		expect(JSON.stringify([...memory.values()])).not.toContain(
			"test-kiosk-fixture-only",
		);
	});
	it("a new workspace gets the complete persona, Jina avatar and greeting is consumed only once", async () => {
		setWebAssetsModeForTests(true);
		await prepareKioskDemoOnboarding();
		expect(JSON.parse(localStorage.getItem("naia-config")!)).toMatchObject({
			agentName: "지나",
			onboardingComplete: true,
			ttsProvider: "naia-local-voice",
			vllmTtsHost: "https://bc250-0-voice.nextain.io",
			ttsVoice: "naia-default",
			avatarProvider: "naia-video-avatar",
			nvaModel: "jina",
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
	it("resolves Jina avatar and widened chat layout when kiosk flag is ON, and preserves normal web avatar and layout when OFF", () => {
		expect(resolveShellAvatarSelection(null)).toEqual({
			avatarProvider: "naia-video-avatar",
			nvaModel: "jina",
		});
		expect(
			resolveShellAvatarSelection({
				provider: "nextain",
				model: "glm-5.1",
				apiKey: "",
				locale: "ko",
				avatarProvider: "naia-video-avatar",
				nvaModel: WEB_DEFAULT_NVA,
			}),
		).toEqual({
			avatarProvider: "naia-video-avatar",
			nvaModel: "jina",
		});
		const kioskLayout = resolveInitialShellChatLayout(800);
		expect(kioskLayout.naiaWidth).toBe(KIOSK_SHELL_NAIA_WIDTH);
		expect(kioskLayout.naiaWidth).toBeGreaterThan(DEFAULT_SHELL_NAIA_WIDTH);
		expect(kioskLayout.chatHeight).toBeGreaterThanOrEqual(540);

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		expect(
			resolveShellAvatarSelection({
				provider: "nextain",
				model: "glm-5.1",
				apiKey: "",
				locale: "ko",
				avatarProvider: "naia-video-avatar",
				nvaModel: WEB_DEFAULT_NVA,
			}),
		).toEqual({
			avatarProvider: "naia-video-avatar",
			nvaModel: WEB_DEFAULT_NVA,
		});
		expect(resolveShellAvatarSelection(null)).toEqual({
			avatarProvider: "vrm",
			nvaModel: "",
		});
		const normalLayout = resolveInitialShellChatLayout(800);
		expect(normalLayout).toEqual({
			naiaWidth: DEFAULT_SHELL_NAIA_WIDTH,
			chatHeight: 320,
		});
	});
	it("does not register or expose WebLLM when kiosk flag is ON, and registers WebLLM normally when OFF", () => {
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		registerWebLlmProvider();
		expect(getLlmProvider("webllm")).toBeDefined();
		expect(listLlmProviders().some((p) => p.id === "webllm")).toBe(true);
		expect(getStaticModelsRecord().webllm).toBeDefined();

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		installWebRuntime();
		registerWebLlmProvider();
		expect(getLlmProvider("webllm")).toBeUndefined();
		expect(listLlmProviders().some((p) => p.id === "webllm")).toBe(false);
		expect(getStaticModelsRecord().webllm).toBeUndefined();

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		installWebRuntime();
		expect(getLlmProvider("webllm")).toBeDefined();
		expect(listLlmProviders().some((p) => p.id === "webllm")).toBe(true);
	});
	it("verifies gateway key and credits once on entry and blocks invalid key or zero credits", async () => {
		const okResult = await verifyKioskDemoWebAuth({
			gatewayUrl: "http://localhost:9999",
			fetchBalance: async () => ({ credits: 42 }),
		});
		expect(okResult).toEqual({ ok: true, credits: 42 });

		const zeroCredits = await verifyKioskDemoWebAuth({
			gatewayUrl: "http://localhost:9999",
			fetchBalance: async () => ({ credits: 0 }),
		});
		expect(zeroCredits).toEqual({ ok: false, reason: "unavailable" });

		const rejectedKey = await verifyKioskDemoWebAuth({
			gatewayUrl: "http://localhost:9999",
			fetchBalance: async () => {
				throw new Error("HTTP 401");
			},
		});
		expect(rejectedKey).toEqual({ ok: false, reason: "unavailable" });

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "");
		const missingKey = await verifyKioskDemoWebAuth({
			gatewayUrl: "http://localhost:9999",
			fetchBalance: async () => ({ credits: 100 }),
		});
		expect(missingKey).toEqual({ ok: false, reason: "missing-key" });
	});
});
