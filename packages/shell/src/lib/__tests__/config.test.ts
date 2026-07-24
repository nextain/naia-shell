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
	normalizeCascadeUrl,
	reconcileExplicitLocalProfile,
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
		expect(loadConfig()?.vllmTtsHost).toBe("http://localhost:8910");

		saveConfig({ provider: "ollama", model: "my-local-model", apiKey: "" });
		migrateLegacyDna3OllamaModel();
		expect(loadConfig()?.model).toBe("my-local-model");
	});

	it("restores the explicit 4060 profile to CPU/NPU DNA3 and local facade", () => {
		const restored = reconcileExplicitLocalProfile({
			provider: "nextain",
			model: "gemini-3.5-flash",
			apiKey: "",
			localGpuTier: "laptop-4060-8g",
			vllmTtsHost: "http://localhost:8901",
		});

		expect(restored.provider).toBe("ollama");
		expect(restored.model).toBe("dna3:latest");
		expect(restored.ollamaNumGpu).toBe(0);
		expect(restored.ttsProvider).toBe("naia-local-voice");
		expect(restored.vllmTtsHost).toBe("http://localhost:8910");
		expect(restored.avatarProvider).toBe("naia-video-avatar");
		expect(restored.nvaModel).toBe("naia");
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
		expect(isToolAllowed("execute_command")).toBe(false);
	});

	it("isToolAllowed returns false when tool not in list", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		expect(isToolAllowed("execute_command")).toBe(false);
	});

	it("addAllowedTool adds and isToolAllowed returns true", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		addAllowedTool("execute_command");
		expect(isToolAllowed("execute_command")).toBe(true);
	});

	it("addAllowedTool does not duplicate", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		addAllowedTool("write_file");
		addAllowedTool("write_file");
		const config = loadConfig()!;
		expect(config.allowedTools).toEqual(["write_file"]);
	});

	it("clearAllowedTools removes all", () => {
		saveConfig({ provider: "gemini", model: "m", apiKey: "k" });
		addAllowedTool("write_file");
		addAllowedTool("execute_command");
		clearAllowedTools();
		expect(isToolAllowed("write_file")).toBe(false);
		expect(isToolAllowed("execute_command")).toBe(false);
	});

	it("clearAllowedTools works when no config", () => {
		clearAllowedTools(); // no throw
		expect(isToolAllowed("write_file")).toBe(false);
	});
});

describe("normalizeCascadeUrl (remote cascade URL 검증·정규화)", () => {
	it("빈 값 → url undefined(로컬 auto), error 없음", () => {
		expect(normalizeCascadeUrl("")).toEqual({ url: undefined });
		expect(normalizeCascadeUrl("   ")).toEqual({ url: undefined });
	});
	it("http/https 유효 → trailing slash 정규화", () => {
		expect(normalizeCascadeUrl("http://100.1.2.3:8910")).toEqual({
			url: "http://100.1.2.3:8910",
		});
		expect(normalizeCascadeUrl("https://x.ts.net:8910/")).toEqual({
			url: "https://x.ts.net:8910",
		});
	});
	it("스킴 위반(ws/ftp) → error scheme", () => {
		expect(normalizeCascadeUrl("ws://x:8910").error).toBe("scheme");
		expect(normalizeCascadeUrl("ftp://x").error).toBe("scheme");
	});
	it("파싱 불가 → error invalid", () => {
		expect(normalizeCascadeUrl("not a url").error).toBe("invalid");
		expect(normalizeCascadeUrl("100.1.2.3:8910").error).toBe("invalid");
	});
});
