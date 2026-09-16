import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #610 absence proof (shell slice): Channels tab, channel-sync, discord auth/api,
 * Discord connections settings, and config field names must not reappear.
 */
describe("#610 discord/cron shell surfaces absent", () => {
	const root = join(import.meta.dirname, "../..");
	const gone = [
		"components/ChannelsTab.tsx",
		"components/ConnectionsSettingsTab.tsx",
		"lib/channel-sync.ts",
		"lib/discord-api.ts",
		"lib/discord-auth.ts",
	];

	it.each(gone)("%s is deleted", (rel) => {
		expect(() => readFileSync(join(root, rel), "utf8")).toThrow();
	});

	it("AppConfig no longer declares discord DM/webhook/relay fields", () => {
		const config = readFileSync(join(root, "lib/config.ts"), "utf8");
		for (const key of [
			"discordWebhookUrl",
			"discordDefaultUserId",
			"discordDefaultTarget",
			"discordDmChannelId",
			"discordSessionMigrated",
			"discordRelayUrl",
			"lastProcessedDiscordMessageId",
		]) {
			expect(config.includes(key)).toBe(false);
		}
	});

	it("notify_config no longer carries discord fields", () => {
		const chat = readFileSync(join(root, "lib/chat-service.ts"), "utf8");
		expect(chat.includes("discordWebhookUrl")).toBe(false);
		expect(chat.includes("discordDefaultUserId")).toBe(false);
		expect(chat.includes("discordDmChannelId")).toBe(false);
	});

	it("built-in skill list has no discord/cron skills", () => {
		const rust = readFileSync(join(root, "../src-tauri/src/lib.rs"), "utf8");
		for (const name of [
			"skill_notify_discord",
			"skill_cron",
			"skill_naia_discord",
		]) {
			expect(rust.includes(`"${name}"`)).toBe(false);
		}
	});
});
