// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addAllowedTool,
	clearAllowedTools,
	hasApiKey,
	isToolAllowed,
	loadConfig,
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
