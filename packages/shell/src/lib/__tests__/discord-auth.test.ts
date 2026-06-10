// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { persistDiscordDefaults } from "../discord-auth";

describe("persistDiscordDefaults", () => {
	afterEach(() => {
		localStorage.clear();
	});

	it("creates base config and persists defaults when config does not exist", () => {
		const next = persistDiscordDefaults({
			discordUserId: "865850174651498506",
		});
		expect(next).toBeTruthy();
		expect(next?.provider).toBe("gemini");
		expect(next?.discordDefaultUserId).toBe("865850174651498506");
		expect(next?.discordDefaultTarget).toBe("user:865850174651498506");

		const stored = loadConfig();
		expect(stored?.discordDefaultUserId).toBe("865850174651498506");
		expect(stored?.discordDefaultTarget).toBe("user:865850174651498506");
	});

	it("keeps explicit target when provided", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-3-flash-preview",
				apiKey: "",
			}),
		);
		const next = persistDiscordDefaults({
			discordUserId: "865850174651498506",
			discordTarget: "channel:1474553973405913290",
		});
		expect(next?.discordDefaultTarget).toBe("channel:1474553973405913290");
	});

	it("returns null for invalid payload", () => {
		const next = persistDiscordDefaults({
			discordUserId: "abc",
			discordTarget: "hello",
		});
		expect(next).toBeNull();
		expect(loadConfig()).toBeNull();
	});
});
