// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_VOICE_REF_URL,
	addAllowedTool,
	clearAllowedTools,
	hasApiKey,
	isToolAllowed,
	loadConfig,
	migrateLegacyDna3OllamaModel,
	reconcileExplicitLocalProfile,
	removeAllowedTool,
	resolveConfiguredGatewayUrl,
	resolveGatewayUrl,
	saveConfig,
} from "../config";

describe("config", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("loadConfig returns null when not set", () => {
		expect(loadConfig()).toBeNull();
	});

	it("uses the Azure public copy for the default reference voice", () => {
		expect(DEFAULT_VOICE_REF_URL).toBe(
			"https://stnaiapub83b29893.blob.core.windows.net/ref-audio/cc0/cc0-ko-female-01.wav",
		);
	});

	it("saveConfig stores and loadConfig retrieves", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key-123",
		});
		const config = loadConfig();
		expect(config).not.toBeNull();
		expect(config?.provider).toBe("gemini");
		expect(config?.model).toBe("gemini-2.5-flash");
		expect(config?.apiKey).toBe("test-key-123");
	});

	it("defaults enableTools to true for existing configs without the field", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "test-key-123",
		});

		expect(loadConfig()?.enableTools).toBe(true);
	});

	it("migrates only the invalid legacy DNA3 Ollama reference", () => {
		saveConfig({
			provider: "ollama",
			model: "hf.co/mradermacher/DNA3.0-4B-GGUF:Q4_K_M",
			apiKey: "",
		});
		migrateLegacyDna3OllamaModel();
		expect(loadConfig()?.model).toBe("dna3:latest");

		saveConfig({
			provider: "ollama",
			model: "dna3:latest",
			apiKey: "",
			ttsProvider: "naia-local-voice",
			vllmTtsHost: "http://localhost:8901/",
		});
		migrateLegacyDna3OllamaModel();
		expect(loadConfig()?.vllmTtsHost).toBe("http://127.0.0.1:8910");

		saveConfig({ provider: "ollama", model: "my-local-model", apiKey: "" });
		migrateLegacyDna3OllamaModel();
		expect(loadConfig()?.model).toBe("my-local-model");
	});

	it("retires the 8GB profile to explicit local voice OFF without changing LLM or avatar", () => {
		const restored = reconcileExplicitLocalProfile({
			provider: "nextain",
			model: "gemini-3.5-flash",
			apiKey: "",
			naiaKey: "nk",
			localGpuTier: "laptop-4060-8g",
			avatarProvider: "vrm",
			vllmTtsHost: "http://localhost:8901",
		});

		expect(restored.provider).toBe("nextain");
		expect(restored.model).toBe("gemini-3.5-flash");
		expect(restored.ollamaNumGpu).toBeUndefined();
		expect(restored.ttsProvider).toBeUndefined();
		expect(restored.vllmTtsHost).toBe("http://localhost:8901");
		expect(restored.localGpuTier).toBeUndefined();
		expect(restored.localVoiceEnabled).toBe(false);
		expect(restored.avatarProvider).toBe("vrm");
		expect(restored.nvaModel).toBeUndefined();
	});

	it("retires the explicit 6GB profile without enabling voice and preserves selected NVA", () => {
		const restored = reconcileExplicitLocalProfile({
			provider: "nextain",
			model: "gemini-3.5-flash",
			apiKey: "",
			naiaKey: "nk",
			localGpuTier: "windows-voice-6g",
			avatarProvider: "naia-video-avatar",
			nvaModel: "stale.nva",
			vllmTtsHost: "http://localhost:8901",
		});
		expect(restored.provider).toBe("nextain");
		expect(restored.ttsProvider).toBeUndefined();
		expect(restored.ttsEnabled).toBeUndefined();
		expect(restored.localVoiceEnabled).toBe(false);
		expect(restored.avatarProvider).toBe("naia-video-avatar");
		expect(restored.nvaModel).toBe("stale.nva");
	});

	it("retires a saved hardware profile without requiring a Naia login", () => {
		const restored = reconcileExplicitLocalProfile({
			provider: "ollama",
			model: "qwen3:8b",
			apiKey: "",
			localGpuTier: "windows-voice-6g",
			avatarProvider: "vrm",
		});

		expect(restored.provider).toBe("ollama");
		expect(restored.model).toBe("qwen3:8b");
		expect(restored.ttsProvider).toBeUndefined();
		expect(restored.localGpuTier).toBeUndefined();
		expect(restored.localVoiceEnabled).toBe(false);
	});

	it("FR-VOICE.13: records the migration reason when a legacy profile disables local voice", () => {
		const restored = reconcileExplicitLocalProfile({
			provider: "nextain",
			model: "gemini-3.5-flash",
			apiKey: "",
			localGpuTier: "windows-voice-6g",
			ttsProvider: "naia-local-voice",
			ttsEnabled: true,
		});
		expect(restored.localVoiceEnabled).toBe(false);
		expect(restored.ttsEnabled).toBe(false);
		expect(restored.localVoiceMigrationNotice).toBe("legacy-local-profile");
	});

	it("FR-VOICE.13: keeps the recorded reason across save/load after the legacy field is dropped", () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-3.5-flash",
			apiKey: "",
			localGpuTier: "laptop-4060-8g",
		});
		expect(loadConfig()?.localGpuTier).toBeUndefined();
		// Re-save without the legacy field: the reason must survive on its own.
		const again = loadConfig();
		expect(again).not.toBeNull();
		if (again) saveConfig(again);
		expect(loadConfig()?.localVoiceMigrationNotice).toBe(
			"legacy-local-profile",
		);
		expect(loadConfig()?.localVoiceEnabled).toBe(false);
	});

	it("FR-VOICE.13: clears the migration notice once local voice is re-enabled", () => {
		saveConfig({
			provider: "nextain",
			model: "gemini-3.5-flash",
			apiKey: "",
			localGpuTier: "windows-voice-6g",
		});
		expect(loadConfig()?.localVoiceMigrationNotice).toBe(
			"legacy-local-profile",
		);
		const cfg = loadConfig();
		expect(cfg).not.toBeNull();
		if (cfg) saveConfig({ ...cfg, localVoiceEnabled: true });
		expect(loadConfig()?.localVoiceMigrationNotice).toBeUndefined();
		expect(loadConfig()?.localVoiceEnabled).toBe(true);
	});

	it("hasApiKey returns false when not set", () => {
		expect(hasApiKey()).toBe(false);
	});

	it("hasApiKey returns true after saving config", () => {
		saveConfig({
			provider: "xai",
			model: "grok-3-mini",
			apiKey: "xai-key",
		});
		expect(hasApiKey()).toBe(true);
	});

	it("hasApiKey returns false for empty apiKey", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "",
		});
		expect(hasApiKey()).toBe(false);
	});

	it("resolveGatewayUrl keeps the legacy default when tools are enabled", () => {
		expect(
			resolveGatewayUrl({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key-123",
				enableTools: true,
			}),
		).toBe("ws://localhost:18789");
	});

	it("resolveConfiguredGatewayUrl returns only an explicit gateway URL", () => {
		expect(
			resolveConfiguredGatewayUrl({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key-123",
				enableTools: true,
			}),
		).toBeUndefined();

		expect(
			resolveConfiguredGatewayUrl({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key-123",
				enableTools: true,
				gatewayUrl: " ws://gateway.example.test:18789 ",
			}),
		).toBe("ws://gateway.example.test:18789");

		expect(
			resolveConfiguredGatewayUrl({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key-123",
				enableTools: true,
				gatewayUrl: "ws://localhost:18789",
			}),
		).toBeUndefined();

		expect(
			resolveConfiguredGatewayUrl({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "test-key-123",
				enableTools: false,
				gatewayUrl: "ws://localhost:18789",
			}),
		).toBeUndefined();
	});
});

