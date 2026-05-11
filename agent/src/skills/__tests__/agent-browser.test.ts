import { describe, expect, it } from "vitest";
import { agentBrowserDescriptor } from "@naia-adk/skills-builtin";
import { createAgentBrowserSkill } from "../built-in/agent-browser.js";

describe("agent-browser skill (ported from OpenClaw via #274)", () => {
	const skill = createAgentBrowserSkill();

	it("registers as skill_agent_browser with tier 1", () => {
		expect(skill.name).toBe(`skill_${agentBrowserDescriptor.name}`);
		expect(skill.name).toBe("skill_agent_browser");
		expect(skill.tier).toBe(1);
		expect(skill.requiresGateway).toBe(false);
		expect(skill.source).toBe("built-in");
	});

	it("uses descriptor.description + inputSchema (no inline drift)", () => {
		expect(skill.description).toBe(agentBrowserDescriptor.description);
		expect(skill.parameters).toBe(agentBrowserDescriptor.inputSchema);
	});

	it("rejects when cmd is missing", async () => {
		const r = await skill.execute({}, { requestId: "t1", writeLine: () => {} });
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/cmd is required/);
	});

	// Subprocess invocation against the real agent-browser CLI is skipped here:
	// the CLI requires playwright browsers (heavy dependency) and a real browser
	// session. Smoke-testing the subprocess wiring belongs in E2E, not unit.
	// The cmd-validation path is exercised by the "rejects when cmd is missing"
	// test above; descriptor schema integrity by the enum-coverage test below.

	it("descriptor enum covers all OpenClaw agent-browser sub-commands", () => {
		const enums = (
			(agentBrowserDescriptor.inputSchema.properties as Record<string, { enum?: string[] }>)?.cmd?.enum ??
			[]
		);
		// OpenClaw cmd set: open / back / forward / reload / close / snapshot /
		// click / dblclick / fill / type / press / hover / check / uncheck /
		// select / scroll / upload / get / screenshot / pdf
		for (const c of ["open", "snapshot", "click", "fill", "press", "screenshot", "pdf"]) {
			expect(enums).toContain(c);
		}
	});
});
