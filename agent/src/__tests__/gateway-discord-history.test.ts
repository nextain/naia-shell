/**
 * E2E test: Discord history via skill_naia_discord (using chat.history RPC).
 *
 * Run manually:
 *   CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/gateway-discord-history.test.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { loadDeviceIdentity } from "../gateway/device-identity.js";
import { createNaiaDiscordSkill } from "../skills/built-in/naia-discord.js";

const GATEWAY_URL = "ws://localhost:18789";
const LIVE_E2E = process.env.CAFE_LIVE_GATEWAY_E2E === "1";

function loadGatewayToken(): string | null {
	const candidates = [
		join(homedir(), ".naia", "gateway.json"),
	];
	for (const path of candidates) {
		try {
			const config = JSON.parse(readFileSync(path, "utf-8"));
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

describe.skipIf(!canRunE2E)("E2E: Discord history via chat.history", () => {
	beforeAll(async () => {
		client = new GatewayClient();
		await client.connect(GATEWAY_URL, {
			token: gatewayToken!,
			device: deviceIdentity,
		});
	});

	afterAll(() => {
		client?.close();
	});

	it("fetches Discord history via skill_naia_discord", async () => {
		const skill = createNaiaDiscordSkill();
		const result = await skill.execute(
			{ action: "history", limit: 10 },
			{
				gateway: client,
				writeLine: () => {},
				requestId: "test-history",
			},
		);

		console.log("History result:", JSON.stringify(result, null, 2));

		expect(result.success).toBe(true);
		expect(result.output).toBeTruthy();

		const parsed = JSON.parse(result.output);
		console.log("Parsed messages count:", parsed.messages?.length ?? 0);

		if (parsed.messages?.length > 0) {
			console.log(
				"First message:",
				JSON.stringify(parsed.messages[0], null, 2),
			);
			console.log(
				"Last message:",
				JSON.stringify(parsed.messages[parsed.messages.length - 1], null, 2),
			);

			// Verify message structure
			for (const msg of parsed.messages) {
				expect(msg.id).toBeDefined();
				expect(msg.from).toBeDefined();
				expect(typeof msg.content).toBe("string");
				expect(msg.timestamp).toBeDefined();
			}
		}
	}, 30_000);
});
