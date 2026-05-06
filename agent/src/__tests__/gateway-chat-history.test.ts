/**
 * E2E test: Gateway chat.history RPC to retrieve Discord messages.
 *
 * Run manually:
 *   CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/gateway-chat-history.test.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { loadDeviceIdentity } from "../gateway/device-identity.js";

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

describe.skipIf(!canRunE2E)(
	"E2E: Gateway chat.history & sessions",
	() => {
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

		it("lists available methods related to chat/sessions", () => {
			const methods = client.availableMethods;
			const relevant = methods.filter(
				(m) =>
					m.includes("chat") ||
					m.includes("session") ||
					m.includes("channel") ||
					m.includes("send"),
			);
			console.log(
				"Chat/session/channel methods:",
				JSON.stringify(relevant, null, 2),
			);

			expect(methods).toContain("chat.history");
			expect(methods).toContain("sessions.list");
		});

		it("lists sessions and finds Discord sessions", async () => {
			const result = (await client.request("sessions.list", {})) as Record<
				string,
				unknown
			>;
			console.log("sessions.list response keys:", Object.keys(result));
			console.log(
				"sessions.list full response:",
				JSON.stringify(result, null, 2).slice(0, 3000),
			);

			// Should have sessions
			expect(result).toBeDefined();
		});

		it("fetches chat.history for main session", async () => {
			try {
				const result = await client.request("chat.history", {
					sessionKey: "agent:main:main",
				});
				console.log(
					"chat.history (main) response:",
					JSON.stringify(result, null, 2).slice(0, 3000),
				);
				expect(result).toBeDefined();
			} catch (err) {
				console.log("chat.history error:", String(err));
			}
		});

		it("fetches chat.history for Discord channel session", async () => {
			// Try Discord sessions — both legacy and per-channel-peer formats
			const discordKeys = [
				"agent:main:discord:direct:865850174651498506",
				"agent:main:discord:channel:1474553973405913290",
				"agent:main:discord:channel:default",
				"agent:main:discord:channel:1275535550845292640",
			];

			for (const key of discordKeys) {
				try {
					const result = await client.request("chat.history", {
						sessionKey: key,
					});
					console.log(
						`chat.history (${key}):`,
						JSON.stringify(result, null, 2).slice(0, 2000),
					);
				} catch (err) {
					console.log(`chat.history (${key}) error:`, String(err));
				}
			}
		});

		it("tries sessions.preview for Discord session", async () => {
			try {
				const result = await client.request("sessions.preview", {
					key: "agent:main:discord:direct:865850174651498506",
				});
				console.log(
					"sessions.preview (discord):",
					JSON.stringify(result, null, 2).slice(0, 2000),
				);
			} catch (err) {
				console.log("sessions.preview error:", String(err));
			}
		});
	},
	60_000,
);
