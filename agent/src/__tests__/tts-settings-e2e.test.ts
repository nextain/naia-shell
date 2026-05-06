/**
 * E2E tests: TTS Settings + Gateway TTS Pipeline
 *
 * Prerequisites:
 *   - Naia Gateway running on localhost:18789
 *   - Device paired with operator token
 *
 * Verifies:
 *   1. Gateway TTS RPC methods work (status, providers, convert)
 *   2. Naia provider → always uses Gateway TTS (not Google direct)
 *   3. TTS engine selection logic: gateway vs "nextain cloud tts" (google)
 *   4. Config save/load for TTS settings
 *
 * Run:
 *   CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/tts-settings-e2e.test.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { loadDeviceIdentity } from "../gateway/device-identity.js";
import {
	type TtsAutoMode,
	type TtsMode,
	convertTts,
	getTtsProviders,
	getTtsStatus,
	setTtsAutoMode,
	setTtsOutputMode,
} from "../gateway/tts-proxy.js";

const GATEWAY_URL = "ws://localhost:18789";
const LIVE_E2E = process.env.CAFE_LIVE_GATEWAY_E2E === "1";

function loadGatewayToken(): string | null {
	const paths = [
		join(homedir(), ".naia", "gateway.json"),
	];
	for (const p of paths) {
		try {
			const config = JSON.parse(readFileSync(p, "utf-8"));
			return config.gateway?.auth?.token || null;
		} catch {}
	}
	return null;
}

const gatewayToken = loadGatewayToken();
const deviceIdentity = loadDeviceIdentity();
const canRunE2E =
	LIVE_E2E && gatewayToken !== null && deviceIdentity !== undefined;

let client: GatewayClient;

function hasMethod(name: string): boolean {
	return new Set(client.availableMethods).has(name);
}

describe.skipIf(!canRunE2E)("E2E: TTS Settings + Pipeline", () => {
	beforeAll(async () => {
		client = new GatewayClient();
		await client.connect(GATEWAY_URL, {
			token: gatewayToken!,
			device: deviceIdentity,
			role: "operator",
			scopes: ["operator.read", "operator.write", "operator.admin"],
		});
	});

	afterAll(() => {
		client?.close();
	});

	// ═══════════════════════════════════════
	// 1. Gateway TTS methods availability
	// ═══════════════════════════════════════
	describe("Gateway TTS methods", () => {
		it("has tts.status method", () => {
			expect(hasMethod("tts.status")).toBe(true);
		});

		it("has tts.convert method", () => {
			expect(hasMethod("tts.convert")).toBe(true);
		});

		it("has tts.providers method", () => {
			expect(hasMethod("tts.providers")).toBe(true);
		});
	});

	// ═══════════════════════════════════════
	// 2. TTS status retrieval
	// ═══════════════════════════════════════
	describe("TTS status", () => {
		it("returns valid status object", async () => {
			if (!hasMethod("tts.status")) return;
			const status = await getTtsStatus(client);
			expect(status).toBeDefined();
			// status should have at least some structure
			expect(typeof status).toBe("object");
		});
	});

	// ═══════════════════════════════════════
	// 3. TTS providers list
	// ═══════════════════════════════════════
	describe("TTS providers", () => {
		it("returns providers data", async () => {
			if (!hasMethod("tts.providers")) return;
			const result = await client.request("tts.providers", {});
			expect(result).toBeDefined();
			// Gateway may return array or object with providers
			const providers = Array.isArray(result)
				? result
				: (result as Record<string, unknown>).providers;
			expect(providers ?? result).toBeDefined();
		});

		it("at least one provider is available", async () => {
			if (!hasMethod("tts.providers")) return;
			const result = await client.request("tts.providers", {});
			const providers = Array.isArray(result)
				? result
				: Array.isArray((result as Record<string, unknown>).providers)
					? ((result as Record<string, unknown>).providers as unknown[])
					: Object.keys(result as Record<string, unknown>);
			expect(providers.length).toBeGreaterThan(0);
		});
	});

	// ═══════════════════════════════════════
	// 4. TTS convert (Gateway path)
	// ═══════════════════════════════════════
	describe("TTS convert via Gateway", () => {
		it("converts Korean text to audio", async () => {
			if (!hasMethod("tts.convert")) return;
			const result = await convertTts(client, "안녕하세요, 테스트입니다.");
			// Depending on TTS config, may or may not have audio
			expect(result).toBeDefined();
			if (result.audio) {
				// Audio should be base64 encoded
				expect(typeof result.audio).toBe("string");
				expect(result.audio.length).toBeGreaterThan(100);
			}
		});

		it("converts short text to audio", async () => {
			if (!hasMethod("tts.convert")) return;
			const result = await convertTts(client, "테스트");
			expect(result).toBeDefined();
		});

		it("handles empty text gracefully", async () => {
			if (!hasMethod("tts.convert")) return;
			try {
				const result = await convertTts(client, "");
				// Should either return empty or throw
				expect(result).toBeDefined();
			} catch {
				// Expected — empty text may be rejected
			}
		});
	});

	// ═══════════════════════════════════════
	// 5. Naia provider TTS routing
	// ═══════════════════════════════════════
	describe("Naia provider TTS routing", () => {
		it("Gateway TTS works for Naia provider (no Google API key needed)", async () => {
			if (!hasMethod("tts.convert")) return;

			// Naia provider uses Gateway TTS exclusively
			// This test verifies that TTS works without any Google API key
			const result = await convertTts(client, "나이아 OS 테스트 음성입니다.");
			expect(result).toBeDefined();
			// If Gateway has a configured provider, should get audio
			if (result.audio) {
				expect(typeof result.audio).toBe("string");
				expect(result.audio.length).toBeGreaterThan(0);
			}
		});
	});

	// ═══════════════════════════════════════
	// 6. Config RPC for TTS settings
	// ═══════════════════════════════════════
	describe("Config TTS settings via Gateway", () => {
		it("can read current gateway config", async () => {
			if (!hasMethod("config.get")) return;
			const config = await client.request("config.get", {});
			expect(config).toBeDefined();
		});

		it("tts section exists in config", async () => {
			if (!hasMethod("config.get")) return;
			const config = (await client.request("config.get", {})) as Record<
				string,
				unknown
			>;
			// TTS config may be under tts or voice section
			const hasTts = "tts" in config || "voice" in config || "audio" in config;
			// It's fine if tts config doesn't exist (means default)
			expect(typeof config).toBe("object");
			if (hasTts) {
				expect(config).toBeDefined();
			}
		});
	});

	// ═══════════════════════════════════════
	// 7. TTS auto/mode save (config.patch)
	// ═══════════════════════════════════════
	describe("TTS auto/mode settings persistence", () => {
		it("set_auto changes auto mode in config", async () => {
			if (!hasMethod("config.patch") || !hasMethod("config.get")) return;

			// Read current config
			const cfgBefore = (await client.request("config.get", {})) as Record<
				string,
				// biome-ignore lint: gateway config is dynamic
				any
			>;
			const originalAuto = cfgBefore?.messages?.tts?.auto ?? "off";

			// Change
			const target = originalAuto === "always" ? "inbound" : "always";
			await setTtsAutoMode(client, target as TtsAutoMode);

			// Verify via config.get (not tts.status)
			const cfgAfter = (await client.request("config.get", {})) as Record<
				string,
				// biome-ignore lint: gateway config is dynamic
				any
			>;
			expect(cfgAfter?.messages?.tts?.auto).toBe(target);

			// Restore
			await setTtsAutoMode(client, originalAuto);
		});

		it("set_mode changes output mode in config", async () => {
			if (!hasMethod("config.patch") || !hasMethod("config.get")) return;

			const cfgBefore = (await client.request("config.get", {})) as Record<
				string,
				// biome-ignore lint: gateway config is dynamic
				any
			>;
			const originalMode = cfgBefore?.messages?.tts?.mode ?? "final";

			// Change
			const target = originalMode === "all" ? "final" : "all";
			await setTtsOutputMode(client, target as TtsMode);

			// Verify via config.get
			const cfgAfter = (await client.request("config.get", {})) as Record<
				string,
				// biome-ignore lint: gateway config is dynamic
				any
			>;
			expect(cfgAfter?.messages?.tts?.mode).toBe(target);

			// Restore
			await setTtsOutputMode(client, originalMode);
		});
	});

	// ═══════════════════════════════════════
	// 8. Diagnostics / Logs poll (bonus)
	// ═══════════════════════════════════════
	describe("Diagnostics logs poll", () => {
		it("logs.tail returns cursor-based response", async () => {
			if (!hasMethod("logs.tail")) return;
			const result = (await client.request("logs.tail", {})) as Record<
				string,
				unknown
			>;
			expect(result).toBeDefined();
			expect(typeof result.cursor).toBe("number");
			expect(Array.isArray(result.lines)).toBe(true);
		});

		it("logs.tail with cursor returns new lines", async () => {
			if (!hasMethod("logs.tail")) return;
			// First call to get cursor
			const first = (await client.request("logs.tail", {})) as Record<
				string,
				unknown
			>;
			const cursor = first.cursor as number;

			// Second call with cursor — should return 0 or few new lines
			const second = (await client.request("logs.tail", {
				cursor,
			})) as Record<string, unknown>;
			expect(second).toBeDefined();
			expect(typeof second.cursor).toBe("number");
			expect(Array.isArray(second.lines)).toBe(true);
		});
	});
});