describe("allowedTools", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("isToolAllowed returns false when no config", () => {
		expect(isToolAllowed("memo_save")).toBe(false);
	});

	it("isToolAllowed returns false when tool not in list", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		expect(isToolAllowed("memo_save")).toBe(false);
	});

	it("addAllowedTool adds and isToolAllowed returns true", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		addAllowedTool("memo_save");
		expect(isToolAllowed("memo_save")).toBe(true);
	});

	it("addAllowedTool does not duplicate", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		addAllowedTool("memo_save");
		addAllowedTool("memo_save");
		const config = loadConfig()!;
		expect(config.allowedTools).toEqual(["memo_save"]);
	});

	it("clearAllowedTools removes all", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		addAllowedTool("memo_save");
		addAllowedTool("memo_list");
		clearAllowedTools();
		expect(isToolAllowed("memo_save")).toBe(false);
		expect(isToolAllowed("memo_list")).toBe(false);
	});

	it("clearAllowedTools works when no config", () => {
		clearAllowedTools(); // no throw
		expect(isToolAllowed("memo_save")).toBe(false);
	});

	it("removeAllowedTool revokes one name and keeps the rest (#647)", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		addAllowedTool("skill_tab_screenshot");
		addAllowedTool("memo_save");
		removeAllowedTool("skill_tab_screenshot");
		expect(isToolAllowed("skill_tab_screenshot")).toBe(false);
		expect(isToolAllowed("memo_save")).toBe(true);
		expect(loadConfig()?.allowedTools).toEqual(["memo_save"]);
	});

	it("removeAllowedTool clears the list when the last name is revoked", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		addAllowedTool("memo_save");
		removeAllowedTool("memo_save");
		expect(loadConfig()?.allowedTools).toBeUndefined();
	});
});

describe("legacy NVA runtime migration on save", () => {
	it("never persists retired remote or avatar-focus fields", () => {
		saveConfig({
			provider: "codex",
			model: "gpt-5.4",
			cascadeRuntimeUrl: "https://stale.invalid:8910",
			local8gFocus: "avatar",
			localAvatarVoiceFocus: "both",
			localGpuTier: "laptop-4060-8g",
		} as unknown as Parameters<typeof saveConfig>[0]);
		const saved = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
		expect(saved.cascadeRuntimeUrl).toBeUndefined();
		expect(saved.local8gFocus).toBeUndefined();
		expect(saved.localAvatarVoiceFocus).toBeUndefined();
		expect(saved.localGpuTier).toBeUndefined();
		expect(saved.localVoiceEnabled).toBe(false);
	});
});
