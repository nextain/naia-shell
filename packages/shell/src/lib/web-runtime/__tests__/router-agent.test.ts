import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentBridge, setAgentBridgeForTests } from "../agent-bridge";
import { routeCommand } from "../router";

describe("router agent commands", () => {
	let sentLines: string[] = [];
	const mockBridge: AgentBridge = {
		sendLine(line: string) {
			sentLines.push(line);
		},
	};

	beforeEach(() => {
		sentLines = [];
		setAgentBridgeForTests(mockBridge);
	});

	afterEach(() => {
		setAgentBridgeForTests(null);
	});

	it("forwards valid send_to_agent_command and resolves to null", async () => {
		const validMsg = JSON.stringify({ type: "chat_request", prompt: "hello" });
		const result = await routeCommand("send_to_agent_command", {
			message: validMsg,
		});
		expect(result).toBeNull();
		expect(sentLines).toEqual([validMsg]);
	});

	it("rejects broken JSON starting with Invalid JSON from frontend:", async () => {
		await expect(
			routeCommand("send_to_agent_command", { message: "{not_json" }),
		).rejects.toThrow(/^Invalid JSON from frontend:/);
		expect(sentLines).toHaveLength(0);
	});

	it("rejects non-object JSON array with Message must be a JSON object", async () => {
		await expect(
			routeCommand("send_to_agent_command", { message: "[1]" }),
		).rejects.toThrow("Message must be a JSON object");
		expect(sentLines).toHaveLength(0);
	});

	it("rejects object without string type field with Message must have a string 'type' field", async () => {
		await expect(
			routeCommand("send_to_agent_command", { message: "{}" }),
		).rejects.toThrow("Message must have a string 'type' field");
		expect(sentLines).toHaveLength(0);

		await expect(
			routeCommand("send_to_agent_command", {
				message: JSON.stringify({ type: 123 }),
			}),
		).rejects.toThrow("Message must have a string 'type' field");
		expect(sentLines).toHaveLength(0);
	});

	it("rejects message over 10MB with Message too large:", async () => {
		const tenMbPlus = "x".repeat(10 * 1024 * 1024 + 1);
		await expect(
			routeCommand("send_to_agent_command", { message: tenMbPlus }),
		).rejects.toThrow(/^Message too large:/);
		expect(sentLines).toHaveLength(0);
	});

	it("routes cancel_stream with requestId and resolves to null", async () => {
		const result = await routeCommand("cancel_stream", { requestId: "r1" });
		expect(result).toBeNull();
		expect(sentLines).toEqual(['{"type":"cancel_stream","requestId":"r1"}']);
	});

	it("routes reload_agent_settings returning not-available status", async () => {
		const res = await routeCommand("reload_agent_settings");
		expect(res).toEqual({
			available: false,
			memoryReloaded: false,
			memoryRetained: false,
			memoryStatus: "next_start",
		});
		expect(sentLines).toHaveLength(0);
	});
});
