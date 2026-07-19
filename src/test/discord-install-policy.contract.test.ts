import { describe, expect, it } from "vitest";
import {
	DISCORD_BOT_PERMISSIONS,
	DISCORD_GATEWAY_INTENTS,
	buildDiscordInstallUrl,
	isCanonicalPositiveUint64Decimal,
} from "../main/domain/discord-setup.js";

describe("Discord 설치 정책", () => {
	it("고정 intent와 최소 bot permission만 사용한다", () => {
		expect(DISCORD_GATEWAY_INTENTS).toEqual([1, 512, 32_768]);
		expect(DISCORD_BOT_PERMISSIONS).toBe(68_608);
		const url = new URL(buildDiscordInstallUrl("123456789012345678"));
		expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
		expect(url.searchParams.get("client_id")).toBe("123456789012345678");
		expect(url.searchParams.get("scope")).toBe("bot");
		expect(url.searchParams.get("permissions")).toBe("68608");
		expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "permissions", "scope"]);
	});

	it("canonical positive uint64 snowflake만 허용한다", () => {
		expect(isCanonicalPositiveUint64Decimal("123456789012345678")).toBe(true);
		for (const value of ["abc", "0", "0123", "18446744073709551616"]) {
			expect(isCanonicalPositiveUint64Decimal(value)).toBe(false);
		}
		expect(() => buildDiscordInstallUrl("not-a-snowflake")).toThrow(
			"invalid_discord_client_id_format",
		);
	});
});
