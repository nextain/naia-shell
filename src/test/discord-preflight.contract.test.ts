import { describe, expect, it } from "vitest";
import {
	DISCORD_PREFLIGHT_CODES,
	evaluateDiscordPreflight,
	type DiscordPreflightFacts,
} from "../main/domain/discord-setup.js";

const ready: DiscordPreflightFacts = {
	networkReachable: true,
	rateLimited: false,
	tokenValid: true,
	messageContentIntent: true,
	guildInstalled: true,
	channelBelongsToGuild: true,
	channelVisibleToBot: true,
	permissionsPresent: true,
	agentReady: true,
};

describe("폐쇄형 Discord preflight", () => {
	it.each([
		[{ ...ready, networkReachable: false }, "network_unavailable"],
		[{ ...ready, rateLimited: true }, "rate_limited"],
		[{ ...ready, tokenValid: false }, "token_invalid"],
		[{ ...ready, messageContentIntent: false }, "intent_missing"],
		[{ ...ready, guildInstalled: false }, "guild_not_installed"],
		[{ ...ready, channelBelongsToGuild: false }, "channel_not_visible"],
		[{ ...ready, channelVisibleToBot: false }, "channel_not_visible"],
		[{ ...ready, permissionsPresent: false }, "permission_missing"],
		[{ ...ready, agentReady: false }, "agent_offline"],
	] as const)("실패 원인을 고정된 code로 반환한다", (facts, code) => {
		expect(evaluateDiscordPreflight(facts)).toEqual({ ok: false, code });
	});

	it("모든 predicate가 참일 때만 성공한다", () => {
		expect(evaluateDiscordPreflight(ready)).toEqual({ ok: true });
		expect(DISCORD_PREFLIGHT_CODES).toHaveLength(8);
	});

	it("미결선·malformed 값은 fail-closed 한다", () => {
		expect(evaluateDiscordPreflight({ ...ready, agentReady: null })).toEqual({
			ok: false,
			blocked: "BLOCKED_BY_CONTRACT",
		});
		expect(evaluateDiscordPreflight({ ...ready, tokenValid: "false" } as unknown)).toEqual({
			ok: false,
			blocked: "BLOCKED_BY_CONTRACT",
		});
	});
});
