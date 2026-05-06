/**
 * E2E test: sessions.list with enriched messageCount.
 *
 * Run manually:
 *   CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/gateway-sessions-list.test.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { loadDeviceIdentity } from "../gateway/device-identity.js";
import { listSessions } from "../gateway/sessions-proxy.js";

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

describe.skipIf(!canRunE2E)("E2E: sessions.list with messageCount", () => {
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

	it("lists sessions with message counts", async () => {
		const result = await listSessions(client);
		console.log(
			"Sessions:",
			JSON.stringify(
				result.sessions.map((s) => ({
					key: s.key,
					label: s.label,
					messageCount: s.messageCount,
					status: s.status,
				})),
				null,
				2,
			),
		);

		expect(result.sessions.length).toBeGreaterThan(0);

		// main session should have messages
		const mainSession = result.sessions.find(
			(s) => s.key === "agent:main:main",
		);
		expect(mainSession).toBeDefined();
		expect(mainSession?.messageCount).toBeGreaterThan(0);
		console.log(`main session: ${mainSession?.messageCount} msgs`);

		// Each session should have label
		for (const s of result.sessions) {
			expect(s.label).toBeTruthy();
			console.log(`${s.key}: label="${s.label}", msgs=${s.messageCount}`);
		}
	}, 30_000);
});
