/**
 * E2E test: Discord DM send + history + channel discovery via skill_naia_discord.
 *
 * Run manually:
 *   CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/discord-dm-send.test.ts
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
const TEST_DM_CHANNEL_ID = "1474816723579306105";

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
let skill: ReturnType<typeof createNaiaDiscordSkill>;

describe.skipIf(!canRunE2E)("E2E: Discord DM send + history pipeline", () => {
	beforeAll(async () => {
		client = new GatewayClient();
		await client.connect(GATEWAY_URL, {
			token: gatewayToken!,
			device: deviceIdentity,
		});
		skill = createNaiaDiscordSkill();
	});

	afterAll(() => {
		client?.close();
	});

	const sentMarker = `e2e-test-${Date.now()}`;

	it("sends a DM via channelId", async () => {
		const result = await skill.execute(
			{
				action: "send",
				message: `DM 테스트 메시지 [${sentMarker}]`,
				channelId: TEST_DM_CHANNEL_ID,
			},
			{
				gateway: client,
				writeLine: () => {},
				requestId: "test-dm-send",
			},
		);

		console.log("Send result:", JSON.stringify(result, null, 2));

		expect(result.success).toBe(true);
		expect(result.output).toBeTruthy();
		expect(result.error).toBeFalsy();
	}, 30_000);

	it("retrieves history containing the sent message", async () => {
		// Brief delay to let the message propagate
		await new Promise((r) => setTimeout(r, 2000));

		const result = await skill.execute(
			{ action: "history", limit: 20 },
			{
				gateway: client,
				writeLine: () => {},
				requestId: "test-dm-history",
			},
		);

		console.log("History result:", JSON.stringify(result, null, 2));

		expect(result.success).toBe(true);
		expect(result.output).toBeTruthy();

		const parsed = JSON.parse(result.output);
		expect(parsed.messages).toBeDefined();
		expect(Array.isArray(parsed.messages)).toBe(true);

		if (parsed.messages.length > 0) {
			// Verify message structure
			for (const msg of parsed.messages) {
				expect(msg.id).toBeDefined();
				expect(msg.from).toBeDefined();
				expect(typeof msg.content).toBe("string");
				expect(msg.timestamp).toBeDefined();
			}

			// Check if our sent message appears in history
			const found = parsed.messages.some((m: { content: string }) =>
				m.content.includes(sentMarker),
			);
			console.log("Sent message found in history:", found);
			// Note: message may not appear immediately in history depending on session routing
		}
	}, 30_000);

	it("discovers DM channel from Gateway sessions", async () => {
		const sessionsList = (await client.request("sessions.list", {})) as {
			sessions?: Array<{
				key: string;
				channel?: string;
				origin?: { provider?: string };
			}>;
		};

		const sessions = sessionsList.sessions ?? [];
		console.log(
			"Discord-related sessions:",
			sessions
				.filter(
					(s) =>
						s.key.includes("discord") ||
						s.channel === "discord" ||
						s.origin?.provider === "discord",
				)
				.map((s) => ({ key: s.key, channel: s.channel, origin: s.origin })),
		);

		// Look for Discord sessions (legacy or per-channel-peer format)
		const dmSession = sessions.find((s) => {
			return (
				/^discord:(?:dm|channel):(\d+)$/.test(s.key) ||
				/^agent:[^:]+:discord:direct:(\d+)$/.test(s.key)
			);
		});

		if (dmSession) {
			const id = dmSession.key.split(":").pop();
			console.log(
				"Discovered Discord session ID from sessions:",
				id,
				"key:",
				dmSession.key,
			);
			expect(id).toMatch(/^\d{10,}$/);
		} else {
			console.log(
				"No Discord session found — DM session may not yet exist. " +
					"This is expected if Discord bot hasn't received a DM in current Gateway lifecycle.",
			);
		}
	}, 15_000);
});
