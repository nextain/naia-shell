// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addAllowedTool,
	clearAllowedTools,
	hasApiKey,
	isToolAllowed,
	loadConfig,
	migrateLegacyMemoryConfig,
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

// ── #332 Phase 2a.5 — S114 legacy memory config migration ──────────────────
//
// Locks the legacy 12-field memory config → new 4-field (`memoryMode`,
// `memoryEmbedding`) conversion. Gemini cross-review flagged silent user-
// intent loss as the main risk; each rule below has a dedicated spec so a
// regression on any branch is caught at unit-test level (no e2e needed).
describe("migrateLegacyMemoryConfig (#332 Phase 2a.5)", () => {
	it("legacy memoryAdapter='local' → memoryMode='local'", () => {
		const out = migrateLegacyMemoryConfig({ memoryAdapter: "local" });
		expect(out.memoryMode).toBe("local");
		expect(out.memoryEmbedding).toBe("offline"); // default
	});

	it("legacy memoryAdapter='qdrant' → memoryMode='cloud' + preserves qdrant fields", () => {
		const out = migrateLegacyMemoryConfig({
			memoryAdapter: "qdrant",
			qdrantUrl: "http://qdrant.example.test:6333",
			qdrantApiKey: "qdrant-secret",
		});
		expect(out.memoryMode).toBe("cloud");
		// Preserve for future cloud-mode wiring (design §9).
		expect(out.qdrantUrl).toBe("http://qdrant.example.test:6333");
		expect(out.qdrantApiKey).toBe("qdrant-secret");
	});

	it("missing memoryAdapter → memoryMode='local' (sensible default)", () => {
		const out = migrateLegacyMemoryConfig({});
		expect(out.memoryMode).toBe("local");
	});

	it("legacy memoryEmbeddingProvider='offline' → memoryEmbedding='offline'", () => {
		const out = migrateLegacyMemoryConfig({
			memoryAdapter: "local",
			memoryEmbeddingProvider: "offline",
		});
		expect(out.memoryEmbedding).toBe("offline");
		expect(out.memoryMode).toBe("local");
	});

	it.each(["ollama", "vllm", "naia"] as const)(
		"legacy memoryEmbeddingProvider='%s' → memoryEmbedding='custom' + preserves baseUrl/model",
		(provider) => {
			const out = migrateLegacyMemoryConfig({
				memoryAdapter: "local",
				memoryEmbeddingProvider: provider,
				memoryEmbeddingBaseUrl: "http://localhost:11434/v1",
				memoryEmbeddingModel: "nomic-embed-text",
			});
			expect(out.memoryEmbedding).toBe("custom");
			// Preserve legacy fields so buildNaiaConfigEnv "custom" branch can
			// emit them (per Phase 2a adk-store.ts behaviour).
			expect(out.memoryEmbeddingBaseUrl).toBe("http://localhost:11434/v1");
			expect(out.memoryEmbeddingModel).toBe("nomic-embed-text");
			expect(out.memoryEmbeddingProvider).toBe(provider);
		},
	);

	it("legacy memoryEmbeddingProvider='none' + memoryAdapter='local' → memoryMode='off'", () => {
		const out = migrateLegacyMemoryConfig({
			memoryAdapter: "local",
			memoryEmbeddingProvider: "none",
		});
		// "none" = user explicitly disabled memory pipeline (no embedder).
		expect(out.memoryMode).toBe("off");
	});

	// CODEX cross-review trap: memoryAdapter=qdrant + memoryEmbeddingProvider=none
	// must NOT silently flip to 'off' — the explicit Qdrant choice is durable
	// cloud intent (design §9) that survives "no embedder picked yet". Memory
	// off must come from an explicit memory-disabled signal, not from the
	// default embedding choice.
	it("legacy memoryAdapter='qdrant' + memoryEmbeddingProvider='none' → memoryMode='cloud' (cloud intent wins, codex trap)", () => {
		const out = migrateLegacyMemoryConfig({
			memoryAdapter: "qdrant",
			memoryEmbeddingProvider: "none",
			qdrantUrl: "http://qdrant.example.test:6333",
		});
		expect(out.memoryMode).toBe("cloud");
		expect(out.qdrantUrl).toBe("http://qdrant.example.test:6333");
	});

	// CODEX cross-review trap: already-set memoryMode must never be overwritten
	// by a stale legacy memoryEmbeddingProvider='none'. partial-new safety.
	it("partial-new: memoryMode set externally, legacy provider='none' does NOT overwrite", () => {
		const out = migrateLegacyMemoryConfig({
			memoryMode: "local",
			memoryEmbeddingProvider: "none",
		});
		expect(out.memoryMode).toBe("local");
		expect(out.memoryEmbedding).toBe("offline");
	});

	it("all legacy fields absent → memoryMode='local' + memoryEmbedding='offline'", () => {
		const out = migrateLegacyMemoryConfig({});
		expect(out.memoryMode).toBe("local");
		expect(out.memoryEmbedding).toBe("offline");
	});

	it("no-op: already-new config (memoryMode + memoryEmbedding set) is not overwritten", () => {
		const out = migrateLegacyMemoryConfig({
			memoryMode: "off",
			memoryEmbedding: "gateway",
			// legacy fields present but should be IGNORED
			memoryAdapter: "qdrant",
			memoryEmbeddingProvider: "ollama",
		});
		expect(out.memoryMode).toBe("off");
		expect(out.memoryEmbedding).toBe("gateway");
	});

	it("idempotent: running twice yields the same result", () => {
		const first = migrateLegacyMemoryConfig({
			memoryAdapter: "local",
			memoryEmbeddingProvider: "ollama",
			memoryEmbeddingBaseUrl: "http://localhost:11434/v1",
		});
		const second = migrateLegacyMemoryConfig(first);
		expect(second.memoryMode).toBe(first.memoryMode);
		expect(second.memoryEmbedding).toBe(first.memoryEmbedding);
	});
});

describe("loadConfig migrates legacy memory config on read (#332 Phase 2a.5)", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("auto-upgrades legacy memoryAdapter='qdrant' to memoryMode='cloud'", () => {
		// Simulate a config saved before #332 (no memoryMode/memoryEmbedding).
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "k",
				memoryAdapter: "qdrant",
				qdrantUrl: "http://qdrant.example.test:6333",
			}),
		);

		const config = loadConfig();
		expect(config?.memoryMode).toBe("cloud");
		// Legacy fields preserved (not destructive — Phase 2a.5 is read-only
		// derivation; the next saveConfig() persists the new fields).
		expect(config?.memoryAdapter).toBe("qdrant");
		expect(config?.qdrantUrl).toBe("http://qdrant.example.test:6333");
	});

	it("auto-upgrades legacy memoryEmbeddingProvider='none' to memoryMode='off'", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "k",
				memoryEmbeddingProvider: "none",
			}),
		);

		expect(loadConfig()?.memoryMode).toBe("off");
	});

	it("does not touch already-migrated configs", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "k",
				memoryMode: "local",
				memoryEmbedding: "gateway",
			}),
		);

		const config = loadConfig();
		expect(config?.memoryMode).toBe("local");
		expect(config?.memoryEmbedding).toBe("gateway");
	});
});
