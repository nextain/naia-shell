/**
 * E2E tests: Skills system (live Gateway connection)
 *
 * Prerequisites:
 *   - Naia Gateway running on localhost:18789
 *   - Device paired with operator token in ~/.naia/identity/device.json
 *   - `cargo tauri dev` or standalone Gateway running
 *
 * Run:
 *   CAFE_LIVE_GATEWAY_E2E=1 pnpm exec vitest run src/__tests__/skills-e2e.test.ts
 *
 * Tests the full chain: LLM tool definitions → SkillRegistry → executeTool → skill handler
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { loadDeviceIdentity } from "../gateway/device-identity.js";
import {
	executeTool,
	getAllTools,
	skillRegistry,
} from "../gateway/tool-bridge.js";

const GATEWAY_URL = "ws://localhost:18789";
const LIVE_E2E = process.env.CAFE_LIVE_GATEWAY_E2E === "1";

function loadGatewayToken(): string | null {
	const candidates = [
		join(homedir(), ".naia", "gateway.json"),
	];
	for (const configPath of candidates) {
		try {
			const config = JSON.parse(readFileSync(configPath, "utf-8"));
			const token = config.gateway?.auth?.token;
			if (token) return token;
		} catch {}
	}
	return null;
}

const gatewayToken = loadGatewayToken();
const deviceIdentity = loadDeviceIdentity();
const canRunE2E =
	LIVE_E2E && gatewayToken !== null && deviceIdentity !== undefined;

let client: GatewayClient;
let memoTmpDir: string;

describe.skipIf(!canRunE2E)("E2E: Skills system (live)", () => {
	beforeAll(async () => {
		client = new GatewayClient();
		await client.connect(GATEWAY_URL, {
			token: gatewayToken!,
			device: deviceIdentity,
		});
		memoTmpDir = mkdtempSync(join(process.cwd(), ".tmp-skills-e2e-"));
	});

	afterAll(() => {
		client?.close();
		if (memoTmpDir) {
			rmSync(memoTmpDir, { recursive: true, force: true });
		}
	});

	// ── Registry ──
	describe("skill registry", () => {
		it("has built-in skills registered", () => {
			expect(skillRegistry.has("skill_time")).toBe(true);
			expect(skillRegistry.has("skill_system_status")).toBe(true);
			expect(skillRegistry.has("skill_memo")).toBe(true);
			expect(skillRegistry.has("skill_weather")).toBe(true);
		});

		it("getAllTools includes skill definitions", () => {
			const tools = getAllTools(true);
			const names = tools.map((t) => t.name);
			// 8 gateway tools + 4 built-in skills (at minimum)
			expect(tools.length).toBeGreaterThanOrEqual(12);
			expect(names).toContain("skill_time");
			expect(names).toContain("skill_system_status");
			expect(names).toContain("skill_memo");
			expect(names).toContain("skill_weather");
		});

		it("getAllTools(false) includes local-only skills", () => {
			const tools = getAllTools(false);
			const names = tools.map((t) => t.name);
			expect(names).toContain("skill_time");
			expect(names).toContain("skill_weather");
		});
	});

	// ── skill_time (Tier 0, local) ──
	describe("skill_time", () => {
		it("returns current time via executeTool", async () => {
			const result = await executeTool(client, "skill_time", {});
			expect(result.success).toBe(true);
			expect(result.output.length).toBeGreaterThan(5);
		});

		it("returns ISO format", async () => {
			const result = await executeTool(client, "skill_time", {
				format: "iso",
			});
			expect(result.success).toBe(true);
			expect(result.output).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it("returns unix timestamp", async () => {
			const result = await executeTool(client, "skill_time", {
				format: "unix",
			});
			expect(result.success).toBe(true);
			expect(Number(result.output)).toBeGreaterThan(1_700_000_000);
		});

		it("respects timezone parameter", async () => {
			const result = await executeTool(client, "skill_time", {
				format: "iso",
				timezone: "Asia/Seoul",
			});
			expect(result.success).toBe(true);
			expect(result.output).toMatch(/\+09:00$/);
		});
	});

	// ── skill_system_status (Tier 0, local) ──
	describe("skill_system_status", () => {
		it("returns full system status", async () => {
			const result = await executeTool(client, "skill_system_status", {});
			expect(result.success).toBe(true);
			const data = JSON.parse(result.output);
			expect(data.os).toBeDefined();
			expect(data.memory).toBeDefined();
			expect(data.cpus).toBeDefined();
			expect(data.uptime).toBeGreaterThan(0);
		});

		it("returns memory section", async () => {
			const result = await executeTool(client, "skill_system_status", {
				section: "memory",
			});
			expect(result.success).toBe(true);
			const data = JSON.parse(result.output);
			expect(data.totalMB).toBeGreaterThan(0);
			expect(data.freeMB).toBeDefined();
			expect(data.usedMB).toBeDefined();
		});

		it("returns cpu section", async () => {
			const result = await executeTool(client, "skill_system_status", {
				section: "cpu",
			});
			expect(result.success).toBe(true);
			const data = JSON.parse(result.output);
			expect(data.count).toBeGreaterThan(0);
			expect(data.model).toBeDefined();
		});
	});

	// ── skill_memo (Tier 1, local) ──
	describe("skill_memo", () => {
		it("save → read → list → delete lifecycle", async () => {
			// Save
			const save = await executeTool(client, "skill_memo", {
				action: "save",
				key: "e2e-test-note",
				content: "skills-e2e-ok",
			});
			expect(save.success).toBe(true);

			// Read
			const read = await executeTool(client, "skill_memo", {
				action: "read",
				key: "e2e-test-note",
			});
			expect(read.success).toBe(true);
			expect(read.output).toBe("skills-e2e-ok");

			// List
			const list = await executeTool(client, "skill_memo", {
				action: "list",
			});
			expect(list.success).toBe(true);
			expect(list.output).toContain("e2e-test-note");

			// Delete
			const del = await executeTool(client, "skill_memo", {
				action: "delete",
				key: "e2e-test-note",
			});
			expect(del.success).toBe(true);

			// Verify deleted
			const readAfter = await executeTool(client, "skill_memo", {
				action: "read",
				key: "e2e-test-note",
			});
			expect(readAfter.success).toBe(false);
			expect(readAfter.error).toContain("not found");
		});
	});

	// ── skill_weather (Tier 0, local via wttr.in) ──
	describe("skill_weather", () => {
		it("returns weather data for a location", async () => {
			const result = await skillRegistry.execute(
				"skill_weather",
				{ location: "Seoul" },
				{},
			);
			// May fail in CI without network, but should not crash
			expect(typeof result.success).toBe("boolean");
			expect(typeof result.output).toBe("string");
		});

		it("requires location parameter", async () => {
			const result = await skillRegistry.execute("skill_weather", {}, {});
			expect(result.success).toBe(false);
			expect(result.error).toContain("location is required");
		});
	});
});
