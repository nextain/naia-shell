// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTtsVoiceId } from "../../components/chat-voice-utils";
import {
	loadConfig,
	mergeBootConfig,
	resolveThinkingLevel,
	saveConfig,
} from "../config";
import {
	DEFAULT_SHELL_NAIA_WIDTH,
	KIOSK_DEMO_ENABLE_TOOLS,
	KIOSK_DEMO_ENVIRONMENT_AWARENESS,
	KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT,
	KIOSK_DEMO_LLM_MODEL,
	KIOSK_DEMO_NVA_MODEL,
	KIOSK_DEMO_THINKING_LEVEL,
	KIOSK_DEMO_TTS_PROVIDER,
	KIOSK_DEMO_TTS_VOICE,
	KIOSK_SHELL_AVATAR_AREA_RATIO,
	KIOSK_SHELL_CHAT_HEIGHT_RATIO,
	KIOSK_SHELL_NAIA_WIDTH,
	applyKioskDemoMainModel,
	buildKioskDemoConfigSeed,
	isKioskLocalAnswerEnabled,
	resolveInitialShellChatLayout,
	resolveKioskDemoMainModel,
	resolveShellAvatarSelection,
	setKioskLocalAnswerEnabled,
} from "../config-seed";
import { isKioskDemo } from "../kiosk-demo/flag";
import { KIOSK_DEMO_PERSONA, buildSystemPrompt } from "../persona";
import {
	resetUiPreferencesForTests,
	setStoredChatHeightRatio,
	setStoredNaiaWidth,
} from "../ui-preferences";
import { useAppStore } from "../../stores/app";
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
	getDefaultLlmModel,
	getLlmProvider,
	getStaticModelsRecord,
	listLlmProviders,
	registerLlmProvider,
	shouldMigrateNextainModel,
} from "../llm/registry";
import { effectiveMainRole, readSlots } from "../slots/model";
import { INITIAL_WEB_WORKSPACE_CONFIG } from "../web-runtime/web-workspace-commands";
import { WEB_LLM_MODEL_PREF_KEY } from "../web-runtime/webllm-model";
import { prepareKioskDemoOnboarding } from "../onboarding-core";
import {
	consumeKioskGreeting,
	isKioskCreditExhaustedError,
	requestKioskGreeting,
	resetKioskVisit,
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
			ttsVoice: KIOSK_DEMO_TTS_VOICE,
			avatarProvider: "naia-video-avatar",
			nvaModel: KIOSK_DEMO_NVA_MODEL,
		});
		expect(seed.vllmTtsHost).toBeUndefined();
		const prompt = buildSystemPrompt(seed.persona, seed);
		for (const text of [
			"존댓말",
			"투자자",
			"넥스테인",
			"지어내지",
			"다른 낱말로 한 번 더",
			"게스트",
		])
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
		expect(KIOSK_DEMO_TTS_VOICE).toBe("ko-KR-Neural2-A");
		await prepareKioskDemoOnboarding();
		expect(JSON.parse(localStorage.getItem("naia-config")!)).toMatchObject({
			agentName: "지나",
			onboardingComplete: true,
			ttsProvider: "nextain",
			ttsVoice: "ko-KR-Neural2-A",
			avatarProvider: "naia-video-avatar",
			nvaModel: "jina",
		});
		const loaded = loadConfig()!;
		expect(loaded.ttsProvider).toBe("nextain");
		expect(loaded.vllmTtsHost).toBeUndefined();
		expect(loaded.ttsVoice).toBe("ko-KR-Neural2-A");
		expect(resolveTtsVoiceId(loaded)).toBe("ko-KR-Neural2-A");
		expect(consumeKioskGreeting()).toBe(false);
		requestKioskGreeting();
		expect(consumeKioskGreeting()).toBe(true);
		expect(consumeKioskGreeting()).toBe(false);
	});
	it("FR-WEB-KIOSK-FIX.10 fixes kiosk main model to gpt-5.6-luna and falls back only when luna is absent from the gateway", async () => {
		const served = (keys: string[]) =>
			vi.fn(async () => new Response(JSON.stringify(keys.map((model_key) => ({ model_key, capabilities: ["llm"], operational_status: "live" })))));
		expect(KIOSK_DEMO_LLM_MODEL).toBe("gpt-5.6-luna");
		expect(KIOSK_DEMO_THINKING_LEVEL).toBe("low");
		expect(KIOSK_DEMO_ENABLE_TOOLS).toBe(true);
		expect(KIOSK_DEMO_ENVIRONMENT_AWARENESS).toBe("off");
		expect(KIOSK_DEMO_ENVIRONMENT_TERMINAL_INPUT).toBe(false);
		expect(buildKioskDemoConfigSeed()).toMatchObject({
			provider: "nextain",
			model: "gpt-5.6-luna",
			enableTools: true,
			thinkingLevel: "low",
			enableThinking: true,
			environmentAwareness: "off",
			environmentTerminalInput: false,
			llmRoles: {
				main: {
					provider: "nextain",
					model: "gpt-5.6-luna",
					thinkingLevel: "low",
				},
			},
		});

		// Gateway serves both terra and luna -> stays on gpt-5.6-luna
		vi.stubGlobal("fetch", served(["gpt-6.1-terra", "gpt-5.6-luna"]));
		await prepareKioskDemoOnboarding();
		let saved = JSON.parse(localStorage.getItem("naia-config")!);
		expect(saved.model).toBe("gpt-5.6-luna");
		expect(saved.llmRoles.main.model).toBe("gpt-5.6-luna");

		// Gateway serves luna + deepseek -> stays on gpt-5.6-luna
		vi.stubGlobal("fetch", served(["gpt-5.6-luna", "deepseek-v4-pro"]));
		await prepareKioskDemoOnboarding();
		saved = JSON.parse(localStorage.getItem("naia-config")!);
		expect(saved.model).toBe("gpt-5.6-luna");
		expect(saved.llmRoles.main.model).toBe("gpt-5.6-luna");

		// Gateway does NOT serve luna -> steps down to fallback (deepseek-v4-pro / deepseek-v4-flash), never terra
		vi.stubGlobal("fetch", served(["gpt-6.1-terra", "deepseek-v4-pro", "deepseek-v4-flash"]));
		await prepareKioskDemoOnboarding();
		saved = JSON.parse(localStorage.getItem("naia-config")!);
		expect(saved.model).toBe("deepseek-v4-pro");
		expect(saved.llmRoles.main.model).toBe("deepseek-v4-pro");
		expect(resolveKioskDemoMainModel(new Set(["deepseek-v4-flash"]))).toBe("deepseek-v4-flash");

		// Gateway metadata fetch fails (offline) -> stays on gpt-5.6-luna
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
		await prepareKioskDemoOnboarding();
		saved = JSON.parse(localStorage.getItem("naia-config")!);
		expect(saved.model).toBe("gpt-5.6-luna");
		expect(saved.llmRoles.main.model).toBe("gpt-5.6-luna");
		vi.unstubAllGlobals();
	});
	it("FR-WEB-KIOSK-FIX.10 resolves gpt-5.6-luna in kiosk mode when saved model is missing or gateway defaultModel changes", () => {
		expect(getDefaultLlmModel("nextain")).toBe("gpt-5.6-luna");
		const originalNextain = getLlmProvider("nextain")!;
		registerLlmProvider({ ...originalNextain, defaultModel: "claude-opus-5" });
		try {
			expect(getDefaultLlmModel("nextain")).toBe("gpt-5.6-luna");
			expect(buildKioskDemoConfigSeed().model).toBe("gpt-5.6-luna");
		} finally {
			registerLlmProvider(originalNextain);
		}

		setWebAssetsModeForTests(true);
		localStorage.setItem("naia-config", JSON.stringify({ provider: "nextain", apiKey: "" }));
		const loadedWithoutModel = loadConfig()!;
		expect(loadedWithoutModel.model).toBe("gpt-5.6-luna");
		expect(loadedWithoutModel.llmRoles?.main).toMatchObject({
			provider: "nextain",
			model: "gpt-5.6-luna",
		});
		expect(effectiveMainRole({} as any)).toEqual({
			provider: "nextain",
			model: "gpt-5.6-luna",
		});
		expect(readSlots({} as any).main).toEqual({
			provider: "nextain",
			model: "gpt-5.6-luna",
		});
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
		const kioskLayout = resolveInitialShellChatLayout(900);
		expect(kioskLayout.naiaWidth).toBe(KIOSK_SHELL_NAIA_WIDTH);
		expect(kioskLayout.naiaWidth).toBeGreaterThan(DEFAULT_SHELL_NAIA_WIDTH);
		expect(KIOSK_SHELL_CHAT_HEIGHT_RATIO).toBeGreaterThanOrEqual(0.75);
		expect(KIOSK_SHELL_AVATAR_AREA_RATIO).toBeLessThanOrEqual(0.25);
		expect(kioskLayout.chatHeight).toBe(Math.round(900 * KIOSK_SHELL_CHAT_HEIGHT_RATIO));

		setStoredChatHeightRatio(0.6);
		setStoredNaiaWidth(440);
		expect(resolveInitialShellChatLayout(900)).toEqual({
			naiaWidth: 440,
			chatHeight: 540,
		});
		resetUiPreferencesForTests();

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
	it("registers WebLLM while keeping cloud (nextain) as default until kiosk local answer is explicitly toggled ON", () => {
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		registerWebLlmProvider();
		expect(getLlmProvider("webllm")).toBeDefined();
		expect(listLlmProviders().some((p) => p.id === "webllm")).toBe(true);
		expect(getStaticModelsRecord().webllm).toBeDefined();

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		installWebRuntime();
		registerWebLlmProvider();
		expect(getLlmProvider("webllm")).toBeDefined();
		expect(getStaticModelsRecord().webllm).toBeDefined();
		expect(isKioskLocalAnswerEnabled()).toBe(false);
		expect(listLlmProviders().some((p) => p.id === "webllm")).toBe(false);
		expect(
			applyKioskDemoMainModel({
				provider: "webllm",
				model: "Qwen3-4B-q4f16_1-MLC",
			}).provider,
		).toBe("nextain");

		setKioskLocalAnswerEnabled(true);
		expect(isKioskLocalAnswerEnabled()).toBe(true);
		expect(listLlmProviders().some((p) => p.id === "webllm")).toBe(true);
		expect(
			applyKioskDemoMainModel({
				provider: "webllm",
				model: "Qwen3-4B-q4f16_1-MLC",
			}).provider,
		).toBe("webllm");
		setKioskLocalAnswerEnabled(false);

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		installWebRuntime();
		expect(getLlmProvider("webllm")).toBeDefined();
		expect(listLlmProviders().some((p) => p.id === "webllm")).toBe(true);
	});
	it("verifies gateway key and credits on entry, retries transient lookup failure once, and only marks unavailable when credits <= 0", async () => {
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

		let attempts = 0;
		const recoveredAfterRetry = await verifyKioskDemoWebAuth({
			gatewayUrl: "http://localhost:9999",
			fetchBalance: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("network timeout");
				return { credits: 67 };
			},
		});
		expect(attempts).toBe(2);
		expect(recoveredAfterRetry).toEqual({ ok: true, credits: 67 });

		let failAttempts = 0;
		const lookupFailed = await verifyKioskDemoWebAuth({
			gatewayUrl: "http://localhost:9999",
			fetchBalance: async () => {
				failAttempts += 1;
				throw new Error("HTTP 502");
			},
		});
		expect(failAttempts).toBe(2);
		expect(lookupFailed).toEqual({ ok: false, reason: "lookup-failed" });

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "");
		const missingKey = await verifyKioskDemoWebAuth({
			gatewayUrl: "http://localhost:9999",
			fetchBalance: async () => ({ credits: 100 }),
		});
		expect(missingKey).toEqual({ ok: false, reason: "missing-key" });
	});
	it("FR-WEB-KIOSK-R3.3 & R3.7 handles web secure-store without desktop_only:secure_store_set and lists 21 demo knowledge manuscripts", async () => {
		const {
			deleteSecretKeyAtPath,
			getSecretKeyAtPath,
			saveSecretKeyAtPath,
		} = await import("../secure-store");
		const { listKioskKnowledgeManuscripts } = await import(
			"../kiosk-demo/knowledge"
		);

		seedKioskDemoWebAuth();
		await expect(
			saveSecretKeyAtPath(
				"apiKey",
				"web-browser-key",
				"opfs://naia-adk/data-private/secure-keys.dat",
			),
		).resolves.toBeUndefined();
		await expect(
			getSecretKeyAtPath(
				"apiKey",
				"opfs://naia-adk/data-private/secure-keys.dat",
			),
		).resolves.toBe("web-browser-key");
		await expect(
			deleteSecretKeyAtPath(
				"naiaKey",
				"opfs://naia-adk/data-private/secure-keys.dat",
			),
		).resolves.toBeUndefined();
		// In kiosk mode, deleting naiaKey must not wipe the shared kiosk demo key
		expect(localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)).toBe(
			"test-kiosk-fixture-only",
		);

		const manuscripts = listKioskKnowledgeManuscripts();
		expect(manuscripts).toHaveLength(21);
		expect(manuscripts.some((m) => m.name === "naia.md")).toBe(true);
	});
	it("FR-WEB-KIOSK-FIX.10 overrides saved terra or other providers to nextain + gpt-5.6-luna in kiosk mode, and preserves saved selections in ordinary web/desktop modes", () => {
		setWebAssetsModeForTests(true);
		// Kiosk ON: saved gpt-6.1-terra -> overridden to nextain + gpt-5.6-luna
		saveConfig({
			provider: "nextain",
			model: "gpt-6.1-terra",
			apiKey: "",
			enableTools: false,
			thinkingLevel: "xhigh",
			enableThinking: false,
			environmentAwareness: "always",
			environmentTerminalInput: true,
			llmRoles: {
				main: {
					provider: "nextain",
					model: "gpt-6.1-terra",
					thinkingLevel: "xhigh",
				},
			},
			mainModelThinkingLevels: {
				"nextain:gpt-6.1-terra": "xhigh",
				"nextain:gpt-5.6-luna": "xhigh",
			},
		} as Parameters<typeof saveConfig>[0]);
		const savedTerra = JSON.parse(localStorage.getItem("naia-config")!);
		expect(savedTerra.provider).toBe("nextain");
		expect(savedTerra.model).toBe("gpt-5.6-luna");
		expect(savedTerra.enableTools).toBe(true);
		expect(savedTerra.thinkingLevel).toBe("low");
		expect(savedTerra.enableThinking).toBe(true);
		expect(savedTerra.environmentAwareness).toBe("off");
		expect(savedTerra.environmentTerminalInput).toBe(false);
		expect(savedTerra.mainModelThinkingLevels).toBeUndefined();
		expect(savedTerra.llmRoles.main).toMatchObject({
			provider: "nextain",
			model: "gpt-5.6-luna",
			thinkingLevel: "low",
		});

		// Kiosk ON: polluted localStorage (xhigh + enableTools:false + environmentAwareness:always + environmentTerminalInput:true) reloaded via loadConfig / mergeBootConfig / resolveThinkingLevel stays fixed
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "codex",
				model: "gpt-5.6-sol",
				apiKey: "",
				enableTools: false,
				thinkingLevel: "xhigh",
				enableThinking: false,
				environmentAwareness: "always",
				environmentTerminalInput: true,
				llmRoles: {
					main: {
						provider: "codex",
						model: "gpt-5.6-sol",
						thinkingLevel: "xhigh",
					},
				},
				mainModelThinkingLevels: {
					"nextain:gpt-5.6-luna": "xhigh",
					"codex:gpt-5.6-sol": "xhigh",
				},
			}),
		);
		const loadedOther = loadConfig()!;
		expect(loadedOther.provider).toBe("nextain");
		expect(loadedOther.model).toBe("gpt-5.6-luna");
		expect(loadedOther.enableTools).toBe(true);
		expect(loadedOther.thinkingLevel).toBe("low");
		expect(loadedOther.enableThinking).toBe(true);
		expect(loadedOther.environmentAwareness).toBe("off");
		expect(loadedOther.environmentTerminalInput).toBe(false);
		expect(
			(loadedOther as unknown as Record<string, unknown>)
				.mainModelThinkingLevels,
		).toBeUndefined();
		expect(loadedOther.llmRoles?.main?.thinkingLevel).toBe("low");
		expect(resolveThinkingLevel(loadedOther)).toBe("low");
		expect(
			resolveThinkingLevel({
				thinkingLevel: "xhigh",
				enableThinking: false,
				llmRoles: {
					main: {
						provider: "nextain",
						model: "gpt-5.6-luna",
						thinkingLevel: "xhigh",
					},
				},
			}),
		).toBe("low");

		const mergedPolluted = mergeBootConfig(
			{
				provider: "nextain",
				model: "gpt-6.1-terra",
				apiKey: "",
				enableTools: false,
				thinkingLevel: "xhigh",
				enableThinking: false,
				environmentAwareness: "always",
				environmentTerminalInput: true,
				llmRoles: {
					main: {
						provider: "nextain",
						model: "gpt-6.1-terra",
						thinkingLevel: "xhigh",
					},
				},
				mainModelThinkingLevels: { "nextain:gpt-5.6-luna": "xhigh" },
			},
			{
				enableTools: false,
				thinkingLevel: "xhigh",
				enableThinking: false,
				environmentAwareness: "always",
				environmentTerminalInput: true,
				llmRoles: {
					main: {
						provider: "nextain",
						model: "gpt-6.1-terra",
						thinkingLevel: "xhigh",
					},
				},
				mainModelThinkingLevels: { "nextain:gpt-5.6-luna": "xhigh" },
			},
			null,
		)! as ReturnType<typeof loadConfig> & Record<string, unknown>;
		expect(mergedPolluted.enableTools).toBe(true);
		expect(mergedPolluted.thinkingLevel).toBe("low");
		expect(mergedPolluted.enableThinking).toBe(true);
		expect(mergedPolluted.environmentAwareness).toBe("off");
		expect(mergedPolluted.environmentTerminalInput).toBe(false);
		expect(mergedPolluted.llmRoles?.main?.thinkingLevel).toBe("low");
		expect(mergedPolluted.mainModelThinkingLevels).toBeUndefined();
		expect(resolveThinkingLevel(mergedPolluted)).toBe("low");
		expect(
			applyKioskDemoMainModel({
				enableTools: false,
				thinkingLevel: "xhigh",
				enableThinking: false,
				environmentAwareness: "always",
				environmentTerminalInput: true,
				llmRoles: {
					main: {
						provider: "nextain",
						model: "gpt-6.1-terra",
						thinkingLevel: "xhigh",
					},
				},
			}),
		).toMatchObject({
			provider: "nextain",
			model: "gpt-5.6-luna",
			enableTools: true,
			thinkingLevel: "low",
			enableThinking: true,
			environmentAwareness: "off",
			environmentTerminalInput: false,
			llmRoles: {
				main: {
					provider: "nextain",
					model: "gpt-5.6-luna",
					thinkingLevel: "low",
				},
			},
		});
		expect(effectiveMainRole(loadedOther)).toEqual({
			provider: "nextain",
			model: "gpt-5.6-luna",
		});
		expect(
			effectiveMainRole({
				provider: "codex",
				model: "gpt-5.6-sol",
				apiKey: "",
				llmRoles: { main: { provider: "codex", model: "gpt-5.6-sol" } },
			}),
		).toEqual({
			provider: "nextain",
			model: "gpt-5.6-luna",
		});

		// Kiosk ON: shouldMigrateNextainModel migrates terra and retired models to gpt-5.6-luna first
		const served = new Set(["gpt-6.1-terra", "gpt-5.6-luna", "deepseek-v4-pro"]);
		expect(shouldMigrateNextainModel("nextain", "gpt-6.1-terra", served)).toEqual({
			migrate: true,
			to: "gpt-5.6-luna",
		});
		expect(shouldMigrateNextainModel("nextain", "claude-opus-5", served)).toEqual({
			migrate: true,
			to: "gpt-5.6-luna",
		});

		// Ordinary Web Mode (kiosk OFF): preserves saved terra, thinkingLevel xhigh, enableTools false, environmentAwareness, and environmentTerminalInput
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		saveConfig({
			provider: "nextain",
			model: "gpt-6.1-terra",
			apiKey: "",
			enableTools: false,
			thinkingLevel: "xhigh",
			environmentAwareness: "always",
			environmentTerminalInput: true,
			llmRoles: {
				main: {
					provider: "nextain",
					model: "gpt-6.1-terra",
					thinkingLevel: "xhigh",
				},
			},
		});
		const webTerra = loadConfig()!;
		expect(webTerra.provider).toBe("nextain");
		expect(webTerra.model).toBe("gpt-6.1-terra");
		expect(webTerra.enableTools).toBe(false);
		expect(webTerra.environmentAwareness).toBe("always");
		expect(webTerra.environmentTerminalInput).toBe(true);
		expect(webTerra.llmRoles?.main?.thinkingLevel).toBe("xhigh");
		expect(resolveThinkingLevel(webTerra)).toBe("xhigh");
		expect(effectiveMainRole(webTerra)).toEqual({
			provider: "nextain",
			model: "gpt-6.1-terra",
		});

		// Desktop Mode (kiosk OFF, web OFF): preserves saved provider/model/environmentAwareness/environmentTerminalInput
		setWebAssetsModeForTests(false);
		vi.stubEnv("MODE", "production");
		saveConfig({
			provider: "codex",
			model: "gpt-5.6-sol",
			apiKey: "",
			environmentAwareness: "always",
			environmentTerminalInput: true,
			llmRoles: { main: { provider: "codex", model: "gpt-5.6-sol" } },
		});
		const desktopCodex = loadConfig()!;
		expect(desktopCodex.provider).toBe("codex");
		expect(desktopCodex.model).toBe("gpt-5.6-sol");
		expect(desktopCodex.environmentAwareness).toBe("always");
		expect(desktopCodex.environmentTerminalInput).toBe(true);
		expect(effectiveMainRole(desktopCodex)).toEqual({
			provider: "codex",
			model: "gpt-5.6-sol",
		});
	});
	it("resetKioskVisit restores localStorage naia-config and OPFS config/ui-config back to the kiosk seed", async () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				agentName: "손님커스텀",
				userName: "방문자",
				speechStyle: "casual",
				persona: "custom persona",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				ttsVoice: "custom-voice",
				provider: "codex",
				model: "gpt-5.6-sol",
				apiKey: "",
			}),
		);
		localStorage.setItem("naia-web-nextain-model", "gpt-6.1-terra");
		localStorage.setItem(WEB_LLM_MODEL_PREF_KEY, "Qwen3-4B-q4f16_1-MLC");
		localStorage.setItem("naia-kiosk-local-answer", "1");
		memory.set(
			"naia-adk/naia-settings/config.json",
			JSON.stringify({ agentName: "손님커스텀", provider: "codex", model: "gpt-5.6-sol" }),
		);
		memory.set(
			"naia-adk/naia-settings/ui-config.json",
			JSON.stringify({ nvaModel: "naia", ttsVoice: "custom-voice", ttsEnabled: false }),
		);

		await resetKioskVisit({
			cancel: () => undefined,
			resetMemory: async () => undefined,
			clearConversations: async () => undefined,
			newConversation: () => undefined,
			reload: () => undefined,
		});

		const seed = buildKioskDemoConfigSeed();
		const resetLocal = loadConfig()!;
		expect(resetLocal).toMatchObject(seed);
		expect(localStorage.getItem("naia-web-nextain-model")).toBeNull();
		expect(localStorage.getItem(WEB_LLM_MODEL_PREF_KEY)).toBeNull();
		expect(localStorage.getItem("naia-kiosk-local-answer")).toBeNull();
		const resetOpfsConfig = JSON.parse(
			memory.get("naia-adk/naia-settings/config.json")!,
		);
		expect(resetOpfsConfig).toMatchObject(seed);
		const resetOpfsUi = JSON.parse(
			memory.get("naia-adk/naia-settings/ui-config.json")!,
		);
		expect(resetOpfsUi).toEqual({
			onboardingComplete: true,
			ttsEnabled: true,
		});
		expect(
			isKioskCreditExhaustedError(
				undefined,
				"OpenAI-compat https://gateway.nextain.io/v1 failed: 402 Payment Required: insufficient_quota",
			),
		).toBe(true);
		expect(memory.get("naia-adk/AGENTS.md")).toContain(
			"지금 캐릭터는 페르소나 설정(캐릭터 카드)을 따른다.",
		);
		expect(memory.get("naia-adk/AGENTS.md")).not.toContain(
			"## 1. 지나가 누구인가",
		);
		expect(memory.get("naia-adk/persona/jina.md")).toBeUndefined();
		expect(resetLocal.uiPreferences?.b2cActiveCardId).toBe("kiosk-jina-card");
		expect(resetLocal.uiPreferences?.b2cCardLibrary).toHaveLength(1);
		expect(resetLocal.uiPreferences?.b2cNvaThemes).toHaveLength(1);
		expect(memory.get("naia-adk/rules/response-rules.md")).toContain("공개 지식");
		expect(memory.get("naia-adk/rules/response-rules.md")).toContain(
			"대답 글에 파일 이름·근거 줄을 쓰지 않습니다",
		);
		expect(memory.get("naia-adk/memory/guest-memory.md")).toContain(
			"사용자 호칭은 게스트님이다.",
		);
		expect(memory.get("naia-adk/knowledge/naia.md")).toContain("나이아");
	});

	it("blocks project selection panel in kiosk demo and keeps chat height unclipped at 1440x900 and 915x412", () => {
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		useAppStore.setState({ activeApp: "workspace" });
		useAppStore.getState().setActiveApp("projects");
		expect(useAppStore.getState().activeApp).toBe("workspace");

		const desktopLayout = resolveInitialShellChatLayout(900);
		expect(desktopLayout.chatHeight).toBeLessThanOrEqual(900 - 88);

		const mobileLandscapeLayout = resolveInitialShellChatLayout(412);
		expect(mobileLandscapeLayout.chatHeight).toBeLessThanOrEqual(412 - 88);
		expect(mobileLandscapeLayout.chatHeight).toBeGreaterThanOrEqual(220);
	});
});
