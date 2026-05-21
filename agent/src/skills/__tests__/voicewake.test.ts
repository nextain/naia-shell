import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type MockGateway,
	createMockGateway,
} from "../../gateway/__tests__/mock-gateway.js";
import { GatewayClient } from "../../gateway/client.js";
import { createVoiceWakeSkill } from "../built-in/voicewake.js";
import type { SkillDefinition } from "../types.js";

describe("skill_voicewake", () => {
	let mock: MockGateway;
	let client: GatewayClient;
	let skill: SkillDefinition;
	let tempDir: string;

	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "naia-voicewake-"));
		process.env.NAIA_VOICEWAKE_PATH = join(tempDir, "voicewake.json");

		mock = createMockGateway(
			(method, params, respond) => {
				switch (method) {
					case "voicewake.get":
						respond.ok({
							triggers: ["낸", "naia"],
						});
						break;
					case "voicewake.set":
						respond.ok({ triggers: params.triggers });
						break;
					default:
						respond.error("UNKNOWN", `Unknown: ${method}`);
				}
			},
			{
				methods: ["exec.bash", "voicewake.get", "voicewake.set"],
			},
		);

		client = new GatewayClient();
		await client.connect(`ws://127.0.0.1:${mock.port}`, {
			token: "test-token",
		});
		skill = createVoiceWakeSkill();
	});

	afterAll(() => {
		client.close();
		mock.close();
		process.env.NAIA_VOICEWAKE_PATH = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("has correct metadata", () => {
		expect(skill.name).toBe("skill_voicewake");
		expect(skill.tier).toBe(0);
		expect(skill.requiresGateway).toBe(false);
		expect(skill.source).toBe("built-in");
	});

	it("returns current triggers", async () => {
		const result = await skill.execute({ action: "get" }, { gateway: client });

		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.triggers).toEqual(["낸", "naia"]);
	});

	it("sets new triggers", async () => {
		const result = await skill.execute(
			{ action: "set", triggers: ["낸", "Naia", "hey alpha"] },
			{ gateway: client },
		);

		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.triggers).toEqual(["낸", "Naia", "hey alpha"]);
	});

	it("requires triggers for set action", async () => {
		const result = await skill.execute({ action: "set" }, { gateway: client });

		expect(result.success).toBe(false);
		expect(result.error).toContain("triggers");
	});

	it("falls back to local defaults without gateway", async () => {
		const result = await skill.execute({ action: "get" }, {});

		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.triggers).toEqual(["낸", "naia"]);
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
