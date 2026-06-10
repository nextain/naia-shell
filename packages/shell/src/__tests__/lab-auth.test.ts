// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock Tauri store plugin (not available in jsdom)
vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	return { load: vi.fn().mockResolvedValue(store) };
});

import {
	getNaiaKey,
	hasApiKey,
	hasNaiaKey,
	loadConfig,
	saveConfig,
} from "../lib/config";

describe("Lab Auth (config integration)", () => {
	afterEach(() => {
		localStorage.clear();
	});

	it("hasNaiaKey returns false when no config", () => {
		expect(hasNaiaKey()).toBe(false);
	});

	it("hasNaiaKey returns true when naiaKey is set", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "test-lab-key-123",
		});
		expect(hasNaiaKey()).toBe(true);
	});

	it("getNaiaKey returns the stored key", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "my-lab-key",
		});
		expect(getNaiaKey()).toBe("my-lab-key");
	});

	it("getNaiaKey returns undefined when no naiaKey", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "direct-key",
		});
		expect(getNaiaKey()).toBeUndefined();
	});

	it("hasApiKey returns true when naiaKey is set (no apiKey)", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "lab-key",
		});
		expect(hasApiKey()).toBe(true);
	});

	it("hasApiKey returns true when apiKey is set (no naiaKey)", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "direct-key",
		});
		expect(hasApiKey()).toBe(true);
	});

	it("hasApiKey returns false when neither is set", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "",
		});
		expect(hasApiKey()).toBe(false);
	});

	it("config preserves naiaKey and naiaUserId on save/load", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "key-abc",
			naiaUserId: "user-123",
		});
		const config = loadConfig();
		expect(config?.naiaKey).toBe("key-abc");
		expect(config?.naiaUserId).toBe("user-123");
	});

	it("naiaKey can be cleared by saving without it", () => {
		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "",
			naiaKey: "key-abc",
		});
		expect(hasNaiaKey()).toBe(true);

		saveConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: "new-direct-key",
		});
		expect(hasNaiaKey()).toBe(false);
		expect(loadConfig()?.naiaKey).toBeUndefined();
	});
});

describe("Lab Auth (deep link URL parsing)", () => {
	// Test the URL parsing logic that runs in Rust (lib.rs)
	// We test the same logic in TypeScript to validate format expectations

	function parseLabDeepLink(
		urlStr: string,
	): { naiaKey: string; naiaUserId?: string; state?: string } | null {
		try {
			const url = new URL(urlStr);
			const isAuth =
				url.hostname === "auth" ||
				url.pathname === "/auth" ||
				url.pathname === "auth";
			if (!isAuth) return null;

			const key = url.searchParams.get("key");
			const code = url.searchParams.get("code");
			const resolved = key ?? (code?.startsWith("gw-") ? code : null);
			if (!resolved) return null;
			if (!resolved.startsWith("gw-")) return null;

			return {
				naiaKey: resolved,
				naiaUserId: url.searchParams.get("user_id") ?? undefined,
				state: url.searchParams.get("state") ?? undefined,
			};
		} catch {
			return null;
		}
	}

	function parseDiscordDeepLink(urlStr: string): {
		discordUserId?: string;
		discordChannelId?: string;
		discordTarget?: string;
	} | null {
		try {
			const url = new URL(urlStr);
			const isAuth =
				url.hostname === "auth" ||
				url.pathname === "/auth" ||
				url.pathname === "auth";
			if (!isAuth) return null;

			const channel = url.searchParams.get("channel");
			const discordUserId =
				url.searchParams.get("discord_user_id") ??
				url.searchParams.get("discordUserId") ??
				(channel === "discord" ? url.searchParams.get("user_id") : null) ??
				undefined;
			const discordChannelId =
				url.searchParams.get("discord_channel_id") ??
				url.searchParams.get("discordChannelId") ??
				undefined;
			const discordTarget =
				url.searchParams.get("discord_target") ??
				url.searchParams.get("discordTarget") ??
				(discordUserId ? `user:${discordUserId}` : undefined) ??
				(discordChannelId ? `channel:${discordChannelId}` : undefined);

			if (!discordUserId && !discordChannelId && !discordTarget) return null;
			return { discordUserId, discordChannelId, discordTarget };
		} catch {
			return null;
		}
	}

	it("parses nanos://auth?key=xxx", () => {
		const result = parseLabDeepLink("nanos://auth?key=gw-test_key-123");
		expect(result).toEqual({
			naiaKey: "gw-test_key-123",
			naiaUserId: undefined,
		});
	});

	it("returns null for nanos://auth?code=xxx when code is not gw key", () => {
		const result = parseLabDeepLink("nanos://auth?code=def456");
		expect(result).toBeNull();
	});

	it("parses nanos://auth?code=xxx when code is gw key", () => {
		const result = parseLabDeepLink("nanos://auth?code=gw-from-code_456");
		expect(result).toEqual({
			naiaKey: "gw-from-code_456",
			naiaUserId: undefined,
		});
	});

	it("parses nanos://auth?key=xxx&user_id=yyy", () => {
		const result = parseLabDeepLink(
			"nanos://auth?key=gw-abc123&user_id=user-42",
		);
		expect(result).toEqual({ naiaKey: "gw-abc123", naiaUserId: "user-42" });
	});

	it("returns null for non-auth paths", () => {
		const result = parseLabDeepLink("nanos://settings?key=abc");
		expect(result).toBeNull();
	});

	it("returns null for missing key", () => {
		const result = parseLabDeepLink("nanos://auth?foo=bar");
		expect(result).toBeNull();
	});

	it("returns null for invalid URLs", () => {
		const result = parseLabDeepLink("not-a-url");
		expect(result).toBeNull();
	});

	it("parses state parameter from deep link", () => {
		const result = parseLabDeepLink(
			"nanos://auth?key=gw-abc123&state=random-state-token",
		);
		expect(result).toEqual({
			naiaKey: "gw-abc123",
			naiaUserId: undefined,
			state: "random-state-token",
		});
	});

	it("state is undefined when not present", () => {
		const result = parseLabDeepLink("nanos://auth?key=gw-abc123");
		expect(result?.state).toBeUndefined();
	});

	it("parses discord flow user_id when channel=discord", () => {
		const result = parseDiscordDeepLink(
			"nanos://auth?channel=discord&user_id=1473170396390883564",
		);
		expect(result).toEqual({
			discordUserId: "1473170396390883564",
			discordChannelId: undefined,
			discordTarget: "user:1473170396390883564",
		});
	});

	it("parses explicit discord target", () => {
		const result = parseDiscordDeepLink(
			"nanos://auth?channel=discord&discord_target=channel:1474553973405913290",
		);
		expect(result).toEqual({
			discordUserId: undefined,
			discordChannelId: undefined,
			discordTarget: "channel:1474553973405913290",
		});
	});
});
