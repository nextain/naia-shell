import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	type MockGateway,
	createMockGateway,
} from "../../gateway/__tests__/mock-gateway.js";
import { GatewayClient } from "../../gateway/client.js";
import { createConfigSkill } from "../built-in/config.js";
import type { SkillDefinition } from "../types.js";

describe("skill_config", () => {
	let mock: MockGateway;
	let client: GatewayClient;
	let skill: SkillDefinition;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		// Mock fetch to prevent dynamic Ollama model discovery in tests
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("mocked"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	beforeAll(async () => {
		mock = createMockGateway(
			(method, params, respond) => {
				switch (method) {
					case "config.get":
						respond.ok({
							provider: "gemini",
							model: "gemini-2.0-flash",
							ttsEnabled: true,
						});
						break;
					case "config.set":
						respond.ok({ updated: true });
						break;
					case "config.schema":
						respond.ok({
							type: "object",
							properties: { provider: { type: "string" } },
						});
						break;
					case "models.list":
						respond.ok({
							models: [
								{
									id: "gemini-2.0-flash",
									name: "Gemini Flash",
									provider: "gemini",
								},
								{ id: "grok-3-mini", name: "Grok Mini", provider: "xai" },
							],
						});
						break;
					case "config.patch":
						respond.ok({ patched: true });
						break;
					default:
						respond.error("UNKNOWN", `Unknown: ${method}`);
				}
			},
			{
				methods: [
					"exec.bash",
					"config.get",
					"config.set",
					"config.schema",
					"models.list",
					"config.patch",
				],
			},
		);

		client = new GatewayClient();
		await client.connect(`ws://127.0.0.1:${mock.port}`, {
			token: "test-token",
		});
		skill = createConfigSkill();
	});

	afterAll(() => {
		client.close();
		mock.close();
	});

	it("has correct metadata", () => {
		expect(skill.name).toBe("skill_config");
		expect(skill.tier).toBe(1);
		expect(skill.requiresGateway).toBe(false);
	});

	it("gets config", async () => {
		const result = await skill.execute({ action: "get" }, { gateway: client });
		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.provider).toBe("gemini");
	});

	it("sets config", async () => {
		const result = await skill.execute(
			{ action: "set", patch: { provider: "xai" } },
			{ gateway: client },
		);
		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.updated).toBe(true);
	});

	it("requires patch for set action", async () => {
		const result = await skill.execute({ action: "set" }, { gateway: client });
		expect(result.success).toBe(false);
		expect(result.error).toContain("patch is required");
	});

	it("gets schema", async () => {
		const result = await skill.execute(
			{ action: "schema" },
			{ gateway: client },
		);
		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.type).toBe("object");
	});

	it("lists models", async () => {
		const result = await skill.execute(
			{ action: "models" },
			{ gateway: client },
		);
		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		// Gateway returns 2 models + 21 local models (minus 1 overlap: grok-3-mini) = 22
		// Ollama models are fetched dynamically (mocked to fail in tests)
		expect(parsed.models).toHaveLength(22);
	});

	it("patches config", async () => {
		const result = await skill.execute(
			{ action: "patch", patch: { ttsEnabled: false } },
			{ gateway: client },
		);
		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.patched).toBe(true);
	});

	it("returns error without gateway", async () => {
		const result = await skill.execute({ action: "get" }, {});
		expect(result.success).toBe(false);
		expect(result.error).toContain("Gateway not connected");
	});

	it("returns error for unknown action", async () => {
		const result = await skill.execute(
			{ action: "invalid" },
			{ gateway: client },
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Unknown action");
	});
});
