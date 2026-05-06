/**
 * E2E test: Gateway chat.send event format discovery & validation.
 *
 * Prerequisites:
 *   - Naia Gateway running on localhost:18789
 *   - Device paired with operator token
 *
 * Run manually:
 *   CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/gateway-chat-events.test.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { loadDeviceIdentity } from "../gateway/device-identity.js";
import { handleChatViaGateway } from "../gateway/gateway-chat.js";
import type { GatewayEvent } from "../gateway/types.js";

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

describe.skipIf(!canRunE2E)("E2E: Gateway chat.send events", () => {
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

	it("lists available methods including chat-related", () => {
		const methods = client.availableMethods;
		// Log all methods for discovery
		console.log("Available Gateway methods:", JSON.stringify(methods, null, 2));

		// Core methods should always be present
		expect(methods.length).toBeGreaterThan(0);

		// Log whether chat.send is available
		const hasChatSend = methods.includes("chat.send");
		const hasAgent = methods.includes("agent");
		console.log(`chat.send available: ${hasChatSend}`);
		console.log(`agent available: ${hasAgent}`);
	});

	it("captures raw events from gateway", async () => {
		const events: GatewayEvent[] = [];

		// Register a catch-all event listener
		client.onEvent((event) => {
			events.push(event);
			console.log(
				`[EVENT] ${event.event}:`,
				JSON.stringify(event.payload, null, 2),
			);
		});

		// Wait briefly to see if there are any background events
		await new Promise((resolve) => setTimeout(resolve, 2000));
		console.log(`Captured ${events.length} background events`);
	});

	it("sends a chat message and captures all response events", async () => {
		const methods = new Set(client.availableMethods);
		const hasChatSend = methods.has("chat.send");
		const hasAgent = methods.has("agent");

		if (!hasChatSend && !hasAgent) {
			console.log("SKIP: Neither chat.send nor agent method available");
			return;
		}

		const allEvents: Array<{ event: string; payload: unknown }> = [];
		const writeLineOutput: unknown[] = [];

		// Log all events during chat
		client.onEvent((event) => {
			allEvents.push({ event: event.event, payload: event.payload });
			console.log(
				`[CHAT EVENT] ${event.event}:`,
				JSON.stringify(event.payload, null, 2),
			);
		});

		const writeLine = (data: unknown) => {
			writeLineOutput.push(data);
			console.log("[WRITELINE]", JSON.stringify(data, null, 2));
		};

		try {
			await handleChatViaGateway(client, {
				message: "Say hello in one sentence.",
				requestId: `test-${Date.now()}`,
				writeLine,
			});
		} catch (err) {
			console.log("[CHAT ERROR]", String(err));
			// Log what we got before error
		}

		console.log("\n=== Summary ===");
		console.log(`Total events: ${allEvents.length}`);
		console.log(
			`Event types: ${[...new Set(allEvents.map((e) => e.event))].join(", ")}`,
		);
		console.log(`WriteLine messages: ${writeLineOutput.length}`);
		console.log(
			`WriteLine types: ${[...new Set(writeLineOutput.map((w) => (w as Record<string, unknown>).type))].join(", ")}`,
		);

		// Should get text + finish
		expect(writeLineOutput.length).toBeGreaterThanOrEqual(2);

		// First should be text
		const firstOutput = writeLineOutput[0] as Record<string, unknown>;
		expect(firstOutput.type).toBe("text");
		expect(typeof firstOutput.text).toBe("string");
		expect((firstOutput.text as string).length).toBeGreaterThan(0);

		// Last should be finish
		const lastOutput = writeLineOutput[writeLineOutput.length - 1] as Record<
			string,
			unknown
		>;
		expect(lastOutput.type).toBe("finish");
	}, 180_000);

	it("tests chat.send RPC directly if available", async () => {
		const methods = new Set(client.availableMethods);
		if (!methods.has("chat.send")) {
			console.log(
				"SKIP: chat.send not available, testing agent method instead",
			);

			if (methods.has("agent")) {
				try {
					const result = await client.request("agent", {
						message: "Respond with OK.",
					});
					console.log("[agent response]:", JSON.stringify(result, null, 2));
				} catch (err) {
					console.log("[agent error]:", String(err));
				}
			}
			return;
		}

		try {
			const result = await client.request("chat.send", {
				message: "Respond with OK.",
				sessionKey: "agent:main:main",
				idempotencyKey: `e2e-direct-${Date.now()}`,
			});
			console.log("[chat.send response]:", JSON.stringify(result, null, 2));
			expect(result).toBeDefined();
		} catch (err) {
			console.log("[chat.send error]:", String(err));
		}
	}, 30_000);
});
