import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #610 absence proof (shell slice): Channels tab, channel-sync, discord auth/api,
 * and Discord connections settings must not reappear as source modules.
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
});
